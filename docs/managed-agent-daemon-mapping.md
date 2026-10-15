# Managed Agent Daemon 映射记录

状态：迁移完成（2026-09，Phase 0–5）

本文记录 agorax 把 Agorax managed-agent daemon（`agorax-agent-daemon/`）及 activity 映射包
复刻到本仓库的过程：复用来源对照、SSE/REST 合同摘要、与 upstream 合同的已知偏差、
状态所有权规则与验证命令清单。规划原文见
`~/.kimi-code/.../plans/havok-miles-morales-storm.md`（本文不重复其问题分析）。

## 结论

agorax 自有 UI（`src/screens/chat/`、群聊）现在通过 **canonical 合同**消费
`agorax-agent-daemon`：事件只是提示（events are hints），canonical 读兜底修复缺口；
前端状态由 activity-core engine 持有；群聊 / mission / Swarm 只投影、不双写。
复用的是 daemon 的**语义层与映射层**，不是 UI 组件——外壳、群聊、mission 所有权不变。

**近期进展（2026-09 Waves）：**

- Wave 2 MCP / Mission 控制通道已接线（managed daemon `mcpEndpoint` / run token）。
- Wave 3：daemon Host REST（title/delete/pin/settings/composer-options/plan-decision/goal 只读）+ adapter/engine 接线。
- Wave 5：Hermes native bridge 已起步（[`docs/hermes-native-bridge.md`](./hermes-native-bridge.md)、`hermes-native-bridge.ts` Phase 0–1 skeleton）；`HermesAdapterStub` / tmux 路径不变。

## 复用来源对照表

| 来源概念 | Agorax 包 | 说明 |
| --- | --- | --- |
| activity-core（canonical engine） | `packages/agent-activity-core`（`@agorax/agent-activity-core`） | canonical 状态引擎整体提取：engine / reducers / selectors / `workspaceEventCoordinator` / `optimisticMessageOverlay` / `sessionReconcileExecutor` / envelope 一致性校验（`agentActivityEventEnvelopeIsConsistent`） |
| daemon DTO adapter | `packages/agent-activity-daemon-adapter`（`@agorax/agent-activity-daemon-adapter`） | daemon DTO↔canonical 映射（~2400 行含测试）：`mappers.ts` / `sessionDetail.ts` / `requests.ts` / `composerOptions.ts` / `composerSettings.ts` / `capabilityReferences.ts`。daemon Go struct 的 PascalCase JSON 是真相源，不一致处以 daemon 实际输出为准修正 |
| managed-agent daemon | `agorax-agent-daemon/` | 复制体升级：WS 事件补全 upstream envelope；REST 新增 session list 与 `afterVersion` 分页 |
| 前端事件桥 | `src/lib/managed-agent-runtime/event-bridge.ts` | SSE 帧→envelope 校验→`queueMicrotask` 批处理→coordinator→engine；断线/坏帧触发 reconcile |
| 前端 reconcile 装配 | `src/lib/managed-agent-runtime/reconcile-port.ts` | core `AgentActivitySessionReconcilePort` 实现：detail 读 + `afterVersion` 增量分页（协议仅支持前向分页，desc/beforeVersion 在端口内组装） |
| interactive answer payload | `src/lib/managed-agent-runtime/interactive-answer-payload.ts` | question interaction 的 `answersByQuestionId` 权威 payload 纯函数 |

被替换掉的 agorax 自有实现：

- `src/lib/agent-activity-core.ts` 本地 shim 已删除，类型统一从
  `@agorax/agent-activity-core` 导入（消除双轨类型漂移）。
- `src/screens/chat/lib/managed-agent-activity-mapper.ts` 的手写 PascalCase 白名单
  （~40 键硬编码 + 写死默认值）已改为委托 `@agorax/agent-activity-daemon-adapter`，
  保留对外函数签名，fail-closed。
- backend→targetId 映射收敛到 `src/lib/managed-agent-runtime/agent-targets.ts`
  （client-safe 单一源，服务端 `http-client` 也从这里 import）。
