# Hermes Native Bridge（双桥合同 · Chat turn 同源）

> 状态：Phase 1 已接线（Hermes 1:1 Engine + commandPort，2026-10）；Chat turn Phase A–D ✅  
> 实现起步：[`src/server/agent-runtime/hermes-native-bridge.ts`](../src/server/agent-runtime/hermes-native-bridge.ts)  
> Engine 宿主：[`src/screens/chat/lib/hermes-agent-engine.ts`](../src/screens/chat/lib/hermes-agent-engine.ts) · runtime [`src/stores/hermes-chat-runtime.ts`](../src/stores/hermes-chat-runtime.ts)  
> Turn identity / adapter：[`src/lib/chat-turn-identity.ts`](../src/lib/chat-turn-identity.ts)、[`src/lib/hermes-activity-adapter.ts`](../src/lib/hermes-activity-adapter.ts)、`packages/agent-activity-core`  
> 映射表：`collab.db` `agorax_run_mapping`（[`src/server/agorax-run-mapping.ts`](../src/server/agorax-run-mapping.ts)）  
> 对照：[`docs/managed-agent-daemon-mapping.md`](./managed-agent-daemon-mapping.md)

## 1. Dual-bridge 模型

Agorax 对前端暴露同一套 `AgentActivityAdapter` / `AgentSessionEngine` 合同，背后有两条互不替代的桥：

| Bridge | 执行面 | Canonical 真相源 | 产品入口 |
| --- | --- | --- | --- |
| **Managed** | `agorax-agentd`（CLI providers） | daemon SQLite Session/Turn/Interaction | 1:1 managed chat、群聊 managed 成员 |
| **Native (Hermes)** | Hermes Gateway +（Swarm）tmux | Workspace 侧映射表 + gateway session；**终态权威仍是 canonical Session/Turn 投影** | 1:1 Hermes chat（`send-stream`）、群聊 Hermes、Swarm dispatch |

```text
AgentSessionEngine
  ├─ managed bridge ──► agorax-agentd REST/WS
  └─ native bridge  ──► Hermes Gateway / send-stream
                          └── Swarm/tmux 仅作投影（不伪装成 child Session）
```

`HermesAdapterStub`（probe-only）与 tmux / swarm-dispatch **继续有效**；native bridge 是并行增长路径，不替换 Swarm 执行模型。

**运行时可以不一样；身份、事件、settle 合同必须同源。**

## 2. Chat turn 分层（运行时分叉 · 接口同源）

```text
┌──────────────────────────────────────────────┐
│ UI 投影（气泡 / Activity / Stop）              │  只认 Engine VM
├──────────────────────────────────────────────┤
│ AgentSessionEngine（权威消息桶 + reconcile）   │  统一接口
├──────────────────────────────────────────────┤
│ Turn / Message 合同                            │  messageId · delta · settle
├──────────────────────────────────────────────┤
│ Runtime Adapter                                │
│   managed  → daemon activity WS                │
│   Hermes   → hermes-activity-adapter ← SSE     │  厂商协议止步于此
└──────────────────────────────────────────────┘
```

| 层 | 统一 | 可不统一 |
| --- | --- | --- |
| 合同 | `messageId` 生命周期、`message_delta` vs settle、禁止换皮 | — |
| 事件 | `@agorax/agent-activity-core` 的 Activity 形态 | 厂商原始 SSE / CLI JSON |
| 接口 | Engine apply / reconcile / 读消息 | — |
| 运行时 | — | Gateway、Claude CLI、Codex… |

### 2.1 Message Identity

| 角色 | id |
| --- | --- |
| Assistant 正文 | `assistant:<runId>`（无 runId → `assistant:pending:<sessionOrTurn>`） |
| Reasoning | `assistant:<runId>:thinking` |
| Tool | `toolcall:<toolCallId>` |

首包分配，流式 / 落库 / 历史同一行。禁止结束后换 ID 换皮。

