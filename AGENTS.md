# Agorax Agent 合同

> 产品名：**Agorax**（AI Agent 的公共广场）。运行时由 **Hermes Agent** 提供（gateway / profiles / `~/.hermes`），运行时术语保持 Hermes 命名不变，见 [`docs/agorax-naming-contract.md`](docs/agorax-naming-contract.md)。

本仓库使用语义化 Hermes agent/worker（不是纯编号 lane）。统一配置真相源是 [`agents.yaml`](agents.yaml)；每个 Hermes agent 在对应 profile 下有配置（**`default` → `~/.hermes`**，其余 → `~/.hermes/profiles/<agent-id>/`），角色 skill 见配置，wrapper 在 `~/.local/bin/`。

**统一 agent 声明**见 [`agents.yaml`](agents.yaml)：同时描述角色、skills、能力和 agent **如何启动**（runtime / command / execution）。一个 agent 条目既是可调度 worker，也是 runtime registry entry。

### Runtime 双轨合同（默认要求）

后续涉及 **Agents / Skills / MCP**（及同类「按 agent 配置能力」）的功能时，**默认必须同时支持**：

| 轨 | `agents.yaml` `runtime` | 例子 | 能力落点 |
| --- | --- | --- | --- |
| **Hermes** | `hermes` | `orchestrator`、`developer`、… | profile `~/.hermes` / `profiles/<id>/`（如 `config.yaml` `mcp_servers`、`skills/`） |
| **Managed** | `claude-code` / `codex` / … | `cc-impl`、`codex-impl` | collab 绑定为真相源；启动时由 adapter 注入（如 Claude Code per-run `mcp-config.json`），**不要**假设存在 Hermes profile |

禁止只为 Hermes profile 列表实现 UI/API 后把 managed 留空。平台库 + `agent_*` 绑定表的 `agent_id` 一律用 registry id（与 Skills 相同）。

**`default` 也是一等 agent：** 只是 Hermes home 路径为 `~/.hermes`（不是 `profiles/default`）。`dispatchable: false` 仅表示 LangGraph / Swarm 不分发到它；**Agents / Skills / MCP 绑定与物化必须支持 `default`**，不得因「非 worker」在 UI/API 里过滤掉。

**Agent 列表读路径：** UI 统一用 `GET /api/agents`（`agents.yaml` + status）。单 agent 能力用 `GET /api/agents/:id/capabilities`（**Hermes + managed**）：Hermes 读 profile FS；managed 读平台绑定 + runtime settings（如 Claude/Codex model）。`GET /api/profiles/capabilities` 仍仅 Hermes profile。声明增删改用 `/api/agent-registry`。

当前版本：`2.5.0`。本地开发：`pnpm dev`（gateway + managed-agent `:8788` + Vite UI）或 `pnpm build && pnpm start`（同栈 + 生产 UI）；仅 UI 用 `pnpm start:ui` / `pnpm dev:ui`（默认 `PORT=6734`；localhost 下 gateway pool 可 lazy-start）。

---

## 一、语义 Roster（LangGraph 可引用）

LangGraph workflow（默认 `radw.yaml`，以及 `rdi.yaml`、`research_only.yaml`、`design_implement.yaml`）**只能**引用下表中的 worker id。

**模型真相源：** 每个 Hermes agent 的默认模型由对应 profile 配置提供。**不要**在本文硬编码模型名——改模型直接更新 `~/.hermes/profiles/<agent-id>/config.yaml`，然后重启对应 worker；`agents.yaml` 的可选 `model` 只用于显式 runtime override。

