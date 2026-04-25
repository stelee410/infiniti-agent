#!/usr/bin/env bash
# 将 openbmb/VoxCPM2 权重下载到 ./models/VoxCPM2（与 start-voxcpm-tts-serve.sh 默认 VOXCPM_MODEL_ID 一致）
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export DEST="${VOXCPM_MODEL_DIR:-$REPO_ROOT/models/VoxCPM2}"
export REPO_ID="${VOXCPM_HF_REPO:-openbmb/VoxCPM2}"

VENV_DIR="${VOXCPM_VENV:-$REPO_ROOT/third_party/voxcpm-venv}"
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  echo "未找到 $VENV_DIR，请先运行: $REPO_ROOT/scripts/setup-voxcpm-venv.sh" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
echo "下载 $REPO_ID -> $DEST （体积较大，请耐心等待）…" >&2
"$VENV_DIR/bin/python" -c "
import os
from huggingface_hub import snapshot_download
dest = os.environ['DEST']
repo = os.environ['REPO_ID']
snapshot_download(repo_id=repo, local_dir=dest, max_workers=4)
print('完成:', dest)
"
echo "模型目录: $DEST" >&2
