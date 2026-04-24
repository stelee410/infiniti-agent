#!/usr/bin/env bash
# 将 MOSS ONNX 权重下载到本仓库 models/（与 MOSS 默认目录名一致）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$REPO_ROOT/models"
mkdir -p "$DEST"

PY="${DOWNLOAD_PYTHON:-python3}"
if ! "$PY" -c 'import huggingface_hub' 2>/dev/null; then
  VENV="/tmp/ia-moss-dl-$$"
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install -q --trusted-host pypi.org --trusted-host files.pythonhosted.org huggingface_hub
  PY="$VENV/bin/python"
fi
export SSL_CERT_FILE="${SSL_CERT_FILE:-$($PY -c 'import certifi; print(certifi.where())' 2>/dev/null || true)}"

"$PY" <<PY
from huggingface_hub import snapshot_download
from pathlib import Path
root = Path("$DEST")
for repo, sub in [
    ("OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX", "MOSS-TTS-Nano-100M-ONNX"),
    ("OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX", "MOSS-Audio-Tokenizer-Nano-ONNX"),
]:
    d = root / sub
    print("snapshot_download", repo, "->", d)
    snapshot_download(repo_id=repo, local_dir=str(d))
print("done ->", root)
PY

mkdir -p "$DEST/moss-prompt"
if [[ ! -f "$DEST/moss-prompt/zh_1.wav" ]]; then
  curl -fsSL -o "$DEST/moss-prompt/zh_1.wav" \
    "https://raw.githubusercontent.com/OpenMOSS/MOSS-TTS-Nano/main/assets/audio/zh_1.wav"
fi
echo "参考音: $DEST/moss-prompt/zh_1.wav"
