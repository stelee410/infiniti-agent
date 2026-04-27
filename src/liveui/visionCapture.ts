import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { LiveUiVisionAttachment } from './protocol.js'

export type CaptureVisionSnapshotOptions = {
  location?: LiveUiVisionAttachment['location']
  timeoutMs?: number
  maxBytes?: number
  logPath?: string
  /** 先打开摄像头并预热，然后至少等待该时长再抓帧。用于让 UI 倒计时和实际拍照对齐。 */
  captureDelayMs?: number
}

export type CaptureVisionSnapshotResult =
  | { ok: true; vision: LiveUiVisionAttachment }
  | { ok: false; error: string }

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_BYTES = 6 * 1024 * 1024
const FORCE_KILL_AFTER_MS = 700

const MACOS_NATIVE_CAMERA_SWIFT = String.raw`
import Foundation
import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers

let nativeLogPath = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : nil

func log(_ message: String) {
  let line = message + "\n"
  FileHandle.standardError.write(line.data(using: .utf8)!)
  if let nativeLogPath = nativeLogPath, let data = line.data(using: .utf8) {
    let url = URL(fileURLWithPath: nativeLogPath)
    if FileManager.default.fileExists(atPath: nativeLogPath) {
      if let handle = try? FileHandle(forWritingTo: url) {
        _ = try? handle.seekToEnd()
        _ = try? handle.write(contentsOf: data)
        _ = try? handle.close()
      }
    } else {
      try? data.write(to: url)
    }
  }
}

final class FrameDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  let outputURL: URL
  let semaphore = DispatchSemaphore(value: 0)
  let context = CIContext()
  let warmupUntil: CFTimeInterval
  let minFrameCount: Int
  var finished = false
  var errorMessage: String?
  var frameCount = 0

  init(outputURL: URL, warmupSeconds: Double, minFrameCount: Int) {
    self.outputURL = outputURL
    self.warmupUntil = CACurrentMediaTime() + warmupSeconds
    self.minFrameCount = minFrameCount
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    if finished { return }
    frameCount += 1
    if CACurrentMediaTime() < warmupUntil || frameCount < minFrameCount {
      if frameCount == 1 || frameCount == minFrameCount {
        log("[camera-native] warmup frame \(frameCount)")
      }
      return
    }
    finished = true

    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      errorMessage = "sample buffer has no image buffer"
      semaphore.signal()
      return
    }

    let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
    guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else {
      errorMessage = "failed to create CGImage"
      semaphore.signal()
      return
    }

    guard let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
      errorMessage = "failed to create JPEG destination"
      semaphore.signal()
      return
    }

    CGImageDestinationAddImage(destination, cgImage, [
      kCGImageDestinationLossyCompressionQuality: 0.86
    ] as CFDictionary)

    if !CGImageDestinationFinalize(destination) {
      errorMessage = "failed to write JPEG"
    }
    semaphore.signal()
  }
}

let outputPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/infiniti-agent-camera.jpg"
let timeoutSeconds = CommandLine.arguments.count > 2 ? max(3.0, Double(CommandLine.arguments[2]) ?? 20.0) : 20.0
let captureDelaySeconds = CommandLine.arguments.count > 4 ? max(0.0, Double(CommandLine.arguments[4]) ?? 0.0) : 0.0
let outputURL = URL(fileURLWithPath: outputPath)
let warmupSeconds = 1.2
let minFrameCount = 20

let status = AVCaptureDevice.authorizationStatus(for: .video)
log("[camera-native] authorization status before request: \(status.rawValue)")

if status == .notDetermined {
  let authSemaphore = DispatchSemaphore(value: 0)
  var granted = false
  AVCaptureDevice.requestAccess(for: .video) { ok in
    granted = ok
    authSemaphore.signal()
  }
  _ = authSemaphore.wait(timeout: .now() + timeoutSeconds)
  log("[camera-native] requestAccess result: \(granted)")
}

let finalStatus = AVCaptureDevice.authorizationStatus(for: .video)
log("[camera-native] authorization status after request: \(finalStatus.rawValue)")
guard finalStatus == .authorized else {
  log("[camera-native] camera permission not authorized")
  exit(13)
}

guard let device = AVCaptureDevice.default(for: .video) else {
  log("[camera-native] no default video device")
  exit(2)
}
log("[camera-native] device: \(device.localizedName) uniqueID=\(device.uniqueID)")

let session = AVCaptureSession()
session.beginConfiguration()
if session.canSetSessionPreset(.vga640x480) {
  session.sessionPreset = .vga640x480
}

do {
  let input = try AVCaptureDeviceInput(device: device)
  guard session.canAddInput(input) else {
    log("[camera-native] cannot add camera input")
    exit(3)
  }
  session.addInput(input)
} catch {
  log("[camera-native] failed to create camera input: \(error)")
  exit(3)
}

let output = AVCaptureVideoDataOutput()
output.alwaysDiscardsLateVideoFrames = true
output.videoSettings = [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
]
let effectiveWarmupSeconds = max(warmupSeconds, captureDelaySeconds)
let delegate = FrameDelegate(outputURL: outputURL, warmupSeconds: effectiveWarmupSeconds, minFrameCount: minFrameCount)
let queue = DispatchQueue(label: "infiniti-agent.camera.capture")
output.setSampleBufferDelegate(delegate, queue: queue)

guard session.canAddOutput(output) else {
  log("[camera-native] cannot add video data output")
  exit(4)
}
session.addOutput(output)
session.commitConfiguration()

log("[camera-native] startRunning warmupSeconds=\(effectiveWarmupSeconds) captureDelaySeconds=\(captureDelaySeconds) minFrameCount=\(minFrameCount)")
session.startRunning()
guard session.isRunning else {
  log("[camera-native] session did not start")
  exit(5)
}

let waitResult = delegate.semaphore.wait(timeout: .now() + timeoutSeconds)
session.stopRunning()
log("[camera-native] stopRunning")

if waitResult == .timedOut {
  log("[camera-native] timed out waiting for frame")
  exit(124)
}

if let errorMessage = delegate.errorMessage {
  log("[camera-native] capture failed: \(errorMessage)")
  exit(1)
}

log("[camera-native] captured frame count: \(delegate.frameCount)")
log("[camera-native] wrote JPEG: \(outputPath)")
exit(0)
`