| Worker         | Wrapper               | Modes                                     | Tools                                                                                   | Skills                                                                                                                                                                                                                                         | MCP | Plugins |
| -------------- | --------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------- |
| `orchestrator` | `orchestrator:plan`   | plan, autoresearch, autoresearch-dispatch | todo, kanban, delegation, terminal, file, session_search, cronjob, skills, clarify, web | orchestrator-core, mission-memory-layout, gstack-for-hermes, llm-wiki, kanban-orchestrator, writing-plans, autoresearch, autoresearch-plan, autoresearch-orchestrate                                                                           | 库可选 | 无      |
| `researcher`   | `researcher:quick`    | quick                                     | web, browser, terminal, file, vision, session_search, skills, todo                      | researcher-core, mission-memory-layout, llm-wiki, browser-harness, gstack-for-hermes, researcher-quick, arxiv, youtube-content, polymarket                                                                                                     | 库可选 | 无      |
| `architect`    | `architect:design`    | design, autoresearch                      | terminal, file, web, session_search, skills, todo                                       | architect-core, harden-gate, mission-memory-layout, gstack-for-hermes, llm-wiki, writing-plans, requesting-code-review, codebase-inspection, architecture-diagram, brainstorming, autoresearch, autoresearch-execute                           | 库可选 | 无      |
| `developer`    | `developer:implement` | implement, autoresearch                   | terminal, file, browser, web, session_search, skills, todo                              | gstack-for-hermes, mission-memory-layout, llm-wiki, test-driven-development, systematic-debugging, codebase-inspection, github-pr-workflow, requesting-code-review, receiving-code-review, executing-plans, autoresearch, autoresearch-execute | 库可选 | 无      |
| `writer`       | `writer:author`       | author, autoresearch                      | terminal, file, web, browser, session_search, skills, todo, vision                      | gstack-for-hermes, mission-memory-layout, llm-wiki, powerpoint, docx, pdf, popular-web-designs, excalidraw, architecture-diagram, claude-design, songwriting-and-ai-music, media, writing-plans, autoresearch, autoresearch-execute            | 库可选 | 无      |
| `learning`     | `learning`            | —                                         | file, session_search, skills, todo, web                                                 | gstack-for-hermes, llm-wiki, obsidian, writing-plans, mission-memory-layout, learning-wiki-ingest                                                                                                                                              | 库可选 | 无      |

> **MCP：** 默认 roster 不预装外部 MCP。平台 MCP 库在 `/mcp`（`collab.db` → `platform_mcp_servers`），须显式绑定到 agent（`agent_mcp_servers`，**Hermes + managed 均可用**）。Hermes：物化进 profile `config.yaml` `mcp_servers`（`_agorax_platform`）；Managed：绑定存库，Claude Code 在 `startRun` 写入 per-run `mcp-config.json`。本地 Agorax 不依赖 gateway 原生 `/api/mcp`；`mcpFallback` 在 local control plane 下可用。`agents.yaml` 的 `mcpServers: []` 预留给后续 seed。

> Swarm2「Add Worker」UI 的历史 role presets（Builder / Reviewer 等）见 [`docs/swarm/ROLES.md`](docs/swarm/ROLES.md)。**那些 preset 名不是** LangGraph workflow 里的 worker id。

### 默认任务流水线

```text
orchestrator → researcher → architect → (developer | writer) → architect（review + harden）→ learning
```

规范合同：[`docs/swarm/HANDOFF-PROTOCOL.md`](docs/swarm/HANDOFF-PROTOCOL.md) · [`docs/swarm/ESCALATION-GUIDE.md`](docs/swarm/ESCALATION-GUIDE.md)。

| 阶段                            | Worker         | 职责                                                                                                                                             |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 路由 / 放行 / autoresearch 分发 | `orchestrator` | 拆解任务、起草 autoresearch 合同、分发执行者、强制人工放行门                                                                                     |
| 调研                            | `researcher`   | 只建立事实（竞品、数据校验、溯源）；不做策略/建议；回应 architect 的质疑时只给证据                                                               |
| 方向 + 设计 / 选道 / 评审       | `architect`    | wedge/bets/kill criteria + 规格/内容 brief；**只选一个**构建执行者（`developer` 或 `writer`）；评审该执行者产出。不做主事实搜集，也不写代码/成文 |
| 构建（开发道）                  | `developer`    | 按规格写代码、测试、构建验证——仅当 architect 设 `executor: developer`                                                                            |
| 构建（写作道）                  | `writer`       | 文档/幻灯/叙事/视觉交付——仅当 architect 设 `executor: writer`                                                                                    |
| 复盘                            | `learning`     | 任务文档、经验沉淀，经 `learning-wiki-ingest` 写入长期知识                                                                                       |

**执行者选道规则：** Architect 拥有 `executor: developer | writer`。同一 mission 步骤两道互斥，禁止并行分发。若既要代码又要内容，按序执行（通常 developer → writer），并重新做一次 architect 决策。

**Gate C（评审重试 ≤3）：** Architect 返回 `REVIEW_OUTCOME: changes_requested` 时，LangGraph 把同一执行者（`developer` 或 `writer`）带着评审反馈再派一轮。该道累计 **3** 次评审失败后升为 `needs_human`（Human Gate），避免死循环。配置在 `hermes_langgraph_orchestrator/workflows/` 里 `changes_requested` 转移上的 `max_iterations: 3`（`radw.yaml` / `rdi.yaml` / `design_implement.yaml`）。

