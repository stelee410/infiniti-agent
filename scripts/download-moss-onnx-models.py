#!/usr/bin/env python3
"""
跨平台版本：将 MOSS ONNX 权重下载到本仓库 models/。

下载内容：
- OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX → models/MOSS-TTS-Nano-100M-ONNX
- OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX → models/MOSS-Audio-Tokenizer-Nano-ONNX
- 参考音频 zh_1.wav → models/moss-prompt/zh_1.wav

对照 .sh：scripts/download-moss-onnx-models.sh

环境变量（与 .sh 保持完全一致）：
- DOWNLOAD_PYTHON  指定 Python 解释器（必须装 huggingface_hub；否则脚本会临时建 venv）
- SSL_CERT_FILE    CA 证书；未设时用 certifi.where() 兜底

用法：
    python scripts/download-moss-onnx-models.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _winutils import find_python, repo_root, venv_python  # noqa: E402

_PROMPT_AUDIO_URL = (
    "https://raw.githubusercontent.com/OpenMOSS/MOSS-TTS-Nano/main/assets/audio/zh_1.wav"
)


def _resolve_dest(root: Path) -> Path:
    """与 .sh 一致：固定 root/models（不接受 env 覆盖）。"""
    return root / "models"


def _get_repos() -> list[tuple[str, str]]:
    """需下载的 HuggingFace 仓库与本地子目录名（与 .sh 一致）。"""
    return [
        ("OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX", "MOSS-TTS-Nano-100M-ONNX"),
        ("OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX", "MOSS-Audio-Tokenizer-Nano-ONNX"),
    ]


def _prompt_audio_url() -> str:
    return _PROMPT_AUDIO_URL


def _has_huggingface_hub(py_cmd: list[str]) -> bool:
    """检查给定 Python 解释器是否能 import huggingface_hub。"""
    try:
        result = subprocess.run(
            [*py_cmd, "-c", "import huggingface_hub"],
            capture_output=True,
            timeout=10,
            check=False,
        )
        return result.returncode == 0
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return False


def _create_temp_venv(py_cmd: list[str]) -> Path:
    """临时 venv（替代 .sh 的 /tmp/ia-moss-dl-$$），装 huggingface_hub。"""
    tmp = Path(tempfile.mkdtemp(prefix="ia-moss-dl-"))
    subprocess.check_call([*py_cmd, "-m", "venv", str(tmp)])
    venv_py = venv_python(tmp)
    subprocess.check_call(
        [
            str(venv_py), "-m", "pip", "install", "-q",
            "--trusted-host", "pypi.org",
            "--trusted-host", "files.pythonhosted.org",
            "huggingface_hub",
        ]
    )
    return tmp


_DOWNLOAD_CODE = """\
import os, sys
from huggingface_hub import snapshot_download
from pathlib import Path
root = Path(os.environ['DEST'])
repos = [
    ("OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX", "MOSS-TTS-Nano-100M-ONNX"),
    ("OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX", "MOSS-Audio-Tokenizer-Nano-ONNX"),
]
for repo, sub in repos:
    d = root / sub
    print("snapshot_download", repo, "->", d)
    snapshot_download(repo_id=repo, local_dir=str(d))
print("done ->", root)
"""


def main() -> int:
    root = repo_root()
    dest = _resolve_dest(root)
    dest.mkdir(parents=True, exist_ok=True)

    # 1. 找一个能 import huggingface_hub 的 Python；否则临时建 venv 装一个
    env_override = os.environ.get("DOWNLOAD_PYTHON")
    if env_override:
        py_cmd: list[str] = [env_override]
    else:
        try:
            py_cmd = find_python(min_minor=8, max_minor=13)
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return 1

    tmp_venv: Path | None = None
    if not _has_huggingface_hub(py_cmd):
        print("当前 Python 未装 huggingface_hub，临时建 venv …", file=sys.stderr)
        tmp_venv = _create_temp_venv(py_cmd)
        py_cmd = [str(venv_python(tmp_venv))]

    try:
        # 2. SSL_CERT_FILE 兜底
        if "SSL_CERT_FILE" not in os.environ:
            try:
                ca = subprocess.check_output(
                    [*py_cmd, "-c", "import certifi; print(certifi.where())"],
                    text=True,
                    timeout=10,
                ).strip()
                if ca:
                    os.environ["SSL_CERT_FILE"] = ca
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                pass

        # 3. 下载两个 HF 仓库
        env = {**os.environ, "DEST": str(dest)}
        subprocess.check_call([*py_cmd, "-c", _DOWNLOAD_CODE], env=env)

        # 4. 下载参考音频（替代 .sh 的 curl）
        prompt_dir = dest / "moss-prompt"
        prompt_dir.mkdir(parents=True, exist_ok=True)
        prompt_wav = prompt_dir / "zh_1.wav"
        if not prompt_wav.exists():
            print(f"下载参考音 {prompt_wav} …", file=sys.stderr)
            urllib.request.urlretrieve(_PROMPT_AUDIO_URL, str(prompt_wav))
        print(f"参考音: {prompt_wav}", file=sys.stderr)
    finally:
        if tmp_venv is not None and tmp_venv.exists():
            shutil.rmtree(tmp_venv, ignore_errors=True)

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
