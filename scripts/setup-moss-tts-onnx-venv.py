#!/usr/bin/env python3
"""
跨平台版本：在 third_party/MOSS-TTS-Nano 下创建 Python 3.11 venv，安装 ONNX serve 所需依赖。

要求：Python 3.11（MOSS 严格要求；非 3.11 请设 MOSS_PYTHON）。
对照 .sh：scripts/setup-moss-tts-onnx-venv.sh

环境变量（与 .sh 保持完全一致）：
- MOSS_TTS_NANO_HOME   MOSS 源码目录（默认 <repo>/third_party/MOSS-TTS-Nano）
- MOSS_PYTHON          指定 Python 3.11 解释器
- SSL_CERT_FILE        CA 证书；未设时用 certifi.where() 兜底

用法：
    python scripts/setup-moss-tts-onnx-venv.py
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

PATCH_MARKER = "MOSS_TTS_SKIP_WETEXT"

_PATCH_OLD = """    text_normalizer_manager = WeTextProcessingManager()
    text_normalizer_manager.start()"""

_PATCH_NEW = """    # 无 OpenFst / WeTextProcessing 时（常见 macOS 仅 pip 环境）：跳过 tn 依赖，由客户端请求里关闭 enable_text_normalization。
    skip_wetext = os.environ.get("MOSS_TTS_SKIP_WETEXT", "").strip().lower() in ("1", "true", "yes")
    if skip_wetext:
        logging.warning("MOSS_TTS_SKIP_WETEXT: WeTextProcessing disabled (no Chinese TN graphs).")
        text_normalizer_manager = None
    else:
        text_normalizer_manager = WeTextProcessingManager()
        text_normalizer_manager.start()"""


def _resolve_moss_home(env: Mapping[str, str], root: Path) -> Path:
    """MOSS_TTS_NANO_HOME 优先，否则 root/third_party/MOSS-TTS-Nano。"""
    return Path(
        env.get("MOSS_TTS_NANO_HOME", str(root / "third_party" / "MOSS-TTS-Nano"))
    )


def _is_patch_already_applied(content: str) -> bool:
    """检查 app_onnx.py 文本是否含 MOSS_TTS_SKIP_WETEXT marker。"""
    return PATCH_MARKER in content


def _apply_skip_wetext_patch(content: str) -> str:
    """精准块替换。找不到 OLD 块抛 RuntimeError。

    与 scripts/patches/moss-onnx-skip-wetext.patch 1:1 对应。
    """
    if _PATCH_OLD not in content:
        raise RuntimeError(
            "未找到目标块（OLD），patch 不能应用。"
            "可能 MOSS-TTS-Nano 上游已变更 app_onnx.py，请手动核对。"
        )
    return content.replace(_PATCH_OLD, _PATCH_NEW, 1)


def main() -> int:
    root = repo_root()
    moss_home = _resolve_moss_home(os.environ, root)
    patch_path = root / "scripts" / "patches" / "moss-onnx-skip-wetext.patch"

    # 1. Clone repo if missing
    if not (moss_home / ".git").exists():
        moss_home.parent.mkdir(parents=True, exist_ok=True)
        print(f"克隆 MOSS-TTS-Nano 到 {moss_home} …", file=sys.stderr)
        subprocess.check_call(
            [
                "git", "clone", "--depth", "1",
                "https://github.com/OpenMOSS/MOSS-TTS-Nano.git",
                str(moss_home),
            ]
        )

    # 2. Apply skip_wetext patch (idempotent via marker)
    app_onnx = moss_home / "app_onnx.py"
    if app_onnx.exists():
        content = app_onnx.read_text(encoding="utf-8")
        if _is_patch_already_applied(content):
            print(f"patch 已应用（marker {PATCH_MARKER} 存在），跳过。", file=sys.stderr)
        else:
            try:
                new_content = _apply_skip_wetext_patch(content)
                app_onnx.write_text(new_content, encoding="utf-8")
                print(f"已应用 patch: {patch_path.name}", file=sys.stderr)
            except RuntimeError as e:
                print(f"补丁应用失败：{e}；若已手动改过 app_onnx.py 可忽略。", file=sys.stderr)
    else:
        print(f"未找到 {app_onnx}，跳过 patch 步骤。", file=sys.stderr)

    # 3. Find Python 3.11 (MOSS 严格要求)
    try:
        py_cmd = find_python(
            min_minor=11,
            max_minor=11,
            env_override=os.environ.get("MOSS_PYTHON"),
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

    # 4. Create venv at MOSS_HOME/.venv
    venv_dir = moss_home / ".venv"
    if not venv_python(venv_dir).exists():
        subprocess.check_call([*py_cmd, "-m", "venv", str(venv_dir)])

    # 5. SSL_CERT_FILE 兜底
    if "SSL_CERT_FILE" not in os.environ:
        ca = try_certifi_path([str(venv_python(venv_dir))])
        if ca is None:
            ca = try_certifi_path(py_cmd)
        if ca:
            os.environ["SSL_CERT_FILE"] = ca

    # 6. Upgrade pip
    pip_install(venv_dir, ["pip"], upgrade=True)

    # 7. Install dependencies (与 .sh 列表完全一致)
    print("安装 MOSS-TTS-Nano ONNX 依赖（torch/torchaudio/onnxruntime/transformers 等） …", file=sys.stderr)
    pip_install(
        venv_dir,
        [
            "numpy>=1.24",
            "fastapi>=0.110",
            "python-multipart>=0.0.9",
            "sentencepiece>=0.1.99",
            "uvicorn>=0.29",
            "onnxruntime>=1.20",
            "torch==2.7.0",
            "torchaudio==2.7.0",
            "transformers==4.57.1",
            "soundfile>=0.12",
        ],
    )

    # 8. Install MOSS itself in editable mode (no deps)
    print("安装 MOSS-TTS-Nano（editable, --no-deps）…", file=sys.stderr)
    py = venv_python(venv_dir)
    subprocess.check_call(
        [
            str(py), "-m", "pip", "install",
            "--trusted-host", "pypi.org",
            "--trusted-host", "files.pythonhosted.org",
            "-e", ".", "--no-deps",
        ],
        cwd=str(moss_home),
    )

    print(
        f"完成。启动服务: python {root / 'scripts' / 'start-moss-tts-onnx.py'}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
