# Operations / Agents 页面重构设计方案

> **IA 更新（2026-09-20）：** 产品一级面最终路由为 **`/agents`**（不再以 Operations 为侧栏名）。  
> Mission Control **Overview** 删除，能力拆入 Agents + Missions Board。  
> 全站入口、redirect、Board KPI、`currentTask` 深链与分阶段计划见  
> [`ia-missions-agents-merge.md`](./ia-missions-agents-merge.md)。  
> 下文「Operations」均指 **Agents 页内部配置深度**；实现时 UI 文案与路由用 Agents。

## 1. 核心问题与设计原则

### 1.1 根因假设

- **定位模糊**：当前 Operations 页面想做 "persistent agent team"，但仅做了轻量的 profile 管理 + 会话拼接。
- **能力浅**：每个 agent 的可配置项仅限 name、emoji、model、description、system prompt，缺少 skills、MCP、tools、workspace、env 等决定 agent 能力边界的关键字段。
- **与 Swarm / Missions Overview 重叠**：多处展示 agent 卡片与 online/busy KPI，配置浅、态势口径不一致。
- **数据分散**：profile、skills、MCP、providers 等配置分布在多个页面，没有一个按 agent 聚合的入口。

### 1.2 设计原则

1. **Single source of agent truth**：一个 agent = 一个 Hermes profile，**Agents（原 Operations）** 是这个 profile 的完整配置中心。
2. **和 Missions / Swarm 明确分层**：
   - Agents：agent 是什么、能做什么、用什么资源（配置 + 轻量健康/用量）。
   - Missions：任务 Board / Pipeline（工作流）；**无 Overview agent 墙**。
   - Swarm：tmux / dispatch / Human Gate / checkpoint（编排现场）。
3. **角色模板化**：预设 role 应该是 "skills + MCP + tools + workspace + memory" 的组合包，而不仅仅是 system prompt 文案。
4. **配置完整性检查**：每个 agent 的配置状态可视（model、provider、skill、MCP、tools 等），缺少关键项时给出明确提示。
5. **轻量运行看板**：保留会话摘要、cron 任务、团队 activity feed，但不去做 Swarm 已经做好的运行时细节，也不做 Missions Board。

## 2. 新定位

Agents（原 Operations）重新定位为：

> **Agent Team Headquarters（Agent 团队总部）**
>
> 在一个页面里，完整配置每个持久化 Agent 的身份、能力、资源和运行策略，并轻量聚合展示其最新活动与产出。

### 2.1 与周边页面的边界

| 页面               | 不再做                       | 交给 Agents（原 Operations）               | 交给 Missions / Swarm                              |
| ------------------ | ---------------------------- | ------------------------------------------ | -------------------------------------------------- |
| Profiles           | 独立入口；列表、创建、激活 | profile 完整编辑 + Activate/Rename         | -                                                  |
| Monitoring（Crew） | 独立 tab                     | Usage tab + 卡上健康摘要                   | -                                                  |
| Missions Overview  | 整 tab 删除                  | Agent wall + agent KPI                     | Board：任务 KPI + Recent；Pipeline 不变            |
| Skills / MCP       | 统一按 profile 散落管理      | 按 agent 管理 skills/MCP                   | -                                                  |
| Settings/Providers | 按 agent 管理 provider/model | provider/model 选择、.env 检测             | -                                                  |
| Swarm              | -                            | 可选 Ping/Recover 快捷                     | worker 运行时、dispatch、tmux、Human Gate          |

## 3. 页面结构

### 3.1 主视图

```
+-----------------------------------------------------------------+
| Operations                    [New Agent]  [Templates]  [...]   |
+-----------------------------------------------------------------+
| Team Overview                                                   |
|   Active N   Idle N   Error N   Needs Setup N   Total Cost/Tokens|
+-----------------------------------------------------------------+
| Agent Grid                                                      |
| +-------------+ +-------------+ +-------------+                 |
| | 🤖 Builder  | | 🐦 Sage     | | 📊 Ops      |                 |
| | [status]    | | [status]    | | [status]    |                 |
| | skills: 5   | | skills: 3   | | skills: 2   |                 |
| | MCP: 2      | | MCP: 1      | | MCP: 0      |                 |
| | Last output | | Last output | | Next run    |                 |
| +-------------+ +-------------+ +-------------+                 |
+-----------------------------------------------------------------+
| Recent Activity (team outputs)                                  |
+-----------------------------------------------------------------+
```

