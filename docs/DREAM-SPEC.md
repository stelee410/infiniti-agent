# Dream Runtime SPEC

Version: v0.1
Status: Draft
Scope: single-machine digital human runtime / Infiniti Agent / subconscious-agent

## 1. Definition

Dream Runtime is the digital human's background cognitive consolidation loop.

It is not ordinary memory compression and it is not simply writing facts into long-term memory. It is a periodic "sleep and review" process:

```text
recent conversation and history fragments
  -> episode organization
  -> reflection and pattern recognition
  -> memory update
  -> MetaState adjustment
  -> long-horizon objective update
  -> Dream Diary
  -> prompt context injection
```

One-line definition:

```text
Long-term memory preserves stable facts about the outside world.
Dream Runtime lets the current agent organize itself in first person after experience.
```

## 2. Runtime Constraints

The current product shape is single-machine and single-avatar.

Non-requirements for v0.1:

- No userId.
- No tenantId.
- No multi-avatar isolation.
- No remote service requirement.
- No complex API server requirement.

Each digital human has its own working directory and independent package:

```text
avatar-current-agent/
  .infiniti-agent/
    subconscious.json
    session.json
    sessions.db
    memory.json
    user_profile.json
    memory/
    dreams/
```

All Dream Runtime data should live under the current working directory:

```text
.infiniti-agent/dreams/
```

## 3. Dream vs Memory

This is the core boundary.

```text
Memory Compression:
Turn history into a shorter form.

Long-term Memory:
Choose which facts, preferences, and project contexts are worth preserving.

Dream Runtime:
Use recent experience to reorganize the agent's own attention, tone, boundaries, continuity, and next waking posture.
```

Relationship:

```text
Memory Compression ⊂ Dream Runtime
Long-term Memory Write ⊂ Dream Runtime

Dream Runtime =
  compression
  + memory selection
  + reflection
  + MetaState update
  + long-horizon objective update
  + user-visible dream diary
```

A background task is only memory organization if it answers:

```text
What did we discuss?
What should be saved?
```

It becomes dreaming when it also answers:

```text
What stayed with me from this experience?
What did I misunderstand or over-structure?
What should I carry forward when I wake up?
How do I want to adjust my tone, attention, and boundaries?
Is there a first-person thought I want to leave as a diary note?
```

## 4. Product Goals

Dream Runtime should give the current agent:

- Long-term continuity.
- Relationship continuity.
- Project-understanding continuity.
- Self-calibration.
- User-visible dream explanation.
- Low-pollution prompt injection.

Example user-visible experience:

```text
昨晚我整理了一下最近的对话。
我发现我们现在讨论的重点不是单纯“记忆压缩”，而是让我形成一种可持续的后台理解能力。
我更新了一个短期目标：帮你把 Dream Runtime 设计成单机可落地的系统。
```

## 5. Non-Goals

v0.1 does not implement:

- Multi-user isolation.
- Centralized multi-avatar management.
- Cloud sync.
- Complex permission systems.
- Public web APIs.
- Large vector database infrastructure.
- Automatic saving of sensitive information.
- Treating dream hypotheses as stable facts.

Dream Runtime does not generate real-time replies and does not directly control facial expressions, lip sync, or motion. Real-time behavior remains owned by Main Agent, the subconscious fast path, and LiveUI.

## 6. Scheduling

Dream Runtime can be triggered by:

- Every 4 hours.
- Every 8 hours.
- Session end.
- Manual trigger.
- Before or after context compaction.
- Strong emotional or high-value project discussion.

Recommended v0.1 behavior:

```text
Default: check every 4 hours.
If there are no new events, skip.
If there is little recent dialogue, run Light Dream.
If there is enough recent dialogue, run Full Dream.
```

Scheduling can reuse the existing heartbeat and schedule mechanisms:

```text
heartbeat
  -> checkDreamDue()
  -> runDream(mode)
```

## 7. Architecture

```text
Main Agent
  |
  v
observeUserInput / observeAssistantOutput
  |
  v
Recent Conversation / Session Archive
  |
  v
Dream Scheduler
  |
  v
Dream Runtime
  |
  |-- Light Dream
  |-- REM Dream
  |-- Deep Dream
  |
  v
Dream Outputs
  |
  |-- memory changes
  |-- meta state patch
  |-- long horizon objective
  |-- dream diary
  |-- optional inbox message
  |
  v
Prompt Context Provider
```

