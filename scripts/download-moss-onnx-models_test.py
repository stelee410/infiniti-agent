#!/usr/bin/env python3
"""单元测试：scripts/download-moss-onnx-models.py（含连字符，importlib 加载）"""
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


class TestDownloadMossOnnxModels(unittest.TestCase):
    module: ModuleType

    @classmethod
    def setUpClass(cls) -> None:
        cls.module = _load_script("download-moss-onnx-models.py")

    def test_module_loads(self) -> None:
        self.assertIsNotNone(self.module)

    def test_main_callable(self) -> None:
        self.assertTrue(callable(getattr(self.module, "main", None)))

    def test_resolve_dest_returns_repo_models(self) -> None:
        result = self.module._resolve_dest(Path("/repo"))
        self.assertEqual(result, Path("/repo") / "models")

    def test_get_repos_returns_two_pairs(self) -> None:
        repos = self.module._get_repos()
        self.assertEqual(len(repos), 2)
        # 验证 repo_id 与子目录名（与 .sh 保持一致）
        repo_ids = {r[0] for r in repos}
        sub_dirs = {r[1] for r in repos}
        self.assertIn("OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX", repo_ids)
        self.assertIn("OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX", repo_ids)
        self.assertIn("MOSS-TTS-Nano-100M-ONNX", sub_dirs)
        self.assertIn("MOSS-Audio-Tokenizer-Nano-ONNX", sub_dirs)

    def test_prompt_audio_url_https(self) -> None:
        url = self.module._prompt_audio_url()
        self.assertTrue(url.startswith("https://"))
        self.assertIn("zh_1.wav", url)


if __name__ == "__main__":
    unittest.main(verbosity=2)