- `use-managed-agent-chat.ts` 的 ping→全量 refetch + 2s 轮询兜底已删除，
  首载一次 hydrate 保留（经 detail 读 + reconcile）。
- `workspaceId` 硬编码 `'default'` 已消除：服务端读 `AGORAX_WORKSPACE_ID`，
  SSE `connected` 帧把它带给前端。

## 分层与合同摘要

```
agorax UI → command port(typed settlement)
          → POST /api/agents/:id/engine/activate|input|cancel|interactions/...
daemon WS ──► SSE(forward 全帧) ──► event-bridge ──► coordinator.ingestEvent ──► engine
                                     缺口/断线 ──► session/reconcileRequested
                                     reconcile-port ──► detail + messages?afterVersion&limit
```

### daemon WS envelope（`/v1/events/ws`）

```json
{
  "id": "<event id>",
  "topic": "agent.activity.updated",
  "version": 42,
  "emittedAt": 1758000000000,
  "scope": { "workspaceId": "<ws>" },
  "payload": {
    "workspaceId": "<ws>",
    "agentSessionId": "<canonical session>",
    "eventType": "message_delta | message_update | turn_update | interaction_update | session_reconcile_required",
    "data": { "…": "eventType 对应负载；identity 字段缺失时 daemon 注入" }
  }
}
```

- `version` 是 hub 单调 revision，发布顺序即订阅观察顺序。
- 滞后订阅者丢帧 → daemon 发 `session_reconcile_required`（可恢复丢失信号）。
- 非 text 消息（payloadSet / toolOutput）经 `message_delta` 完整下发；
  `message_update` 携带 committed 快照的 latestVersion / acceptedCount / 完整 messages。

### daemon REST（`/v1/workspaces/{ws}/...`）

| 端点 | 说明 |
| --- | --- |
| `GET /v1/agent-targets` | daemon catalog target 列表 |
| `GET /v1/workspaces/{ws}/agent-sessions` | session list（含 messageVersion 游标） |
| `POST /v1/workspaces/{ws}/agent-sessions` | 建 canonical session（client 提供 agentSessionId） |
| `POST .../agent-sessions/{id}/input` | sendInput（clientSubmitId 幂等） |
| `POST .../turns/{tid}/cancel` | cancelTurn |
| `GET .../agent-sessions/{id}/interactions` | pending interaction 快照 |
| `POST .../turns/{tid}/interactions/{rid}/response` | respondToInteraction |
| `GET .../agent-sessions/{id}/activity?afterVersion=&limit=` | activity 聚合（session+turns+messages+interactions）+ `messageVersion`/`hasMoreMessages` 游标；limit 默认 500、上限 1000 |

服务端 `agorax-managed-agent-http-client.ts` 实现 core `AgentActivityAdapter`
（`listSessions / listSessionMessages(afterVersion) / createSession / sendInput /
submitInteractive / cancelTurn`），是该接口的 daemon 方言 typed client。

### 服务端 SSE（`GET /api/agents/:id/engine/session/:sid/events`）

按 workspace 共享一条 daemon WS（module 级注册表 + 引用计数，取代每客户端一条），
按 `agentSessionId` 匹配 fan-out，**全帧转发**（不丢 payload）：

- `event: connected` — `data {"workspaceId": "..."}`，每次 attach（含重连）
- `event: activity` — `data <完整 daemon envelope>`
- `event: reconnect` — `data {"reason": "daemon-ws-drop" | "daemon-ws-reconnect"}`，
  daemon WS 断线/恢复时广播，前端据此跑 gap-closing reconcile

### 前端事件桥（`src/lib/managed-agent-runtime/event-bridge.ts`）

1. `activity` 帧 → `parseManagedAgentActivityEnvelope`（topic/scope/payload 形状 +
   core `agentActivityEventEnvelopeIsConsistent` 一致性校验，data 缺 identity 字段时归一化补齐）；