## 8. Dream Stages

### 8.1 Light Dream

Purpose: organize what happened into an episode.

Inputs:

- Recent messages.
- Relevant session archive search results.
- Tool result summaries.
- Current subconscious state.

Output:

```ts
type DreamEpisode = {
  id: string;
  createdAt: string;
  source: "heartbeat" | "schedule" | "manual" | "compact" | "session_end";

  summary: string;
  topics: string[];
  keyFacts: string[];
  userPreferences: string[];
  projectSignals: string[];
  emotionalSignals: string[];
  unresolvedQuestions: string[];

  rawEventRefs: string[];
};
```

Rules:

- Do not add new facts.
- Do not make strong inferences.
- Do not write long-term memory.
- Only clean, classify, and summarize.

### 8.2 REM Dream

Purpose: understand meaning, patterns, direction, and memory candidates.

Inputs:

- Episode.
- Existing memory.
- Subconscious state.
- Recent dream diaries.
- Session search results.

Output:

```ts
type RemDreamInsight = {
  repeatedPatterns: string[];
  projectUnderstanding: string[];
  relationshipSignals: string[];
  emotionalTrend: string[];
  unresolvedThreads: string[];

  memoryCandidates: DreamMemoryCandidate[];
  selfReflection: string;
  behaviorGuidance: string[];
  longHorizonObjectiveCandidate?: LongHorizonObjective;
  optionalMessageToUser?: string;
};
```

`selfReflection` is the boundary between Dream Runtime and ordinary memory compression.

Example:

```text
Steven 当前讨论的重点不是多用户架构，而是单机数字人如何形成后台连续理解。
我醒来后应该先澄清概念边界，再推进工程落点。
```

REM Dream may make associations, but every association must be marked as insight or hypothesis. It must not be written directly as a stable fact.

### 8.3 Deep Dream

Purpose: decide what should be preserved and apply durable changes.

Output:

```ts
type DeepDreamResult = {
  memoriesCreated: string[];
  memoriesUpdated: string[];
  memoriesDiscarded: string[];

  fuzzyMemoriesCreated: string[];
  metaStatePatch: MetaStatePatch;
  longHorizonObjective?: LongHorizonObjective;

  dreamDiary: DreamDiary;
  promptContext: DreamPromptContext;
};
```

Write rules:

```text
importance >= 0.75 && confidence >= 0.70
  -> long-term memory

importance >= 0.55
  -> fuzzy memory / soft memory

importance < 0.55
  -> episode only / discard
```

## 9. Data Models

### 9.1 DreamRun

```ts
type DreamRun = {
  id: string;
  version: 1;
  mode: "light" | "rem" | "deep" | "full";
  source: "heartbeat" | "schedule" | "manual" | "compact" | "session_end";

  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "skipped";

  reason: string;
  error?: string;

  episodeId?: string;
  diaryId?: string;
};
```

### 9.2 DreamMemoryCandidate

```ts
type DreamMemoryCandidate = {
  id: string;

  type:
    | "user_preference"
    | "project_context"
    | "relationship_signal"
    | "design_decision"
    | "personal_fact"
    | "long_horizon_objective";

  content: string;
  evidence: string[];

  explicitness: number;
  recurrence: number;
  futureUsefulness: number;
  emotionalWeight: number;
  projectRelevance: number;

  importance: number;
  confidence: number;

  action: "save" | "merge" | "soft_save" | "discard" | "confirm_later";
  reason: string;
};
```

### 9.3 LongHorizonObjective

```ts
type LongHorizonObjective = {
  objective: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  confidence: number;
};
```

Default expiration: 7 days.

Update conditions:

- User goal clearly changes.
- Current goal is completed.
- Multiple dreams point toward a new topic.
- Objective expires.

### 9.4 DreamDiary

```ts
type DreamDiary = {
  id: string;
  createdAt: string;

  title: string;
  summary: string;

  whatHappened: string[];
  whatIUnderstood: string[];
  memoriesChanged: string[];
  metaStateChanges: string[];
  currentObjective?: string;

  messageToUser?: string;

  visibleToUser: boolean;
};
```

