#!/usr/bin/env python3
"""
跨平台工具函数集合，被 scripts/*.py 共享。

设计原则：
- 仅依赖 Python 标准库。
- 跨平台分支用显式参数注入（_is_windows）便于单测。
- 函数返回值优先使用 pathlib.Path / list[str]（命令前缀），不返回拼接好的 shell 字符串。
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

__all__ = [
    "repo_root",
    "is_windows",
    "venv_python",
    "venv_executable",
    "parse_python_version",
    "find_python",
    "try_certifi_path",
    "pip_install",
]


def repo_root() -> Path:
    """返回 scripts/ 的父目录绝对路径（即仓库根 D:\\infiniti-agent）。"""
    return Path(__file__).resolve().parent.parent


def is_windows() -> bool:
    """当前是否在 Windows 上运行。"""
    return os.name == "nt"


def venv_python(venv_dir: Path, *, _is_windows: bool | None = None) -> Path:
    """返回 venv 内 Python 解释器路径。

    Windows: <venv>/Scripts/python.exe
    其他:    <venv>/bin/python
    """
    win = is_windows() if _is_windows is None else _is_windows
    if win:
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def venv_executable(
    venv_dir: Path, name: str, *, _is_windows: bool | None = None
) -> Path:
    """返回 venv 内任意可执行文件路径（自动追加 .exe / 选择 Scripts vs bin）。"""
    win = is_windows() if _is_windows is None else _is_windows
    if win:
        return venv_dir / "Scripts" / f"{name}.exe"
    return venv_dir / "bin" / name


_VERSION_RE = re.compile(r"Python\s+(\d+)\.(\d+)(?:\.(\d+))?")


def parse_python_version(text: str) -> tuple[int, int] | None:
    """从 `python --version` 输出解析 (major, minor)；无法解析返 None。"""
    if not text:
        return None
    match = _VERSION_RE.search(text)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def _try_python_command(cmd: list[str]) -> tuple[int, int] | None:
    """尝试用 `cmd --version` 获取版本号；失败/超时返 None。"""
    try:
        result = subprocess.run(
            [*cmd, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None
    # Python 2 把 --version 写到 stderr；Python 3 写到 stdout
    output = (result.stdout or "") + (result.stderr or "")
    return parse_python_version(output)


def find_python(
    min_minor: int,
    max_minor: int,
    env_override: str | None = None,
) -> list[str]:
    """探测可用 Python 解释器，返回命令前缀（list 形式，便于 subprocess 调用）。

    搜索顺序：
    1. env_override（如 VOXCPM_PYTHON 指定的路径）
    2. 候选名：python3.{max..min}, python3, python
    3. Windows 上额外尝试 py launcher：py -3.{max..min}

    要求版本在 [3.{min_minor}, 3.{max_minor}] 闭区间。
    全部失败抛 RuntimeError 含中文提示。
    """
    candidates: list[list[str]] = []

    if env_override:
        candidates.append([env_override])

    for minor in range(max_minor, min_minor - 1, -1):
        candidates.append([f"python3.{minor}"])

    candidates.append(["python3"])
    candidates.append(["python"])

    if is_windows():
        py_launcher = shutil.which("py")
        if py_launcher:
            for minor in range(max_minor, min_minor - 1, -1):
                candidates.append([py_launcher, f"-3.{minor}"])

    for cmd in candidates:
        version = _try_python_command(cmd)
        if version is None:
            continue
        major, minor = version
        if major == 3 and min_minor <= minor <= max_minor:
            return cmd

    raise RuntimeError(
        f"未找到 Python 3.{min_minor}~3.{max_minor}。\n"
        f"  - macOS:   brew install python@3.11\n"
        f"  - Windows: 从 https://www.python.org/downloads/ 安装 3.11，"
        f"或设置环境变量 VOXCPM_PYTHON / MOSS_PYTHON 指向已安装的解释器。"
    )


def try_certifi_path(py_cmd: list[str]) -> str | None:
    """用给定 Python 探测 certifi CA 路径，失败返 None（不抛）。"""
    try:
        result = subprocess.run(
            [*py_cmd, "-c", "import certifi; print(certifi.where())"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    path = result.stdout.strip()
    return path or None


def pip_install(
    venv_dir: Path,
    packages: list[str],
    *,
    upgrade: bool = False,
) -> None:
    """用 venv 内 pip 安装包，trusted-host 与原 .sh 一致。

    失败抛 subprocess.CalledProcessError（不 catch，让 traceback 显示）。
    """
    py = venv_python(venv_dir)
    cmd: list[str] = [
        str(py), "-m", "pip", "install",
        "--trusted-host", "pypi.org",
        "--trusted-host", "files.pythonhosted.org",
    ]
    if upgrade:
        cmd.append("--upgrade")
    cmd.extend(packages)
    subprocess.check_call(cmd)
