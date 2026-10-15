# Agorax 代码结构与仓库导航

> 产品名：**Agorax**（运行时仍由 Hermes Agent 提供，命名合同见 [`docs/agorax-naming-contract.md`](agorax-naming-contract.md)）
> 版本基线：v2.5.0
> 文档定位：complement [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)（含架构评审与优化路线 §9），偏重**代码目录、文件职责与模块依赖**，帮助开发者快速定位代码。

---

## 1. 顶层目录一览

```text
/home/ramon.jing/hermes-workspace
├── src/                              # 前端 + 服务端 + API 路由（单仓全栈）
├── hermes_langgraph_orchestrator/    # Python LangGraph 编排器
├── agorax-agent-daemon/              # Go managed-agent daemon
├── packages/                         # Workspace 内 TypeScript 共享包
├── agents/                           # Hermes swarm worker 的 SOUL / README
├── skills/                           # 本地 skill 包
├── docs/                             # 设计文档、合同、架构说明
├── scripts/                          # 开发/运维脚本
├── electron/                         # Electron 桌面壳
├── docker/                           # Docker entrypoint
├── pipelines/                        # 任务流水线模板
├── memory/                           # Swarm handoffs / mission 记忆
├── logs/                             # 运行时日志
├── .runtime/                         # 运行时状态（JSON + artifact）
├── .agorax/                          # Daemon 状态
├── .hermes/                          # 本地 Hermes profile（运行时生成）
├── public/                           # 静态资源
├── e2e/                              # Playwright e2e
├── tests/                            # Python 测试辅助
├── nix/                              # Nix 包/module
├── macos/                            # launchd 模板
├── .devcontainer/                    # VS Code dev container
├── agents.yaml                       # 统一 agent registry
├── projects.yaml                     # 可修改的目标仓库声明
├── pipelines.yaml                    # 流水线声明
├── package.json                      # Node 项目 + 脚本
├── vite.config.ts                    # Vite + TanStack Start 配置
├── server-entry.js                   # 生产入口
└── pnpm-workspace.yaml               # pnpm workspace
```

---

## 2. 前端代码结构（`src/`）

### 2.1 页面 / 路由（`src/screens/` + `src/routes/`）

TanStack Start 采用**文件路由**：`src/routes/<path>.tsx` 即为页面入口，业务组件集中在 `src/screens/<name>/`。

| 页面目录 | 路由文件 | 职责 |
|----------|----------|------|
| `src/screens/agents/` | `src/routes/agents.tsx` | Agent roster / operations |
| `src/screens/chat/` | `src/routes/chat/` | 1:1 agent 聊天、session 列表、composer、managed chat |
| `src/screens/dashboard/` | `src/routes/dashboard.tsx` | 用量/概览 dashboard |
| `src/screens/echo-studio/` | `src/routes/echo-studio.tsx` | Prompt studio |
| `src/screens/files/` | `src/routes/files.tsx` | 文件浏览器 / 编辑器 |
| `src/screens/group-chat/` | `src/routes/group-chat.tsx`、`.group-chat/` | 多 agent 房间、房间列表 |
| `src/screens/jobs/` | `src/routes/jobs.tsx` | Cron / job 管理 |
| `src/screens/mcp/` | `src/routes/mcp.tsx` | MCP 市场与配置 |
| `src/screens/memory/` | `src/routes/memory.tsx` | 知识 / 记忆浏览器 |
| `src/screens/mission-control/` | `src/routes/mission-control.tsx`、`missions.tsx`、`tasks.tsx` | 看板、pipeline、mission 界面 |
| `src/screens/settings/` | `src/routes/settings.tsx`、`settings/` | 连接 / provider 设置 |
| `src/screens/skills/` | `src/routes/skills.tsx`、`skills/` | 平台 skill 目录与绑定 |
| `src/screens/swarm/` | `src/routes/swarm.tsx`（`/swarm2` → redirect） | Swarm 作战室（human gate、看板、报告） |
| `src/screens/vt-capital/` | `src/routes/vt-capital.tsx` | VT Capital 定制屏 |

### 2.2 共享组件（`src/components/`）

