#!/usr/bin/env bash
# 启动 MOSS-TTS-Nano ONNX HTTP 服务（默认 127.0.0.1:18083），供 infiniti-agent config.tts.provider=moss_tts_nano 使用。
# 需先运行: ./scripts/setup-moss-tts-onnx-venv.sh
# 模型目录: 仓库根下 models/（含 MOSS-TTS-Nano-100M-ONNX 与 MOSS-Audio-Tokenizer-Nano-ONNX）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MOSS_HOME="${MOSS_TTS_NANO_HOME:-$REPO_ROOT/third_party/MOSS-TTS-Nano}"
MODEL_DIR="${MOSS_ONNX_MODEL_DIR:-$REPO_ROOT/models}"

export MOSS_TTS_SKIP_WETEXT="${MOSS_TTS_SKIP_WETEXT:-1}"

if [[ ! -x "$MOSS_HOME/.venv/bin/moss-tts-nano" ]]; then
  echo "未找到 $MOSS_HOME/.venv ，请先执行: $REPO_ROOT/scripts/setup-moss-tts-onnx-venv.sh" >&2
  exit 1
fi

if [[ ! -d "$MODEL_DIR/MOSS-TTS-Nano-100M-ONNX" || ! -d "$MODEL_DIR/MOSS-Audio-Tokenizer-Nano-ONNX" ]]; then
  echo "未找到 ONNX 模型目录，请用 huggingface_hub 下载到 $MODEL_DIR ，见 scripts/download-moss-onnx-models.sh" >&2
  exit 1
fi

cd "$MOSS_HOME"
exec .venv/bin/moss-tts-nano serve --backend onnx --onnx-model-dir "$MODEL_DIR" --host 127.0.0.1 --port "${MOSS_TTS_PORT:-18083}"
