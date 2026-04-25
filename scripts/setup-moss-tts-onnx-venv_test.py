#!/usr/bin/env python3
"""单元测试：scripts/setup-moss-tts-onnx-venv.py（含连字符，importlib 加载）"""
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


# 用于 patch 测试的样本文本（模拟 app_onnx.py 中关键片段）
ORIGINAL_APP_SNIPPET = """    logging.basicConfig(
        format="...",
        level=logging.INFO,
    )

    text_normalizer_manager = WeTextProcessingManager()
    text_normalizer_manager.start()
    output_dir = Path(args.output_dir).expanduser().resolve()
"""

PATCHED_APP_SNIPPET = """    logging.basicConfig(
        format="...",
        level=logging.INFO,
    )

    # 无 OpenFst / WeTextProcessing 时（常见 macOS 仅 pip 环境）：跳过 tn 依赖，由客户端请求里关闭 enable_text_normalization。
    skip_wetext = os.environ.get("MOSS_TTS_SKIP_WETEXT", "").strip().lower() in ("1", "true", "yes")
    if skip_wetext:
        logging.warning("MOSS_TTS_SKIP_WETEXT: WeTextProcessing disabled (no Chinese TN graphs).")
        text_normalizer_manager = None
    else:
        text_normalizer_manager = WeTextProcessingManager()
        text_normalizer_manager.start()
    output_dir = Path(args.output_dir).expanduser().resolve()
"""


class TestSetupMossOnnxVenv(unittest.TestCase):
    module: ModuleType

    @classmethod
    def setUpClass(cls) -> None:
        cls.module = _load_script("setup-moss-tts-onnx-venv.py")

    def test_module_loads(self) -> None:
        self.assertIsNotNone(self.module)

    def test_main_callable(self) -> None:
        self.assertTrue(callable(getattr(self.module, "main", None)))

    def test_resolve_moss_home_uses_env_override(self) -> None:
        env = {"MOSS_TTS_NANO_HOME": "/custom/moss"}
        result = self.module._resolve_moss_home(env, Path("/repo"))
        self.assertEqual(result, Path("/custom/moss"))

    def test_resolve_moss_home_falls_back_to_default(self) -> None:
        result = self.module._resolve_moss_home({}, Path("/repo"))
        self.assertEqual(result, Path("/repo") / "third_party" / "MOSS-TTS-Nano")

    def test_is_patch_already_applied_true(self) -> None:
        self.assertTrue(self.module._is_patch_already_applied(PATCHED_APP_SNIPPET))

    def test_is_patch_already_applied_false(self) -> None:
        self.assertFalse(self.module._is_patch_already_applied(ORIGINAL_APP_SNIPPET))

    def test_apply_skip_wetext_patch_transforms_correctly(self) -> None:
        result = self.module._apply_skip_wetext_patch(ORIGINAL_APP_SNIPPET)
        self.assertEqual(result, PATCHED_APP_SNIPPET)

    def test_apply_skip_wetext_patch_idempotent(self) -> None:
        # 已应用的内容再次调用应等价（marker 检测在 _is_patch_already_applied 处理）
        # 但 _apply 不带 marker 检测，应在 main() 调用前先用 _is_patch_already_applied 判断
        # 因此此函数对已应用文本不应被调用；此用例验证 OLD 块不存在时抛 RuntimeError
        with self.assertRaises(RuntimeError):
            self.module._apply_skip_wetext_patch(PATCHED_APP_SNIPPET)


if __name__ == "__main__":
    unittest.main(verbosity=2)