| 类别 | 代表文件/目录 |
|------|---------------|
| Agent / Chat | `agent-avatar.tsx`、`agent-card.tsx`、`chat-panel.tsx`、`chat-message-list.tsx`、`message-item.tsx`、`attachment-*.tsx` |
| 导航 / 外壳 | `workspace-shell.tsx`、`mobile-tab-bar.tsx`、`command-palette.tsx` |
| 状态 / 反馈 | `status-indicator.tsx`、`attention-toaster.tsx`、`error-boundary.tsx`、`connection-*` |
| 模式 / 模型 | `mode-selector.tsx`、`model-suggestion-toast.tsx` |
| 终端 / 文件 | `terminal-panel.tsx`、`workspace-folder-picker.tsx` |
| Swarm | `swarm/` 子目录、`orchestrator-avatar.tsx` |
| UI 原子 | `ui/`（Tailwind/shadcn 风格）、`prompt-kit/`、`avatars/`、`auth/`、`search/`、`settings/`、`inspector/`、`memory-viewer/`、`file-explorer/`、`usage-meter/` |

### 2.3 状态管理（`src/stores/`）

使用 **Zustand**。

| Store | 文件 | 管理内容 |
|-------|------|----------|
| Agent | `agent-store.ts` | Agent registry、状态、能力 |
| Agent Swarm | `agent-swarm-store.ts` | Swarm worker 选择 / 状态 |
| Chat | `chat-store.ts` | 聊天会话、消息、流式输出、composer |
| Chat Activity | `chat-activity-store.ts` | 在途 chat activity / runs |
| Mission | `mission-store.ts` | Mission、task、kanban |
| Session Model | `session-model-store.ts` | 每会话模型覆盖 |
| Task | `task-store.ts` | 任务流水线状态 |
| Terminal Panel | `terminal-panel-store.ts` | 终端会话 UI |
| Workspace | `workspace-store.ts` | Workspace 路径 / 文件夹状态 |

### 2.4 工具与运行时适配（`src/lib/`）

| 类别 | 关键文件 |
|------|----------|
| Agent / Runtime | `agent-api.ts`、`agent-status.ts`、`agent-types.ts`、`managed-agent-runtime/`、`create-agent.ts` |
| Gateway / Hermes | `gateway-api.ts`、`mission-control-api.ts`、`workspace-client.ts`、`workspace-checkpoints.ts` |
| 群聊 | `group-chat-api.ts`、`group-chat-types.ts`、`use-group-chat-events.ts` |
| 模型 / Provider | `model-info.ts`、`model-provider.ts`、`provider-catalog.ts`、`format-model-name.ts` |
| Job / Cron | `jobs-api.ts`、`cron-api.ts` |
| UI 辅助 | `theme.ts`、`i18n.ts`、`sounds.ts`、`clipboard.ts`、`markdown-math.ts` |

### 2.5 其他 `src/` 子目录

- `src/routes/api/` — 所有 API 路由（见第 3 节）
- `src/server/` — 服务端逻辑（见第 4 节）
- `src/hooks/`、 `src/types/`、 `src/utils/` — 小型 hooks、类型、工具
- `src/styles/` — 主题 CSS（`default-theme.css`、`scifi-theme.css` 等）

---

## 3. API 路由目录（`src/routes/api/`）

TanStack Start 文件路由：每个 `.ts` 文件export server handlers。

### 3.1 Agent / Managed Runtime

| 路由文件 | 说明 |
|----------|------|
| `agents/index.ts` | Agent 列表 |
| `agents/$agentId/capabilities.ts` | 单 agent 能力 |
| `agents/$agentId/models.ts` | 模型列表 |
| `agents/$agentId/chat.ts` | 1:1 聊天（legacy SSE spawn） |
| `agents/$agentId/skills.ts`、`skills/$skillId.ts`、`local-skills.ts` | Skill 绑定 |
| `agents/$agentId/mcp.ts`、`mcp/$serverId.ts` | MCP 绑定 |
| `agents/$agentId/engine/activate.ts` | Managed session 激活 |
| `agents/$agentId/engine/sessions.ts` | Managed sessions 列表 |
| `agents/$agentId/engine/session/$sessionId/{index,messages,input,events}.ts` | 会话详情 / 消息 / 输入 / SSE 事件 |
| `agents/$agentId/engine/session/$sessionId/turns/$turnId/cancel.ts` | 取消 turn |
| `agents/$agentId/engine/session/$sessionId/plan-decisions/$requestId.ts` | Plan decision 响应 |
| `agents/$agentId/activity/$sessionId.ts` | Activity 聚合 |
| `agents/$agentId/interactions/$sessionId/$turnId/$requestId.ts` | Interaction 响应 |
| `available-agents.ts`、`agents/status.ts`、`agents/snapshot.ts` | 可用/状态/快照 |
| `agent-registry.ts` | Registry 增删改 |

