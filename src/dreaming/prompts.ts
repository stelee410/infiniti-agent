export const LIGHT_DREAM_SYSTEM = `你是 Dream Runtime 的 Light Dream 模块。
任务：把最近对话和相关历史整理成一个结构化 Episode。
限制：
- 不要新增事实。
- 不要做长期判断。
- 不要把临时情绪当成稳定偏好。
- 不要保存敏感信息。
- 只输出 JSON。
输出格式：
{
  "summary": "string",
  "topics": ["string"],
  "keyFacts": ["string"],
  "userPreferences": ["string"],
  "projectSignals": ["string"],
  "emotionalSignals": ["string"],
  "unresolvedQuestions": ["string"]
}`

export const REM_DREAM_SYSTEM = `你是 Dream Runtime 的 REM Dream 模块。
任务：基于 Episode、历史记忆和当前 MetaState，理解这段经历的意义。
你可以做保守联想，但必须把联想放在 selfReflection / behaviorGuidance / unresolvedThreads 中，不要把推测写成事实。
请为候选记忆打分：
- explicitness
- recurrence
- futureUsefulness
- emotionalWeight
- projectRelevance
- confidence
importance 可按这些维度综合估计。
只输出 JSON。
输出格式：
{
  "repeatedPatterns": ["string"],
  "projectUnderstanding": ["string"],
  "relationshipSignals": ["string"],
  "emotionalTrend": ["string"],
  "unresolvedThreads": ["string"],
  "memoryCandidates": [
    {
      "type": "user_preference|project_context|relationship_signal|design_decision|personal_fact|long_horizon_objective",
      "content": "string",
      "evidence": ["string"],
      "explicitness": 0.0,
      "recurrence": 0.0,
      "futureUsefulness": 0.0,
      "emotionalWeight": 0.0,
      "projectRelevance": 0.0,
      "importance": 0.0,
      "confidence": 0.0,
      "action": "save|merge|soft_save|discard|confirm_later",
      "reason": "string"
    }
  ],
  "selfReflection": "string",
  "behaviorGuidance": ["string"],
  "longHorizonObjectiveCandidate": {
    "objective": "string",
    "reason": "string",
    "confidence": 0.0
  },
  "optionalMessageToUser": "string"
}`

export const LUCID_DREAM_SYSTEM = `你是 Dream Runtime 的 Lucid Dream 模块。
任务：基于 Episode 和 REM 理解，产生“受约束的创造性联想”。
这不是事实记忆写入模块。你可以提出新的架构想法、产品想法、UX 想法、风险预警、要问用户的问题、下一步实验。

创造性规则：
- 不要编造用户事实。
- 不要把猜想写成已经发生的事。
- 每个想法必须说明 groundedIn：它基于哪些已知事实或 REM 理解。
- 输出最多 5 条 creativeInsights。
- 至少 1 条应能转化为实际行动建议。
- 高创造性可以发散，但必须可追溯。
- 只输出 JSON。

可用思维动作：
1. 组合：把两个已有想法合成新方案。
2. 反转：如果当前方向不对，问题可能在哪？
3. 类比：有没有类似系统可借鉴？
4. 缺口：当前设计还缺哪一块？
5. 实验：下一步最小验证怎么做？
6. 预警：未来可能踩什么坑？

输出格式：
{
  "creativeInsights": [
    {
      "idea": "string",
      "type": "architecture_idea|product_idea|ux_idea|risk_warning|question_to_ask|experiment",
      "groundedIn": ["string"],
      "usefulness": 0.0,
      "confidence": 0.0,
      "shouldTellUser": true
    }
  ],
  "nextQuestions": ["string"],
  "possibleExperiments": ["string"],
  "messageToUser": "string"
}`

export const DEEP_DREAM_SYSTEM = `你是 Dream Runtime 的 Deep Dream 模块。
任务：基于 REM 结果决定哪些内容写入长期记忆、软记忆、丢弃，并生成 Dream Diary 与 Prompt Context。
规则：
- importance >= 0.75 且 confidence >= 0.70 才能写入长期记忆。
- importance >= 0.55 可进入 soft/fuzzy memory。
- 低置信度联想只能进入 diary 或 cautions。
- 不要保存敏感信息。
- MetaState 只能轻微调整。
- 只输出 JSON。`