2. 校验通过 → `queueMicrotask` 批处理 → 宿主回调里
   `workspaceEventCoordinator.ingestEvent` → engine inline 应用；
3. 坏帧 / 解析失败 → `onMalformedActivity` → 宿主 dispatch `session/reconcileRequested`；
4. EventSource error → CLOSED 时显式重开（3s 退避），新 `connected` 帧触发优先 reconcile。

### 群聊 managed 成员

`turn-executor` 消费 canonical 事件（不再只认 `text_delta`/`run_exited`）：
`interaction_update` 经 `src/lib/group-chat-interaction-card.ts` 投影为 room 消息卡片
（marker `agorax:managed-interaction:v1`），状态以 daemon canonical 为准、无本地 pending
状态机；人回写走
`POST /api/rooms/:roomId/messages/:messageId/interaction-response`
（`src/server/group-chat/managed-interaction-cards.ts`），同一 canonical command 路径。

## 状态所有权规则

1. **daemon host** 是 Session / Turn / Interaction 生命周期 owner（其 SQLite 为真相源）。
2. **activity-core engine** 是前端 canonical state owner（不可变 snapshot + selectors）；
   事件流只是提示，一切终态以 canonical 读为准。
3. **1:1 managed sidebar**：列表 / rename / delete 只认 daemon
   （`GET|PATCH|DELETE /api/agents/:id/sessions` → `agent-sessions-service`）。
   新建会话 `displaySessionId === agentSessionId`（单一 UUID）；`engine/activate`
   **不再**写入 collab.db `managed_chat_*`。delete 成功后仅 best-effort 清 collab 残留。
   daemon 未配置时才回退 collab（legacy spawn）。
4. **群聊 / mission / Swarm**：room 卡片、assignment 推进仍可投影；不写第二套
   pending/turn 状态机。群聊 `turn-executor` 等路径可继续碰 collab，与 1:1 sidebar 分离。
5. Hermes runtime 完全不动：仍走 gateway / swarm-dispatch 路径，managed 合同仅覆盖
   claude-code / codex / cursor / kimi / opencode。
6. Legacy `AgentStreamEvent` 路径（router → bridge → transport →
   `agorax-managed-agent-events.ts` 转换）保留：群聊 managed turn 与旧
   `POST /api/agents/:id/chat` 路由仍消费它；daemon transport 未配置
   （无 `AGORAX_MANAGED_AGENT_URL`）时 router 回退 spawn adapter。

## 与上游合同的已知偏差

| 偏差 | 现状 | 后续 |
| --- | --- | --- |
| composer options | daemon 从本地 Claude settings / Codex config.toml 填充模型目录（`LoadLocalProviderModels`）；无配置时仍空（fail-closed）；未做 AppServer live `model/list` 探测 | 需要时再接 Codex AppServer / OpenCode CLI list |
| client 生成 agentSessionId | 前端生成**一个** UUID，同时作为 display 与 canonical（`displaySessionId === agentSessionId`）提交 activate | 如需与 host 生成策略对齐再调 |
| plan decision | daemon / engine / UI 已接 plan-decision（Codex `implement_prompt`）；非 Codex Host 可能拒绝 | 扩 provider 矩阵 |
| goal control | GET goal 只读已接；goalControl 写路径仍 throw | 单独立项 |
| session fork 未接 | engine 支持，agorax 未暴露 fork saga | 单独立项 |
| edit retry 未接 | engine 支持，无 history revision fence | 单独立项 |
| side conversation 未接 | 无对应产品流程 | 需要时映射为 thread/panel |
| mission MCP 控制通道 | daemon createSession 接受 `mcpEndpoint`/`mcpRunToken`/`mcpToolAllowlist`；Claude CLI adapter 写入 per-run mcp-config；transport 转发 `McpHandshake`；生产 `installAdvanceBridge` 挂在 dispatch-ready | Codex/其他 provider 见能力矩阵；非 Claude 可能 partial |
| capability 上报 | adapter 用 `agentActivitySessionCapabilitiesFromIds` 展开 `Capabilities.values`；未上报时仍为 null（unknown） | 随 composer-options 端点一起补模型目录 |
| **platform skills（目录 + 绑定）** | collab.db `platform_skills` / `agent_skills`；Hermes 物化到 profile skills；managed activate/input 注入 | Skills UI 全 registry agent 分配；Composer `/` 仅列 enabled 绑定；本轮选中不改绑定 | 见 [`docs/platform-skills.md`](./platform-skills.md) |