### 3.2 Swarm / Mission / Task

| 路由文件 | 说明 |
|----------|------|
| `swarm-dispatch.ts` | Swarm 任务派发 |
| `swarm-direct-chat.ts` | 对 tmux worker 直聊 |
| `swarm-chat.ts`、`swarm-decompose.ts` | Swarm 聊天 / 拆解 |
| `swarm-project.ts`、`swarm-memory.ts`、`swarm-memory/search.ts` | 项目 / 记忆 |
| `swarm-kanban.ts`、`swarm-missions.ts`、`swarm-lifecycle.ts` | 看板 / mission 状态 / 生命周期 |
| `swarm-runtime.ts`、`swarm-runtime.reset.ts` | Runtime 状态 / 重置 |
| `swarm-tmux-start.ts`、`swarm-tmux-stop.ts`、`swarm-tmux-restart-active.ts`、`swarm-tmux-delivery.ts` | tmux 生命周期 |
| `swarm-health.ts`、`swarm-checkpoint.ts` | 健康 / checkpoint |
| `swarm-orchestrator-loop.ts` | Phase 1 编排循环 |
| `swarm-environment.ts` | 环境变量 |
| `swarm-langgraph/{run,status,cancel,resume,mission-event}.ts` | Phase 2 LangGraph 编排 |
| `orchestrator-active-gates.ts`、`orchestrator-state.ts` | Human Gate 查询 |
| `missions/index.ts`、`missions/$missionId/index.ts` | Mission CRUD |
| `missions/$missionId/tasks/$taskId/runtime.ts` | Task runtime |
| `tasks/index.ts`、`tasks/$taskId.ts` | 任务列表 / 详情 |
| `hermes-tasks.ts`、`hermes-tasks.$taskId.ts`、`hermes-tasks-assignees.ts` | Hermes task 同步 |

### 3.3 群聊房间

| 路由文件 | 说明 |
|----------|------|
| `rooms.ts` | 房间 CRUD |
| `rooms/from-mission.ts` | 从 mission 创建房间 |
| `rooms/$roomId.ts` | 单房间 |
| `rooms/$roomId/messages.ts` | 房间消息 |
| `rooms/$roomId/messages/$messageId/interaction-response.ts` | interaction 响应 |
| `rooms/$roomId/participants.ts`、`participants/$participantId.ts` | 成员管理 |
| `rooms/$roomId/pending-turns.ts` | pending turn 列表 |
| `rooms/$roomId/pending-turns/$turnId/{answer,dismiss}.ts` | 应答 / 解散 |

### 3.4 文件 / 终端 / 系统

| 路由文件 | 说明 |
|----------|------|
| `files.ts`、`preview-file.ts` | 文件读写 / 预览 |
| `workspace.ts`、`workspace.folders.ts` | Workspace 路径 / 文件夹 |
| `git/diff.ts` | Git diff |
| `terminal-stream.ts`、`terminal-input.ts`、`terminal-close.ts` | PTY 终端 |
| `system-metrics.ts`、`connection-status.ts`、`auth-check.ts` | 指标 / 连接 / 鉴权 |

### 3.5 Memory / Skill / MCP

