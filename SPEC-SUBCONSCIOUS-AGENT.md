# Subconscious Agent SPEC

## 1. Overview

Subconscious Agent 是一个**独立于主任务 Agent 的心理与表现引擎**，用于驱动数字人的：

* 情绪（Emotion）
* 人格与关系（Affinity / Trust）
* 行为风格（Speech / Gesture）
* 即时反应（Pre-reaction）
* 记忆压缩（Memory Compression）

其核心设计基于：

* **MVU（Multiple Variables Update）**
* **状态驱动行为（State-driven Behavior）**
* **主 Agent 与 Meta Agent 解耦**

---

## 2. Design Principles

### 2.1 MVU（Multiple Variables Update）

> 一个输入 → 同时更新多个心理变量

```text
Input → delta → applyUpdate(state) → behavior → render
```

---

### 2.2 State-driven Behavior

系统不接受“直接控制表情”的指令：

❌ 错误：

```text
LLM：微笑
```

✅ 正确：

```text
LLM：emotion=happy, trust+0.2
系统：自动决定表现
```

---

### 2.3 Separation of Concerns

| 模块                 | 职责             |
| ------------------ | -------------- |
| Main Agent         | 任务执行、工具调用、代码修改 |
| Subconscious Agent | 情绪、人设、关系、记忆    |
| Renderer           | 表情、动作、语音       |

---

### 2.4 Hard vs Soft Context

```text
Hard Context（主 Agent）：
- 用户需求
- 工具结果
- 代码
- 事实

Soft Context（Subconscious Agent）：
- 情绪
- 语气
- 人格
- 关系
```

---

## 3. System Architecture

```text
User Input
   ├── Main Agent (task execution)
   └── Subconscious Agent (meta processing)

Main Result + Meta State
   ↓
Behavior Planner
   ↓
Renderer (Avatar)
```

---

## 4. Core State Model

```ts
type MetaState = {
  emotion: "neutral" | "happy" | "sad" | "angry" | "surprised" | "thinking";
  emotionIntensity: number; // 0~1

  mood: number;       // -1~1 (long-term)
  affinity: number;   // -1~1
  trust: number;      // -1~1
  tension: number;    // 0~1

  confidence: number; // 0~1
  engagement: number; // 0~1
}
```

---

## 5. Input Analysis Model

```ts
type InputAnalysis = {
  sentiment: number;        // -1~1
  aggression: number;       // 0~1
  frustration: number;      // 0~1
  praise: number;           // 0~1
  urgency: number;          // 0~1
  intimacySignal: number;   // 0~1
  correctionSignal: number; // 0~1
  taskFocus: number;        // 0~1
}
```

---

## 6. MVU Delta Format

```ts
type StateDelta = {
  emotion?: {
    type: MetaState["emotion"];
    intensityDelta?: number;
    absolute?: number;
  };

  mood?: number;
  affinity?: number;
  trust?: number;
  tension?: number;

  confidence?: number;
  engagement?: number;

  speechStyle?: string;
  gesture?: string;
}
```

---

## 7. Update Engine

```ts
function applyUpdate(state: MetaState, delta: StateDelta): MetaState {
  // clamp & merge
}
```

### Constraints

```text
affinity delta: [-0.03, +0.03]
trust delta:    [-0.05, +0.05]
tension delta:  [-0.15, +0.15]
```

---

## 8. Time Window Model

```text
Recent 1 message   → instantEmotion
Recent 3-5 msgs   → current emotion
Recent 10-20 msgs → mood
Long-term         → affinity / trust
```

### Weighting

```text
1 msg:   50%
3-5 msg: 30%
long:    20%
```

---

## 9. Dual-Path Execution (Critical)

### 9.1 Fast Path (Meta Agent)

```text
Latency: 100~500ms
用途：
- 即时表情
- 初始反应
```

```json
{
  "immediate": {
    "expression": "thinking",
    "intensity": 0.5,
    "gesture": "look_up",
    "durationMs": 1200
  }
}
```

---

### 9.2 Slow Path (Main Agent)

```text
用途：
- 回复生成
- 工具调用
- 代码执行
```

---

## 10. Behavior Planner

```text
MetaState → Behavior → Render Commands
```

### Example

```ts
if (state.tension > 0.6) {
  speechStyle = "careful";
}

if (state.affinity > 0.7) {
  expression = "warm";
}
```

---

## 11. Rendering Interface

```ts
type AvatarCommand = {
  expression: {
    name: string;
    intensity: number;
  };

  gesture?: string;

  speech?: {
    speaking: boolean;
    text?: string;
    phoneme?: string;
  };
}
```

---

## 12. Memory System

### Types

```ts
type Memory = {
  project: string[];
  userPreference: string[];
  persona: string[];
}
```

### Responsibility

* Subconscious Agent 负责压缩
* Main Agent 只读取必要片段

---

## 13. Critical Constraints

### DO

* 状态驱动行为
* 并行执行 Meta / Main
* 情绪用于表达层

### DO NOT

* 情绪影响工具调用
* 情绪影响代码决策
* Meta Agent 控制执行逻辑

---

## 14. MVP Scope

### Minimal State

```ts
{
  emotion,
  emotionIntensity,
  trust,
  tension,
  speechStyle
}
```

### Minimal Pipeline

```text
Input → Meta delta → State → Behavior → Render
```

---

## 15. Future Extensions

* Personality Traits（Big Five）
* Long-term Memory Graph
* Emotional inertia system
* Multi-agent internal dialogue

---

## 16. Summary

Subconscious Agent 的本质是：

> 一个“心理状态引擎”，用 MVU 维护多维状态，
> 用状态驱动数字人的表现，
> 并与任务执行系统完全解耦。