## 非目标（本次明确不做）

- 不迁入外部桌面 UI / UI System / Workbench；Agorax 保留全部自有外壳。
- 不用 Host Turn settle **替代** Mission MCP `task_complete`（Turn settle 可作执行层终态，但不单独驱动 mission DAG）。
- goal control / session fork / edit retry / side conversation 等 高级合同（goal / fork / edit retry 等）产品化另立（Host REST 已部分出口）。

## 验证命令清单

```bash
# 类型基线（pre-existing 39 处错误，e2e specs / debug tests 等，与重构无关）
pnpm exec tsc --noEmit | grep -c "error TS"   # 期望 39

# 前端 + 服务端相关 vitest（Node 22）
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" \
  pnpm exec vitest run src/screens/chat src/server/agent-runtime \
    src/lib/managed-agent-runtime src/server/group-chat
# 已知 2 个环境敏感失败：agent-session-manager「退休中毒 session」、
# runner-baseline「single drive reproducibility」——与本重构无关

# 各包 node --test（activity-core / daemon-adapter）
(cd packages/agent-activity-core && pnpm test)
(cd packages/agent-activity-daemon-adapter && pnpm test)

# src 下 node:test 约定文件（*-node-test.ts，vitest 不收集）
node --test --experimental-strip-types \
  src/lib/managed-agent-runtime/interactive-answer-payload-node-test.ts

# daemon（改动涉及的 package）
(cd agorax-agent-daemon && go test ./...)
```

已知环境注意：

- vitest jsdom 已从 27 降到 25（修 `html-encoding-sniffer ERR_REQUIRE_ESM`）。
- 仓库 `.env` 配置 `AGORAX_MANAGED_AGENT_URL` 时，router 测试用 `vi.stubEnv` 钉空，
  断言的是「transport 未配置」回退路径。

## 前端 canonical-kind 映射修复（2026-09-18）

**问题**：daemon 已按 canonical 合同输出 `tool_call`（payload `toolName`/`input`/`output`/`error`）
与 `reasoning`（payload `text`/`content`）消息（见
`agorax-agent-daemon/packages/agent/daemon/runtime/reporter_message.go`），但
`src/screens/chat/lib/managed-agent-engine.ts` 只识别旧 shim kind `tool` 且读
`payload.name`/`payload.arguments`。后果：工具调用不进活动工具区、不按工具卡片渲染；
reasoning 被当普通文本，无折叠思考块。

**修复**（仅 adapter 层，UI 组件零改动——`MessageItem`/`TuiActivityCard` 的
thinking 折叠块与工具卡片本就已消费这些 content part）：

| canonical | ChatMessage 投影 | UI 路径 |
| --- | --- | --- |
| `tool_call`（兼容 legacy `tool`） | `content:[{type:'toolCall',id: messageId, name: toolName, arguments: input}]` + 顶层 `toolName`/`details:{input,output?,error?}`/`isError?` | tool-only 消息经 `buildDisplayEntries` 挂到下一条 assistant 文本 entry 的 `attachedToolMessages`，工具卡片由 `attachedToolSections` 渲染（`toolName` 定型、`readToolArgs(details)` 取参、output/error 进卡片） |
| `reasoning` | `content:[{type:'thinking', thinking: text}]`（payload 按 `text→content→message→body→displayPrompt→title` 回退取值） | 独立 entry → `TuiActivityCard` 思考折叠区（默认收起、streaming 时显示计时与状态） |
| `activeToolCalls` | kind ∈ {`tool_call`,`tool`} 且 status 未终结（`completed/failed/canceled/error` 剔除） | `ThinkingBubble` "Using: X" 与流式活动区 |