| 路由文件 | 说明 |
|----------|------|
| `memory.ts`、`memory/{list,read,write,search}.ts` | Memory 文件操作 |
| `knowledge/{config,list,read,search,sync,graph}.ts` | Knowledge 图谱 |
| `skills.ts`、`skills/{install,uninstall,toggle,hub-search,content}.ts` | Skill 管理 |
| `platform-skills.ts`、`platform-skills/$skillId.ts`、`platform-skills/import.ts`、`platform-skills/seed.ts` | 平台 skill |
| `mcp.ts`、`mcp/{configure,discover,presets,test}.ts`、`mcp/$name.ts`、`mcp/$name.logs.ts` | MCP 配置 |
| `mcp/hub-sources.ts`、`mcp/hub-sources.$id.ts`、`mcp/hub-search.ts` | MCP Hub |
| `platform-mcp.ts`、`platform-mcp/$serverId.ts`、`profiles/mcp.ts` | 平台 MCP 绑定 |

### 3.6 会话 / 聊天 / 用量

| 路由文件 | 说明 |
|----------|------|
| `sessions.ts`、`sessions/search.ts`、`sessions/send.ts` | Session 列表 / 搜索 / 发送 |
| `sessions/$sessionKey.{compress,status,truncate,active-run}.ts` | Session 操作 |
| `send.ts`、`send-stream.ts`、`session-send.ts`、`session-status.ts`、`session-history.ts` | 消息发送 / 流式 / 历史 |
| `chat-events.ts` | SSE 聊天事件总线 |
| `usage/{summary,by-model,by-provider,by-agent,by-profile,trends,logs,pricing}.ts` | 用量统计 |
| `provider-usage.ts`、`models.ts`、`models-local.ts`、`model/info.ts` | Provider / 模型 |

### 3.7 Gateway / Auth / 集成

| 路由文件 | 说明 |
|----------|------|
| `gateway-status.ts`、`hermes-config.ts`、`hermes-update.ts` | Gateway / Hermes 配置 |
| `auth.anthropic.ts`、`oauth.device-code.ts` | 鉴权 |
| `integrations.ts`、`plugins.ts`、`claude-jobs.ts` | 集成 / 插件 / job |
| `agent-runtime/{install,login,status,enable,daemon.restart}.ts` | Managed runtime 安装/启用 |
| `start-gateway.ts`、`stt-status.ts`、`transcribe.ts` | 启动 Hermes gateway / STT |
| `background.ts`、`events.ts`、`collab-events.ts` | 后台任务 / 事件 |

---

## 4. 服务端模块（`src/server/`）

### 4.1 Agent Runtime（`src/server/agent-runtime/`）

统一接入外部 CLI agent（Claude Code / Codex / Cursor / OpenCode / Kimi）。

| 文件 | 职责 |
|------|------|
| `router.ts` | Agent id → adapter 路由；Hermes 走 stub，managed 走 bridge |
| `types.ts` | Adapter 接口（`AgentRuntimeAdapter`、`AgentProbeResult`） |
| `agents-config.ts` | 加载、校验 `agents.yaml` |
| `dispatch.ts` | 分发辅助 |
| `run-managed-turn.ts` | 单 managed turn 执行 |
| `advance.ts` | Turn 推进 / 汇合 |
| `managed-agent-daemon.ts` | Daemon 生命周期 |
| `agorax-managed-agent-http-client.ts` | Daemon HTTP client |
| `agorax-managed-agent-transport.ts` | 传输层 |
| `agorax-managed-agent-bridge.ts` | Bridge 层 |
| `agorax-managed-agent-events.ts` | 事件转换 |
| `agorax-managed-agent-activity-stream.ts` | Activity 流 |
| `agorax-managed-agent-session-identity.ts` | Session identity |
| `agorax-managed-agent-run-store.ts` | Run store |
| `agorax-managed-agent-provider-status.ts` | Provider 状态 |
| `managed-chat-store.ts` | SQLite managed chat 会话/消息投影 |
| `hermes-gateway-probe.ts`、`hermes-native-bridge.ts` | Hermes gateway 探测 / native bridge 骨架 |
| `claude-stream-json.ts` | Claude Code JSON 流解析 |
| `aggregate-runtime-status.ts` | 跨 adapter 状态聚合 |

### 4.2 群聊（`src/server/group-chat/`）

