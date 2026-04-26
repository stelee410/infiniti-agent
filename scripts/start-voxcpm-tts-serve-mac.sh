#!/usr/bin/env bash
# macOS / Apple Silicon 专用启动入口。
# 只设置更适合本机交互服务的默认环境变量，然后交给通用 start-voxcpm-tts-serve.sh。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 默认使用共享模型目录；仍可用 VOXCPM_MODEL_DIR / VOXCPM_MODEL_ID 覆盖。
export VOXCPM_MODEL_DIR="${VOXCPM_MODEL_DIR:-$HOME/Dev/models/VoxCPM2}"

# MPS：放宽高水位，减少 VoxCPM2 加载/推理时的显存限制误伤。
export PYTORCH_MPS_HIGH_WATERMARK_RATIO="${PYTORCH_MPS_HIGH_WATERMARK_RATIO:-0.0}"

# MPS 上 torch.compile 不带来 CUDA 上那类收益；跳过预热让服务启动更快。
export VOXCPM_OPTIMIZE="${VOXCPM_OPTIMIZE:-0}"

# 本地单服务交互场景下，限制底层线程池过度抢占，减少和 Electron/音频播放争资源。
export TOKENIZERS_PARALLELISM="${TOKENIZERS_PARALLELISM:-false}"
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"
export VECLIB_MAXIMUM_THREADS="${VECLIB_MAXIMUM_THREADS:-1}"

# 遇到个别算子 MPS 不支持时允许回退 CPU，优先保证服务可用。
export PYTORCH_ENABLE_MPS_FALLBACK="${PYTORCH_ENABLE_MPS_FALLBACK:-1}"

exec "$SCRIPT_DIR/start-voxcpm-tts-serve.sh" "$@"
