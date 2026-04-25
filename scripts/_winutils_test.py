#!/usr/bin/env python3
"""
单元测试：scripts/_winutils.py

设计原则：
- 仅测纯函数，不测 subprocess 真实调用、文件系统真实操作。
- 跨平台分支用显式参数注入（_is_windows）替代 mock，更稳健。
- 运行：python scripts/_winutils_test.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _winutils import (  # noqa: E402
    parse_python_version,
    repo_root,
    venv_executable,
    venv_python,
)


class TestVenvPython(unittest.TestCase):
    def test_venv_python_windows_path(self) -> None:
        venv = Path("/tmp/myvenv")
        result = venv_python(venv, _is_windows=True)
        self.assertEqual(result, venv / "Scripts" / "python.exe")

    def test_venv_python_posix_path(self) -> None:
        venv = Path("/tmp/myvenv")
        result = venv_python(venv, _is_windows=False)
        self.assertEqual(result, venv / "bin" / "python")


class TestVenvExecutable(unittest.TestCase):
    def test_venv_executable_appends_exe_on_windows(self) -> None:
        venv = Path("/tmp/myvenv")
        result = venv_executable(venv, "moss-tts-nano", _is_windows=True)
        self.assertEqual(result, venv / "Scripts" / "moss-tts-nano.exe")

    def test_venv_executable_no_exe_on_posix(self) -> None:
        venv = Path("/tmp/myvenv")
        result = venv_executable(venv, "moss-tts-nano", _is_windows=False)
        self.assertEqual(result, venv / "bin" / "moss-tts-nano")


class TestParsePythonVersion(unittest.TestCase):
    def test_parse_python_version_normal(self) -> None:
        self.assertEqual(parse_python_version("Python 3.11.5"), (3, 11))

    def test_parse_python_version_with_extra(self) -> None:
        self.assertEqual(parse_python_version("Python 3.10.12 (main, ...)"), (3, 10))

    def test_parse_python_version_malformed(self) -> None:
        self.assertIsNone(parse_python_version("foo"))
        self.assertIsNone(parse_python_version(""))
        self.assertIsNone(parse_python_version("Python 3"))


class TestRepoRoot(unittest.TestCase):
    def test_repo_root_is_scripts_parent(self) -> None:
        # repo_root() 应返回 scripts/ 的父目录
        expected = Path(__file__).resolve().parent.parent
        self.assertEqual(repo_root(), expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
