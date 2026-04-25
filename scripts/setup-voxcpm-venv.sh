#!/usr/bin/env bash
# 在项目内 third_party/voxcpm-venv 创建独立 Python 环境，安装 VoxCPM2 HTTP 服务依赖。
# 要求：Python 3.10～3.12（VoxCPM 文档：<3.13）。可选：brew install python@3.11
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="${VOXCPM_VENV:-$REPO_ROOT/third_party/voxcpm-venv}"

PY="${VOXCPM_PYTHON:-}"
for cand in python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    ver="$("$cand" -c 'import sys as s; v=s.version_info; print("%d.%d" % (v.major, v.minor))')"
    major="${ver%%.*}"
    minor="${ver#*.}"
    if [[ "$major" -eq 3 ]] && [[ "$minor" -ge 10 ]] && [[ "$minor" -le 12 ]]; then
      PY="$cand"
      break
    fi
  fi
done

if [[ -z "$PY" ]]; then
  echo "需要 Python 3.10～3.12（VoxCPM 要求 <3.13）。可: brew install python@3.11 后设置 VOXCPM_PYTHON=/path/to/python3.11" >&2
  exit 1
fi

echo "使用: $PY ($("$PY" --version))" >&2
mkdir -p "$(dirname "$VENV_DIR")"
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  "$PY" -m venv "$VENV_DIR"
fi

if [[ -z "${SSL_CERT_FILE:-}" ]]; then
  _ca="$("$PY" -c 'import certifi; print(certifi.where())' 2>/dev/null)" || true
  [[ -n "$_ca" ]] && export SSL_CERT_FILE="$_ca"
  unset _ca
fi
"$VENV_DIR/bin/pip" install -q --upgrade pip --trusted-host pypi.org --trusted-host files.pythonhosted.org
echo "正在安装 torch / voxcpm 等（体积大，可能需数分钟至十几分钟）…" >&2
# torch：Mac 用默认 wheel；Linux CUDA 请自行按 PyTorch 官网换源安装后再 pip install voxcpm
# uvicorn[extra] 用单引号，避免 bash 把 [...] 当 glob
"$VENV_DIR/bin/pip" install --trusted-host pypi.org --trusted-host files.pythonhosted.org \
  "torch>=2.5" "numpy>=1.24" "soundfile>=0.12" "fastapi>=0.110" 'uvicorn[standard]>=0.29' \
  "python-multipart>=0.0.9" "huggingface_hub>=0.20" "voxcpm"

echo "venv 就绪: $VENV_DIR" >&2

if [[ "${VOXCPM_SKIP_MODEL_DOWNLOAD:-0}" == "1" ]]; then
  echo "已跳过模型下载（VOXCPM_SKIP_MODEL_DOWNLOAD=1）。需要时执行: $REPO_ROOT/scripts/download-voxcpm-model.sh" >&2
else
  echo "开始自动下载 VoxCPM2 权重到 models/VoxCPM2（体积大、耗时长；仅跳过请设 VOXCPM_SKIP_MODEL_DOWNLOAD=1）…" >&2
  "$SCRIPT_DIR/download-voxcpm-model.sh"
fi
