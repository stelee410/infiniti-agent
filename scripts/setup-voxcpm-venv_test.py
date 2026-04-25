#!/usr/bin/env python3
"""
单元测试：scripts/setup-voxcpm-venv.py（含连字符的脚本，用 importlib 加载）

测试范围：
- 模块可加载、main 函数存在
- 抽出的纯函数 _resolve_venv_dir 在「env 给 / env 不给」两种情况下行为正确

不测：subprocess 调用、pip install 实际行为。
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from types import ModuleType

SCRIPTS_DIR = Path(__file__).resolve().parent


def _load_script(name: str) -> ModuleType:
    """加载含连字符的脚本为可测 module。"""
    file_path = SCRIPTS_DIR / name
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_").removesuffix(".py"),
        str(file_path),
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载 {file_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TestSetupVoxcpmVenv(unittest.TestCase):
    module: ModuleType

    @classmethod
    def setUpClass(cls) -> None:
        cls.module = _load_script("setup-voxcpm-venv.py")

    def test_module_loads(self) -> None:
        self.assertIsNotNone(self.module)

    def test_main_callable(self) -> None:
        self.assertTrue(hasattr(self.module, "main"))
        self.assertTrue(callable(self.module.main))

    def test_resolve_venv_dir_uses_env_override(self) -> None:
        env = {"VOXCPM_VENV": "/custom/path/voxcpm"}
        result = self.module._resolve_venv_dir(env, Path("/repo"))
        self.assertEqual(result, Path("/custom/path/voxcpm"))

    def test_resolve_venv_dir_falls_back_to_default(self) -> None:
        env: dict[str, str] = {}
        result = self.module._resolve_venv_dir(env, Path("/repo"))
        self.assertEqual(result, Path("/repo") / "third_party" / "voxcpm-venv")

    def test_should_auto_download_default_true(self) -> None:
        self.assertTrue(self.module._should_auto_download({}))

    def test_should_auto_download_skipped_when_set_to_one(self) -> None:
        self.assertFalse(
            self.module._should_auto_download({"VOXCPM_SKIP_MODEL_DOWNLOAD": "1"})
        )

    def test_should_use_cuda_torch_windows_gpu_true(self) -> None:
        self.assertTrue(self.module._should_use_cuda_torch(has_gpu=True, is_win=True))

    def test_should_use_cuda_torch_windows_no_gpu_false(self) -> None:
        self.assertFalse(self.module._should_use_cuda_torch(has_gpu=False, is_win=True))

    def test_should_use_cuda_torch_macos_gpu_false(self) -> None:
        # 即使 has_gpu=True，非 Windows 也不应启用（保持 macOS / Linux 行为不变）
        self.assertFalse(self.module._should_use_cuda_torch(has_gpu=True, is_win=False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
