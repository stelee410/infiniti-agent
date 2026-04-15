/**
 * Live2D / 占位圆 与底部 HTML（字幕气泡 + 控制条）的垂直关系。
 * 改完保存后 Vite dev 会热更；生产环境需重新 `npm run build -w infiniti-agent-liveui`。
 */
export const FIGURE_LAYOUT = {
  /**
   * 在「站台」高度之外再减的间隙 = round(屏高 * 该值)，脚底目标略上移。
   * 一般可保持 0；想脚离气泡顶稍远一点可略增。
   */
  footGapScreenFraction: 0,

  /** 对齐包围盒后再整体下移，抵消模型纹理底部透明区；与 footNudgeScreenFraction 取较小 */
  footNudgeMaxPx: 18,
  footNudgeScreenFraction: 0.015,

  /**
   * 脚底「踩在」哪条线上：相对**字幕气泡顶**（气泡 `.visible` 时）或**控制条顶**（无气泡时），
   * 包围盒底边可比该线再低多少像素（略陷入气泡顶边，像站在对话框上）。
   * 纯对齐、不陷入设 0；略陷入设 2～6。
   */
  footStandOnOverlapPx: 4,

  /**
   * 包围盒底边最多只能到「控制条上沿 − 该像素」，避免鞋踩进输入区。
   * 气泡可见时：脚站在气泡上，但不能压过控制条。
   */
  footClearOfControlBarPx: 10,

  /**
   * 多行输入增高时控制条整体上移，soleCeiling 会过小导致人物被「顶」到屏外。
   * 用「站台」参考线的最小屏高比例（距画布顶），低于此值则按此值计算，保证人物仍在可视区内。
   */
  minPlatformTopScreenFraction: 0.36,

  /** 模型最大宽度占画布宽的比例（水平留白） */
  modelWidthScreenFraction: 0.92,

  /** 用「从画布顶到脚底可用高度」算缩放时的系数，略小于 1 留一点顶边余量 */
  modelHeightScaleFraction: 0.99,

  /** 无底部 dock 时，用于估算的屏高比例（兜底） */
  fallbackDockReserveScreenFraction: 0.24,
} as const
