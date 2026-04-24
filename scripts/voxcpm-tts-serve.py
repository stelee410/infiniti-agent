#!/usr/bin/env python3
"""
本地 VoxCPM2 HTTP 服务，供 infiniti-agent 的 tts.provider=voxcpm 调用。

依赖（建议在独立 venv 中安装）:
  pip install fastapi uvicorn voxcpm soundfile numpy torch

启动:
  python scripts/voxcpm-tts-serve.py --port 8810

环境变量:
  VOXCPM_MODEL_ID  默认 openbmb/VoxCPM2（或本机模型目录）
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
    logger.info("Loading VoxCPM model: %s", mid)
    _model_id = mid
    try:
        _model = voxcpm.VoxCPM.from_pretrained(mid, load_denoiser=False, optimize=True)
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


def _pcm_stream_from_generate(
    *,
    final_text: str,
    ref_path: Optional[str],
    cfg_value: float,
    inference_timesteps: int,
    normalize: bool,
    denoise: bool,
) -> Iterator[bytes]:
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
        # 旧版 API 可能无部分关键字
        kwargs.pop("normalize", None)
        kwargs.pop("denoise", None)
        stream_it = model.generate_streaming(**kwargs)
    for chunk in stream_it:
        yield _float_chunk_to_pcm_s16le(chunk)


@_app.get("/health")
def health():
    return {"ok": True, "model_loaded": _model is not None, "model_id": _model_id or None}


@_app.post("/api/tts")
async def tts_full(
    text: str = Form(...),
    control_instruction: str = Form(""),
    cfg_value: float = Form(2.0),
    inference_timesteps: int = Form(10),
    normalize: bool = Form(False),
    denoise: bool = Form(True),
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
    inference_timesteps: int = Form(10),
    normalize: bool = Form(False),
    denoise: bool = Form(True),
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
