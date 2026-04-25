#!/usr/bin/env python3
"""
本地 VoxCPM2 HTTP 服务，供 infiniti-agent 的 tts.provider=voxcpm 调用。

依赖（建议在独立 venv 中安装）:
  pip install fastapi uvicorn voxcpm soundfile numpy torch

启动:
  python scripts/voxcpm-tts-serve.py --port 8810

环境变量:
  VOXCPM_MODEL_ID  默认 openbmb/VoxCPM2（或本机模型目录）
  VOXCPM_OPTIMIZE  是否启用 torch 侧 optimize + 首句 warm-up。Mac（MPS）上 compile 本就不会启用；
                   设 0 / false 可略过首句预热，略加快启动。默认 1。
  PYTORCH_MPS_*    见 start-voxcpm-tts-serve.sh（如 PYTORCH_MPS_HIGH_WATERMARK_RATIO）
"""
from __future__ import annotations

import argparse
import io
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Iterator, Optional

import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("voxcpm-tts-serve")

try:
    from fastapi import FastAPI, File, Form, UploadFile
    from fastapi.responses import Response, StreamingResponse
    import soundfile as sf
    import uvicorn
except ImportError as e:
    raise SystemExit(
        "缺少依赖，请先安装: pip install fastapi uvicorn soundfile numpy\n" + str(e)
    ) from e

_app = FastAPI(title="VoxCPM TTS for infiniti-agent", version="0.1")
_model = None
_model_id: str = ""


def _get_model():
    global _model, _model_id
    if _model is not None:
        return _model
    import voxcpm

    mid = os.environ.get("VOXCPM_MODEL_ID", "openbmb/VoxCPM2").strip()
    wants_opt = os.environ.get("VOXCPM_OPTIMIZE", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )
    logger.info("Loading VoxCPM model: %s, optimize/warmup=%s", mid, wants_opt)
    _model_id = mid
    try:
        _model = voxcpm.VoxCPM.from_pretrained(mid, load_denoiser=False, optimize=wants_opt)
    except TypeError:
        _model = voxcpm.VoxCPM.from_pretrained(mid, load_denoiser=False)
    logger.info("VoxCPM loaded, sample_rate=%s", getattr(_model.tts_model, "sample_rate", "?"))
    return _model


def _final_text(text: str, control: str) -> str:
    text = (text or "").strip()
    if not text:
        raise ValueError("empty text")
    c = re.sub(r"[()（）]", "", (control or "").strip()).strip()
    return f"({c}){text}" if c else text


def _amplitude_apply_f32(x: np.ndarray, mode: str) -> np.ndarray:
    """在整段波形上做峰值或 RMS 归一化，减轻句与句之间电平差异。"""
    m = (mode or "none").strip().lower()
    if m in ("none", "off", "false", "0", ""):
        return np.asarray(x, dtype=np.float32)
    a = np.asarray(x, dtype=np.float32)
    if a.size == 0:
        return a
    flat = a.reshape(-1)
    if m in ("peak", "max"):
        peak = float(np.max(np.abs(flat)) + 1e-8)
        scale = 0.99 / peak
    else:
        rms = float(np.sqrt(np.mean(np.float64(flat) ** 2)) + 1e-8)
        scale = 0.1 / rms
    out = np.clip(a * scale, -1.0, 1.0).astype(np.float32)
    return out