| 文件 | 职责 |
|------|------|
| `room-store.ts` | `collab.db` 房间 CRUD |
| `room-runtime.ts` | 房间运行时初始化 |
| `group-chat-runner.ts` | 主 turn loop / drive |
| `turn-executor.ts` | 单 agent turn 执行 |
| `agent-session-manager.ts` | 房间内 per-agent session 管理 |
| `pending-turn-service.ts` | Pending-turn 生命周期 |
| `prompt-builder.ts` | Agent turn prompt 组装 |
| `mention-routing.ts` | `@mention` 路由 |
| `responder-utils.ts`、`runner-state.ts`、`summaries.ts` | 响应处理、runner 状态、摘要 |
| `resolve-room-cwd.ts` | 房间 cwd 计算 |
| `ensure-room-for-mission.ts` | Mission 绑定房间 |
| `types.ts`、`constants.ts` | 类型 / 常量 |

### 4.3 任务管道（`src/server/task-pipeline/`）

| 文件 | 职责 |
|------|------|
| `task-service.ts` | 核心 task service |
| `dispatch-ready.ts` | 决定哪些 task 可派发 |
| `reconcile.ts` | Mission/task 双写 reconcile |
| `mission-serialize.ts`、`mission-status.ts` | 序列化 / 状态 |
| `pipeline-templates.ts` | 内置 pipeline 模板 |
| `projects.ts` | 项目定义读取 |
| `review.ts`、`stage-brief.ts`、`task-scheduler.ts` | 评审门、stage brief、调度 |

### 4.4 MCP / Skill / 平台能力

| 目录/文件 | 职责 |
|-----------|------|
| `src/server/mcp/` | MCP handler、task runs、run tokens、tool groups |
| `src/server/mcp-hub/` | MCP 市场 / catalog、source、cache、trust |
| `src/server/platform-mcp/` | 平台 MCP catalog + agent 绑定 |
| `src/server/platform-skills/` | 平台 skill catalog + agent 绑定 |

### 4.5 Swarm 模块（`src/server/` 根级 swarm 文件）

| 文件 | 职责 |
|------|------|
| `swarm-tmux-delivery.ts` | tmux paste / 投递 |
| `swarm-foundation.ts`、`swarm-lifecycle.ts`、`swarm-missions.ts`、`swarm-memory.ts`、`swarm-kanban-store.ts` | 基础 / 生命周期 / mission / 记忆 / 看板 |
| `swarm-roster.ts`、`swarm-profile-config.ts`、`swarm-environment.ts`、`swarm-checkpoints.ts` | Roster / profile / 环境 / checkpoint |
| `swarm-tmux-restart.ts`、`swarm-background-harvest.ts`、`swarm-mission-sync.ts`、`swarm-mission-artifacts.ts` | tmux 重启 / 收割 / 同步 / artifact |
| `swarm-chat-reader.ts`、`swarm-chat-command.ts`、`swarm-notifications.ts`、`swarm-mode.ts`、`swarm-runtime-reset.ts` | 聊天读取 / 命令 / 通知 / 模式 / runtime 重置 |

### 4.6 LangGraph 桥接

| 文件 | 职责 |
|------|------|
| `langgraph-orchestrator.ts` | TypeScript 侧 Python 编排器入口 |
| `langgraph-human-gate.ts` | Human Gate 恢复逻辑 |

### 4.7 数据库与 Gateway

| 文件 | 职责 |
|------|------|
| `collab-db.ts` | `collab.db` schema 与 migrations |
| `sqlite-helper.ts` | SQLite driver 包装（better-sqlite3 → node:sqlite → CLI fallback） |
| `gateway-pool.ts` | 多 profile gateway 懒启动池 |
| `gateway-ports.ts`、`gateway-port-owner.ts`、`gateway-lifecycle.ts`、`gateway-capabilities.ts` | 端口 / 生命周期 / 能力协商 |
| `hermes-api.ts`、`hermes-api-profile.ts`、`hermes-config-store.ts`、`hermes-config-migration.ts`、`hermes-config-route.ts`、`hermes-paths.ts` | Hermes 集成 |
| `profiles-browser.ts` | Profile 文件系统浏览 |

### 4.8 其他关键服务端文件

