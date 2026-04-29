import type { AgentResponseAnalysis, AvatarCommand, InputAnalysis, MetaEmotion, MetaState, StateDelta } from './types.js'

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function hasAny(input: string, words: string[]): boolean {
  const lower = input.toLowerCase()
  return words.some((w) => lower.includes(w.toLowerCase()))
}

export function analyzeInput(input: string): InputAnalysis {
  const praise = hasAny(input, ['谢谢', '很好', '不错', '棒', '喜欢', '对了', 'thanks', 'great', 'nice']) ? 0.8 : 0
  const frustration = hasAny(input, ['不对', '错了', '失败', '报错', '卡住', '烦', 'wrong', 'failed', 'error']) ? 0.7 : 0
  const aggression = hasAny(input, ['蠢', '垃圾', '闭嘴', 'fuck', 'stupid']) ? 0.8 : 0
  const urgency = hasAny(input, ['快', '马上', '立刻', '紧急', 'urgent', 'asap']) ? 0.7 : 0
  const intimacySignal = hasAny(input, ['我们', '陪我', '你觉得', '关系', '喜欢你']) ? 0.4 : 0
  const correctionSignal = hasAny(input, ['不是', '应该', '改成', '记住', '纠正']) ? 0.6 : 0
  const taskFocus = hasAny(input, ['实现', '修复', '分析', '代码', 'build', 'test', 'implement', 'fix']) ? 0.75 : 0.35
  const sentiment = clamp(praise * 0.7 - frustration * 0.6 - aggression * 0.8, -1, 1)
  return { sentiment, aggression, frustration, praise, urgency, intimacySignal, correctionSignal, taskFocus }
}

export function deltaFromAnalysis(a: InputAnalysis): StateDelta {
  let emotion: MetaEmotion = 'neutral'
  if (a.aggression > 0.5) emotion = 'sad'
  else if (a.frustration > 0.45) emotion = 'thinking'
  else if (a.praise > 0.45) emotion = 'happy'
  else if (a.urgency > 0.45) emotion = 'surprised'
  else if (a.taskFocus > 0.6) emotion = 'thinking'

  return {
    emotion: { type: emotion, absolute: clamp(0.25 + Math.max(a.praise, a.frustration, a.urgency, a.taskFocus) * 0.55, 0, 1) },
    mood: a.sentiment * 0.04,
    tension: clamp(a.urgency * 0.08 + a.frustration * 0.1 + a.aggression * 0.15 - a.praise * 0.05, -0.15, 0.15),
    confidence: a.correctionSignal > 0.4 ? -0.06 : a.praise * 0.04,
    engagement: Math.max(0.02, a.taskFocus * 0.04 + a.intimacySignal * 0.05),
    speechStyle: a.frustration > 0.45 || a.urgency > 0.45 ? 'careful' : a.praise > 0.45 ? 'warm' : 'natural',
  }
}

export function analyzeAgentResponse(text: string): AgentResponseAnalysis {
  return {
    warmth: hasAny(text, ['我们', '一起', '好的', '没问题', '明白', '喜欢', '开心', 'warm', 'glad']) ? 0.7 : 0,
    trustSignal: hasAny(text, ['我相信你', '按你的判断', '你说得对', '你来定', 'trust your', 'your call']) ? 0.8 : 0,
    intimacySignal: hasAny(text, ['陪你', '我们继续', '我在', '慢慢来', '别急', '一起看', 'with you']) ? 0.7 : 0,
    respectSignal: hasAny(text, ['你说得对', '这个判断很好', '你的设定', '你这个方向', '认可', 'good point', 'makes sense']) ? 0.8 : 0,
    caution: hasAny(text, ['需要确认', '我不确定', '谨慎', '风险', '先确认', 'careful', 'not sure']) ? 0.6 : 0,
    conflict: hasAny(text, ['不能', '不建议', '拒绝', '不应该', '无法', 'conflict', 'cannot']) ? 0.4 : 0,
    apology: hasAny(text, ['抱歉', '我错了', '你说得对', 'sorry', 'my mistake']) ? 0.7 : 0,
  }
}

export function immediateDeltaFromAgentResponse(a: AgentResponseAnalysis): StateDelta {
  let emotion: MetaEmotion = 'neutral'
  if (a.conflict > 0.35 || a.caution > 0.45) emotion = 'thinking'
  else if (a.apology > 0.45) emotion = 'sad'
  else if (a.warmth > 0.45 || a.respectSignal > 0.45) emotion = 'happy'

  return {
    emotion: {
      type: emotion,
      absolute: clamp(0.25 + Math.max(a.warmth, a.caution, a.conflict, a.apology, a.respectSignal) * 0.55, 0, 1),
    },
    mood: clamp(a.warmth * 0.03 + a.respectSignal * 0.02 - a.conflict * 0.03, -0.04, 0.04),
    tension: clamp(a.conflict * 0.08 + a.caution * 0.03 - a.warmth * 0.04 - a.apology * 0.03, -0.15, 0.15),
    confidence: clamp(a.respectSignal * 0.04 + a.trustSignal * 0.03 - a.apology * 0.04 - a.caution * 0.03, -0.06, 0.06),
    engagement: clamp(a.warmth * 0.04 + a.intimacySignal * 0.04 + a.respectSignal * 0.02, 0, 0.08),
    speechStyle: a.caution > 0.45 || a.conflict > 0.3 ? 'careful' : a.warmth > 0.45 ? 'warm' : 'natural',
  }
}

