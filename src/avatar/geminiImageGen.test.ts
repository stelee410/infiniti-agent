import { afterEach, describe, expect, it, vi } from 'vitest'
import { geminiGenerateImageBuffer } from './geminiImageGen.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('geminiGenerateImageBuffer', () => {
  it('posts generateContent with inline reference images and decodes inlineData output', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: {
            parts: [
              { text: 'ok' },
              { inlineData: { mimeType: 'image/png', data: Buffer.from('png-bytes').toString('base64') } },
            ],
          },
        }],
      }),
    } as Response)

    const out = await geminiGenerateImageBuffer({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/',
      apiKey: 'test-key',
      model: 'models/gemini-3.1-flash-image-preview',
      prompt: 'draw it',
      referenceImages: [{ mimeType: 'image/png', base64: 'cmVm' }],
      aspectRatio: '4:3',
      imageSize: '1K',
    })

    expect(out.toString()).toBe('png-bytes')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent')
    expect((init as RequestInit).headers).toMatchObject({
      'x-goog-api-key': 'test-key',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      contents: [{
        role: 'user',
        parts: [
          { text: 'draw it' },
          { inlineData: { mimeType: 'image/png', data: 'cmVm' } },
        ],
      }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: '4:3',
          imageSize: '1K',
        },
      },
    })
  })
})