**payload key 合同**（与 daemon message projection 对齐）：tool_call 用
`payload.{toolName|name, input|arguments, output, error|errorMessage}`；reasoning 用
`payload.{text|content|message|body|displayPrompt|title}`。

**回归测试**：`managed-agent-engine.test.ts`（canonical tool_call active 列表、legacy kind
兼容、reasoning→thinking、settled output/error 字段）；`chat-message-list.test.tsx`
（managed 消息形状经 `buildDisplayEntries` 挂到后续文本 entry 的集成契约）。

**已知限制**：turn 以 tool-only 消息收尾且无后续 assistant 文本时，工具卡片不进时间线
（`buildDisplayEntries` 尾挂规则 + `getTrailingToolOnlyTurnSummary` 未接线，属常规
chat 路径的既有行为，非本次引入）。settled 工具卡片的输出经 `details` JSON 兜底展示，
输入输出同卡，后续可参照 daemon 工具内容展开约定 的 rendererKind 分工具类型精修。

## 前端未接入能力审计（2026-09-18，待评审）

> 状态：只读审计完成，供评审排期。结论三类：**纯前端缺口**（数据已映射，接 UI 即可）、
> **双端缺口**（daemon 无 REST 端点，需先补合同）、**前端假象**（UI 给了选项但不生效）。