| 文件 | 职责 |
|------|------|
| `auth-middleware.ts` | 路由鉴权中间件 |
| `background-tasks.ts` | 后台任务 |
| `chat-event-bus.ts` | SSE 事件总线（内存 pub-sub） |
| `terminal-sessions.ts` | 终端 session 管理 |
| `run-store.ts` | Run 记录 |
| `tool-artifacts-store.ts` | Tool artifact 存储 |
| `dashboard-aggregator.ts` | Dashboard 数据聚合 |
| `context-usage.ts` | 上下文用量 |
| `usage/` | 用量聚合、定价、扫描 |
| `git-ops.ts` | Git worktree / commit / merge / diff |
| `kanban-backend.ts` | 看板后端 |
| `knowledge-browser.ts`、`memory-browser.ts`、`managed-memory.ts` | 知识 / 记忆浏览 |
| `openai-compat-api.ts`、`responses-api.ts` | OpenAI 兼容 API |
| `stt-transcription.ts` | 语音转录 |
| `ssh-terminal.ts` | SSH 终端 |
| `update-system.ts` | 自动更新 |
| `workspace-path-policy.ts`、`workspace-state-dir.ts`、`workspace-remote.ts` | Workspace 路径 / 状态 / 远程 |

---

## 5. Python 编排器（`hermes_langgraph_orchestrator/`）

| 文件 | 职责 |
|------|------|
| `workflows/radw.yaml` | Research → Architect → Developer/Writer → review/harden |
| `workflows/rdi.yaml` | Research → Design → Implement |
| `workflows/design_implement.yaml` | Design → Implement |
| `workflows/research_only.yaml` | 仅调研 |
| `nodes.py` | LangGraph 节点：init、ensure、dispatch、wait、classify、route、harvest |
| `graph.py` | 图结构 wiring |
| `state.py` | `OrchestratorState`、`WorkerCheckpoint`、`WorkerClassification` |
| `workflow.py` | Workflow loader、校验、路由逻辑 |
| `resume.py` | 从 human gate 恢复 |
| `mock_services.py` | 测试用 mock services |
| `mission_artifacts.py` | Artifact 路径改写 |
| `__main__.py` | CLI 入口（`--execute`、`--resume`） |
| `bin/` | 辅助脚本 |
| `requirements.txt`、`pyproject.toml` | Python 依赖 |
| `README.md` | 编排器文档 |

---

## 6. Managed Agent Daemon（`agorax-agent-daemon/` + `packages/`）

### 6.1 Go daemon（`agorax-agent-daemon/`）

Go workspace，vanity path `agorax.local/agent-daemon/...`。

| Package | 职责 |
|---------|------|
| `packages/agent/host` | Canonical Session/Turn/Interaction 生命周期 |
| `packages/agent/store-sqlite` | Canonical SQLite 状态 + migrations |
| `packages/agent/store-sqlite/canonical` | 共享 identity/state 合同 |
| `packages/agent/activity-replication` | Activity 复制原语 |
| `packages/agent/session-replay` | Replay / provider history 合同 |
| `packages/agent/activity-core` | Core activity 类型 |
| `packages/agent/daemon` | Daemon 组合根 |
| `packages/agent/daemon/cmd/agorax-agentd` | 主 daemon 二进制（`main.go`、`bridge.go`、`events.go` 等） |
| `packages/agent/daemon/runtime` | Runtime adapters：cursor、opencode、codex、openclaw 等 |
| `packages/agent/daemon/modelcatalog` | 模型目录与选型 |
| `packages/agent/daemon/{providerstatus,agentstatus,agoraxstate,liveprotocol,managedruntime,managednpm,usercommand,titletext,claudecodecompat,reportercompat}` | 各类子系统 |
| `packages/connector/daemon/core` | Connector runtime core |
| `packages/events/stream-go` | 事件流传输原语 |

### 6.2 TypeScript 共享包（`packages/`）

| 包 | 路径 | 导出 |
|----|------|------|
| `agent-activity-core` | `packages/agent-activity-core/` | `@agorax/agent-activity-core`：activity 合同、session engine reducers、message types、selectors |
| `agent-activity-daemon-adapter` | `packages/agent-activity-daemon-adapter/` | `@agorax/agent-activity-daemon-adapter`：daemon 方言 typed client，被 `src/server/agent-runtime` 使用 |

---

## 7. Agent / Skill / MCP 合同文件

### 7.1 `agents.yaml`

