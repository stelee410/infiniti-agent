#!/usr/bin/env bash
# 启动 VoxCPM HTTP 服务。优先使用 third_party/voxcpm-venv；若已下载 models/VoxCPM2 则自动指向本地目录。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VENV_DIR="${VOXCPM_VENV:-$ROOT/third_party/voxcpm-venv}"
if [[ -x "$VENV_DIR/bin/python" ]]; then
  PY="$VENV_DIR/bin/python"
else
  PY="${VOXCPM_PYTHON:-python3}"
fi

if [[ -z "${VOXCPM_MODEL_ID:-}" && -d "$ROOT/models/VoxCPM2" ]]; then
  export VOXCPM_MODEL_ID="$ROOT/models/VoxCPM2"
fi

# Apple Silicon (M 系列) + PyTorch MPS：缓解显存压力、避免与系统图形抢占
# 未显式设置时设 0.0（可覆盖）；详见 PyTorch 文档 notes/mps
if [[ -z "${PYTORCH_MPS_HIGH_WATERMARK_RATIO:-}" ]]; then
  export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0
fi

# Mac 上 VoxCPM2 的 torch.compile 仅 CUDA 有效；MPS 仍会做首句 warm-up。启动略快可设:
#   export VOXCPM_OPTIMIZE=0
exec "$PY" "$ROOT/scripts/voxcpm-tts-serve.py" "$@"
