#!/usr/bin/env python3
"""单元测试：scripts/download-voxcpm-model.py（含连字符，importlib 加载）"""
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


class TestDownloadVoxcpmModel(unittest.TestCase):
    module: ModuleType

    @classmethod
    def setUpClass(cls) -> None:
        cls.module = _load_script("download-voxcpm-model.py")

    def test_module_loads(self) -> None:
        self.assertIsNotNone(self.module)

    def test_main_callable(self) -> None:
        self.assertTrue(callable(getattr(self.module, "main", None)))

    def test_resolve_dest_uses_env_override(self) -> None:
        env = {"VOXCPM_MODEL_DIR": "/custom/models/voxcpm"}
        result = self.module._resolve_dest(env, Path("/repo"))
        self.assertEqual(result, Path("/custom/models/voxcpm"))

    def test_resolve_dest_falls_back_to_default(self) -> None:
        result = self.module._resolve_dest({}, Path("/repo"))
        self.assertEqual(result, Path("/repo") / "models" / "VoxCPM2")

    def test_resolve_repo_id_uses_env_override(self) -> None:
        self.assertEqual(
            self.module._resolve_repo_id({"VOXCPM_HF_REPO": "foo/bar"}),
            "foo/bar",
        )

    def test_resolve_repo_id_falls_back_to_default(self) -> None:
        self.assertEqual(self.module._resolve_repo_id({}), "openbmb/VoxCPM2")


if __name__ == "__main__":
    unittest.main(verbosity=2)
