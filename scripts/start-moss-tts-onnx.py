#!/usr/bin/env python3
"""
跨平台版本：启动 MOSS-TTS-Nano ONNX HTTP 服务（默认 127.0.0.1:18083）。

需先运行: python scripts/setup-moss-tts-onnx-venv.py
模型目录: 仓库根下 models/（含 MOSS-TTS-Nano-100M-ONNX 与 MOSS-Audio-Tokenizer-Nano-ONNX）。

对照 .sh：scripts/start-moss-tts-onnx.sh

环境变量（与 .sh 保持完全一致）：
- MOSS_TTS_NANO_HOME    MOSS 源码目录（默认 <repo>/third_party/MOSS-TTS-Nano）
- MOSS_ONNX_MODEL_DIR   ONNX 模型根目录（默认 <repo>/models）
- MOSS_TTS_PORT         服务端口（默认 18083）
- MOSS_TTS_SKIP_WETEXT  跳过 WeTextProcessing（默认 1，与 .sh 一致）

用法：
    python scripts/start-moss-tts-onnx.py
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _winutils import repo_root, venv_executable  # noqa: E402


def _resolve_moss_home(env: Mapping[str, str], root: Path) -> Path:
    return Path(
        env.get("MOSS_TTS_NANO_HOME", str(root / "third_party" / "MOSS-TTS-Nano"))
    )


def _resolve_model_dir(env: Mapping[str, str], root: Path) -> Path:
    return Path(env.get("MOSS_ONNX_MODEL_DIR", str(root / "models")))


def _resolve_port(env: Mapping[str, str]) -> int:
    return int(env.get("MOSS_TTS_PORT", "18083"))


def _resolve_skip_wetext(env: Mapping[str, str]) -> str:
    """默认 '1'（与 .sh 一致）；用户已设值则保留。"""
    return env.get("MOSS_TTS_SKIP_WETEXT", "1")


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    root = repo_root()
    moss_home = _resolve_moss_home(os.environ, root)
    model_dir = _resolve_model_dir(os.environ, root)
    port = _resolve_port(os.environ)
    skip_wetext = _resolve_skip_wetext(os.environ)

    venv_dir = moss_home / ".venv"
    moss_cli = venv_executable(venv_dir, "moss-tts-nano")

    if not moss_cli.exists():
        print(
            f"未找到 {moss_cli}，请先运行: python {root / 'scripts' / 'setup-moss-tts-onnx-venv.py'}",
            file=sys.stderr,
        )
        return 1

    needed = [
        model_dir / "MOSS-TTS-Nano-100M-ONNX",
        model_dir / "MOSS-Audio-Tokenizer-Nano-ONNX",
    ]
    for d in needed:
        if not d.is_dir():
            print(
                f"未找到 {d}，请先运行: python {root / 'scripts' / 'download-moss-onnx-models.py'}",
                file=sys.stderr,
            )
            return 1

    env = {**os.environ, "MOSS_TTS_SKIP_WETEXT": skip_wetext}
    cmd = [
        str(moss_cli), "serve",
        "--backend", "onnx",
        "--onnx-model-dir", str(model_dir),
        "--host", "127.0.0.1",
        "--port", str(port),
        *argv,
    ]

    try:
        return subprocess.call(cmd, cwd=str(moss_home), env=env)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