const MACOS_NATIVE_CAMERA_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.linkyun.infiniti-agent.camera-helper</string>
  <key>CFBundleExecutable</key>
  <string>camera-helper</string>
  <key>CFBundleName</key>
  <string>Infiniti Agent Camera Helper</string>
  <key>CFBundleDisplayName</key>
  <string>Infiniti Agent Camera Helper</string>
  <key>NSCameraUsageDescription</key>
  <string>Infiniti Agent needs camera access to take photos from the CLI.</string>
</dict>
</plist>
`

function splitInputArgs(raw: string): string[] {
  return raw.split(/\s+/).map((s) => s.trim()).filter(Boolean)
}

function ffmpegInputCandidates(): string[][] {
  const custom = process.env.INFINITI_LIVEUI_CAMERA_FFMPEG_INPUT?.trim()
  if (custom) return [splitInputArgs(custom)]

  if (process.platform === 'darwin') {
    return [
      ['-f', 'avfoundation', '-framerate', '30', '-video_size', '640x480', '-i', '0:none'],
      ['-f', 'avfoundation', '-i', '0:none'],
      ['-f', 'avfoundation', '-i', 'default:none'],
    ]
  }

  if (process.platform === 'linux') {
    return [['-f', 'v4l2', '-video_size', '640x480', '-i', '/dev/video0']]
  }

  if (process.platform === 'win32') {
    const camera = process.env.INFINITI_LIVEUI_DSHOW_CAMERA ?? 'Integrated Camera'
    return [['-f', 'dshow', '-i', `video=${camera}`]]
  }

  return []
}

function compactErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function waitForProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  logPrefix: string,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let closed = false
    let stopRequested = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (forceKillTimer && (closed || !stopRequested)) clearTimeout(forceKillTimer)
      fn()
    }

    const stopProcess = (reason: string): void => {
      if (closed || stopRequested) return
      stopRequested = true
      console.warn(`${logPrefix} stopping process: ${reason}`)
      proc.kill('SIGTERM')
      forceKillTimer = setTimeout(() => {
        if (!closed) proc.kill('SIGKILL')
      }, FORCE_KILL_AFTER_MS)
    }

    timer = setTimeout(() => {
      stopProcess(`timeout ${timeoutMs}ms`)
      finish(() => reject(new Error(`${command} 超时（${timeoutMs}ms）`)))
    }, timeoutMs)

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > 12_000) stdout = stdout.slice(-12_000)
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8')
      stderr += s
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000)
      for (const line of s.split(/\r?\n/).filter(Boolean)) {
        console.error(line.startsWith('[camera-native]') ? line : `${logPrefix} ${line}`)
      }
    })

    proc.on('error', (err) => finish(() => reject(err)))

    proc.on('close', (code) => {
      closed = true
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (settled) return
      if (code !== 0) {
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
        finish(() => reject(new Error(detail ? `${command} 退出码 ${code}: ${detail}` : `${command} 退出码 ${code}`)))
        return
      }
      finish(() => resolve({ stdout, stderr }))
    })
  })
}

async function ensureMacOsNativeCameraHelper(timeoutMs: number): Promise<string> {
  const hash = createHash('sha256')
    .update(MACOS_NATIVE_CAMERA_SWIFT)
    .update(MACOS_NATIVE_CAMERA_PLIST)
    .digest('hex')
    .slice(0, 16)
  const dir = join(homedir(), '.infiniti-agent', 'native')
  const appPath = join(dir, 'InfinitiAgentCameraHelper.app')
  const contentsPath = join(appPath, 'Contents')
  const macosPath = join(contentsPath, 'MacOS')
  const binPath = join(macosPath, 'camera-helper')
  const hashPath = join(dir, 'InfinitiAgentCameraHelper.hash')
  if (existsSync(binPath) && existsSync(hashPath) && process.env.INFINITI_AGENT_CAMERA_REBUILD !== '1') {
    try {
      const installedHash = (await readFile(hashPath, 'utf8')).trim()
      if (installedHash === hash) return appPath
    } catch {
      /* rebuild below */
    }
  }

  await rm(appPath, { recursive: true, force: true })
  await mkdir(macosPath, { recursive: true })
  const swiftPath = join(dir, `camera-helper-${hash}.swift`)
  const plistPath = join(dir, `camera-helper-${hash}.plist`)
  await writeFile(swiftPath, MACOS_NATIVE_CAMERA_SWIFT, 'utf8')
  await writeFile(plistPath, MACOS_NATIVE_CAMERA_PLIST, 'utf8')
  await writeFile(join(contentsPath, 'Info.plist'), MACOS_NATIVE_CAMERA_PLIST, 'utf8')

  console.error(`[camera-native] compiling helper app: ${appPath}`)
  await waitForProcess(
    'swiftc',
    [
      swiftPath,
      '-o',
      binPath,
      '-Xlinker',
      '-sectcreate',
      '-Xlinker',
      '__TEXT',
      '-Xlinker',
      '__info_plist',
      '-Xlinker',
      plistPath,
    ],
    Math.max(timeoutMs, 20_000),
    '[camera-native:swiftc]',
  )
  await chmod(binPath, 0o755)
  await waitForProcess('codesign', ['--force', '--deep', '--sign', '-', appPath], Math.max(timeoutMs, 20_000), '[camera-native:codesign]')
  await writeFile(hashPath, hash, 'utf8')
  return appPath
}

async function captureWithMacOsNativeCamera(
  timeoutMs: number,
  maxBytes: number,
  logPath?: string,
  captureDelayMs = 0,
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'infiniti-agent-camera-'))
  const imagePath = join(dir, `${randomUUID()}.jpg`)
  const appPath = await ensureMacOsNativeCameraHelper(timeoutMs)

  try {
    await waitForProcess(
      'open',
      [
        '-W',
        '-n',
        appPath,
        '--args',
        imagePath,
        String(Math.ceil(timeoutMs / 1000)),
        logPath ?? '',
        String(Math.max(0, captureDelayMs / 1000)),
      ],
      timeoutMs,
      '[camera-native]',
    )

    const st = await stat(imagePath)
    if (st.size <= 0) throw new Error('macOS 原生拍照没有输出图像')
    if (st.size > maxBytes) throw new Error(`macOS 原生拍照输出超过 ${maxBytes} bytes`)
    return await readFile(imagePath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function captureWithFfmpeg(inputArgs: string[], timeoutMs: number, maxBytes: number): Promise<Buffer> {
  const args = [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'error',
    ...inputArgs,
    '-frames:v',
    '1',
    '-an',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ]

  return await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0
    let stderr = ''
    let timedOut = false
    let tooLarge = false
    let settled = false
    let closed = false
    let stopRequested = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (forceKillTimer && (closed || !stopRequested)) clearTimeout(forceKillTimer)
      fn()
    }

    const stopProcess = (reason: string): void => {
      if (closed || stopRequested) return
      stopRequested = true
      console.warn(`[liveui] 停止摄像头拍照进程: ${reason}`)
      proc.kill('SIGTERM')
      forceKillTimer = setTimeout(() => {
        if (!closed) proc.kill('SIGKILL')
      }, FORCE_KILL_AFTER_MS)
    }

    timer = setTimeout(() => {
      timedOut = true
      stopProcess(`timeout ${timeoutMs}ms`)
      finish(() => reject(new Error(`ffmpeg 拍照超时（${timeoutMs}ms）`)))
    }, timeoutMs)

    proc.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        tooLarge = true
        stopProcess(`output too large ${bytes} bytes`)
        finish(() => reject(new Error(`ffmpeg 输出超过 ${maxBytes} bytes`)))
        return
      }
      chunks.push(chunk)
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000)
    })

    proc.on('error', (err) => {
      finish(() => reject(err))
    })

    proc.on('close', (code) => {
      closed = true
      if (settled) {
        if (forceKillTimer) clearTimeout(forceKillTimer)
        return
      }
      if (timedOut) {
        finish(() => reject(new Error(`ffmpeg 拍照超时（${timeoutMs}ms）`)))
        return
      }
      if (tooLarge) {
        finish(() => reject(new Error(`ffmpeg 输出超过 ${maxBytes} bytes`)))
        return
      }
      if (code !== 0) {
        const detail = stderr.trim()
        finish(() => reject(new Error(detail ? `ffmpeg 退出码 ${code}: ${detail}` : `ffmpeg 退出码 ${code}`)))
        return
      }
      if (bytes <= 0) {
        const detail = stderr.trim()
        finish(() => reject(new Error(detail ? `ffmpeg 没有输出图像: ${detail}` : 'ffmpeg 没有输出图像')))
        return
      }
      finish(() => resolve(Buffer.concat(chunks, bytes)))
    })
  })
}

export async function captureVisionSnapshot(
  opts: CaptureVisionSnapshotOptions = {},
): Promise<LiveUiVisionAttachment | null> {
  const result = await captureVisionSnapshotResult(opts)
  return result.ok ? result.vision : null
}

export async function captureVisionSnapshotResult(
  opts: CaptureVisionSnapshotOptions = {},
): Promise<CaptureVisionSnapshotResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  if (process.platform === 'darwin' && process.env.INFINITI_LIVEUI_CAMERA_DISABLE_NATIVE !== '1') {
    try {
      const image = await captureWithMacOsNativeCamera(timeoutMs, maxBytes, opts.logPath, opts.captureDelayMs)
      console.error(`[liveui] macOS 原生视觉快照已拍摄: ${image.length} bytes`)
      return {
        ok: true,
        vision: {
          imageBase64: image.toString('base64'),
          mediaType: 'image/jpeg',
          capturedAt: new Date().toISOString(),
          ...(opts.location ? { location: opts.location } : {}),
        },
      }
    } catch (e) {
      const message = compactErrorMessage(e)
      console.warn(`[liveui] macOS 原生视觉快照失败: ${message}`)
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, error: message }
      }
    }
  }

  const candidates = ffmpegInputCandidates()
  if (candidates.length === 0) {
    const error = '当前平台没有默认摄像头采集参数，请设置 INFINITI_LIVEUI_CAMERA_FFMPEG_INPUT'
    console.warn(`[liveui] ${error}`)
    return { ok: false, error }
  }

  const errors: string[] = []
  for (const inputArgs of candidates) {
    try {
      const image = await captureWithFfmpeg(
        inputArgs,
        timeoutMs,
        maxBytes,
      )
      console.error(`[liveui] 视觉快照已拍摄: ${image.length} bytes`)
      return {
        ok: true,
        vision: {
          imageBase64: image.toString('base64'),
          mediaType: 'image/jpeg',
          capturedAt: new Date().toISOString(),
          ...(opts.location ? { location: opts.location } : {}),
        },
      }
    } catch (e) {
      const message = compactErrorMessage(e)
      errors.push(`${inputArgs.join(' ')} => ${message}`)
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || message.includes('超时')) break
    }
  }

  const message = errors.join(' | ') || '未知错误'
  console.warn(
    `[liveui] 视觉快照失败: ${message}。` +
      '请确认已安装 ffmpeg，并在系统设置里允许 Terminal/iTerm 使用摄像头；' +
      '如需指定设备，可设置 INFINITI_LIVEUI_CAMERA_FFMPEG_INPUT。',
  )
  return { ok: false, error: message }
}
