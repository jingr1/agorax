# Agorax 架构与技术路线

> **产品名**：**Agorax** — AI Agent 的公共广场
>
> **适用范围**：整个仓库（前端、服务端、Swarm 多智能体系统、LangGraph 编排器、群聊、部署设施） 
>
> **关系说明**：`docs/swarm/SWARM_ARCHITECTURE_OVERVIEW.md` 只覆盖 Swarm 子系统且基线为 v2.3.0，本文是全仓总览（含架构评审与优化路线）；Agent/Swarm 的合同细节（roster、runtime、handoff、escalation）以 `[AGENTS.md](../AGENTS.md)` 和 `[agents.yaml](../agents.yaml)` 为真相源。代码目录见 `[CODE_STRUCTURE.md](CODE_STRUCTURE.md)`。

---

## 1. 项目定位

Agorax 是 AI agent 的**公共广场 / 多智能体协作控制面**：把聊天、任务编排、多 agent 协作流水线、文件/内存/skills/终端管理整合进一个 Web 应用（外加 Electron 桌面壳），让不同专长的 Agent 在对话中协作求解复杂问题。它可以同时驱动两类 agent：

- **Hermes agents**：本机 tmux 长驻的语义化专家（orchestrator / researcher / architect / developer / writer / learning）
- **Managed agents**：外部 CLI agent（Claude Code、Codex、opencode、kimi code、Cursor等，经统一 adapter 接入）

编排层分两代：**Phase 1 持久 orchestrator**（Node 侧 swarm 控制循环，agents.yaml 统一 roster + tmux 分发）和 **Phase 2 LangGraph 编排器**（Python，workflow YAML 声明状态机，Human Gate 暂停/恢复）。

---



## 2. 全景与进程拓扑



### 2.1 端口地图


| 端口       | 进程                              | 说明                                                                 |
| -------- | ------------------------------- | ------------------------------------------------------------------ |
| **6734** | Agorax（`pnpm dev:ui` / `vite dev`） | 主应用；dev 默认 6734（`strictPort`）                                      |
| **8642** | Hermes Gateway                  | 规范实例 `hermes gateway run`；worker profile 的 chat/models/MCP/job 运行时 |
| 8643+    | 按 profile 分配                    | `src/server/gateway-ports.ts` 按 profile 名顺序分配并持久化                  |
| 9119     | Hermes Dashboard                | **可选**外链，仅分析，不做能力门控                                                |
| 3847     | Electron 内嵌 server              | `electron/prod-server.cjs`                                         |




### 2.2 一次典型协作的进程关系

```
┌────────────────────────── 单机 ──────────────────────────┐
│  Browser / Electron                                      │
│    │  REST + SSE                                         │
│    ▼                                                     │
│  Agorax (:6734, Node 22, TanStack Start 全栈)             │
│    │  spawn / httpx 回调                                  │
│    ├──► LangGraph Orchestrator (Python venv, LangGraph)   │
│    │       checkpoint: ~/.hermes/langgraph-checkpoints.db │
│    ├──► tmux server ──► hermes chat --tui (worker profile)│
│    ├──► managed：agorax-agent-daemon（REST+WS，见 §5.4）；  │
│    │    无 daemon 时 spawn claude -p / codex -p 子进程      │
│    └──► Hermes Gateway (:8642) ◄── worker profile 回连    │
└──────────────────────────────────────────────────────────┘
```



### 2.3 顶层目录导览