### 9.5 DreamPromptContext

This is the artifact injected into Main Agent prompts. It is not the full dream diary.

```ts
type DreamPromptContext = {
  updatedAt: string;

  longHorizonObjective?: string;
  recentInsight?: string;

  relevantStableMemories: string[];
  behaviorGuidance: string[];
  unresolvedThreads: string[];

  cautions: string[];
};
```

## 10. Storage

v0.1 should use local files:

```text
.infiniti-agent/dreams/
  dream-runs.jsonl
  episodes.jsonl
  candidates.jsonl
  prompt-context.json
  diaries/
    2026-05-04T04-00-00.md
    2026-05-04T04-00-00.json
```

If query requirements grow, this can move to SQLite:

```text
dream_runs
dream_episodes
dream_memory_candidates
dream_diaries
```

## 11. Prompt Injection

Do not inject full dreams into the prompt.

Correct mapping:

```text
Dream Diary        -> user-visible
Dream Insights     -> subconscious-agent
Memory Changes     -> memory provider
Long Objective     -> Main Agent
MetaState Patch    -> tone / behavior system
```

Main Agent should only read compressed `DreamPromptContext`.

Recommended prompt block:

```text
## Dream Context

Long-horizon objective:
帮助当前 agent 把 Dream Runtime 设计成单机可落地的第一人称自我整理系统。

Recent insight:
最近讨论显示，Steven 当前更关心“做梦”和“记忆压缩”的本质区别，以及梦境如何进入提示词工程。

Behavior guidance:
- 优先解释概念边界。
- 避免引入多用户、多数字人隔离。
- 给出单机可落地的工程方案。
- 对联想内容要标注为推测，不要当事实。

Unresolved threads:
- Dream Runtime 的最小实现边界。
- Dream Diary 与 prompt context 的分离方式。
```

Injection order:

```text
System Prompt
  -> Long-term Memory
  -> Dream Context
  -> MetaState Context
  -> Current User Message
```

Limits:

- Keep Dream Context around 300-800 tokens.
- Do not inject full Dream Diary.
- Do not inject low-confidence hypotheses.
- Do not inject raw long history.
- Do not inject sensitive information.

## 12. MetaState Updates

Dream Runtime may update long-term state, but only gradually.

```ts
type MetaStatePatch = {
  relationship?: {
    affinity?: number;
    trust?: number;
    intimacy?: number;
    respect?: number;
    tension?: number;
  };

  persona?: {
    warmth?: number;
    humor?: number;
    proactiveness?: number;
    formality?: number;
  };

  speechStyle?: string;
};
```

Limits:

```text
trust delta <= 0.03
affinity delta <= 0.03
intimacy delta <= 0.03
respect delta <= 0.03
tension may rise faster, but should fall slowly
```

Principles:

- One strong emotional event must not permanently change the relationship.
- Long-term relationship changes require repeated signals.
- Persona changes must be gradual.
- Dream Runtime does not control real-time expression.

## 13. User Experience

Dream Diary example:

```text
# 我的梦境笔记

昨晚我整理了我们最近的讨论。

我记得我们正在设计 Dream Runtime。
这次我理解到，Steven 关心的不是单纯保存更多记忆，而是让我拥有一种后台复盘和自我校准的能力。

我更新了一个短期目标：
帮助 Steven 把 Dream Runtime 做成单机可落地的系统，并且保持它和长期记忆、提示词工程之间的边界清晰。

我没有把低置信度联想写入长期记忆。
```

Optional inbox message:

```text
我昨晚想到一件事：Dream Context 不应该是梦境全文，而应该是梦醒后留下的“行动摘要”。
```

## 14. Safety Rules

Do not save by default:

- Exact addresses.
- Government ID information.
- Medical diagnosis.
- Financial accounts.
- Passwords, tokens, keys.
- Sensitive political or religious identity.
- Unconfirmed personal hypotheses.

REM Dream may produce hypotheses, but they must go into:

```text
selfReflection
cautions
confirm_later
```

They must not directly enter:

```text
long-term memory
profile
knowledge graph
```

## 15. Failure Handling

LLM JSON failure:

```text
1. Try JSON repair.
2. Retry once with a format-fixing prompt.
3. If still invalid, mark dream run failed.
4. Do not write long-term memory.
```