**Gate H（harden 清单）：** 构建道 `REVIEW_OUTCOME: approved` 之后，architect 还必须用 skill `harden-gate` 发出 `HARDEN_OUTCOME: pass|fail`（证据清单：密钥、路径、测试/文档保真）。`pass` → learning / 申请发布放行；`fail` → 同一 EXECUTOR 修订（≤2）；批准后缺 harden → Human Gate。这不是新 worker，而是 architect 上的 skill。

---

## 二、运行时声明（`agents.yaml`）

[`agents.yaml`](agents.yaml) 是统一 agent registry，同时声明启动方式与 Swarm 编排元数据。

| id                          | runtime            | 说明                                                                              |
| --------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `default`                   | `hermes`           | 隐式根 profile：`~/.hermes`（不是 `profiles/default`）；`dispatchable: false`     |
| `orchestrator` … `learning` | `hermes`           | 与 swarm roster 一一对应；`profile` 同 id                                         |
| `gpuserver`                 | `hermes`           | `execution: ssh`；capabilities：gpu / cuda / benchmark / training；mention：`gpu` |
| `cc-impl`                   | `claude-code`      | 展示名 Claude Code；`command: claude`，`args: ['-p']`；mention：`claude`          |
| `codex-impl`                | `codex`            | `command: codex`；mention：`codex`（adapter 可能尚未完整落地）                    |
| `cursor-impl`               | `cursor`           | 展示名 Cursor；`command: cursor-agent`；mention：`cursor`                         |
| `opencode-impl`             | `opencode`         | 展示名 OpenCode；`command: opencode`；mention：`opencode`                         |
| `kimi-impl`                 | `kimi`             | 展示名 kimi；`command: kimi`                                                      |
| `ds-harness`                | `deepseek-harness` | `command: deepseek-harness`；mention：`deepseek`（adapter 可能尚未完整落地）      |

加载规则（见 `src/server/agent-runtime/agents-config.ts`）：

- `runtime !== hermes` 且 `execution === ssh` → 硬错误（SSH 本地性仅限 Hermes）。
- 未写 `execution` 时，可从 profile `terminal.backend` 自动检测；非 hermes + 检测为 ssh → 硬错误。
- Claude Code 的 provider/model 优先 `~/.claude/settings.json`；`agents.yaml` 的可选 `model` 仅作显式覆盖。
- Hermes 分发仍走现有 swarm-dispatch / tmux 路径；managed 运行时（当前主要是 claude-code）走 `src/server/agent-runtime/`。

---

## 三、群聊房间 Workspace（双模式）

群聊支持两种路径模型（实现：`src/server/group-chat/`）：

| 模式       | 行为                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ad-hoc** | 建房 / 改房可设 `workspacePath`；路径 sticky 在房间上，不是 composer 每条消息切换                                                                                              |
| **任务型** | 房间绑定 `missionId` 后，`workspacePath` 由 mission 派生（只读）；有 `projectId` 且 `workspaceMode=worktree` 时用 mission worktree，否则用 `projects.yaml` 里的 `project.repo` |

**Turn cwd（性能关键）：** drive 开始时对房间算一次 `resolveRoomCwd(room)`：

- managed（claude-code）：`startRun({ cwd })`
- Hermes：**只把路径写进 turn prompt**（如 `Room workspace: …`），**不**在群聊 turn 里改 profile 全局 workspace（避免跨房间互踩与每轮切换成本）

API 要点：

- `POST /api/rooms`：可选 `workspacePath`
- `PATCH /api/rooms/:id`：可改 `workspacePath`；已绑 `missionId` 时手改 path → **409**
- `POST /api/rooms/from-mission`：`{ missionId }` → `ensureRoomForMission`（幂等）

项目声明见 [`projects.yaml`](projects.yaml)（控制面仓库默认不在列表中；自托管需 `selfHosted: true`）。Mission ↔ Project 合同见 [`docs/mission-project-domain.md`](docs/mission-project-domain.md)。

---

## 四、操作规则

