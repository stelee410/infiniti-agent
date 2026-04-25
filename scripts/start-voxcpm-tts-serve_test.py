#!/usr/bin/env python3
"""单元测试：scripts/start-voxcpm-tts-serve.py（含连字符，importlib 加载）"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from types import ModuleType

SCRIPTS_DIR = Path(__file__).resolve().parent


def _load_script(name: str) -> ModuleType:
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


class TestStartVoxcpmTtsServe(unittest.TestCase):
    module: ModuleType

    @classmethod
    def setUpClass(cls) -> None:
        cls.module = _load_script("start-voxcpm-tts-serve.py")

    def test_module_loads(self) -> None:
        self.assertIsNotNone(self.module)

    def test_main_callable(self) -> None:
        self.assertTrue(callable(getattr(self.module, "main", None)))

    def test_resolve_venv_dir_uses_env_override(self) -> None:
        env = {"VOXCPM_VENV": "/custom/voxcpm-venv"}
        result = self.module._resolve_venv_dir(env, Path("/repo"))
        self.assertEqual(result, Path("/custom/voxcpm-venv"))

    def test_resolve_venv_dir_falls_back_to_default(self) -> None:
        result = self.module._resolve_venv_dir({}, Path("/repo"))
        self.assertEqual(result, Path("/repo") / "third_party" / "voxcpm-venv")

    def test_resolve_default_model_id_when_local_dir_exists(self) -> None:
        # 模拟「本地 models/VoxCPM2 存在」情况，预期返回该路径
        local = Path("/repo") / "models" / "VoxCPM2"
        result = self.module._resolve_default_model_id(
            env={},
            root=Path("/repo"),
            local_dir_exists=lambda p: p == local,
        )
        self.assertEqual(result, str(local))

    def test_resolve_default_model_id_returns_none_when_dir_missing(self) -> None:
        result = self.module._resolve_default_model_id(
            env={},
            root=Path("/repo"),
            local_dir_exists=lambda p: False,
        )
        self.assertIsNone(result)

    def test_resolve_default_model_id_respects_existing_env(self) -> None:
        # 已设置 VOXCPM_MODEL_ID 时不覆盖（返回 None 表示无需修改 env）
        result = self.module._resolve_default_model_id(
            env={"VOXCPM_MODEL_ID": "user/preset"},
            root=Path("/repo"),
            local_dir_exists=lambda p: True,
        )
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