统一 agent registry，单一真相源。当前包含 ~15 个 agent，runtime 类型：

| Runtime | 当前 Agent |
|---------|------------|
| `hermes` | `default`、`orchestrator`、`researcher`、`architect`、`developer`、`writer`、`learning`、`gpuserver`、`aider` |
| `claude-code` | `cc-impl` |
| `codex` | `codex-impl` |
| `cursor` | `cursor-impl` |
| `opencode` | `opencode-impl` |
| `kimi` | `kimi-impl` |
| `deepseek-harness` | `ds-harness`（占位/禁用） |

每个声明字段：`id`、`name`、`role`、`mission`、`profile`、`modes`、`tools`、`skills`、`mcpServers`、`wrapper`、`capabilities`、`preferredTaskTypes`、`greenlightRequiredFor`、`maxConcurrentTasks`、`runtime`、`execution`、`dispatchable`、`enabled`。

### 7.2 `agents/` 目录

每个 swarm worker 一个子目录，含 `SOUL.md`（人格/系统提示）和 `README.md`：

- `agents/orchestrator/`
- `agents/researcher/`
- `agents/architect/`
- `agents/developer/`
- `agents/writer/`
- `agents/learning/`

### 7.3 `skills/` 目录

本地 skill 包，按类别组织：

- `skills/swarm/` — `architect-core`、`autoresearch*`、`browser-harness`、`harden-gate`、`learning-wiki-ingest`、`mission-memory-layout`、`orchestrator-core`、`researcher-*`
- `skills/software-development/`
- `skills/github/`
- `skills/hermes-workspace-agents-integration/`
- `skills/workspace-dispatch/`

平台 skill / MCP 实际存储在 `collab.db`（`platform_skills`、`platform_skill_files`、`agent_skills`、`platform_mcp_servers`、`agent_mcp_servers`）。

---

## 8. 配置与部署文件

| 文件 | 职责 |
|------|------|
| `vite.config.ts` | Vite 7 + TanStack Start；dev server、代理、CSP、gateway 自动拉起 |
| `server-entry.js` | 生产入口：加载 `.env`、静态资源、SSR handler、非回环密码强制 |
| `package.json` | 脚本与依赖 |
| `electron/main.cjs` | Electron 主进程 |
| `electron/preload.cjs` | Preload 脚本 |
| `electron/prod-server.cjs` | Electron 内嵌生产 server |
| `electron/server-bundle.cjs` | esbuild 打包后的 server |
| `docker/entrypoint.sh` | Docker entrypoint |
| `.env.example` | 环境变量模板 |
| `tsconfig.json`、`eslint.config.*`、`prettier.config.*` | 工具链配置 |

---

## 9. 数据存储与状态文件

### 9.1 `collab.db`（仓库根或 `~/.hermes/collab.db`）

SQLite，migrations 在 `src/server/collab-db.ts:25`。

| 表 | 用途 |
|----|------|
| `rooms` | 群聊房间 |
| `room_participants` | 房间成员 |
| `room_messages` | 房间消息 |
| `room_summaries` | 房间摘要 |
| `room_watermarks` | 每成员已读水位 |
| `pending_turns` | 待人工 turn |
| `run_tokens` | 能力域 run token |
| `task_runs` | mission assignment run 记录 |
| `managed_chat_sessions` / `managed_chat_messages` | managed 1:1 会话投影 |
| `platform_skills` / `platform_skill_files` / `agent_skills` | 平台 skill catalog / 绑定 |
| `platform_mcp_servers` / `agent_mcp_servers` | 平台 MCP catalog / 绑定 |
| `schema_migrations` | 迁移记录 |

### 9.2 `.runtime/` 文件

| 文件 | 用途 |
|------|------|
| `local-sessions.json` | 本地聊天 session 缓存 |
| `swarm-missions.json` | mission JSON 真相源（与 `collab.db` 双写，已知负债） |
| `tool-artifacts/` | tool 输出 artifact |
| `pending-update-release-notes.json` | 待更新 release notes |

### 9.3 `~/.hermes/` 结构