| 能力 | 后端状态 | 前端现状 | 接法 | 优先级 |
| --- | --- | --- | --- | --- |
| reasoning effort 静默丢弃（**前端假象**） | daemon create/input 请求体无 effort 字段（`daemonDtos.ts:416-431`）；`activate` 路由只收 model（`src/routes/api/agents/$agentId/engine/activate.ts:53`） | thinkingLevel 选择器存在并随 `submit` 传 `options.effort`（`managed-agent-chat-view.tsx:82-100`），但 `activateSession`/`sendInput` body 未转发 | daemon 请求契约加 `reasoningEffort` → 路由转发 → engine 补发 | **P0**（唯一"选项无效"假象） |
| turn fileChanges（diff 统计） | Go 已从 provider payload 归一化并持久化（`runtime/tool_file_changes.go`、`cmd/agorax-agentd/main.go:464`）；adapter 已映射（`mappers.ts:110`） | `selectManagedAgentChatState` 不暴露；`src/screens/chat` 0 引用 | chat state 加 `latestTurn.fileChanges`，消息列表底部渲染文件数/增删行统计条 | P1 |
| noticeCommand 语义（compact/review/undo/goal） | daemon 写入 message Semantics（`runtime/reporter.go:330-390`）；adapter 已映射（`mappers.ts:158-164`） | `toChatMessage` 忽略 `semantics`，进行中/完成无渲染 | mapper 识别 `semantics.noticeCommand(+Status)` 输出轻量系统行（如 "Compacting context…"） | P1 |
| 消息增量 toolOutput 流式展示 | daemon WS 发 `message_delta`（`toolOutput set/append_text`）；core coordinator 应用到 optimistic overlay（`workspaceEventCoordinator.ts:319-366`） | hook 直读 `engine.getSnapshot()`，从不调用 `coordinator.project()`，optimistic 增量被丢弃，要等 reconcile 折叠 | hook 订阅 coordinator 投影（或把 optimistic message dispatch 进 engine） | P1 |
| session usage / token 用量 | daemon `SessionMetadata.usage`；adapter 映射 `session.usage`；core `resolveAgentActivityUsage`（`usage.ts`）现成 | 聊天视图无用量展示（现有 usage-meter 是 Hermes gateway 形状，非 canonical） | composer/hint 区挂 context 百分比 + quota 条 | P1 |
| session 列表 / resumable | **已终态**：`GET /api/agents/:id/sessions` 对 managed 只读 daemon `listSessions`（按 `agentTargetId` 过滤）。`engine/sessions` 仍可用作调试。Go `Resumable` 投影与 UI 徽章可再补 | sidebar 不再读 collab 列表 | daemon 投影真 `Resumable` + UI 标识 | P2 |
| session rename/delete | **已终态**：sidebar `PATCH`/`DELETE /sessions/:id` → daemon `updateTitle` / `deleteSession`；成功后顺带清 collab 残留。engine title/delete 路由并存 | — | pin UI 等仍待接 | done |
| session pin | daemon JSON 有 `PinnedAtUnixMS`（`daemonDtos.ts:102`），adapter 已映射（`mappers.ts:90`） | 无 pin UI、effect unavailable | daemon 补 pin 端点 + sidebar 置顶排序 | P2 |
| composerOptions（模型目录/reasoning 选项/权限模式） | adapter 保留完整映射等 daemon 端点（`composerOptions.ts`）；Go `modelcatalog.ProjectComposerCatalog` 无 REST 出口；`permissionConfig` 恒 `{configurable:false}` | 前端用 legacy `/models` 路由 + 本地存储；`loadComposerOptions` 无人调用 | daemon 加 composer-options 端点 → engine `loadComposerOptions` → composer 换 canonical 数据源（可拆分） | P2 |
| goal 控制 | codex adapter 维护 goal（`codex_appserver_event_info.go:257`）；session `goal` 已映射；core engine 有全套 goalControl reducer/selector | 前端从不调用 `engine.goalControl`，无 goal UI；server adapter throw；daemon 无 goal 路由 | 可先消费 `session.goal` 做只读展示（成本低）；控制面等 daemon 端点 | P2 |
| session fork | core 有完整 fork 类型 + `providerForkBindingAllowsAttempt`；turn `ProviderForkBindingAvailable` 已映射；daemon 无端点 | 无 fork 入口 | 等 daemon fork 端点 → 接 engine fork 命令 | P2 |
| childSessions（subagent 投影） | canonical 有 root/child 血缘（`mappers.ts:37-43`）；daemon activity 聚合**不含 childSessions 数组**；adapter 与前端 hydrate 均硬编码 `[]`（`sessionDetail.ts:86`、`managed-agent-engine.ts:205`） | 无 subagent 面板 | daemon 先投影 child 会话 → 前端做 subagent 视图 | P2 |
| session.title（daemon 自动标题） | daemon 有 Title + 自动生成 | `activeTitle` 取首条用户消息截 40 字（`use-managed-agent-chat.ts:583-587`） | 直接用 `selectEngineSession(...).title`，fallback 现有逻辑 | P2 |
| capabilities 展示 | daemon 有快照，但 adapter 映射 `capabilities: null`（`mappers.ts:63-66`，CapabilitySnapshot 未展开） | view hint 恒显 "Capabilities unknown" | mapper 用 core helper `agentActivitySessionCapabilitiesFromIds`（`capabilities.ts:40`）展开 values | P2 |

**已对齐良好的能力**（不需动）：activate/sendInput/cancelTurn/respondToInteraction 四
effect + cancel 状态机投影；SSE→WS 桥与重连 reconcile；message_update 内联折叠 +
afterVersion 分页；interactions approval/question 卡片与 settlement 状态机；tool_call /
reasoning 消息映射（本次修复）；错误上浮（agent_visible_error/agent_system_notice/
terminalTurn failed）；turn phase → isStreaming；activeToolCalls；engine 提交准入与
prompt 队列计数；promptContent 附件块；provider-status / provider install。

**评审建议**：P0 的 reasoning effort 是唯一"给了选项不生效"的假象，建议最先修（改动小：
daemon DTO + 两条路由转发 + engine body 字段）。P1 里 fileChanges / usage /
noticeCommand 三个都是"数据已在前端手里，只差展示"，可合并成一个"turn 元数据展示"
小迭代。其余 P2 多数卡在 daemon REST 端点，需先排 daemon 侧合同。
