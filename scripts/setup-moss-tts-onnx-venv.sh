#!/usr/bin/env bash
# 在 third_party/MOSS-TTS-Nano 下创建 Python 3.11 venv，安装 ONNX serve 所需依赖（不经 requirements.txt，避免 pynini 源码编译）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MOSS_HOME="${MOSS_TTS_NANO_HOME:-$REPO_ROOT/third_party/MOSS-TTS-Nano}"
PATCH="$REPO_ROOT/scripts/patches/moss-onnx-skip-wetext.patch"

if [[ ! -d "$MOSS_HOME/.git" ]]; then
  mkdir -p "$(dirname "$MOSS_HOME")"
  git clone --depth 1 https://github.com/OpenMOSS/MOSS-TTS-Nano.git "$MOSS_HOME"
fi

if ! grep -q 'MOSS_TTS_SKIP_WETEXT' "$MOSS_HOME/app_onnx.py"; then
  patch -d "$MOSS_HOME" -p1 --forward <"$PATCH" || {
    echo "补丁应用失败；若已手动改过 app_onnx.py 可忽略。" >&2
  }
fi

PY="${MOSS_PYTHON:-python3.11}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "需要 Python 3.11（Homebrew: brew install python@3.11），或设置 MOSS_PYTHON 指向 3.11 可执行文件。" >&2
  exit 1
fi

cd "$MOSS_HOME"
if [[ ! -x .venv/bin/python ]]; then
  "$PY" -m venv .venv
fi
export SSL_CERT_FILE="${SSL_CERT_FILE:-$("$PY" -c 'import certifi; print(certifi.where())' 2>/dev/null || true)}"
.venv/bin/pip install -q --upgrade pip --trusted-host pypi.org --trusted-host files.pythonhosted.org
.venv/bin/pip install -q --trusted-host pypi.org --trusted-host files.pythonhosted.org \
  'numpy>=1.24' 'fastapi>=0.110' 'python-multipart>=0.0.9' 'sentencepiece>=0.1.99' \
  'uvicorn>=0.29' 'onnxruntime>=1.20' 'torch==2.7.0' 'torchaudio==2.7.0' 'transformers==4.57.1' \
  'soundfile>=0.12'
# soundfile：torchaudio.load 读参考 wav 所需后端（否则报 Couldn't find appropriate backend）
.venv/bin/pip install -q --trusted-host pypi.org --trusted-host files.pythonhosted.org -e . --no-deps

echo "完成。启动服务: $REPO_ROOT/scripts/start-moss-tts-onnx.sh"