### 2.2 Adapter 职责

- **Managed**：daemon 已发 Activity；`event-bridge` 只转发。
- **Hermes**：`hermesSseToActivityEvents` 把 `started|chunk|thinking|tool|done` 译成同一套 `message_delta` / `turn_update`。
- UI **不**直接吃 Hermes SSE 业务语义；Hermes 1:1 列表与 busy 只订 Engine（`selectHermesChatState`）。`chat-store` write-through 仅作 SSE 侧信道 / portable 遗留，**不是**列表真相源；`streamingText` / `streamingThinking` / `activeToolCalls` 等 list sidecar **仅 portable** 传入，Hermes 1:1 不喂。
- **列表投影同源：** `projectActivityMessagesToChat` + `selectAssistantStreamingMessageId`（`activity-list-projection.ts`）同时服务 `selectHermesChatState` 与 `selectManagedAgentChatState`。禁止一边 fold、一边 1:1 map。
- **send 种壳同源：** `ingestEngineUserPromptMessage`（Hermes / managed 共用）在 submit 前写入 `user:<clientSubmitId>` + `assistant:pending:<session>:<turn>`；`applyOpenAssistantStreamingChrome` 优先 pending host，并用 `foldOpenTurnIntoLiveHost` 吞掉 daemon/SSE 旁路行。

### 2.3 Settle（Tutti 对齐：`running → settling → settled`）

- 成功 `done` → `turn_update` `phase=settling`（`activeTurnId` 保持；composer busy / fold 仍开）
- commandPort 在 settling 内：先用 `done.message` stamp 终稿 text；**仅当 done 未带正文** 才 `/api/history` 补洞（更长才写），再发 `phase=settled`
- `error` / failed / interrupted `done` → 直接 `phase=settled`（失败无需等补洞）
- Composer busy 跟 `phase !== settled`（见 `selectHermesChatState`）
- **禁止**用 history 页整段替换已投影正文；Reconcile = 补洞 / stamp id / version，不是换皮
- **禁止**在成功 `done` 瞬间开输入框（须等 settled）
- **开 turn / settling 期间**：`foldOpenTurnIntoLiveHost` 把 last-user 之后的工具/中间正文并进唯一 host；有线程内 host 时底部 Thinking pill 必须关（禁止 `liveToolActivity` 单独点亮）

### 2.4 Chat turn 分阶段（A–D）

| Phase | 内容 | 状态 |
| --- | --- | --- |
| A | Identity + Hermes write-through（不换皮） | ✅ |
| B | Hermes SSE → Activity 纯 adapter | ✅ `hermes-activity-adapter.ts` |
| C | Native bridge 真接线：send-stream → adapter → Engine | ✅ `createHermesAgentEngine` + commandPort（`/api/send-stream` / `/api/runs/.../stop` 仅 port 内）；`agorax_run_mapping` 落 collab.db；SSE→adapter→`coordinator.ingestEvent` |
| D | Hermes 1:1 UI 只订 Engine（与 managed 同 hook 投影） | ✅ 列表 ← Engine；history→Engine 用 **turn identity stamp**；Activity 桶内 reasoning/tool/text 可分行存储，**投影** `projectActivityMessagesToChat`（Hermes + managed 同源）折回唯一 host。禁止 chat-store→RQ history 双写。send → `ingestHermesUserPromptMessage`；adapter 首包 `set` 锚点 |

## 3. 所有权

- **Canonical Session / Turn / Interaction** 是终态权威。UI、群聊卡片、mission 列表只投影。
- **观察量（非权威）**：`runtime.json`、tmux 存活、LangGraph checkpoint、gateway WS 连通性。
- **禁止**：把 Swarm worker assignment / Human Gate / mission gate 伪装成 managed child Session 或 provider Interaction。

## 4. Identity 映射（`agorax_run_mapping`）

