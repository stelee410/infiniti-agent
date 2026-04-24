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

exec "$PY" "$ROOT/scripts/voxcpm-tts-serve.py" "$@"