- 改 agent 时保持 `agents.yaml`（tools / skills / mission）与 profile toolset、skills、SOUL、wrapper 对齐。模型默认值由 profile `config.yaml` 管理；只有需要显式覆盖时才在 `agents.yaml` 使用可选 `model`。
- **GBrain ≡ llm-wiki**：本仓库未部署本地 `gbrain` skill/MCP。Brain-first 查询用 Hermes 内置 `llm-wiki`（`WIKI_PATH`，默认 `~/wiki`），外加 `memory/swarm/` 下的 mission 记忆。
- **Brain-first 顺序**（先于 web 搜索）：① 读 `$WIKI_PATH/SCHEMA.md` + `index.md` + 近期 `log.md`；② grep `memory/swarm/` 与 dispatch handoff；③ `session_search` 查历史会话；④ 本地不足再用外部 `web` / `arxiv`。
- **知识分层：** `~/wiki` = 长期领域知识；`memory/swarm/missions/<missionId>/` = 归档任务产物；`memory/swarm/<worker>/` = 进行中草稿；`memory/handoffs/swarm/` = 最新 checkpoint；任务结束后由 `learning` 把可复用结论 ingest 进 wiki（见 `docs/swarm/LEARNING-WIKI-INGEST.md`）。
- **职责边界：** Researcher 只立事实；Architect 可质疑并握方向/规格/选道/评审/harden；Developer / Writer 只执行本道规格，缺口升给 architect（writer 事实缺口经 architect 回 researcher）；Learning 文档化与 wiki ingest；Orchestrator 路由与放行。质疑往返最多 3 轮，再按 `docs/swarm/ESCALATION-GUIDE.md` 升级。
- 除非任务明确需要，不要全局启用可选 Hermes plugin；先在 `agents.yaml` 记录 plugin/toolset 对齐。
- 本地 Workspace 配对/调试时，**一个 gateway 为规范实例**：`hermes gateway run` 监听 `:8642`。Dashboard（`:9119`）可选，仅分析。再起 gateway 前先 `curl http://127.0.0.1:<workspace-port>/api/sessions`（本机 `pnpm dev:ui` 多为 `6734`）。Sessions 已有数据则刷新/重探测 UI，不要再起第二个 gateway。
- 若默认模型走 `openai-codex` / Codex 族，聊天依赖本机 Codex CLI 已登录（`codex login`）。

---

## 五、LangGraph Phase 2 Human Gate

当 Phase 2 orchestrator 置 `needs_human=True` 时：

- **Dashboard（推荐）：** 打开 `/swarm`。Human Gate 面板会显示阻塞 worker、阻塞类型、checkpoint、待办分配与路由分析。点 **继续执行** 恢复，或 **中止**。
- **CLI 回退：**
  - `python -m hermes_langgraph_orchestrator --execute --resume approved --mission-id <id>`
  - `python -m hermes_langgraph_orchestrator --execute --resume abort --mission-id <id>`
- **自动化 API：**
  - `GET /api/orchestrator-active-gates` — 扫描 SQLite，返回所有 `needs_human=True` 的 mission
  - `GET /api/orchestrator-state?missionId=<id>` — 单个暂停态
  - `POST /api/orchestrator-resume` — body `{ missionId, action: "approved" | "abort" }`，后台恢复
  - 启动 mission 优先 `POST /api/swarm-langgraph/run`；人工门恢复优先 `POST /api/swarm-langgraph/resume`（可带 `continueWaitMinutes`，超时阻塞时继续等待 15/60 分钟）

Orchestrator venv（每台机器一次，Python ≥ 3.10，建议 3.11+）：