| 区域             | 路径                                                     | 内容                                                                                                         |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 前端             | `src/screens/` `src/components/` `src/stores/`         | 页面（chat、group-chat、swarm、mission-control、tasks…）、~70 共享组件、zustand stores                                   |
| API 路由         | `src/routes/api/`                                      | ~90 个 TanStack Start 文件路由（server handlers）                                                                 |
| 服务端逻辑          | `src/server/`                                          | ~120 个平铺模块 + 6 个子系统目录（`agent-runtime/` `group-chat/` `task-pipeline/` `mcp/`+`mcp-hub/` `oauth/` `usage/`） |
| Agent/Swarm 合同 | `agents.yaml` `agents/` `skills/`                      | roster、运行时声明、角色 SOUL 源、角色 skills                                                                           |
| LangGraph      | `hermes_langgraph_orchestrator/`                       | Python 编排器（workflows/*.yaml）                                                                               |
| 记忆             | `memory/`                                              | swarm 三层记忆（missions / handoffs / worker 草稿）                                                                |
| 运行时状态          | `.runtime/`                                            | `swarm-missions.json`、`local-sessions.json`、`tool-artifacts/`                                              |
| 部署             | `docker/` `nix/` `electron/` `.devcontainer/` `macos/` | 容器 / Nix / 桌面 / 开发容器 / launchd                                                                             |
| 周边             | `e2e/` `scripts/` `docs/`                              | e2e、运维脚本、文档                                                                                                |


---



## 3. 技术栈总览


| 层       | 选型                                                                                                            | 备注                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 前端框架    | React 19 + **TanStack Start**（SSR 全栈）+ TanStack Router（文件路由）+ TanStack Query                                  | `routeTree.gen.ts` 为生成文件                             |
| UI / 样式 | Tailwind CSS 4（vite 插件）、@base-ui/react、framer-motion、cva/clsx/tailwind-merge                                  | `default-theme.css` / `scifi-theme.css` 双主题          |
| 富媒体     | Monaco、Excalidraw、Mermaid、xterm.js、shiki、recharts、react-joyride                                               | —                                                    |
| 状态管理    | zustand（`src/stores/`）                                                                                        | chat / mission / task / workspace / terminal-panel 等 |
| 服务端     | **无独立框架**：TanStack Start 文件路由 server handlers（`createFileRoute('/api/ping')({ server: { handlers } })`）       | 不是 Express/Hono；`src/server/` 是被路由 import 的模块层       |
| 实时推送    | **SSE / fetch ReadableStream**（`chat-event-bus` 内存 pub-sub）                                                   | `ws` 库仅作客户端连 gateway WS；vite 对长连接路由豁免 socket timeout |
| 数据库     | **SQLite**：better-sqlite3 → node:sqlite → sqlite3 CLI 三级 fallback（`src/server/sqlite-helper.ts`），无 ORM        | schema 为各模块内联 `CREATE TABLE` / 迁移文件                  |
| 桌面      | Electron 40 + electron-updater + electron-builder                                                             | `electron/` 四件套（见 §7）                                |
| 编排器     | Python ≥3.10 venv：langgraph 1.x + langgraph-checkpoint-sqlite + langchain-openai（DeepSeek 分类）+ httpx + pyyaml | `hermes_langgraph_orchestrator/`                     |
| 工具链     | Node ≥22、pnpm 10.5.2、Vite 7、TypeScript 5.7（strict）、vitest 3 + jsdom、Playwright、eslint 10、pytest               | `.npmrc` `legacy-peer-deps=true`                     |


---



## 4. 应用架构



### 4.1 运行时入口

- **Dev**：`pnpm dev:ui` = `PORT=6734 vite dev`。`vite.config.ts`（承载大量运维逻辑）插件链：`vite-tsconfig-paths` → `@tailwindcss/vite` → `tanstackStart()` → `@vitejs/plugin-react`，外加自写插件（dev no-cache、CSP/healthcheck/`agorax-dev-server`、客户端 env 替换、构建后拷贝 `pty-helper.py`）。
- **生产**：`pnpm build`（Vite 产出 `dist/client` 静态资源 + `dist/server/server.js` Web 标准 handler）→ `node server-entry.js`（仓库根，原生 `node:http`）：强制加载 `.env`、静态资源优先、其余转 SSR handler、注入 CSP 等安全头；HOST 非回环时强制 `HERMES_PASSWORD`；同时监听 `127.0.0.1` 与 `::1`。
- **Electron**：`pnpm electron:bundle-server` 用 esbuild 把 `dist/server/server.js` 打成单文件 CJS（`electron/server-bundle.cjs`），桌面壳内嵌运行。



### 4.2 vite.config.ts 内嵌的运维职责


| 职责           | 要点                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Dev 自动拉起     | Hermes gateway（`src/server/gateway-pool.ts`，可用 `AGORAX_AUTO_START_AGENT=false` 禁用）                                      |
| 代理表          | `/api/hermes-proxy`→`$HERMES_API_URL`（默认 :8642）                                                                                      |
| 安全头          | 全量 CSP / X-Content-Type-Options / Referrer-Policy（与 `src/lib/csp.ts`、`__root.tsx` meta 三处保持同步）                         |
| Watch ignore | `.runtime/**`、`.tanstack/**` `agents.yaml`、`*.log` 等，防止运行时文件触发 HMR                                                     |
| Dev 特例       | `PATCH /api/swarm-roster` 在 dev middleware 直写 `agents.yaml`（绕开 dev 模式 SSR PATCH 挂起）                                    |




### 4.3 实时性模型

服务端推送统一走 **SSE**：`src/server/chat-event-bus.ts`（globalThis 单例 pub-sub）→ `GET /api/chat-events`（支持 `?roomId=` 过滤，30s 心跳）→ 前端 `EventSource`（如 `src/lib/use-group-chat-events.ts`）。`ws` 依赖只用于主动外连（managed-agent transport、engine session events）。流式 agent 回复（`/api/agents/:id/chat`、send-stream）用 fetch ReadableStream。

### 4.4 安全模型

- `server-entry.js` 层：非回环绑定强制密码、CSP、API 响应 `no-store`。
- 路由层：`src/server/auth-middleware.ts`（`requireLocalOrAuth`）。
- Managed adapter：per-run 临时 MCP config + `HERMES_MCP_TOKEN`；非 loopback 明文传输会告警。

---



## 5. 核心子系统



### 5.1 Swarm 多智能体系统（Phase 1 控制面）

**真相源分层**：`agents.yaml`（统一 agent roster/runtime）→ `~/.hermes/profiles/<agent-id>/`（运行时 profile）→ `~/.local/bin/`（wrapper）。

- **统一 agent registry**（`agents.yaml`，`version: 2` + `agents:`）：每个 agent 同时包含角色、模型、tools/skills/capabilities、Swarm 门控和 runtime 启动字段。`runtime ∈ hermes | claude-code | codex | deepseek-harness | opencode`；非 hermes + `execution: ssh` 为硬错误（SSH 本地性仅限 Hermes）；managed runtime 写 `command/args`。schema 读写见 `src/server/swarm-roster.ts` 和 `src/server/agent-runtime/agents-config.ts`。
- **分发**（`src/routes/api/swarm-dispatch.ts` + `src/server/swarm-tmux-delivery.ts`）：
  - Session：`tmux new-session -d -s swarm-<workerId>`；存在且健康则复用，退化成 bare shell/zombie 则 kill 重建；TUI 用 capture-pane markers 检测 ready，CLI 检测 `~$` prompt。
  - `HERMES_SWARM_TMUX_MODE`：**tui（默认/推荐）** session 内 `exec hermes chat --tui`，完整 prompt 先写 `<profile>/swarm-task.md`，再 bracketed-paste（`\x1b[200~…\x1b[201~`）一行短指令，500ms 后 `C-m` 提交（明确不用 C-c，会杀 TUI）；**cli** session 内 `bash -l`，每轮 `send-keys` 跑 `hermes chat -q`。
  - oneshot：`HERMES_SWARM_FORCE_ONESHOT=1` 或 tmux 不可用时 fallback；`HERMES_SWARM_MOCK_BIN=<dir>` 让 wrapper 优先找 mock（测试路由）。
  - Checkpoint 等待：派发前记 runtime.json + state.db 最新 checkpoint 为 baseline，`waitForFreshCheckpoint` 轮询新 checkpoint 后 attach。
- **Profile 同步**（`scripts/sync-swarm-profiles.mjs`）：按 agents.yaml 重写各 profile `config.yaml` 的 toolsets、生成 `SOUL.md`/`memory/IDENTITY.md`、复制 agent skills 到 profile 和 `~/.hermes/skills/swarm/`、生成 `~/.local/bin/` wrapper。Profile 内容：`config.yaml`（完整 Hermes Agent 配置）、`SOUL.md`、`skills/`、`state.db`（聊天历史，WebUI 读取源）、`logs/`、`cron/` 等。
- **Agent 管理**（`/agents` 详情抽屉 + `/api/agent-registry`）：创建 Hermes agent 时调用现有 `createProfile()` 创建或认领 `~/.hermes/profiles/<profile>`，再写入 `agents.yaml`；Codex/Claude Code 只写 managed runtime declaration，不创建 Hermes profile。删除 Hermes agent 同时删除其 profile，编辑不允许在原地改变 runtime 或 Hermes profile 绑定，避免 agent declaration 与 profile 分离。registry 字段（role / specialty / command / args）在 Agents 详情 Identity 页编辑。
- **收割与记忆**：worker 产出结构化 checkpoint（STATE/RESULT/BLOCKER/NEXT_ACTION…，`src/server/swarm-checkpoints.ts`），`swarm-harvest.ts` / `swarm-background-harvest.ts` 主动/周期收割；共享记忆三层布局（`memory/swarm/missions/<id>/` 归档、`memory/handoffs/swarm/` 协作总线、`memory/swarm/<worker>/` 草稿，`src/server/swarm-memory.ts`），长期知识由 learning 经 `learning-wiki-ingest` 写入 `~/wiki`。
- **Swarm UI**（`src/screens/swarm/`，路由 `/swarm`；`/swarm2` redirect）：worker/orchestrator 卡片、kanban 看板、live chat（对 tmux 内 worker 直聊）、task queue、activity feed、wires 连线图、memory/artifacts/reports 面板、Human Gate 面板（阻塞详情 + 继续执行/中止/继续等待）、tmux attach 终端。
- **控制面分层原则**（`src/server/gateway-capabilities.ts`）：控制平面 = 本地 profile 目录；运行时 = 当前 profile 的 gateway；Dashboard 只是可选外链。



### 5.2 LangGraph 编排器（Phase 2）

Python 包 `hermes_langgraph_orchestrator/`，把 mission 执行建模为**声明式 workflow + 通用循环图**，替代 Phase 1 的 orchestrator 自由路由。

- **Workflow YAML DSL**（`workflows/radw.yaml`、`rdi.yaml`、`research_only.yaml`、`design_implement.yaml`）：顶层 `name/version/entry/description/transitions[]/blockers/settings`。transition = `from` + `on`（`verdict` / `review_outcome` / `metadata`，AND 语义，逗号分隔表 OR）+ `to`（`null`=终止）+ 可选 `max_iterations`（该转移循环上限）。`blockers` 声明 `escalate`（→ Human Gate）与 `retry`（自动重试）类别；`settings.max_iterations` 为全局路由迭代上限。
- **radw 语义**（research → architect → developer/writer → review → harden）：architect 按 metadata `executor`/`deliverable_type` 选道；**Gate C**：`changes_requested` → 同 executor，`max_iterations: 3`，超限 → Human Gate；**Gate H**：`approved` 且 `harden_outcome: pass` → 终止（规则必须排在裸 approved 之前），`fail` → 同 executor ≤2，缺 harden → Human Gate。
- **图结构**（`graph.py`）：`START → init → ensure_sessions → dispatch_assignments → wait_for_checkpoints → classify → route →{human_approval | finalize | ensure_sessions | wait}`，`interrupt_before=["human_approval"]`。**没有 per-worker 节点**——worker 只是 assignment 的 `worker_id`，图是"派发 → 等 checkpoint → 分类 → 路由"的通用循环。
- **分类**：`classify_workers` 是唯一的 LLM 调用（langchain-openai 指向 DeepSeek，`HERMES_ORCHESTRATOR_MODEL` 默认 `deepseek-v4-pro`），有规则 fast-path；产出 verdict（DONE/BLOCKED/NEEDS_INPUT/HANDOFF/SKIP）。
- **与 Node 集成**（`src/server/langgraph-orchestrator.ts`）：detached spawn `python -m hermes_langgraph_orchestrator`（venv 解析顺序：包内 `.venv` → `HERMES_LANGGRAPH_PYTHON` → PATH python3；`PYTHONPATH=<workspace root>`；日志 `~/.hermes/logs/langgraph-<missionId>.log`）。Python 侧经 httpx 回调 Agorax API（`/api/swarm-dispatch`、`/api/swarm-tmux-start`、`/api/swarm-missions`、`/api/swarm-orchestrator-loop`）。路由：`src/routes/api/swarm-langgraph/{run,resume,status,cancel,mission-event}` + 旧版平面端点 `orchestrator-{active-gates,state,resume}`。
- **Human Gate**：route 置 `langgraph_needs_human=True` → 图在 human_approval 前暂停，state 持久化到 `~/.hermes/langgraph-checkpoints.db`（AsyncSqliteSaver）。恢复：`approved` 把 pending assignments 写回继续；`abort` 清空并 goto finalize。`wait_for_checkpoints` 轮询 90×10s，staleMinutes（默认 30，被 `HERMES_LANGGRAPH_CONTINUE_WAIT_MINUTES` 覆盖）耗尽时合成超时 BLOCKED checkpoint 走 retry/escalate，且有防呆（stale synthetic checkpoint 不进 human gate）。
- **测试**：`tests/test_langgraph_orchestrator.py`（~30 用例）全部走 `mock_services.py`（合成 checkpoint 序列，profile：generic/blocked_once/cdc/human_gate），不碰真实 API；`logs/compare_*.json` 是 swarm↔LangGraph 路由对齐 eval 记录（同一 checkpoint 双决策对比）。



### 5.3 群聊系统

多 agent + 人混聊的房间模型（`src/server/group-chat/` + `src/routes/api/rooms*` + `src/screens/group-chat/`）。**"公共广场"的产品载体**：房间即议事厅，roster agent 即广场成员。

- **存储**（collab.db，见 §5.6）：rooms / room_participants / room_messages / room_watermarks（每成员已见水位）/ room_summaries / pending_turns。
- **驱动**（`group-chat-runner.ts`）：用户 POST 消息 → `insertMessage` + SSE 事件 → fire-and-forget `triggerRoomRun` → `driveRoom`（epoch+running 互斥锁）→ `runGroupChatRounds`（Bot Mode：3 rounds / 10 messages / 2 continuations 上限）；5s tick 只做 stranded harvest 与 pending-turn 过期，不按水位差重驱动（防死循环）。
- **Turn 执行**（`turn-executor.ts`）：按 runtime 分流——Hermes 成员走 profile gateway 上的 "Bot Chat" session（`agent-session-manager.ts`，SQLite `group_chat_sessions` 持久化，崩溃恢复），SSE 流式，软截止 3min（有事件顺延）硬顶 20min，**超时不 abort**，标记 stranded 后由 tick/round harvest 从 session transcript 补发（"late, never lost"）；managed 成员 `runManagedTurn`（spawn 进程、drain 事件、硬超时 interrupt）。
- **Prompt 组装**（`prompt-builder.ts`）：delta 消息行 + 房间摘要（超阈值时生成）+ 群规则 + `Room workspace: <path>` 行。**Hermes 只把 cwd 写进 turn prompt，不改 profile 全局 workspace**；managed 才 `startRun({ cwd })`。
- **Workspace 双模式**：ad-hoc（房间 `workspacePath` sticky）；任务型（绑 missionId 后只读派生：worktree 模式走 mission worktree，否则 `projects.yaml` 的 `project.repo`）。`resolveRoomCwd` 每轮 drive 算一次。
- **Human gate**：`pending_turn_service.ts`（needs_input / blocked / approval / review），UI 为 `PendingTurnCard`。
- **事件回传**：纯 SSE（`group_chat_message` / `group_chat_reply` / `group_chat_failed`），前端经 `use-group-chat-events.ts` 订阅后增量拉取。



### 5.4 Agent Runtime（managed 运行时）

统一接入外部 CLI agent（claude-code / codex / cursor / kimi / opencode；`src/server/agent-runtime/`）。2026-09 起为 **daemon bridge + canonical engine 两层架构**：Agorax 自有 `agorax-agent-daemon` + `packages/agent-activity-core` / `packages/agent-activity-daemon-adapter`；迁移记录见 `docs/managed-agent-daemon-mapping.md`。

```text
┌─ daemon host（agorax-agent-daemon）──────────────────────────────────┐
│  生命周期 owner：Session/Turn/Interaction 真相源在其 SQLite            │
│  REST  /v1/workspaces/{ws}/agent-sessions（list/create/input/cancel/ │
│        interactions/activity[afterVersion,limit]/title/pin/settings/│
│        delete/composer-options/plan-decisions/goal）                 │
│  WS    /v1/events/ws  activity envelope（id/topic/version/emittedAt/ │
│        scope/payload；payload.eventType ∈ message_delta|message_update│
│        |turn_update|interaction_update|session_reconcile_required）  │
└──────────────┬───────────────────────────────────────────────────────┘
               │ HTTP + WS（PascalCase JSON，DTO 由 @agorax/agent-activity-daemon-adapter 映射为 canonical）
┌──────────────▼─ 服务端 bridge（src/server/agent-runtime/ + 路由）─────┐
│  agorax-managed-agent-http-client：实现 core AgentActivityAdapter     │
│  （listSessions/listSessionMessages(afterVersion)/createSession/     │
│  sendInput/submitInteractive/cancelTurn 的 daemon 方言 typed client） │
│  events.ts（SSE）：按 workspace 共享一条 daemon WS（引用计数 + 断线    │
│  指数退避重连），全帧转发给匹配 agentSessionId 的浏览器订阅             │
│  三类 SSE 帧：connected / activity（完整 envelope）/ reconnect        │
└──────────────┬───────────────────────────────────────────────────────┘
               │ SSE
┌──────────────▼─ 前端 canonical 层（src/lib/managed-agent-runtime/）───┐
│  event-bridge：envelope 一致性校验 → queueMicrotask 批处理 →          │
│  workspaceEventCoordinator.ingestEvent → engine（inline 应用）        │
│  reconcile-port：detail + afterVersion 分页读，喂 sessionReconcileExecutor│
│  command port（managed-agent-engine.ts）：activateSession/sendInput/  │
│  cancelTurn/respondToInteraction → typed settlement                 │
└──────────────┬───────────────────────────────────────────────────────┘
               │ engine 语义方法 + canonical 合同
┌──────────────▼─ 消费方（只投影、不双写）──────────────────────────────┐
│  src/screens/chat/（1:1 managed chat UI：interaction kind 分支卡片、   │
│  answersByQuestionId payload、composer submit availability/queue）    │
│  群聊 turn-executor（canonical interaction_update → room 卡片，        │
│  回写 POST /api/rooms/:roomId/messages/:messageId/interaction-response）│
└───────────────────────────────────────────────────────────────────────┘
```

- **事件 = 提示，canonical 读兜底**：WS/SSE 事件带完整 payload，前端 envelope 校验 + 版本连续性判断后 inline 应用；帧解析失败、版本缺口、断线重连 → 原地 dispatch reconcile，经 detail / `afterVersion` 增量读修复。daemon WS 对滞后订阅者丢帧时发 `session_reconcile_required`。
- **状态所有权**：daemon host = Session/Turn/Interaction 生命周期 owner（SQLite 真相源）；activity-core engine = 前端 canonical state owner（不可变 snapshot + selectors）；群聊 / mission / Swarm / sidebar 只投影，不双写生命周期事实。
- **Legacy 兼容路径**：`router.ts` + `agorax-managed-agent-bridge.ts` + `transport.ts`（daemon WS → `agorax-managed-agent-events.ts` 的 canonical→`AgentStreamEvent` 转换）仍为群聊 managed turn 与旧 `POST /api/agents/:id/chat` 路由服务；所有 managed runtime（claude-code / codex / cursor / opencode / kimi）一律走 daemon target，无 `AGORAX_MANAGED_AGENT_URL` 时 slot 为 unavailable。Hermes = `HermesAdapterStub`（只 probe gateway，执行仍走 swarm-dispatch / send-stream）。**Native bridge skeleton**（`hermes-native-bridge.ts`，见 `[docs/hermes-native-bridge.md](./hermes-native-bridge.md)`）定义 `agorax_run_mapping` 与 Create/Send stubs，不替换 stub/tmux。
- **Host REST 出口（daemon）**：session title/delete/pin/settings、composer-options（诚实空目录）、plan-decision、goal 只读已挂到 `agorax-agentd`；Workspace engine 路由与 activity adapter 已接线 rename/delete/pin。
- **回合执行**（`run-managed-turn.ts`）：群聊 managed turn 与 legacy chat 共用；issueRunToken → startRun → drain 事件（软截止顺延、硬顶 interrupt）；pending interaction 阻塞时软截止顺延。
- **汇合推进**（`advance.ts`）：MCP `task_complete` → assignment 状态推进 → 派发下一 stage；内存 promise-chain 串行化（mission 状态在 JSON 文件，无 SQLite 事务保护）。
- **进程治理**：`pid-registry.ts`（spawn 路径的崩溃重挂、SIGKILL interrupt）；`managed-chat-store.ts`（legacy spawn / 群聊仍可写 collab.db managed 会话；**1:1 daemon sidebar 列表与 rename/delete 只认 daemon**，activate 不再写 collab 投影）。



### 5.5 任务管道与 worktree

- **projects.yaml**：显式声明目标 repo（`id/repo/defaultBranch/worktreeRoot/setup/maxConcurrentWorktrees/gitRemote/selfHosted/remotes{host,repo,worktreeRoot,setup}`）。控制面仓库默认禁止，须 `selfHosted: true`；`assertServerNotInWorktreeRoot` 启动自检。
- **git-ops.ts**：统一 `GitContext`（local `git -C` / ssh 只读消费 + rsync 产物回传）。核心能力：`ensureMissionWorktree`（每 mission 一个 worktree + setup + baseRef 盖章）、`commitStage`、`mergeSiblings`（fan-in merge）、`diffRange`、`pushBranchToRemote`、`releaseMissionWorktree`。
- **task-pipeline/**：kanban 卡片 → `instantiatePipeline`（swarm-missions.json 两遍建 mission + 依赖重写）→ worktree 创建 → `dispatchReadyAssignments`（ssh hermes agent 走 remote worktree）；`lane-sync.ts` 把 mission 状态映射回 kanban lane；`review.ts` 解析 Gate C 评审 verdict；`reconcile.ts` 启动时修复 JSON/SQLite 双写漂移。



### 5.6 存储层


| 存储                       | 位置                                                             | 内容                                                                                                                              | 真相源?                                                    |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| collab.db                | 仓库根（`collab-db.ts`，schema_migrations v1–v6）                    | rooms/messages/watermarks/summaries/pending_turns、run_tokens、task_runs、managed_chat_sessions/messages、pid 表、group_chat_sessions | 群聊/会话/run 记录                                            |
| swarm-missions.json      | `.runtime/`                                                    | mission / assignment 状态、依赖 DAG                                                                                                  | **mission 状态真源**（已知 JSON/SQLite 双写负债，`reconcile.ts` 缓解） |
| langgraph-checkpoints.db | `~/.hermes/`                                                   | LangGraph state + needs_human 标记                                                                                                | Phase 2 编排状态                                            |
| usage.db                 | `~/.hermes/workspace/`（`getStateDir()`，`AGORAX_STATE_DIR` 可覆盖） | token/费用（`usage-db.ts`）                                                                                                         | 用量                                                      |
| worker state.db          | `~/.hermes/profiles/<id>/`                                     | worker 聊天历史（WebUI/收割读取源）                                                                                                        | worker 会话                                               |
| 记忆                       | `memory/`（`SWARM_MEMORY_ROOT` 可覆盖）                             | missions 归档 / handoffs 总线 / worker 草稿；`memory/goals/` sprint 目标                                                                 | 共享记忆                                                    |
| 长期知识                     | `~/wiki`（`WIKI_PATH`）                                          | learning ingest 的领域知识                                                                                                           | 长期知识                                                    |


---



## 6. 关键数据流



### 6.1 LangGraph mission 生命周期（radw）

```
POST /api/swarm-langgraph/run ──► spawnLanggraphDetached(python -m …)
  init_mission          载入 workflow + roster 校验 + 种子 entry 派发
  ensure_sessions       POST /api/swarm-tmux-start（worker tmux session）
  dispatch_assignments  fire-and-forget POST /api/swarm-dispatch（prompt→tmux TUI）
  wait_for_checkpoints  轮询 /api/swarm-missions + 驱动 harvester（90×10s）
  classify_workers      LLM/规则 → verdict（DONE/BLOCKED/…）
  route_workflow        按 transitions 路由；环触顶/blocker escalate → needs_human
       │
       ├─ 正常 ──► 下一 worker 的 ensure_sessions（循环）
       ├─ 全部完成 ──► finalize_mission（写 logs/execute_*.json、重置 runtime）
       └─ needs_human ──► interrupt（图暂停，state 入 checkpoints.db）
                              ▲
        Dashboard /swarm2 Human Gate 面板 或 POST /api/swarm-langgraph/resume
        { action: approved | abort, choice, continueWaitMinutes }
```



### 6.2 群聊一次 turn

```
用户 POST /api/rooms/:id/messages
  → insertMessage(human) + SSE group_chat_message + triggerRoomRun(fire-and-forget)
  → driveRoom：resolveRoomCwd → maybeSummarizeRoom → runGroupChatRounds
      对响应成员逐个 runMemberTurn：
        buildTurnContext(delta, summary, "Room workspace: …")
        hermes:  profile gateway session → SSE stream（软 3min/硬 20min）
                 超时 → stranded → harvest 从 transcript 补发
        managed: adapter.startRun({cwd}) → drain AgentStreamEvent
      reply → insertMessage(agent) + SSE group_chat_reply
      pass → 只推进 watermark；failed → watermark + SSE group_chat_failed
  → finishDrive：全员 watermark 对齐
前端：useGroupChatEvents 订阅 → 增量拉消息渲染
```



### 6.3 Managed 1:1 chat turn（canonical engine 路径）

```
首次提交（canonical session 尚不存在）
  → command port POST /api/agents/:id/engine/activate{displaySessionId, agentSessionId(client 生成), message}
  → ensureManagedChatSession（collab.db 关联投影）+ startManagedChatRun
  → daemon 建 canonical session → 返回 runId + 当前 activity 聚合（PascalCase）

后续交互（engine 语义方法 → typed settlement）
  submitPrompt     → POST .../engine/session/:sid/input     → {result, activity}
  stopSession      → POST .../engine/session/:sid/turns/:tid/cancel
  respondToInteraction → POST /api/agents/:id/interactions/:sid/:tid/:requestId

观察路径（与命令路径并行，事件 = 提示）
  EventSource .../engine/session/:sid/events（connected/activity/reconnect）
  → envelope 校验 → workspaceEventCoordinator → engine inline 应用
  帧损坏/版本缺口/断线 → session/reconcileRequested
    → reconcile-port 读 .../detail + .../messages?afterVersion&limit 修复
```

legacy `POST /api/agents/:id/chat`（SSE spawn 路径）仍保留供兼容，前端已不再调用。

---



## 7. 部署与分发


| 形态       | 路径                                                                      | 要点                                                                                                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生产（Node） | `server-entry.js`                                                       | 静态优先 + SSR 转发；loopback 双栈绑定；非回环强制密码                                                                                                                                                                                                                                       |
| Docker   | `Dockerfile` + `docker-compose.yml` + `docker/entrypoint.sh`            | 多阶段（node:22-slim 构建 → 运行时含 python3/tini/gosu，非 root `workspace` 用户 UID 10010）；entrypoint 按 `HERMES_UID/GID` 对齐挂载属主后 gosu 降权；compose service `agorax`，预构建镜像 `ghcr.io/outsourc-e/agorax`（过渡期与仓库名镜像双推）+ `nousresearch/hermes-agent`；数据卷 `hermes-workspace-files` 保留旧名（数据连续性） |
| Nix      | `flake.nix` `nix/package.nix` `nix/module.nix`                          | NixOS module（systemd，依赖独立 hermes-agent gateway）                                                                                                                                                                                                                           |
| Electron | `electron/main.cjs` `preload.cjs` `prod-server.cjs` `server-bundle.cjs` | 单实例锁；内嵌后端 :3847 + gateway :8642 健康检查；electron-updater 自动更新状态机经 IPC 广播；Hermes 缺失时一键安装（`window.hermesDesktop`）                                                                                                                                                              |
| 开发容器     | `.devcontainer/`                                                        | 基于仓库 docker-compose（service `agorax`），转发 6734/8642                                                                                                                                                                                                                        |
| 用户级服务    | `scripts/install-dashboard-service.sh` `macos/*.plist.template`         | macOS launchd / Linux systemd --user 跑 `server-entry.js`                                                                                                                                                                                                                  |
| CI       | `.github/workflows/`                                                    | `ci.yml`（build+lint，Node 22/pnpm 10）；`docker-publish.yml`（GHCR 双名推送，tag `v*` 发版本）；`security.yml`（secrets 扫描）                                                                                                                                                              |


**端口/环境注意**：Windows 需 Gateway（:8642）+ Agorax（:6734）双服务，两套/三套 `.env`（Gateway 读 `%LOCALAPPDATA%\hermes\.env`，CLI 读 `~/.hermes\.env`，Agorax 读仓库 `.env`）；Windows 需自带 sqlite3 CLI。

---



## 8. 技术路线与演进



### 8.1 主线演进链


| 阶段            | 标志                                                             | 内容                                                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v2.1.0        | `docs/release-2.1.0.md`                                        | **Swarm 诞生**：语义化 roster + tmux 长驻 worker + 持久 orchestrator + review gate                                                                                                                                                              |
| 2026-04       | `docs/swarm2-*-spec.md` ×5                                     | Swarm2 控制面细化：agent-ide、autopilot-orchestration、memory-framework、frankengpu-control-plane、worker-lifecycle-compaction                                                                                                                  |
| Hybrid 分层 ADR | `docs/design/multi-agent_workspace_extension_28825236.plan.md` | **多 agent 控制面总设计（方案 C）**：MCP 控制通道 + AgentRuntime 适配层（Hermes/Claude Code/Codex/DeepSeek）+ per-mission worktree + projects.yaml 声明；phase checklist 已完成                                                                                  |
| 路由迁移          | `logs/compare_*.json`（~260 份）                                  | swarm → LangGraph 路由对齐 eval：同一 checkpoint 双决策对比，量化 divergence 后切换 Phase 2 编排                                                                                                                                                          |
| v2.5.0        | `docs/release-2.5.0.md`                                        | **Multi-Agent 控制面 + Claude Code managed runtime**（`AgentRuntimeAdapter`、managed 群聊/1:1、task_complete 汇合推进）                                                                                                                            |
| 2026-09       | 本文件                                                            | **更名 Agorax**：产品表现层（包名/Electron/PWA/UI/文档/Docker 镜像）全面改名，Hermes 运行时契约（`HERMES_`*、`~/.hermes`、swarm 引擎命名）不变，命名合同见 `docs/agorax-naming-contract.md`；**移除 hermes-world 游戏子项目与 /agora 2D 大厅原型**（约 30MB 资产与独占 3D 依赖），广场叙事落在 group-chat 房间上 |




### 8.2 贯穿性架构决策

1. **控制/展示通道分离**：MCP typed tool call 驱动状态机，AgentStreamEvent 只喂 UI 不落库（managed runtime 的核心约束）。
2. **声明式编排**：workflow YAML 表达转移规则与门控上限（Gate C ≤3 / Gate H ≤2），图是通用循环而非 per-worker 节点。
3. **Human Gate 一等公民**：LangGraph `interrupt_before` + SQLite checkpoint 持久化暂停态，Dashboard/CLI/API 三路恢复。
4. **真相源单一化**：agent/roster=agents.yaml、mission 状态=swarm-missions.json、群聊=collab.db、长期知识=`~/wiki`；双写处均有 reconcile 兜底。
5. **Profile 即控制平面**：能力由本地 profile 目录（config/skills/state.db）承载，gateway 只是运行时，dashboard 不做能力门控。
6. **品牌/契约分层**：产品名（Agorax）与运行时契约（Hermes）分离——用户可见层随品牌走，wire 层（env vars、profile 路径、session 命名、wire identifiers）保持稳定，见命名合同。



### 8.3 已知负债与后续方向

摘要（细节与路线图见 [§9](#9-架构合理性分析与优化方向)）：

- **mission 状态 JSON/SQLite 双写**：swarm-missions.json 与 collab.db 存在漂移风险，靠 `reconcileOnBoot` 缓解，未根治。
- **deepseek-harness adapter 未交付**（`UnavailableAdapter` 占位）。
- **Hermes adapter 仍走老路**：`HermesAdapterStub` 只 probe 不执行，1:1 群聊与 swarm 分发两套路径并存；native bridge Phase 0–1 仅骨架（见 `docs/hermes-native-bridge.md`）。
- **vite.config.ts / server-entry.js 过度耦合**运维生命周期与构建配置。
- **GitHub 仓库未更名**：包名/镜像名已是 agorax，但仓库路径仍为 `outsourc-e/hermes-workspace`（更新器与命名合同中按 legacy 处理）；仓库更名后需同步 `claude-update.ts` 的 remote 定义与 compose 镜像引用。
- 文档基线漂移：`docs/swarm/SWARM_ARCHITECTURE_OVERVIEW.md` 基于 v2.3.0，roster 真相已迁至 AGENTS.md + agents.yaml。

---



## 9. 架构合理性分析与优化方向

> 原独立文档 `ARCHITECTURE_REVIEW.md` 已并入本节。配套代码结构见 `[CODE_STRUCTURE.md](CODE_STRUCTURE.md)`；Agent/Swarm 合同见 `[AGENTS.md](../AGENTS.md)`。



### 9.1 执行摘要

Agorax 的架构在**单节点、本地优先、多 Agent 协作**这个定位下是合理且功能完整的。它以 `agents.yaml` 为统一 registry，用 TanStack Start 全栈承载 UI + API，用 Python LangGraph 做声明式编排，用 Go daemon 接入外部 managed agent，形成了一条清晰的分层链路。安全、profile 隔离、human gate、reconcile 等机制体现了生产意识。

但项目也积累了明显的**结构性负债**：

1. **双写状态（JSON + SQLite）** 是最大隐患，虽已做 reconcile，但未根除。
2. **Hermes 与 managed runtime 执行路径未统一**，AgentRuntime 对 Hermes 是 stub，导致两套分发语义并存。
3. **vite.config.ts / server-entry.js 过度承载运维职责**，构建配置与运行时生命周期耦合。
4. **全局单例 + 本地文件系统假设** 较强，限制了横向扩展与多租户。
5. **SQLite 迁移内联、raw SQL 散落**，长期维护成本会上升。

优化应分三步走：短期把双写治理好、把测试补齐；中期统一 AgentRuntime、拆分构建配置；长期抽象出 cloud-ready 的运行时与状态层。

---



### 9.2 评价维度


| 维度    | 权重  | 说明                       |
| ----- | --- | ------------------------ |
| 职责划分  | 高   | 模块边界是否清晰，是否符合单一职责        |
| 真相源管理 | 高   | 状态是否单一、一致、可恢复            |
| 可扩展性  | 高   | 能否支撑更多 runtime、更多用户、横向扩容 |
| 可运维性  | 中   | 部署、调试、监控、HMR、日志是否友好      |
| 安全性   | 高   | 鉴权、CSP、远程绑定、凭证隔离         |
| 测试覆盖  | 中   | 单元 / 集成 / e2e 是否足以防止回归   |
| 技术债务  | 中   | 已知负债是否可控、是否有偿还计划         |


---



### 9.3 架构合理性分析



#### 9.3.1 整体分层与职责划分 —— 合理

```text
Browser/Electron
       │ REST/SSE
       ▼
  Agorax (:6734)  TanStack Start 全栈
       │
       ├──► src/routes/api/*        API 路由层
       ├──► src/server/*            服务端业务层
       ├──► hermes_langgraph_orchestrator/  Python 编排器
       ├──► agorax-agent-daemon/    Go managed agent daemon
       └──► ~/.hermes/profiles/*    Hermes runtime profile
```

**优点：**

- `src/screens/` + `src/routes/` + `src/server/` 三层 frontend/API/server 分离清晰，新增页面和 API 的路径可预测。
- `agents.yaml` 作为 agent registry 的单一真相源，统一了 Hermes 与 managed runtime 的声明，避免了 UI、服务端、编排器三处各维护一份名单。
- 服务端按子系统目录组织：`group-chat/`、`task-pipeline/`、`agent-runtime/`、`platform-skills/`、`platform-mcp/`，符合领域边界。
- LangGraph 编排器独立为 Python 包，与 Node 侧通过 HTTP 回调交互，保持语言选择和版本节奏独立。

**可改进点：**

- `src/server/` 根目录平铺了约 120 个模块，部分通用能力（如 `gateway-*.ts`、`hermes-*.ts`）可再收拢到子目录。
- `lib/` 与 `src/lib/`、 `src/server/` 与 `src/routes/api/` 的边界偶有交叉，比如 `agent-status.ts` 在 `src/lib/`，而 `agent-status-watcher.ts` 在 `src/server/`。



#### 9.3.2 Agent Runtime 抽象 —— 部分成功，存在裂缝

`src/server/agent-runtime/router.ts:70` 的 `AgentRuntimeRouter` 是统一 runtime 的核心抽象：

```typescript
switch (decl.runtime) {
  case 'hermes':
    return new HermesAdapterStub(decl)
  case 'claude-code':
  case 'codex':
  case 'cursor':
  case 'kimi':
  case 'opencode':
    return new AgoraxManagedAgentBridge(...)
  default:
    return new UnavailableAdapter(decl)
}
```

**优点：**

- Managed runtime（claude/codex/cursor/opencode/kimi）被统一到 `AgoraxManagedAgentBridge`，通过 Go daemon 落地，避免为每个 CLI 写独立胶水。
- `probeAll()` 并行探测，避免顺序 health check 阻塞 `/api/agents/status`（`router.ts:139`）。
- HMR-safe singleton + `resetAgentRuntimeRouter()` 在 dev 环境下能热重载 adapter。

**问题：**

- **Hermes 是 stub，不是一等 adapter**。`HermesAdapterStub.startRun()` 直接抛错：`"hermes runtime is dispatched via the existing swarm-dispatch path"`（`router.ts:31`）。这意味着群聊里 Hermes agent 的 turn 走 `swarm-dispatch/tmux`，而 managed agent 走 `AgentRuntime`，两套超时、重试、interrupt、artifact 模型并存，是长期维护的负担。
- `UnavailableAdapter` 对 `deepseek-harness` 占位，说明 runtime 矩阵未闭合。
- `router.ts` 直接 `import` 并构造 daemon transport，依赖 `AGORAX_MANAGED_AGENT_URL` 环境变量，单元测试需要 `setAgentRuntimeRouterForTests` 才能替换。

**优化方向：** 完成 `HermesNativeAdapter`（`docs/hermes-native-bridge.md` 已有骨架），让 Hermes 也走 `startRun / streamEvents / interrupt` 语义；群聊 turn-executor 只认 canonical adapter，不再特殊处理 Hermes。

#### 9.3.3 数据层设计 —— 明显负债



##### 9.3.3.1 双写：swarm-missions.json + collab.db

`src/server/collab-db.ts:9` 的注释写得非常诚实：

> "mission JSON (swarm-missions.json) is the pipeline source of truth; collab.db is the source of truth for runs / rooms / tokens. Dual-write is a known liability."

`src/server/task-pipeline/reconcile.ts:5` 进一步说明：

> "Repairs the split-brain window between the mission store (swarm-missions.json, pipeline source of truth) and collab.db task_runs (run source of truth). They are not transactional with each other; this pass makes the known liability RECOVERABLE."

reconcile 逻辑（`reconcile.ts:123`）在启动时做四路判断：crash_orphan、dispatch_incomplete、process_dead、reattached，并开 pending_turns 让人工介入。这是一个**补丁级别的解决方案**，不是架构级解决方案。

**风险：**

- 任何在 reconcile 窗口外的崩溃（运行中进程被 kill、JSON 写入失败）仍可能让 mission 状态与 task_runs 不一致。
- 无法横向扩展：两个 Node 进程各自读写同一份 JSON + SQLite 极易冲突。
- 缺乏事务：mission 推进依赖 "先写 JSON，再写 DB" 的顺序，中间失败即不一致。

**优化方向：** 把 mission / assignment 状态完全迁移到 `collab.db`，用 SQLite 事务包裹状态转移；`swarm-missions.json` 降级为导出缓存或只读镜像。这与 `collab-db.ts:15` 自身的 roadmap 一致。

##### 9.3.3.2 SQLite schema 内联且不断增长

`src/server/collab-db.ts` 已有 430 行， migrations v1–v7+ 全部以 inline SQL 字符串存在。v2/v3/v5 甚至需要做 `CREATE TABLE ..._new → INSERT → DROP → ALTER RENAME` 来补列，说明早期 schema 设计偏快。

**问题：**

- 没有 ORM 或 query builder，raw SQL 散落在 `room-store.ts`、`managed-chat-store.ts`、`task-runs.ts`、`run-tokens.ts` 等模块。
- 迁移与业务代码同文件，review 时难以聚焦。
- 缺乏类型安全的查询层，schema 变更容易漏改调用点。

**优化方向：**

- 引入轻量 query builder（如 drizzle-orm、kysely）或至少把 SQL 按表抽到 repository 层。
- 迁移文件按版本拆分到 `src/server/migrations/`。
- 对 mission/room/run 等核心表生成 TypeScript schema types。



#### 9.3.4 编排与调度 —— 先进但有运维成本



##### 9.3.4.1 LangGraph 声明式编排

`hermes_langgraph_orchestrator/workflows/*.yaml` + `nodes.py` + `graph.py` 把 mission 执行建模为通用循环：

```text
START → init → ensure_sessions → dispatch → wait → classify → route → (human_approval | finalize | ensure_sessions)
```

**优点：**

- Workflow YAML 表达转移规则与门控上限（Gate C ≤3、Gate H ≤2），比 Node 侧硬编码 routing 更易审阅和调整。
- `interrupt_before=["human_approval"]` + SQLite checkpoint 让 Human Gate 成为一等公民，Dashboard/CLI/API 都能恢复。
- 测试用 `mock_services.py` 合成 checkpoint 序列，不依赖真实 API。

**问题：**

- Python 进程通过 httpx **回调 Node API**（`/api/swarm-dispatch`、`/api/swarm-missions` 等）。这意味着 LangGraph 与 Agorax 必须同机或互相可达，网络抖动、端口变更、API 变更都会破坏编排。
- `classify_workers` 是唯一的 LLM 调用（默认 `deepseek-v4-pro`），所有 verdict 推导集中在此，调试时需要同时看 Python log 和 Node log。
- 编排器 venv 需要单独维护（Python ≥3.10），与 Node 工具链割裂。

**优化方向：**

- 考虑在 Python 侧直接操作 Hermes profile / tmux / daemon，反向依赖 Node API 只用于 "report progress"，降低循环依赖。
- 或把 LangGraph 封装为 gRPC/HTTP service，Agorax 作为 client 调用，由 service 内部完成 dispatch。



##### 9.3.4.2 Swarm Phase 1 与 Phase 2 并存

`src/server/swarm-orchestrator-loop.ts`（Phase 1 Node 侧）与 `src/server/langgraph-orchestrator.ts`（Phase 2 Python 侧）同时存在。文档承认这是迁移期状态。

**风险：** 两套语义长期并存会导致行为分歧、测试重复、用户困惑（例如某个 gate 在 Phase 1 和 Phase 2 表现不同）。`logs/compare_*.json` 的 eval 记录说明团队已经在做对齐，但 eval 记录本身不是保障。

**优化方向：** 明确 Phase 1 的退役时间表，把 missions UI 默认路由到 LangGraph，保留旧 API 作为兼容层。

#### 9.3.5 群聊并发模型 —— 适中但有扩展限制

`src/server/group-chat/group-chat-runner.ts` 采用：

- 一个全局 `setInterval` 每 `GROUP_RUNNER_TICK_MS`  tick 一次（`group-chat-runner.ts:171`）。
- `triggerRoomRun` fire-and-forget 启动一次 bounded drive，上限 3 rounds / 10 messages / 2 continuations（`constants.ts`）。
- 用 `runner-state.ts` 维护 in-memory 运行状态（epoch、holds、stranded、error cooldown）。
- tick 只做 harvest 与过期，不按水位差重驱动（`group-chat-runner.ts` 注释），避免死循环。

**优点：**

- 设计克制，明确用预算（round/message/continuation）避免 bot 风暴。
- "late, never lost"：Hermes turn 超时只标记 stranded，由 harvest 从 session transcript 补发，不丢消息。

**问题：**

- runner state 是内存单例，无法横向扩展到多进程/多机。
- 全局 interval 在 HMR 时需要 `import.meta.hot.dispose` 清理，生产环境无 HMR 但仍依赖单个 Node 进程。
- 群聊内每个 Hermes agent 需要独立 gateway session，session 数随房间成员线性增长。

**优化方向：** 把 runner state 持久化到 `collab.db`，用数据库行锁或队列任务替代全局 interval；考虑用 job queue（bullmq / pg-boss / sqlite-queue）驱动房间 turn。

#### 9.3.6 工程化与部署 —— 复杂但功能完整



##### 9.3.6.1 vite.config.ts 过度耦合

`vite.config.ts` 仍较长（约 560+ 行），同时承担：

- Vite + TanStack Start + Tailwind 插件链
- dev 模式自动拉起 Hermes gateway（`startClaudeAgent`）
- 代理表（`/api/hermes-proxy`）
- CSP 头（需要与 `src/lib/csp.ts`、`__root.tsx` 三处同步）
- dev 特例：直接拦截 `PATCH /api/swarm-roster` 写 `agents.yaml`

**问题：**

- 构建工具配置本应是声明式/插件化，现在混入了大量运行时运维代码。
- 同一逻辑在 dev（vite.config.ts）与生产（server-entry.js）两份实现，容易漂移。

**优化方向：**

- 把 gateway auto-start、proxy 提取到独立的 dev orchestrator 脚本（如 `scripts/dev-orchestrator.mjs`）。
- vite.config.ts 只保留构建配置和轻量插件注册。
- CSP 从单一文件（`src/lib/csp.ts`）生成，注入到 meta、header、vite config 三处，避免手动同步。



##### 9.3.6.2 server-entry.js 手搓静态服务器

`server-entry.js`（349 行）自己实现了：

- `.env` 加载
- CSP / 安全头
- 静态资源服务 + 404 处理（避免旧 chunk 返回 200 HTML）
- SSR handler 转发
- loopback 密码强制

**问题：**

- 自研静态服务器 + SSR 接入容易遗漏 edge case（ETag、range request、compression、HTTP/2、反向代理头处理）。
- 生产模式要求项目根必须有 `.env`，否则 `process.exit(1)`（`server-entry.js:26`），对容器化部署不够友好。

**优化方向：**

- 评估迁移到 Nitro（TanStack Start 已基于 Nitro）或直接使用 `node-server` preset，让框架处理静态文件和 SSR。
- 若保留自研入口，把静态服务、env 加载、安全头拆成可单测的模块。



#### 9.3.7 安全模型 —— 扎实

**优点：**

- 默认 loopback 绑定，非回环必须 `HERMES_PASSWORD`（`server-entry.js:93`）。
- CSP 同时以 header 和 meta 注入，防御 Cloudflare challenge 等场景（`server-entry.js:54`、`src/lib/csp.ts`）。
- 文件路由有 path-traversal guard（real-path 边界检查，不是字符串前缀）。
- Managed adapter 使用 per-run 临时 MCP config + `HERMES_MCP_TOKEN`。

**可改进点：**

- `CLAUDE_PASSWORD`、`CLAUDE_API_TOKEN`、`CLAUDE_ALLOWED_HOSTS` 等 legacy 命名仍大量存在，增加新用户认知成本，应加速迁移到 `HERMES_*`。



#### 9.3.8 测试覆盖 —— 良好但有缺口

**数据：**

- `src/` 下非测试源码约 1001 个 TS/TSX 文件，测试文件约 235 个，比例约 1:4.3。
- Python 编排器源码仅 9 个 `.py` 文件（不含 `.venv`），测试在 `tests/test_langgraph_orchestrator.py`。
- e2e 只有 2 个 spec（`chat-flicker-duplicate.spec.ts`、`chat-thinking-state.spec.ts`）。

**优点：**

- 服务端核心模块（`group-chat/`、`task-pipeline/`、`agent-runtime/`、`platform-skills/`、`platform-mcp/`）基本都有单元测试。
- `mock_services.py` 让 LangGraph 测试不依赖真实 LLM / API。

**缺口：**

- 缺少跨子系统集成测试（例如 mission → LangGraph → swarm-dispatch → task_runs → collab.db 端到端）。
- e2e 覆盖极少，UI 回归风险高。
- `vite.config.ts`、 `server-entry.js`、Electron 主进程等运维代码几乎没有单测。

---



### 9.4 关键风险清单


| 风险                                    | 位置                                                       | 影响                        | 紧迫度 |
| ------------------------------------- | -------------------------------------------------------- | ------------------------- | --- |
| mission 双写状态                          | `src/server/task-pipeline/reconcile.ts`、`collab-db.ts:9` | 崩溃后状态不一致、无法横向扩展           | 高   |
| Hermes 执行路径未统一                        | `src/server/agent-runtime/router.ts:24`                  | 两套超时/重试/artifact 模型，维护负担大 | 高   |
| LangGraph 回调 Node API                 | `src/server/langgraph-orchestrator.ts`、Python `nodes.py` | 网络/端口/API 变更破坏编排          | 中   |
| 全局内存 runner state                     | `src/server/group-chat/runner-state.ts`                  | 无法多进程/多机扩展                | 中   |
| vite.config.ts / server-entry.js 过度复杂 | `vite.config.ts`、`server-entry.js`                       | dev/prod 行为漂移、维护困难        | 中   |
| raw SQL + inline migrations           | `src/server/collab-db.ts`                                | schema 变更易漏、类型不安全         | 中   |
| deepseek-harness 占位                   | `src/server/agent-runtime/router.ts:44`                  | runtime 矩阵未闭合             | 低   |
| legacy `CLAUDE_*` 命名                  | 多处                                                       | 新用户认知成本、文档噪音              | 低   |


---



### 9.5 优化方向与路线图



#### 9.5.1 短期（1–2 个月）：稳定现有架构

1. **把 mission 状态锁进 SQLite 事务**
  - 目标：让 `collab.db` 的 `task_runs` + 新增 `missions` / `assignments` 表成为唯一真相源。
  - 关键文件：`src/server/task-pipeline/task-service.ts`、`src/server/swarm-missions.ts`、`src/server/collab-db.ts`。
  - 验收：崩溃测试后 `reconcileOnBoot` 不再产生 finding。
2. **补齐跨子系统集成测试**
  - 覆盖：mission create → LangGraph run → dispatch → checkpoint → task_runs update → UI SSE。
  - 工具：可用 supertest + 内存 SQLite + `mock_services.py` + stub daemon。
3. **统一错误码与状态枚举**
  - `task_runs.status` 等字符串枚举散落在多处，应集中到 `src/types/` 或 `src/server/schema.ts`。
4. **清理 legacy** `CLAUDE_`* **环境变量**
  - 保留 backward-compat 读取，但文档与示例全面切到 `HERMES_*` / `AGORAX_*`。



#### 9.5.2 中期（3–6 个月）：结构性优化

1. **完成 Hermes Native Adapter**
  - 参考 `docs/hermes-native-bridge.md`，让 Hermes 也实现 `AgentRuntimeAdapter` 的 `startRun / streamEvents / interrupt`。
  - 群聊 `turn-executor.ts` 不再区分 Hermes / managed，统一调用 adapter。
  - 逐步退役 `swarm-dispatch.ts` 中针对 Hermes 的特殊路径。
2. **拆分 vite.config.ts 与 server-entry.js**
  - 提取 `scripts/dev-orchestrator.mjs` 负责 gateway / daemon 生命周期。
  - CSP 由 `src/lib/csp.ts` 统一导出，三处消费。
  - 评估 Nitro / node-server preset 替换手搓入口。
3. **引入 Repository / Query 层**
  - 按领域建 `repositories/rooms.ts`、`repositories/task-runs.ts` 等，封装 SQL。
  - 迁移文件拆分到 `src/server/migrations/`。
  - 考虑 Kysely 或 Drizzle 提供类型安全。
4. **群聊 runner 持久化**
  - 用数据库行锁或轻量 job queue 替代全局 interval + 内存 state。
  - 目标：支持多进程部署（哪怕同一机器多实例）。
5. **LangGraph 与 Agorax 解耦**
  - 方案 A：Python 编排器直接操作文件系统 / daemon，只向 Agorax report progress。
  - 方案 B：把 LangGraph 包成独立 service，Agorax 作为 client 调用。
  - 推荐先方案 A（减少循环依赖），再视情况 B。



#### 9.5.3 长期（6–12 个月）：战略重构

1. **Cloud-ready 运行时抽象**
  - 把 `~/.hermes/profiles/`、`~/.local/bin/wrapper`、tmux 等本地假设抽象成 `RuntimeBackend` 接口。
  - 允许后端是本地进程、远程 SSH、Kubernetes pod 或 serverless function。
2. **多租户 / 多 workspace 支持**
  - `collab.db`、`swarm-missions.json`、`.runtime/` 当前都是单租户文件结构。
  - 引入 `workspace_id` 隔离，或支持 per-workspace 数据库。
3. **事件溯源化 mission 生命周期**
  - 用事件流（`mission_created`、`assignment_dispatched`、`checkpoint_received`、`review_verdict`）替代直接状态写入。
  - 便于审计、replay、调试 Human Gate。
4. **统一可观测性**
  - 当前日志分散在 Node stdout、Python `~/.hermes/logs/langgraph-*.log`、Go daemon log。
  - 引入结构化日志 + trace id，贯穿一次 mission 的 Node ↔ Python ↔ Go 调用链。

---



### 9.6 结论

Agorax 的架构在**功能完整性、本地体验、安全默认**三方面表现优秀，能够支撑当前 v2.5.0 的多 Agent 协作场景。其分层设计、统一 registry、声明式编排、managed runtime bridge 都是正确的方向。

但项目正处于**从本地单节点工具向更可控平台演进**的拐点，最大的拦路虎是：

1. **双写状态**（mission JSON + SQLite）
2. **Hermes 与 managed runtime 执行路径分裂**
3. **构建/运维配置过度集中**

## 建议按 "短期稳状态 → 中期统一 runtime 与拆分配置 → 长期云化抽象" 的节奏推进。每一步都应伴随集成测试，避免在修复旧债时引入新债。



## 10. 参考文档索引


| 主题                          | 文档                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 命名合同（Agorax/Hermes 边界）      | `[AGENTS.md](../AGENTS.md)`、`../docs/agorax-naming-contract.md`                                                                                                                         |
| Swarm 合同（roster/handoff/升级） | `swarm/HANDOFF-PROTOCOL.md`、`swarm/ESCALATION-GUIDE.md`、`swarm/DISPATCH-GUIDE.md`                                                                                                       |
| Swarm 架构详解（v2.3.0 基线）       | `swarm/SWARM_ARCHITECTURE_OVERVIEW.md`、`swarm/ARCHITECTURE.md`                                                                                                                          |
| 多 agent 控制面 ADR             | `design/multi-agent_workspace_extension_28825236.plan.md`                                                                                                                               |
| Provider / 模型配置             | `design/provider-catalog.md`、`claude-openai-compat-spec.md`                                                                                                                             |
| Swarm 子系统 spec              | `swarm2-agent-ide-spec.md`、`swarm2-autopilot-orchestration-spec.md`、`swarm2-memory-framework-spec.md`、`swarm2-frankengpu-control-plane.md`、`swarm2-worker-lifecycle-compaction-spec.md` |
| 版本演进                        | `release-2.1.0.md`、`release-2.5.0.md`                                                                                                                                                   |
| Managed runtime 接入          | `../skills/hermes-workspace-agents-integration/SKILL.md`                                                                                                                                |
| Managed agent 迁移与 daemon 映射 | `managed-agent-daemon-mapping.md`                                                                                                                                                       |
| 代码目录与模块职责                   | `[CODE_STRUCTURE.md](CODE_STRUCTURE.md)`                                                                                                                                                |
| 运维                          | `docker.md`、`dashboard-service.md`、`troubleshooting.md`、`windows-setup-guide.md`、`AGENT-PAIRING.md`、`api-key-registry.md`                                                               |
| 周边                          | `../hermes_langgraph_orchestrator/README.md`                                                                                                                                            |


