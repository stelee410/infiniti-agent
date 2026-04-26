import type { LoadedSkill } from './loader.js'

export const BUILTIN_SKILLS: LoadedSkill[] = [
  {
    id: 'snap',
    title: 'Snap Photo',
    path: 'builtin:snap',
    body: [
      '当用户想让你生成照片、合照、自拍感图片、把用户/你们放进某个场景，或用自然语言说“拍一张/生成一张/来张图”时，优先使用 `snap_photo` 工具。',
      '',
      '使用方式：',
      '- 从用户语境中整理出自然、具体的 `prompt`。',
      '- 调用 `snap_photo` 后，不要等待图片完成；用普通聊天语气告诉用户你已经在后台生成，完成后会放进“你的邮箱”，小信封会亮起。',
      '- 不要在回复中暴露内部 job id，除非用户明确询问。',
      '- 如果用户已经通过相机按钮附带了视觉快照，正常对话链路会携带它；`snap_photo` 仍只需要 `prompt`。',
    ].join('\n'),
  },
]