```bash
cd hermes_langgraph_orchestrator
python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

---

## 六、Swarm 分发环境变量

- `HERMES_SWARM_FORCE_ONESHOT=1` — 强制 wrapper oneshot（`hermes -p <worker> chat -q`），不用默认 tmux 长会话。适合 CI 或无 tmux 主机。
- `HERMES_SWARM_TMUX_MODE=tui` — **默认/推荐**。tmux 长驻 `hermes chat --tui`；WebUI 经 bracketed-paste 送到 TUI prompt，支持实时对话。
- `HERMES_SWARM_TMUX_MODE=cli` — **可选 fallback**。tmux 跑 `bash -l`；dispatch 用 `send-keys` 每轮跑 `hermes chat -q`。不支持 WebUI 实时聊天，但 paste 更稳，适合纯编排或 TUI 不可用。
- `HERMES_SWARM_USE_LIVE=1` — **已弃用**（tmux 已是默认）；设置只会告警。
- `HERMES_SWARM_MOCK_BIN=<dir>` — `src/routes/api/swarm-dispatch.ts` 优先在该目录找 worker wrapper，找不到再回退 `~/.local/bin/`。用于不调真实 LLM 时验证路由。

**tmux 全局配置**（TUI/CLI 都依赖）：在 `~/.tmux.conf` 加：

```
set -g exit-empty off
set -g exit-unattached off
```

防止最后一个 session 关闭时 tmux server 退出。

**实现要点（运维相关）：**

1. TUI bracketed-paste：`src/server/swarm-tmux-delivery.ts` 的 `tmuxPasteWithBracketedPaste`，用 `\e[?2004h` / `\e[200~` / `\e[201~` / `\e[?2004l` 包装 paste，避免 prompt_toolkit 多行 continuation。
2. TUI 空壳检测：`src/routes/api/swarm-direct-chat.ts` 发送前检查 session 是否真在跑 Hermes；仅 bare shell 则 kill 重建，避免消息当 shell 命令执行。
3. CLI shell ready：`tmuxPaneLooksLikeShellReady` 识别 `~$` 结尾，忽略 `.bashrc` 噪音。
4. `workflowId`：`src/routes/api/swarm-langgraph/run.ts` 不把短名（如 `rdi`）当路径；仅含 `/` 或 `\` 时才当绝对路径。
5. Human Gate「继续等待」：`langgraph-human-gate.ts` → resume API → `HERMES_LANGGRAPH_CONTINUE_WAIT_MINUTES` → orchestrator `wait_for_checkpoints` 覆盖 `staleMinutes`；UI 在 `/swarm`。
6. 部分 workflow（如 `rdi.yaml`）把 `timeout` 从 `retry` 改为 `escalate`，超时进 Human Gate 而非无限重试。

---

## 七、Windows 备注

- **两个必需服务**：Gateway（:8642）+ Workspace（`pnpm dev:ui` 默认 :6734）。Dashboard（:9119）可选。
  - Gateway：`hermes gateway run`
  - Workspace：`pnpm dev:ui`
  - 可选：`hermes dashboard --port 9119 --host 127.0.0.1 --no-open`
  - 或 Electron：`pnpm electron:dev`（自动起 gateway + workspace）
- **桌面端**：`electron/main.cjs`；`electron:build:win` 产出 NSIS 到 `release/`。
- **两套/三套 `.env`：** Gateway 读 `%LOCALAPPDATA%\hermes\.env`；CLI 读 `%USERPROFILE%\.hermes\.env`；Workspace 读仓库 `.env`。API key 需保持一致。
- Gateway API 需 `API_SERVER_ENABLED=true` + `API_SERVER_KEY`，否则无已连接平台。
- Workspace 运行时读 `HERMES_API_URL` / `HERMES_API_TOKEN` / `HERMES_DASHBOARD_URL`。Gateway 地址只认 `HERMES_API_URL`。`HERMES_API_TOKEN` 与 `HERMES_DASHBOARD_URL` 仍接受同名 `CLAUDE_*` 回退。本地多 profile（`HERMES_GATEWAY_POOL` 开着，loopback 默认开）时，1:1 聊天按请求里的 profile 直连该 profile 的端口和 `API_SERVER_KEY`，不改进程全局 `HERMES_API`。Pool 关掉或远程配对时，所有 profile 仍共用这一个地址。
- Windows 无自带 `sqlite3` CLI：`winget install SQLite.SQLite`，并把 `sqlite3.exe` 放进 PATH。
- Claude Code managed agents 需要 `claude` CLI：`npm install -g @anthropic-ai/claude-code`。
- 端口冲突：PowerShell `netstat -ano | findstr :<port>` + `Stop-Process -Id <PID> -Force`。
- 需要 Node.js 22+。Windows npm script 不要依赖 `NODE_ENV=...` / `NODE_OPTIONS=...` 前缀写法。

---

## 八、给 Agent 的仓库导航（简图）

| 区域                         | 路径                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Chat 分层合同（运行时分叉·事件同源） | `docs/hermes-native-bridge.md`、`src/lib/hermes-activity-adapter.ts` |
| Agent / Swarm 合同与 roster  | `agents.yaml`、`AGENTS.md`、`docs/swarm/`                                    |
| 运行时声明                   | `agents.yaml`、`src/server/agent-runtime/`                                   |
| LangGraph                    | `hermes_langgraph_orchestrator/`                                             |
| 群聊                         | `src/server/group-chat/`、`src/screens/group-chat/`、`src/routes/api/rooms*` |
| 1:1 Chat / managed companion | `src/screens/chat/`、`src/routes/api/agents/`                                |
| Missions / Agents UI         | `/missions`、`/agents`（旧 `/mission-control` `/operations` `/profiles` redirect）；合同见 `docs/ia-missions-agents-merge.md`、`docs/mission-task-domain.md`（mission-keyed，无 kanban card） |
| Swarm UI                     | `src/screens/swarm/`、`src/routes/swarm.tsx`（`/swarm2` redirect）            |
| Profile 同步                 | `scripts/sync-swarm-profiles.mjs`                                            |
| 项目 / worktree              | `projects.yaml`、`docs/mission-project-domain.md`、`src/server/git-ops.ts`、`src/server/task-pipeline/` |

改 agent roster / skills / 门控时：先改 `agents.yaml`（及必要时 workflow yaml），再 sync profiles，并同步更新本文，避免合同漂移。