Workspace 侧（或 collab.db）维护稳定映射，避免把 gateway id 直接当 `agentSessionId` 泄漏到 engine：

| 字段 | 含义 |
| --- | --- |
| `agentSessionId` | Agorax / engine 侧会话 id（UUID） |
| `turnId` | Agorax / engine 侧回合 id |
| `gatewaySessionId` | Hermes gateway session key（可空直至 Create） |
| `assignmentId` | Swarm assignment id（仅 Phase 3+；可空） |
| `hermesRunId` | gateway / send-stream run id（可空） |
| `bridgeKind` | 恒为 `hermes-native` |
| `updatedAtUnixMs` | 映射行更新时间 |

映射规则：

1. CreateSession → 分配 `agentSessionId`，探测/打开 gateway session，写入 `gatewaySessionId`。
2. SendInput → 新 `turnId`，调用 gateway send-stream，绑定 `hermesRunId`。
3. CancelTurn → 走 gateway abort API；**禁止**对 tmux TUI 发送 C-c 杀进程。Turn cancel = 停止等待 + canonical settle（`outcome=canceled`）。
4. Reconcile → 以映射表 + gateway 只读状态重放 activity，不 invent 成功。

## 5. Cancel 规则

| 场景 | 行为 |
| --- | --- |
| Managed | Host `CancelTurn` → provider abort |
| Native 1:1 | Gateway abort / stop waiting；settle Turn |
| Native Swarm / tmux | **禁止 C-c 杀 TUI**；cancel = 停止编排等待 + 标记 Turn/assignment 结算 |
| 未知 / 无映射 | fail closed，不报告假成功 |

## 6. Native bridge 分阶段

| Phase | 范围 | 本文件状态 |
| --- | --- | --- |
| **0** | 映射类型 + 包边界；不改执行路径 | ✅ skeleton |
| **1** | gateway 1:1：Create/Send/Cancel/stream → activity 事件 + Engine | ✅ `createHermesCommandPort`：activate→`/api/sessions`；sendInput→`/api/send-stream` SSE→`hermesSseToActivityEvents`→ingest；cancelTurn→`/api/runs/:id/stop` + `phase=settled` `canceled`；映射落库 |
| **2** | 群聊 Hermes 成员 Turn 投影 + 精确 cancel/resume | 文档预留 |
| **3** | Swarm assignment ↔ Turn；Human Gate 仍属 Hermes | 文档预留 |
| **4** | Interaction：gateway `approval.request` → Interaction 投影 + `ManagedAgentInteractionPanel` + `POST /v1/runs/{id}/approval` 回写 | ✅ 1:1 Hermes chat（见 `hermes-approval.ts` / send-stream / hermes-agent-engine） |
| **4+** | Goal/Fork 后置 | 文档预留 |

## 7. 与 Runtimes 页的关系

Hermes 在 Settings → Runtimes 的「就绪」= gateway probe（`probeHermesProfileGateway`），与 native bridge hydrate **解耦**：probe 失败不伪造 bridge Create 成功。1:1 UI Send/Stop 已经 Engine commandPort（内部仍调既有 `send-stream` / `runs/stop`）；Swarm/tmux 路径不变。portable / local-model 仍是 Workspace `send-stream` 传输分叉，经同一 port 发出，不必单独 Engine 化。

## 8. 非目标

- 把 Hermes tmux 长会话改成 managed `startRun` 进程模型
- 整包替换为外部 Agent GUI
- 在 native bridge 内重实现 Swarm 编排
- 在 UI 里维护两套 merge（Hermes history cache vs Engine overlay）作为列表终态 — Hermes 1:1 已切 Engine-primary
- 用正文 fingerprint 折叠「看起来像重复」的气泡 — 身份必须以 `messageId` / turn 对齐；正文折叠只是掩盖 gateway `msg-N` 与 live `assistant:<runId>` 分叉
- 把 Swarm tmux 伪装成 managed child Session
- 用正文 fingerprint 当 React key