Dream failure:

```text
Do not affect the main conversation.
Do not delete unprocessed context.
Retry next time.
Record error.
```

Memory conflict:

```text
Do not overwrite old memory.
Mark conflict / preference_shift.
Wait for future confirmation.
```

## 16. MVP Plan

### Phase 1: Dream Diary MVP

Goal: the current agent can periodically dream and leave a readable first-person diary.

Tasks:

- Add DreamRun type.
- Add DreamEpisode type.
- Add dream store.
- Implement `runLightDream()`.
- Implement `writeDreamDiary()`.
- Support manual dream trigger.

Outputs:

```text
.infiniti-agent/dreams/diaries/*.md
.infiniti-agent/dreams/prompt-context.json
```

### Phase 2: REM + Prompt Context

Goal: Dreams enter prompt engineering without polluting context.

Tasks:

- Implement `runRemDream()`.
- Generate `selfReflection`.
- Generate `behaviorGuidance`.
- Generate `unresolvedThreads`.
- Generate `DreamPromptContext`.
- Inject Dream Context from `systemBuilder`.

### Phase 3: Deep Dream + Memory

Goal: high-value information enters long-term memory.

Tasks:

- Implement `scoring.ts`.
- Implement memory candidates.
- Implement save / soft_save / discard.
- Connect to `memory.json`, fuzzy memory, and longTerm memory.
- Generate created / discarded memory records.

### Phase 4: MetaState + Objective

Goal: the current agent forms a long-term first-person waking posture.

Tasks:

- Implement `longHorizonObjective`.
- Implement `MetaStatePatch`.
- Implement expiration.
- Let dream insight lightly influence `speechStyle`.

## 17. Recommended Directory Structure

```text
src/
  dreaming/
    types.ts
    prompts.ts
    scoring.ts
    dreamStore.ts
    lightDream.ts
    remDream.ts
    deepDream.ts
    dreamRunner.ts
    diary.ts
    promptContext.ts
    objective.ts

  subconscious/
    agent.ts
    state.ts
    engine.ts

  memory/
    structured.ts
    documentMemory.ts

  session/
    archive.ts
```

`subconscious-agent` owns scheduling and state. `dreaming-runtime` owns one complete dream run.

## 18. Core Pseudocode

```ts
async function runDream(mode: DreamMode, source: DreamSource) {
  const run = await dreamStore.startRun({ mode, source });

  const recent = await loadRecentConversation();
  const history = await searchRelevantSessions(recent);
  const metaState = await loadSubconsciousState();
  const memories = await loadMemoryStores();

  const episode = await lightDream({ recent, history });

  if (mode === "light") {
    const diary = await writeDreamDiary({ episode });
    await updatePromptContext({ episode });
    return complete(run, diary);
  }

  const rem = await remDream({
    episode,
    memories,
    metaState,
    recentDreams: await loadRecentDreamDiaries(),
  });

  const deep = await deepDream({
    episode,
    rem,
    memories,
    metaState,
  });

  await applyMemoryChanges(deep.memoryChanges);
  await applyMetaStatePatch(deep.metaStatePatch);
  await saveLongHorizonObjective(deep.longHorizonObjective);
  await saveDreamPromptContext(deep.promptContext);
  await writeDreamDiary(deep.dreamDiary);

  if (deep.dreamDiary.messageToUser) {
    await maybeWriteInboxMessage(deep.dreamDiary.messageToUser);
  }

  await dreamStore.completeRun(run.id);
}
```

## 19. Minimum Success Criteria

v0.1 is successful when:

- The current agent checks whether it should dream every 4 or 8 hours.
- New content produces a Dream Diary.
- Dream Diary is user-readable.
- Dream Context enters the Main Agent prompt.
- Main Agent does not read the full dream.
- Long-term memory only stores high-confidence facts.
- The current agent maintains a short-term long-horizon objective.

## 20. Final Principle

Dream Runtime is not about remembering more. It is about:

```text
turning experience into understanding;
turning understanding into direction;
turning direction into continuity in the next conversation.
```

Relationship to memory:

```text
Long-term memory is the archive of stable outside-world facts.
Dream Runtime is the agent's first-person self-organization.
Prompt Context is the small piece of organized self the agent carries into the day.
```
