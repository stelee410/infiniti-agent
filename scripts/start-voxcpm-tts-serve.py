#!/usr/bin/env python3
"""
跨平台版本：启动 VoxCPM HTTP 服务。

优先使用 third_party/voxcpm-venv；若已下载 models/VoxCPM2 则自动指向本地目录。

对照 .sh：scripts/start-voxcpm-tts-serve.sh

环境变量（与 .sh 保持完全一致）：
- VOXCPM_VENV       venv 目录（默认 <repo>/third_party/voxcpm-venv）
- VOXCPM_PYTHON     当 venv 不存在时使用的 Python 解释器
- VOXCPM_MODEL_ID   模型 ID 或本地路径（未设时若 models/VoxCPM2 存在则自动指向）

用法：
    python scripts/start-voxcpm-tts-serve.py [-- voxcpm-tts-serve 参数...]
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable, Mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _winutils import repo_root, venv_python  # noqa: E402


def _resolve_venv_dir(env: Mapping[str, str], root: Path) -> Path:
    return Path(env.get("VOXCPM_VENV", str(root / "third_party" / "voxcpm-venv")))


def _resolve_default_model_id(
    env: Mapping[str, str],
    root: Path,
    local_dir_exists: Callable[[Path], bool],
) -> str | None:
    """若 env 未设置 VOXCPM_MODEL_ID 且本地 models/VoxCPM2 存在，返回该路径字符串；否则返 None。"""
    if "VOXCPM_MODEL_ID" in env:
        return None
    local = root / "models" / "VoxCPM2"
    if local_dir_exists(local):
        return str(local)
    return None


def _select_python(venv_dir: Path, env: Mapping[str, str]) -> list[str] | None:
    """选择 Python 解释器：venv 优先，其次 VOXCPM_PYTHON，最后 python3 / python（PATH 兜底）。"""
    venv_py = venv_python(venv_dir)
    if venv_py.exists():
        return [str(venv_py)]

    candidates = [env.get("VOXCPM_PYTHON"), "python3", "python"]
    for c in candidates:
        if not c:
            continue
        resolved = shutil.which(c)
        if resolved:
            return [resolved]
    return None


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    root = repo_root()
    venv_dir = _resolve_venv_dir(os.environ, root)

    py_cmd = _select_python(venv_dir, os.environ)
    if py_cmd is None:
        print(
            "未找到可用 Python 解释器（已尝试 venv / VOXCPM_PYTHON / python3 / python）",
            file=sys.stderr,
        )
        return 1

    default_model = _resolve_default_model_id(
        os.environ, root, local_dir_exists=Path.is_dir
    )
    if default_model is not None:
        os.environ["VOXCPM_MODEL_ID"] = default_model

    serve_py = root / "scripts" / "voxcpm-tts-serve.py"
    if not serve_py.exists():
        print(f"未找到 {serve_py}", file=sys.stderr)
        return 1

    try:
        return subprocess.call([*py_cmd, str(serve_py), *argv])
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