### 3.2 Agent 卡片信息

每个 agent 卡片至少展示：

- 头部：emoji + name + 状态指示器 + 设置按钮
- 身份：description（一行）
- 能力统计：skills 数量、MCP server 数量、tools 类别（文件/终端/web/网页）
- 资源：model / provider / workspace（缺少时高亮 "Needs setup"）
- 活动：最近一条 output 摘要 + 时间 / 下次 cron 时间
- 快捷操作：运行一次任务、打开 chat、编辑设置

### 3.3 Agent 详情 / 设置面板

点击卡片进入详情，分为以下 tab：

#### Tab 1: Identity

- Name / Emoji / Description
- System Prompt
- Role template（可与 skills/tools/MCP 联动）

#### Tab 2: Model & Provider

- Provider 选择
- Model 选择
- Fallback model（可选）
- Temperature / max_tokens 等高级参数（如果 config 支持）

#### Tab 3: Capabilities（核心扩展）

- **Skills**：已安装 skills 列表，按 agent 开关 / 排序 / 搜索；提供 "Add skill" 跳转
- **MCP Servers**：平台 MCP 库 + 按 agent 显式分配（与 Skills / Multica 同模型）；Operations 可 toggle profile 级条目，并从库一键 assign；入库 ≠ 授权
- **Tools**：基于 Hermes config 的 enabled_toolsets / toolsets 显示（如果有），简单展示哪些 toolset 可用
- **Workspace**：绑定工作区目录
- **Memory**：绑定 wiki / memory 路径（如果支持）

#### Tab 4: Schedule

- 属于该 agent 的 cron jobs 列表（现有）
- 新增 / 编辑 / 删除 cron job
- 模板："Daily standup report"、"Weekly competitor scan"等

#### Tab 5: Activity

- 该 agent 的近期 outputs 列表
- 点击跳转到对应 session
- 按日期、source（session/cron）筛选

## 4. 数据模型与 API

### 4.1 扩展 OperationsAgent 类型

```ts
export type OperationsAgent = GatewayConfigAgent & {
  meta: OperationsAgentMeta
  shortModel: string
  status: OperationsAgentStatus
  sessionKey: string
  sessions: GatewaySession[]
  latestSession: GatewaySession | null
  jobs: CronJob[]
  nextRunAt: number | null
  lastActivityAt: number | null
  activityLabel: string
  progressValue: number
  progressStatus: 'running' | 'queued' | 'failed' | 'complete' | 'thinking'
  recentOutputs: OperationsOutputItem[]
  needsSetup: boolean

  // 新增
  capabilities: {
    skills: AgentSkillItem[]
    mcpServers: AgentMcpItem[]
    toolsets: string[]
  }
  resources: {
    workspace?: string
    memoryPaths?: string[]
    envExists: boolean
  }
  health: {
    hasModel: boolean
    hasProvider: boolean
    missingSkills: string[]
    disabledMcp: string[]
  }
}
```

### 4.2 新增 API

| API                                   | 方法     | 功能                                                     |
| ------------------------------------- | -------- | -------------------------------------------------------- |
| `/api/profiles/read`                  | GET      | 读取单个 profile 的完整 config（已有）                   |
| `/api/profiles/skills?name=<profile>` | GET      | 读取某 profile 的 skills（已有）                         |
| `/api/profiles/update`                | POST     | 更新 profile config（已有）                              |
| `/api/profiles/toggle-skill`          | POST     | 切换某 profile 的 skill 开关（已有）                     |
| `/api/profiles/mcp`                   | GET/POST | 读取/更新某 profile 的 MCP（toggle/remove/upsert） |
| `/api/platform-mcp`                   | GET/POST | 平台 MCP 库 CRUD（写侧含完整 config；读侧脱敏） |
| `/api/agents/:id/mcp`                 | GET/POST | 按 agent 分配平台 MCP；写后物化到 profile |
| `/api/profiles/env`                   | GET      | 检测某 profile 是否有 .env（已有能力，封装 API）         |
| `/api/profiles/capabilities`          | GET      | 聚合返回 skills + MCP + toolsets（可选，减少前端请求数） |