| 路径 | 用途 |
|------|------|
| `~/.hermes/config.yaml` | 默认 Hermes profile 配置 |
| `~/.hermes/profiles/<agent-id>/` | 命名 Hermes agent profile（config.yaml、skills/、runtime.json） |
| `~/.hermes/collab.db` | 协作 SQLite |
| `~/.hermes/workspace-sessions.json` | 加密 session token |
| `~/.hermes/.env` | Hermes gateway 环境 |
| `~/.hermes/langgraph-checkpoints.db` | LangGraph checkpoint / Human Gate 暂停态 |

### 9.4 Daemon DB

| 文件 | 用途 |
|------|------|
| `agorax-agent-daemon/agorax-agent.db` | managed agent daemon 状态 |

---

## 10. 模块依赖模式

### 10.1 前端 → API

```text
src/stores/*.ts  →  src/lib/*-api.ts  →  src/routes/api/*.ts
```

- `chat-store.ts` → `src/lib/agent-api.ts`、`src/lib/gateway-api.ts`
- `agent-store.ts` → `src/lib/agent-status.ts`、`src/lib/agent-api.ts`
- `mission-store.ts` → `src/lib/mission-control-api.ts`
- `group-chat-api.ts` → `src/routes/api/rooms*.ts`

### 10.2 API 路由 → 服务端模块

```text
src/routes/api/*.ts  →  src/server/<subsystem>/*.ts
```

- Agent chat → `src/server/agent-runtime/router.ts` → `AgoraxManagedAgentBridge`
- Swarm → `src/server/swarm-*.ts`、`src/server/task-pipeline/`
- Rooms → `src/server/group-chat/room-store.ts`、`group-chat-runner.ts`
- MCP → `src/server/mcp/`、`platform-mcp/`
- Skills → `src/server/platform-skills/`

### 10.3 服务端 → 外部真相源

| 目标 | 位置 |
|------|------|
| Hermes agents | `~/.hermes/profiles/<id>/` FS + Hermes gateway API（`:8642`） |
| Managed agents | `AGORAX_MANAGED_AGENT_URL` daemon（`:8788`） |
| Missions | `.runtime/swarm-missions.json` + `collab.db`（双写负债，`task_runs` 为 run 真相） |
| 平台 skill / MCP | `collab.db` |
| Agent registry | `agents.yaml` |

### 10.4 LangGraph 编排器

`hermes_langgraph_orchestrator/` 通过 httpx 回调 Workspace API（`:6734/api`）完成派发、roster、checkpoint 收割。TypeScript 入口：`src/server/langgraph-orchestrator.ts`。

### 10.5 Managed Runtime 桥接

`src/server/agent-runtime/router.ts` 按 `agents.yaml` 的 `runtime` 字段构造 adapter：

- `hermes` → `HermesAdapterStub`（探测 gateway，执行仍走 swarm/tmux）
- `claude-code` / `codex` / `cursor` / `opencode` / `kimi` → `AgoraxManagedAgentBridge` → `agorax-managed-agent-http-client.ts` → Go daemon

---

## 11. 快速导航表

| 我想… | 去哪 |
|-------|------|
| 新增/修改 agent | `agents.yaml` → `src/server/agent-runtime/agents-config.ts` → `scripts/sync-swarm-profiles.mjs` |
| 修改 swarm workflow 门控 | `hermes_langgraph_orchestrator/workflows/*.yaml`、`nodes.py` |
| 新增 managed runtime | `src/server/agent-runtime/router.ts`、`agorax-agent-daemon/packages/agent/daemon/runtime/` |
| 新增 API | `src/routes/api/<path>.ts` |
| 新增页面 | `src/routes/<name>.tsx` + `src/screens/<name>/` |
| 修改房间 DB schema | `src/server/collab-db.ts` |
| 修改 skill / MCP catalog | `src/server/platform-skills/`、`src/server/platform-mcp/` |
| 生产构建入口 | `server-entry.js` → `dist/server/server.js` |
| 本地开发启动 | `pnpm dev`（dev）/ `pnpm build && pnpm start`（prod；均含 gateway `:8642` + UI `:6734` + daemon `:8788`） |
| 查看架构总览 / 评审与优化路线 | [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)（§9） |
| 查看 Agent/Swarm 合同 | [`AGENTS.md`](../AGENTS.md)、[`agents.yaml`](../agents.yaml) |
