# FUTURE-FEATURES.md

---

## 🔴 高优先（解锁「App Factory」通宵跑；以及 Chat 同源切轨）

### 1. 迭代精炼循环（Iterative Refinement Loop）

**做什么：** 校验不止跑一遍 `tsc`。循环：跑 tsc → 有错？→ 打回 agent → 修复 → 再跑。最多 3 轮，再升给人审。  
**为什么：** Anthropic 明确把这当作让 agent 可靠的模式。当前单次校验失败时容易静默。  
**落点：** mission/swarm 校验路径（原 `workspace-daemon` 已移除；见 `src/server/task-pipeline/` / LangGraph harden gate）  
**模式来源：** Anthropic Skills Guide — "Iterative Refinement"

### 2. Agent Handoff（跨 agent 传上下文）

**做什么：** 一个 agent 完成一波后，把结构化上下文（git diff、错误日志、做了什么、跳过了什么）交给下一个。禁止冷启动。  
**为什么：** 现在每个任务几乎从零开始。Handoff 是 OpenAI Agents SDK 的一等原语——显式交接 + 上下文。通宵跑要靠这个连贯。  
**落点：** `docs/swarm/HANDOFF-PROTOCOL.md` + swarm dispatch handoff（原 `workspace-daemon` 已移除）  
**模式来源：** OpenAI Agents SDK — "Handoffs"

### 3. 专用 Agent 角色

**做什么：** 用角色化 agent 替代泛化 Codex adapter：

- **Researcher** — 读代码库，产出规格/上下文文档
- **Planner** — 吃规格，产出带依赖的任务拆解
- **Builder** — 执行任务（Codex）
- **Validator** — 跑 tsc、测试、审 diff
- **Deployer** — git 操作、开 PR、通知

**为什么：** 「App Factory」截图跑的是专用角色；泛化 agent 缺领域上下文。  
**落点：** `agents.yaml` roster + Hermes/managed adapters（原 `workspace-daemon` 已移除）  
**模式来源：** Anthropic Skills — "Domain-specific intelligence" + App Factory

### 4. Chat turn Phase C — Native bridge 真接线 ✅

**已做：** `createHermesAgentEngine` + `createHermesCommandPort`：Send/Stop 经 Engine；`/api/send-stream` 与 `/api/runs/.../stop` 仅出现在 commandPort；SSE→`hermesSseToActivityEvents`→`coordinator.ingestEvent`；`agorax_run_mapping` 落 `collab.db`（刷新后可找回 `hermesRunId`）。  
**落点：** `src/screens/chat/lib/hermes-agent-engine.ts`、`src/stores/hermes-chat-runtime.ts`、`src/server/agorax-run-mapping.ts`、`docs/hermes-native-bridge.md`  
**仍缓：** Swarm/tmux；历史整桶改 Engine；portable 单独工程（同 port→send-stream 即可）。

### 5. Chat turn Phase D — Hermes 1:1 UI 只订 Engine ✅（开 turn）

**已做：** `useHermesEngineChatState` 双订 engine+coordinator；`turnBusy` ← `selectHermesChatState.showProcessingIndicator`，不再 OR `waitingForResponse` / `pendingGeneration`。  
**落点：** `src/screens/chat/hooks/use-hermes-engine-chat.ts`、`chat-screen.tsx`  
**仍缓：** 已 settle 历史整桶仍用 history query（禁止换皮）；portable 显式同轨降级。

---



## 🟡 中优先



### 6. 并行护栏（agent 跑着时的 tsc watcher）

**做什么：** Codex 跑的同时开 tsc watch，不只在 checkpoint 后才查错；实时标错、不堵主流程。  
**为什么：** OpenAI SDK 把 guardrail 和 agent 并行跑——发现问题但不阻塞主链路。  
**落点：** 在 `agent-runner.ts` 旁拉起新进程  
**模式来源：** OpenAI Agents SDK — "Guardrails"

### 7. Checkpoint 拒绝时回滚

**做什么：** checkpoint 被拒时自动回到任务前 git 状态，不要把脏代码留在树上。  
**为什么：** 现在拒绝后坏代码会留给下一个 agent。  
**落点：** `src/server/git-ops.ts` — 增加 `revertToCheckpoint()`

### 8. 上下文感知的工具选择

**做什么：** 按文件大小、任务类型、上下文选不同工具。大重构 → Codex；小手术 → Claude ACP session；调研 → 带 web search 的 Claude。  
**模式来源：** Anthropic Skills — "Context-aware tool selection"

---



## 🔵 低优先（企业 / 规模）



### 9. 把会话持久化暴露给 Agent

**做什么：** 每个任务开始时把上一轮上下文（什么成了、什么挂了、git 历史）塞进 agent。现在即使重跑也经常从盲状态起步。  
**落点：** 更新 adapter `buildPrompt()`，从 SQLite 带入 run history

### 10. Agent Prompt 的渐进式 Skill 加载

**做什么：** 系统提示用 Anthropic 三级渐进披露——最小 header 常驻，完整说明仅在触发时加载，参考文档按需。  
**为什么：** 多 agent 并行时保持上下文精简。  
**模式来源：** Anthropic Skills Guide — 核心架构

### 11. Skills 市场 / Agent Skill 定义

**做什么：** 把 agent「技能」做成可移植的 SKILL.md 风格文件，可共享、可版本、可替换。例如「React Builder」vs「Python API Builder」。  
**模式来源：** Anthropic agentskills.io 开放标准

---



## 汇总表


| 功能                            | 影响   | 工作量 | 优先建议                 |
| ----------------------------- | ---- | --- | -------------------- |
| 迭代精炼循环                        | 🔥 高 | 低   | 先做                   |
| Agent Handoff                 | 🔥 高 | 中   | 其次                   |
| 专用 Agent 角色                   | 🔥 高 | 高   | 第三                   |
| Chat Phase C（bridge → Engine） | ✅ 已落地（1:1） | — | Swarm/历史整桶仍缓 |
| Chat Phase D（UI 只订 Engine）    | ✅ 开 turn busy | — | 历史整桶仍 history query |
| 并行护栏                          | 中    | 中   | 角色之后                 |
| 拒绝时回滚                         | 中    | 低   | 角色之后                 |
| 上下文感知工具选择                     | 中    | 高   | 更晚                   |
| 会话持久化暴露                       | 低    | 低   | 更晚                   |
| 渐进式 Skill 加载                  | 低    | 中   | 更晚                   |
| Skills 市场                     | 低    | 高   | 很晚                   |


