#!/usr/bin/env python3
"""
跨平台版本：在 third_party/voxcpm-venv 创建独立 Python 环境，安装 VoxCPM2 HTTP 服务依赖。

要求：Python 3.10～3.12（VoxCPM 文档：<3.13）。
对照 .sh：scripts/setup-voxcpm-venv.sh（功能等价，逻辑步骤一一对应）

环境变量（与 .sh 保持完全一致）：
- VOXCPM_VENV    venv 安装路径（默认 <repo>/third_party/voxcpm-venv）
- VOXCPM_PYTHON  指定 Python 解释器
- SSL_CERT_FILE  CA 证书；未设时用 certifi.where() 兜底

用法：
    python scripts/setup-voxcpm-venv.py
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _winutils import (  # noqa: E402
    find_python,
    pip_install,
    repo_root,
    try_certifi_path,
    venv_python,
)


def _resolve_venv_dir(env: Mapping[str, str], root: Path) -> Path:
    """根据环境变量 / 默认路径返回 venv 目录。"""
    return Path(env.get("VOXCPM_VENV", str(root / "third_party" / "voxcpm-venv")))


def _should_auto_download(env: Mapping[str, str]) -> bool:
    """venv 就绪后是否自动调用 download-voxcpm-model.py（与 .sh 行为一致）。"""
    return env.get("VOXCPM_SKIP_MODEL_DOWNLOAD", "0") != "1"


def main() -> int:
    root = repo_root()
    venv_dir = _resolve_venv_dir(os.environ, root)

    try:
        py_cmd = find_python(
            min_minor=10,
            max_minor=12,
            env_override=os.environ.get("VOXCPM_PYTHON"),
        )
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1

    try:
        version_out = subprocess.check_output(
            [*py_cmd, "--version"], text=True, stderr=subprocess.STDOUT
        ).strip()
    except subprocess.CalledProcessError:
        version_out = "(version unknown)"
    print(f"使用: {' '.join(py_cmd)} ({version_out})", file=sys.stderr)

    venv_dir.parent.mkdir(parents=True, exist_ok=True)

    if not venv_python(venv_dir).exists():
        subprocess.check_call([*py_cmd, "-m", "venv", str(venv_dir)])

    # SSL_CERT_FILE 兜底（与 .sh 行为一致）
    if "SSL_CERT_FILE" not in os.environ:
        ca = try_certifi_path([str(venv_python(venv_dir))])
        if ca is None:
            ca = try_certifi_path(py_cmd)
        if ca:
            os.environ["SSL_CERT_FILE"] = ca

    pip_install(venv_dir, ["pip"], upgrade=True)

    print(
        "正在安装 torch / voxcpm 等（体积大，可能需数分钟至十几分钟）…",
        file=sys.stderr,
    )
    pip_install(
        venv_dir,
        [
            "torch>=2.5",
            "numpy>=1.24",
            "soundfile>=0.12",
            "fastapi>=0.110",
            "uvicorn[standard]>=0.29",
            "python-multipart>=0.0.9",
            "huggingface_hub>=0.20",
            "voxcpm",
        ],
    )

    print(f"venv 就绪: {venv_dir}", file=sys.stderr)

    download_py = root / "scripts" / "download-voxcpm-model.py"
    if _should_auto_download(os.environ):
        print(
            "开始自动下载 VoxCPM2 权重到 models/VoxCPM2"
            "（体积大、耗时长；仅跳过请设 VOXCPM_SKIP_MODEL_DOWNLOAD=1）…",
            file=sys.stderr,
        )
        subprocess.check_call([sys.executable, str(download_py)])
    else:
        print(
            f"已跳过模型下载（VOXCPM_SKIP_MODEL_DOWNLOAD=1）。"
            f"需要时执行: python {download_py}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
