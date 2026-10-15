# Missions / Agents IA 合并方案

> 状态：已确认（2026-09-20）  
> 取代：侧栏「Missions Overview + Operations + Profiles(+Monitoring)」三入口重叠模型  
> 相关：[`operations-redesign-spec.md`](./operations-redesign-spec.md)（Agents 页内部配置深度仍有效，页面名改为 Agents）  
> 明确不做：不把 `/swarm` 并进 Missions 或 Agents

---

## 1. 目标信息架构

保留 **两个一级面** + **一个编排现场面**：

| 侧栏文案 | 最终路由 | 一句话 | 管什么 |
| -------- | -------- | ------ | ------ |
| **Missions** | `/missions` | 「在做什么」 | MissionSurface（board/list/swimlane）+ 详情 Tasks；Create Mission（Goal / pipeline / assignee）；可选群聊 |
| **Agents** | `/agents` | 「是谁、能干什么、健康吗」 | profile 配置、轻量健康/用量、cron、outputs |
| **Swarm** | `/swarm` | 「编排现场」 | dispatch / tmux / Human Gate / checkpoint |

**删除的独立入口：**

- Mission Control **Overview** tab（能力拆到 Agents + Board）
- `/profiles`（含 Monitoring tab）
- `/operations` 作为产品名（路由 redirect 到 `/agents`）
- **独立 `/tasks` 页**（redirect → `/missions`；Task 仅在 Mission 详情展示）

---

## 2. Overview 拆分归属

| Overview 现有块 | 并入 | 规格 |
| --------------- | ---- | ---- |
| Online / Executing / Blocked / Pending human KPI | **Agents** Team Overview | 与 Agents 现有 KPI 合并；同源 `unifiedStatus`，禁止两套数字 |
| Agent wall（runtime badge、status、current task、checkpoint） | **Agents** 网格 | 卡上保留 runtime + status；见 §4 `currentTask` 深链 |
| Task progress by lane | **Board** 顶栏 | 可选：按 lane 计数条；Board 列本身已表达，优先轻量 |
| Recent tasks | **Board** | 默认按 `updatedAt` 降序；不强制单独「最近」面板 |

Overview tab **删除**。`?tab=overview` → redirect 到 Board（见 §5）。

---

## 3. Missions：Board 为唯一列表态

### 3.1 子态

| 子态 | 如何进入 | 说明 |
| ---- | -------- | ---- |
| **MissionSurface** | `/missions` | board / list / swimlane；Create Mission（pipeline \| assignee 互斥） |
| **Detail** | `/missions?missionId=<id>`（兼容 `taskId`） | Tasks 分解表 + StageBar + Timeline；群聊按需 Create room |

列表实体始终是 **Mission**；Task 不进列表行。详见 [`mission-task-domain.md`](./mission-task-domain.md)。

旧 tab 名 `board` / `pipeline` 可映射到上述行为；`overview` 废弃。

### 3.2 Board 顶栏 — 任务向 KPI（必做）

Overview 删除后，Board 必须自带态势，避免空板无引导。

**只放任务 KPI，不放 Online agents**（agent 态势归 `/agents`）：

| KPI | 口径（初版） | 点击行为（建议） |
| --- | ------------ | ---------------- |
| In progress | lane ∈ {`in_progress`, `review`, …} 或 status 执行中 | 过滤 Board 到对应列 |
| Blocked | 任务/assignment 阻塞（含 agent blocked 关联的卡） | 过滤 blocked |
| Pending human | `needs_human` / pending_turn / Gate 等待 | 过滤待人工 |
| Done | lane=`done` 或今日完成（API 有 `completedAt` 后再做「今日」） | 过滤 done |

实现注意：

- 数据源：`GET /api/missions`（兼容 `GET /api/tasks`；与 Board 同 query），不要另轮询 `/api/agents/status` 只为这四个数。
- 空板：文案 + 主 CTA **Create Mission**（pipeline \| assignee 互斥）。

### 3.3 Board 上不再出现

- Agent 配置 / Activate / skills / MCP / cron / Recover / Ping
- Token / cost / Telegram 明细