### 4.3 后端实现复用

- `src/server/profiles-browser.ts`：profile 读写、列表、skill 统计。
- `src/server/swarm-profile-config.ts`：`ensureSwarmProfileConfig` 用于 profile 引导；Swarm 默认 model 由 profile `config.yaml` 管理，dispatch 不再注入 roster model。
- `src/routes/api/profiles/skills.ts`：skill 列表代理。
- MCP 部分可借鉴 `src/screens/mcp/hooks/use-mcp-servers.ts` 的逻辑，做成按 profile 范围的读写。

## 5. 实施路径

### 5.1 阶段一：卡片增强（低风险） ✅ 已完成

1. 在 `useOperations` 中增加对 skills、MCP、workspace、env 的读取（可以先在后端 `/api/profiles/read` 返回）。
2. 修改 `OperationsAgentCard`，增加：
   - skills 数量、MCP 数量、workspace 路径
   - 更精确的 `needsSetup` 检测（缺 model/provider/env 均提示）
   - 点击卡片主体打开详情
3. 保持后端 API 不大变的情况下，用现有 `/api/profiles/read` 补充 skills/MCP 信息。

### 5.2 阶段二：详情配置面板 ✅ 已完成

1. 重写 `OperationsAgentDetail`，改为 tab 形式：Identity / Model & Provider / Capabilities / Schedule / Activity。
2. 实现 Capabilities tab：
   - 调用 `/api/profiles/capabilities` 聚合获取 skills + MCP + toolsets + workspace + env；
   - 调用 `/api/profiles/mcp` (POST toggle/remove) 管理 MCP servers；
   - 调用 `/api/profiles/toggle-skill` (PUT) 切换 skill 启用/禁用；
   - 显示 workspace 路径、.env 检测、toolsets 列表。
3. 把现有的 system prompt、model 配置整合到 Identity 和 Model & Provider tab。
4. 新增 Schedule tab（展示 cron jobs）和 Activity tab（展示 outputs + sessions）。

**新增 API：**

- `GET /api/profiles/capabilities?name=<profile>` — 聚合返回 skills + MCP + toolsets + workspace + envExists
- `GET /api/profiles/mcp?name=<profile>` — 读取 profile 的 MCP servers 列表
- `POST /api/profiles/mcp` — toggle/remove/upsert MCP server（body: `{name, action, server, enabled?}`）
- `GET/POST /api/platform-mcp` — 平台 MCP 库（入库 ≠ 分配）
- `GET/POST /api/agents/:agentId/mcp` — 绑定平台 MCP 到 agent 并 materialize
- `PATCH/DELETE /api/agents/:agentId/mcp/:serverId` — enable/disable / 解绑

### 5.4 阶段二 Bug 修复计划（待实施）

运行时发现详情配置面板存在以下问题，需逐一修复。

---

#### Bug 1：name / description 字段保存无效

**根因**：`saveAgentMutation`（`use-operations.ts` 第 876 行）只把 `model` 和 `systemPrompt` 写入 config.yaml，`name` 和 `description` 字段从未持久化到任何地方。`persistAgentMeta` 只写 emoji + systemPrompt，`updateClaudeProfile` 的 patch 对象里也没有这两个字段。用户在输入框里修改后点 Save，实际上什么都没写。

**修复**：

1. `saveAgentMutation` 的 `patch` 对象里加入 `name`（对应 config.yaml 的 `display_name` 字段）。
2. `persistAgentMeta` 调用时传入 `description`，写入 localStorage meta。
3. `saveAgentMeta` helper 类型 `OperationsAgentMeta` 补充 `name?: string` 字段。

---

#### Bug 2：Model & Provider tab 下拉列表为空

