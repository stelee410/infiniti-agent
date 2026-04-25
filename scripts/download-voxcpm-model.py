#!/usr/bin/env python3
"""
跨平台版本：将 openbmb/VoxCPM2 权重下载到 ./models/VoxCPM2。

对照 .sh：scripts/download-voxcpm-model.sh

环境变量（与 .sh 保持完全一致）：
- VOXCPM_MODEL_DIR  目标目录（默认 <repo>/models/VoxCPM2）
- VOXCPM_HF_REPO    HuggingFace repo（默认 openbmb/VoxCPM2）
- VOXCPM_VENV       venv 目录（默认 <repo>/third_party/voxcpm-venv）

用法：
    python scripts/download-voxcpm-model.py
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _winutils import repo_root, venv_python  # noqa: E402


def _resolve_dest(env: Mapping[str, str], root: Path) -> Path:
    return Path(env.get("VOXCPM_MODEL_DIR", str(root / "models" / "VoxCPM2")))


def _resolve_repo_id(env: Mapping[str, str]) -> str:
    return env.get("VOXCPM_HF_REPO", "openbmb/VoxCPM2")


def _resolve_venv_dir(env: Mapping[str, str], root: Path) -> Path:
    return Path(env.get("VOXCPM_VENV", str(root / "third_party" / "voxcpm-venv")))


_DOWNLOAD_CODE = """\
import os
from huggingface_hub import snapshot_download
dest = os.environ['DEST']
repo = os.environ['REPO_ID']
snapshot_download(repo_id=repo, local_dir=dest, max_workers=4)
print('完成:', dest)
"""


def main() -> int:
    root = repo_root()
    dest = _resolve_dest(os.environ, root)
    repo_id = _resolve_repo_id(os.environ)
    venv_dir = _resolve_venv_dir(os.environ, root)
    py = venv_python(venv_dir)

    if not py.exists():
        print(
            f"未找到 {venv_dir}，请先运行: python {root / 'scripts' / 'setup-voxcpm-venv.py'}",
            file=sys.stderr,
        )
        return 1

    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"下载 {repo_id} -> {dest} （体积较大，请耐心等待）…", file=sys.stderr)

    env = {**os.environ, "DEST": str(dest), "REPO_ID": repo_id}
    subprocess.check_call([str(py), "-c", _DOWNLOAD_CODE], env=env)

    print(f"模型目录: {dest}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