def _float_chunk_to_pcm_s16le(chunk: np.ndarray) -> bytes:
    arr = np.asarray(chunk, dtype=np.float32)
    if arr.size == 0:
        return b""
    if arr.ndim == 2 and arr.shape[1] == 2:
        l, r = arr[:, 0], arr[:, 1]
        inter = np.empty(l.size * 2, dtype=np.float32)
        inter[0::2] = l
        inter[1::2] = r
        x = inter
    else:
        x = arr.reshape(-1)
    pcm = (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2")
    return pcm.tobytes()


def _iter_float_from_generate(
    *,
    final_text: str,
    ref_path: Optional[str],
    cfg_value: float,
    inference_timesteps: int,
    normalize: bool,
    denoise: bool,
) -> Iterator[np.ndarray]:
    model = _get_model()
    kwargs = dict(
        text=final_text,
        cfg_value=float(cfg_value),
        inference_timesteps=int(inference_timesteps),
        normalize=bool(normalize),
        denoise=bool(denoise),
    )
    if ref_path:
        kwargs["reference_wav_path"] = ref_path
    try:
        stream_it = model.generate_streaming(**kwargs)
    except TypeError:
        kwargs.pop("normalize", None)
        kwargs.pop("denoise", None)
        stream_it = model.generate_streaming(**kwargs)
    for chunk in stream_it:
        yield np.asarray(chunk, dtype=np.float32)


def _concat_float_chunks(chunks: list[np.ndarray]) -> np.ndarray:
    if not chunks:
        return np.array([], dtype=np.float32)
    a0 = np.asarray(chunks[0], dtype=np.float32)
    if a0.ndim == 2 and a0.shape[1] == 2:
        return np.vstack([np.asarray(c, dtype=np.float32) for c in chunks])
    return np.concatenate([np.asarray(c, dtype=np.float32).reshape(-1) for c in chunks], axis=0)


def _iter_pcm_s16le_fixed(full: np.ndarray, samples_per_emit: int) -> Iterator[bytes]:
    if full.ndim == 2 and full.shape[1] == 2:
        for i in range(0, full.shape[0], samples_per_emit):
            part = full[i : i + samples_per_emit, :]
            if part.size:
                yield _float_chunk_to_pcm_s16le(part)
        return
    flat = full.reshape(-1)
    for i in range(0, flat.size, samples_per_emit):
        seg = flat[i : i + samples_per_emit]
        if seg.size:
            yield _float_chunk_to_pcm_s16le(seg)


def _pcm_stream_from_generate(
    *,
    final_text: str,
    ref_path: Optional[str],
    cfg_value: float,
    inference_timesteps: int,
    normalize: bool,
    denoise: bool,
    amplitude_normalize: str,
) -> Iterator[bytes]:
    it = _iter_float_from_generate(
        final_text=final_text,
        ref_path=ref_path,
        cfg_value=cfg_value,
        inference_timesteps=inference_timesteps,
        normalize=normalize,
        denoise=denoise,
    )
    m = (amplitude_normalize or "none").strip().lower()
    if m in ("none", "off", "false", "0", ""):
        for chunk in it:
            yield _float_chunk_to_pcm_s16le(chunk)
        return
    chunks = list(it)
    full = _concat_float_chunks(chunks)
    full = _amplitude_apply_f32(full, m)
    if full.size == 0:
        return
    a0 = np.asarray(chunks[0], dtype=np.float32) if chunks else full
    samples = 2048
    if a0.ndim == 2 and a0.shape[1] == 2:
        samples = 1024
    yield from _iter_pcm_s16le_fixed(full, samples)


@_app.get("/health")
def health():
    return {"ok": True, "model_loaded": _model is not None, "model_id": _model_id or None}


@_app.post("/api/tts")
async def tts_full(
    text: str = Form(...),
    control_instruction: str = Form(""),
    cfg_value: float = Form(2.0),
    inference_timesteps: int = Form(20),
    normalize: bool = Form(False),
    denoise: bool = Form(True),
    amplitude_normalize: str = Form("rms"),
    reference_audio: Optional[UploadFile] = File(None),
):
    """整段 WAV（非流式，便于调试）。"""
    model = _get_model()
    final_text = _final_text(text, control_instruction)
    ref_path: Optional[str] = None
    tmp_path: Optional[str] = None
    try:
        if reference_audio is not None and reference_audio.filename:
            raw = await reference_audio.read()
            t = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            t.write(raw)
            t.flush()
            t.close()
            tmp_path = t.name
            ref_path = tmp_path
        kwargs = dict(
            text=final_text,
            cfg_value=float(cfg_value),
            inference_timesteps=int(inference_timesteps),
            normalize=bool(normalize),
            denoise=bool(denoise),
        )
        if ref_path:
            kwargs["reference_wav_path"] = ref_path
        try:
            wav = model.generate(**kwargs)
        except TypeError:
            kwargs.pop("normalize", None)
            kwargs.pop("denoise", None)
            wav = model.generate(**kwargs)
        wav = _amplitude_apply_f32(np.asarray(wav, dtype=np.float32), str(amplitude_normalize))
        sr = int(model.tts_model.sample_rate)
        buf = io.BytesIO()
        sf.write(buf, wav, sr, subtype="PCM_16", format="WAV")
        return Response(content=buf.getvalue(), media_type="audio/wav")
    finally:
        if tmp_path and Path(tmp_path).exists():
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except OSError:
                pass


@_app.post("/api/tts/stream")
async def tts_stream(
    text: str = Form(...),
    control_instruction: str = Form(""),
    cfg_value: float = Form(2.0),
    inference_timesteps: int = Form(20),
    normalize: bool = Form(False),
    denoise: bool = Form(True),
    amplitude_normalize: str = Form("rms"),
    reference_audio: Optional[UploadFile] = File(None),
):
    """流式 raw PCM s16le little-endian；声道与采样率见响应头。"""
    model = _get_model()
    final_text = _final_text(text, control_instruction)
    ref_path: Optional[str] = None
    tmp_path: Optional[str] = None

    if reference_audio is not None and reference_audio.filename:
        raw = await reference_audio.read()
        t = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        t.write(raw)
        t.flush()
        t.close()
        tmp_path = t.name
        ref_path = tmp_path

    sr = int(model.tts_model.sample_rate)
    # 从首块推断声道（默认 1）
    ch = 1

    def gen() -> Iterator[bytes]:
        try:
            for pcm in _pcm_stream_from_generate(
                final_text=final_text,
                ref_path=ref_path,
                cfg_value=cfg_value,
                inference_timesteps=inference_timesteps,
                normalize=normalize,
                denoise=denoise,
                amplitude_normalize=amplitude_normalize,
            ):
                yield pcm
        finally:
            if tmp_path and Path(tmp_path).exists():
                try:
                    Path(tmp_path).unlink(missing_ok=True)
                except OSError:
                    pass

    return StreamingResponse(
        gen(),
        media_type="application/octet-stream",
        headers={
            "X-Sample-Rate": str(sr),
            "X-Channels": str(ch),
            "Cache-Control": "no-store",
        },
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8810)
    parser.add_argument(
        "--model-id",
        default=os.environ.get("VOXCPM_MODEL_ID", "openbmb/VoxCPM2"),
        help="HuggingFace repo id 或本机模型路径",
    )
    args = parser.parse_args()
    os.environ["VOXCPM_MODEL_ID"] = args.model_id.strip()
    uvicorn.run(_app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