Agent 点击若出现在任务卡 assignee 上：进 Pipeline 或 Chat；「配置此 agent」→ `/agents?agent=<id>`。

---

## 4. Agents：唯一配置 + 健康面

### 4.1 从旧页迁入

| 来源 | 迁入位置 |
| ---- | -------- |
| Profiles：列表 / Create / Activate / Rename / Delete / clone wizard | 网格 + New Agent；Detail → Identity |
| Profiles：description 编辑 | Detail → Identity |
| Monitoring：online、Telegram、tokens/cost、session/tool 计数 | 卡片 1 行摘要 + Detail → **Usage** tab |
| Monitoring：跳 `/missions?missionId=` `/jobs?agent=` | 卡上保留或 Usage 内链接 |
| Operations：Capabilities / Schedule / Activity / Outputs / Recover / Ping | 保留；Agent Bus 收成顶栏「Swarm health」条，不再整面 Troop 墙 |

### 4.2 Detail tabs（目标）

1. Identity（含 Activate / Rename）
2. Model & Provider
3. Capabilities（skills / MCP / tools / workspace）
4. Schedule（cron）
5. Activity
6. **Usage**（原 Monitoring）

### 4.3 Agent 卡 — `currentTask` 深链（必做）

Overview 里「谁在忙哪张卡」迁到 Agents 卡，避免 Missions↔Agents 断联：

| 字段 | 展示 | 交互 |
| ---- | ---- | ---- |
| `currentTask` / `missionId` / task card id | 卡上单行标题或 id | 点击 → `/missions?missionId=<missionId>`（兼容 `taskId` card id） |
| checkpoint / needsHuman | 状态点旁短标签 | needsHuman 时可次要链到 `/swarm` |

无 current task 时不占位空行（或显示 Idle）。

### 4.4 Team Overview KPI

与 snapshot 的 `unifiedStatus` 对齐，建议字段：

- Online / Active(Executing) / Blocked / Needs setup  
- 可选：Total tokens / cost（来自 Usage 聚合）

与 Missions Board 的任务 KPI **命名空间分离**，避免「Blocked」一词两边口径不同却并排展示。

---

## 5. Redirect 表

| 旧路径 | 新路径 | 备注 |
| ------ | ------ | ---- |
| `/mission-control` | `/missions` | 默认 Board |
| `/mission-control?tab=overview` | `/missions` | Overview 废弃 |
| `/mission-control?tab=board` | `/missions` | |
| `/mission-control?tab=pipeline` | `/missions` | 无 taskId 时仍 Board |
| `/mission-control?tab=pipeline&taskId=X` | `/missions?missionId=X`（兼容 `taskId`） | |
| `/mission-control?taskId=X` | `/missions?missionId=X`（兼容 `taskId`） | |
| `/tasks` | `/missions` | 独立 Tasks 页废弃 |
| `/operations` | `/agents` | 保留 query（如 `?agent=`） |
| `/operations?*` | `/agents?*` | |
| `/profiles` | `/agents` | |
| `/profiles` + UI tab Monitoring | `/agents`（可 `?tab=usage` 打开 Usage；首版可忽略深链） | Monitoring 无 URL tab，仅兼容入口 |

侧栏 / mobile：

| 位置 | 旧 | 新 |
| ---- | -- | -- |
| Desktop Agents 区 | Missions · Operations | **Missions · Agents** |
| Desktop Knowledge 区 | Profiles | **删除** Profiles 项 |
| Mobile tab / hamburger | Missions · Profiles · Operations | **Missions · Agents**（+ 按需 Swarm） |

实现落点（参考）：`src/screens/chat/components/chat-sidebar.tsx`、`src/routes/mission-control.tsx` → `missions`、`src/routes/operations.tsx` → `agents`、`src/routes/profiles.tsx` redirect。

---

## 6. 统一态势 API（性能）

三处曾各自派生 online/busy：

- MC Overview：`GET /api/agents/status`
- Monitoring：`GET /api/crew-status`
- Operations：session + swarm-runtime 本地合成