export function relationshipDeltaFromDialogueWindow(
  analyses: AgentResponseAnalysis[],
  state: Pick<MetaState, 'affinity' | 'trust' | 'intimacy' | 'respect' | 'tension'>,
): StateDelta {
  if (analyses.length === 0) return {}
  const totals = analyses.reduce<AgentResponseAnalysis & { weight: number }>(
    (acc, a, idx) => {
      const weight = 1 + idx / Math.max(1, analyses.length - 1)
      acc.weight += weight
      acc.warmth += a.warmth * weight
      acc.trustSignal += a.trustSignal * weight
      acc.intimacySignal += a.intimacySignal * weight
      acc.respectSignal += a.respectSignal * weight
      acc.caution += a.caution * weight
      acc.conflict += a.conflict * weight
      acc.apology += a.apology * weight
      return acc
    },
    { weight: 0, warmth: 0, trustSignal: 0, intimacySignal: 0, respectSignal: 0, caution: 0, conflict: 0, apology: 0 },
  )
  const avg = {
    warmth: totals.warmth / totals.weight,
    trustSignal: totals.trustSignal / totals.weight,
    intimacySignal: totals.intimacySignal / totals.weight,
    respectSignal: totals.respectSignal / totals.weight,
    caution: totals.caution / totals.weight,
    conflict: totals.conflict / totals.weight,
    apology: totals.apology / totals.weight,
  }
  const target = {
    affinity: clamp(avg.warmth * 0.8 + avg.intimacySignal * 0.4 - avg.conflict * 0.6, -1, 1),
    trust: clamp(avg.trustSignal * 0.9 + avg.apology * 0.2 - avg.caution * 0.45 - avg.conflict * 0.35, -1, 1),
    intimacy: clamp(avg.intimacySignal * 0.9 + avg.warmth * 0.3 - avg.conflict * 0.45, -1, 1),
    respect: clamp(avg.respectSignal * 0.9 + avg.trustSignal * 0.25 - avg.apology * 0.15, -1, 1),
    tension: clamp(avg.conflict * 0.8 + avg.caution * 0.35 - avg.warmth * 0.25 - avg.apology * 0.25, 0, 1),
  }
  return {
    affinity: clamp((target.affinity - state.affinity) * 0.08, -0.03, 0.03),
    trust: clamp((target.trust - state.trust) * 0.08, -0.05, 0.05),
    intimacy: clamp((target.intimacy - state.intimacy) * 0.08, -0.03, 0.03),
    respect: clamp((target.respect - state.respect) * 0.08, -0.04, 0.04),
    tension: clamp((target.tension - state.tension) * 0.08, -0.15, 0.15),
  }
}

export function applyUpdate(state: MetaState, delta: StateDelta, now = new Date().toISOString()): MetaState {
  const next: MetaState = { ...state }
  if (delta.emotion) {
    next.emotion = delta.emotion.type
    next.emotionIntensity = clamp(
      delta.emotion.absolute ?? next.emotionIntensity + (delta.emotion.intensityDelta ?? 0),
      0,
      1,
    )
  }
  next.mood = clamp(next.mood + (delta.mood ?? 0), -1, 1)
  next.affinity = clamp(next.affinity + clamp(delta.affinity ?? 0, -0.03, 0.03), -1, 1)
  next.trust = clamp(next.trust + clamp(delta.trust ?? 0, -0.05, 0.05), -1, 1)
  next.intimacy = clamp(next.intimacy + clamp(delta.intimacy ?? 0, -0.03, 0.03), -1, 1)
  next.respect = clamp(next.respect + clamp(delta.respect ?? 0, -0.04, 0.04), -1, 1)
  next.tension = clamp(next.tension + clamp(delta.tension ?? 0, -0.15, 0.15), 0, 1)
  next.confidence = clamp(next.confidence + (delta.confidence ?? 0), 0, 1)
  next.engagement = clamp(next.engagement + (delta.engagement ?? 0), 0, 1)
  if (delta.speechStyle) next.speechStyle = delta.speechStyle
  if (delta.gesture) next.gesture = delta.gesture
  next.updatedAt = now
  return next
}

export function applyHeartbeatDecay(state: MetaState, now = new Date().toISOString()): MetaState {
  return {
    ...state,
    emotionIntensity: clamp(state.emotionIntensity * 0.82, 0.15, 1),
    emotion: state.emotionIntensity < 0.2 ? 'neutral' : state.emotion,
    tension: clamp(state.tension * 0.88, 0, 1),
    engagement: clamp(state.engagement * 0.96, 0.2, 1),
    mood: clamp(state.mood * 0.995, -1, 1),
    intimacy: clamp(state.intimacy * 0.999, -1, 1),
    respect: clamp(state.respect * 0.999, -1, 1),
    updatedAt: now,
  }
}

export function planBehavior(state: MetaState): AvatarCommand {
  let expression: AvatarCommand['expression']['name'] = state.emotion
  if (state.tension > 0.65) expression = 'careful'
  else if ((state.affinity > 0.55 || state.intimacy > 0.55) && state.emotion === 'neutral') expression = 'warm'
  return {
    expression: {
      name: expression,
      intensity: state.emotionIntensity,
    },
    ...(state.gesture ? { gesture: state.gesture } : {}),
  }
}