**根因**：`operations-agent-detail.tsx` 直接调用 `import { fetchModels } from '@/lib/gateway-api'`，该函数内部使用 `makeEndpoint('/api/models')` 构造 URL，`makeEndpoint` 把路径拼在 `BASE_URL`（即 `HERMES_API_URL`，gateway 地址 `:8642`）上，而不是 workspace 服务器 `:6734`。Operations 所有其他 API（`/api/profiles/*`、`/api/swarm-runtime` 等）都用相对路径走 `:6734`，这里是例外。若 gateway 未响应或未配置，`models` 为空数组，下拉没有任何选项，但组件不报错，表现为"空白下拉"。

**修复**：

1. 在 detail 组件里把 `queryFn: fetchModels` 替换为直接 `fetch('/api/models')` 相对路径调用，走 workspace 服务器。
2. 或者在 `use-operations.ts` 里统一管理 models query（`queryKey: ['operations', 'models']`），避免 detail 组件直接引入 gateway-api。
3. 下拉为空时显示 placeholder 提示"Gateway 未连接，无法加载模型列表"，而不是沉默空白。

---

#### Bug 3：Skill toggle 点击无反应

**根因（双重）**：

A. **视觉层**：toggle 开关用的是 Tailwind `peer` 机制（`peer-checked:translate-x-4` 等），是受控组件（`checked={skill.enabled}`）。用户点击后 React 立即用旧的 `skill.enabled` 值覆盖浏览器原生状态，视觉上开关没动。因为没有乐观更新（optimistic update），Mutation 完成前状态不变，用户看不到任何反馈。

B. **网络层**：`toggle-skill` API 通过 `dashboardFetch` 代理到 Hermes Dashboard（`:9119`），先检查 `capabilities.dashboard.available`。Dashboard 未连接时直接返回 503，`onError` 里调用 `toast()` 弹出通知，但 toast 可能渲染在模态框 z-index 层级之下或边缘不可见区域，用户看不到报错。

**修复**：

1. **乐观更新**：`toggleSkillMutation` 的 `onMutate` 里对 `['operations', 'capabilities']` 做 `queryClient.setQueryData` 乐观翻转，`onError` 时 rollback。
2. **内联错误**：Capabilities tab 顶部加 inline error banner，dashboard 不可用时显示"Dashboard 未连接，技能开关不可用"，不依赖 toast。
3. **备选方案（长期）**：绕开 dashboard 代理，改为直接读写 profile config.yaml 文件系统（`skills.disabled` 数组），与 `/api/profiles/capabilities` 读取路径一致，完全不依赖 dashboard 连接。

---

#### Bug 4：Schedule tab "+ Add Job" 跳出页面

**根因**：`ScheduleTab` 里用了原生 `<a href="/jobs">` 触发硬导航，整个应用跳转到 `/jobs` 路由，模态框关闭、页面刷新。

**修复**：

1. 把 `<a href="/jobs">` 改为 TanStack Router 的 `<Link to="/jobs">` 软导航（不刷新页面）。
2. 同时在 `onClose` 前把 detail modal 关掉，避免 navigation + modal 同时存在的状态。
3. 更好的 UX："+ Add Job" 改为在 Schedule tab 内展开一个 inline 表单，填写 name + schedule + prompt，调用 `/api/jobs` 创建，创建后 invalidate cronJobsQuery，无需跳出页面。

---

#### 修复优先级

| Bug                            | 严重性           | 修复难度                  | 优先级 |
| ------------------------------ | ---------------- | ------------------------- | ------ |
| Bug 2：Model 下拉为空          | 高（功能不可用） | 低（改一行 fetch URL）    | P0     |
| Bug 1：name/description 不保存 | 高（数据丢失）   | 低（扩展 patch 对象）     | P0     |
| Bug 3：Skill toggle 无反应     | 高（功能不可用） | 中（乐观更新 + 内联错误） | P1     |
| Bug 4：Add Job 跳出            | 中（UX 问题）    | 低（改为 Link 组件）      | P1     |

### 5.3 阶段三：角色模板与一键配置 ✅ 已完成

1. 扩展 `agent-presets.ts`，从 "只填 system prompt