**目标：**

1. 后端单一聚合（扩展 `/api/agents/status` 或新 `GET /api/agents/snapshot`）：registry + `unifiedStatus` + runtime badge + process/gateway/Telegram + usage 摘要 + currentTask/needsHuman。
2. 前端 `useAgentSnapshot` 共用 React Query key；Missions **不再**为 Overview 拉 agents；Agents 首屏只打 snapshot；Detail 再懒加载 capabilities/cron。
3. 停掉 Agents 页并行 30s 多路（`profiles/list` + `crew-status` + `swarm-runtime` + `swarm-health`）。

成功标准：打开 `/agents` 首屏聚合请求 ≤ 1；Missions 与 Agents 对同一 agent 的 Online/Blocked **数字一致**。

---

## 7. 写路径边界（硬规则）

| 操作 | 唯一入口 |
| ---- | -------- |
| Create / Start task、Pipeline advance、Enter room | **Missions** |
| Profile CRUD、Activate、Rename、skills/MCP、model、cron 编辑 | **Agents** |
| Ping workers、tmux Recover、Human Gate 继续/中止 | **Swarm**（Agents 可保留轻量 Ping/Recover 快捷，深链 Swarm） |

禁止：Missions 编辑 profile；Agents 做 Board/Create Task。

---

## 8. 分阶段落地

### Phase 0 — 文档与命名（本文件）

- [x] 确认 IA：无 Overview；路由叫 Agents
- [x] `operations-redesign-spec.md` 顶部注明页面更名为 Agents，边界表指向本文
- [x] 同步 `AGENTS.md` 导航简图（若列出 WebUI 路由）

### Phase 1 — 路由与瘦身

- [x] 新增 `/missions`、`/agents`；旧路由 redirect（§5）
- [x] 删除 Overview tab 与 `overview-view` 挂载；Board 加任务 KPI + 空态
- [x] Agents 卡加 `currentTask` → `/missions?taskId=`
- [x] 侧栏文案改为 Missions / Agents；去掉 Profiles

### Phase 2 — Profiles / Monitoring 并入

- [x] Agents Detail 补 Activate / Rename；New Agent 吃 clone wizard
- [x] Usage tab；Monitoring 屏退役
- [x] Agent Bus 收成 Swarm health 条

### Phase 3 — snapshot 与删死代码

- [x] `/api/agents/snapshot`（或扩展 status）+ `useAgentSnapshot`
- [x] 删除 Ops 本地 status 合成为主路径；crew-status 仅 Usage 懒加载
- [x] 删除 `profiles-screen` / `crew-screen` / `overview-view` 路由壳

---

## 9. 验收清单

1. 侧栏 Agents 区一级入口为 **Missions + Agents**；Profiles / Operations 文案消失。
2. 无 Overview tab；`/mission-control?tab=overview` 落到 Board。
3. Board 顶栏具备任务向 KPI + Create Task 空态。
4. Agents 卡可从 current task 深链进 Pipeline。
5. 配置写操作仅 Agents；任务写操作仅 Missions。
6. （Phase 3）两页 Online/Blocked 一致；Agents 首屏 ≤ 1 聚合轮询。

---

## 10. 决策记录

| 决策 | 结论 |
| ---- | ---- |
| Overview 是否保留 | **否** — 拆入 Agents + Board |
| 最终 Agents 路由名 | **`/agents`**（不用 Operations） |
| Missions 默认视图 | **Board** |
| Swarm2 | **独立**，不合并 |
| Profiles / Monitoring | **并入 Agents** 后删入口 |

### New Agent 双入口合同（2026-09-20）

Agents → New Agent 与 Settings → Add agent **行为一致**：

1. 支持全部 runtime（`hermes` + managed backends）。
2. 一律登记 `POST /api/agent-registry`。
3. 选 Hermes 时先走 `POST /api/profiles/create`（可选 clone/model），服务端 registry **不再**静默 `createProfile`。
4. 共享实现：`src/lib/create-agent.ts`（`createAgentConsistent`）。
