# Operations 重构前端界面设计细则

## 1. 整体信息架构

```
Operations 页面
├── Header（页头）
├── Team Overview（团队概览）
├── Agent Grid（Agent 卡片网格）
├── Recent Activity（团队活动流）
└── Modals / Drawers（侧边抽屏与模态框）
    ├── New Agent Modal
    ├── Agent Detail Drawer
    ├── Operations Settings Modal
    └── Template Gallery Modal
```

## 2. Header（页头）

### 2.1 布局

```
+---------------------------------------------------------------+
| 🧠 Operations    Your persistent agent team      [Overview|Outputs] [+ New Agent] [⚙️ Settings] |
+---------------------------------------------------------------+
```

### 2.2 元素与状态

| 元素        | 说明                                                    | 交互                           |
| ----------- | ------------------------------------------------------- | ------------------------------ |
| 标题区      | 标题 "Operations" + 副标题 "Your persistent agent team" | 静态                           |
| View Switch | Overview / Outputs 两个 tab                             | 切换主视图区域                 |
| New Agent   | 主按钮                                                  | 打开 New Agent Modal           |
| Settings    | 次按钮                                                  | 打开 Operations Settings Modal |

### 2.3 View Switch 行为

- **Overview（默认）**：展示 Team Overview + Agent Grid + Recent Activity。
- **Outputs**：全屏展示所有 agent 的产出历史，支持按 agent、source（session/cron）、日期筛选。

## 3. Team Overview（团队概览）

### 3.1 布局

```
+---------------------------------------------------------------------+
| ● Active 3   ○ Idle 2   ⚠️ Error 1   ⚠️ Needs Setup 1   ⎘ 1.2M tokens  |
+---------------------------------------------------------------------+
```

### 3.2 统计卡片

| 卡片        | 字段          | 计算方式                        | 点击行为                       |
| ----------- | ------------- | ------------------------------- | ------------------------------ |
| Active      | 数量          | status === 'active' 的 agent 数 | 过滤 Agent Grid，只显示 active |
| Idle        | 数量          | status === 'idle' 的 agent 数   | 过滤显示 idle                  |
| Error       | 数量          | status === 'error' 的 agent 数  | 过滤显示 error                 |
| Needs Setup | 数量          | needsSetup === true 的 agent 数 | 过滤显示 needs setup           |
| Tokens      | 本周 token 数 | 后端计算或 dashboard 数据       | 展示详情 tooltip               |
| Cost        | 本周估算成本  | 后端计算或 dashboard 数据       | 展示详情 tooltip               |

### 3.3 空状态

- 当没有 agent 时，Team Overview 隐藏，直接显示 Empty State。
- 数据加载中时，卡片展示 skeleton 卡片。

## 4. Agent Grid（Agent 卡片网格）

### 4.1 响应式网格

| 届宽            | 列数 |
| --------------- | ---- |
| < 640px         | 1 列 |
| 640px - 1024px  | 2 列 |
| 1024px - 1440px | 3 列 |
| >= 1440px       | 4 列 |

### 4.2 Agent Card 结构

```
+--------------------------------------------------+
| [⏰] 2            Builder            ▶ ⚙️ |
+--------------------------------------------------+
|                                                  |
|               [🔴 progress ring + avatar]        |
|                  Builder                         |
|         Senior full-stack engineer               |
|                                                  |
+--------------------------------------------------+
| 🧠 6 skills   🔗 2 MCP   💼 /workspace/project  |
| 📈 anthropic / claude-sonnet-4                  |
+--------------------------------------------------+
| ● Active · 2m ago                              |
| Last: Refactored auth middleware and added tests |
+--------------------------------------------------+
| [Run task] [Open chat]                           |
+--------------------------------------------------+
```

### 4.3 卡片区域详细设计

#### 区域 A：顶部工具栏

| 元素        | 说明                                     | 交互                                                             |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------- |
| Cron 计数器 | 属于该 agent 的 cron job 数量            | 点击展开/折叠 Cron Mini Panel                                    |
| Agent 名称  | 展示 name（不带 emoji）                  | 点击整个卡片打开 Agent Detail                                    |
| 状态指示点  | active=green pulse, idle=gray, error=red | hover 显示状态文字                                               |
| 运行按钮    | ▶ / ⏸                                    | 点击发起 "Run your primary task now"；如果 needsSetup 则打开详情 |
| 设置按钮    | ⚙️                                       | 打开 Agent Detail Drawer                                         |

#### 区域 B：身份区

| 元素   | 字段                                           | 空状态           |
| ------ | ---------------------------------------------- | ---------------- |
| Avatar | `meta.emoji` + `meta.color` 生成的 PixelAvatar | 默认 🤖          |
| 名称   | `agent.name`                                   | "Unnamed agent"  |
| 描述   | `meta.description` 或 `agent.description`      | "No description" |

#### 区域 C：能力与资源

| 元素      | 字段                             | 空状态 /错误状态 |
| --------- | -------------------------------- | ---------------- |
| Skills    | `capabilities.skills.length`     | "0 skills"       |
| MCP       | `capabilities.mcpServers.length` | "0 MCP"          |
| Workspace | `resources.workspace`            | "No workspace"   |
| Model     | `shortModel`                     | "No model" 高亮  |

#### 区域 D：活动摘要

| 元素        | 字段                       | 说明                   |
| ----------- | -------------------------- | ---------------------- |
| 状态标签    | `status` + `activityLabel` | 例如 "Active · 2m ago" |
| 最近 output | `recentOutputs[0].summary` | 超长时截断并加 "..."   |

#### 区域 E：快捷操作

| 按钮      | 状态                          | 交互                                           |
| --------- | ----------------------------- | ---------------------------------------------- |
| Run task  | 正常 / disabled（needsSetup） | 发送 "Run your primary task now" 到 sessionKey |
| Open chat | 正常                          | 在卡片内展开 Inline Chat（保留现有）           |

### 4.4 Cron Mini Panel

点击顶部时钟图标后，在卡片内展开 mini panel：

```
+--------------------------------------------------+
| Scheduled Jobs                                   |
| ■ Daily report   every day at 9am    [▶] [✓]    |
| □ Weekly scan    every monday       [▶] [✓]    |
|                                [+ Add Job]       |
+--------------------------------------------------+
```

- 每行显示 job name、schedule、立即运行按钮、启用/禁用 switch。
- 空状态："No scheduled jobs" + [+ Add Job]。
- [+ Add Job] 跳转到 `/jobs` 页面并带上 agentId 参数。

### 4.5 Needs Setup 状态

当 `needsSetup === true` 时：

- 卡片顶部显示橙色边框和 "Needs setup" badge。
- Run task 按钮禁用，点击后提示先配置 model。
- 点击卡片直接打开 Model & Provider tab。

## 5. Recent Activity（团队活动流）

### 5.1 布局

```
+---------------------------------------------------------------+
| Recent Activity                                  [View all →] |
+---------------------------------------------------------------+
| 🤖 Builder   Refactored auth middleware...        2m ago       |
| 🐦 Sage       Drafted thread on local LLMs...     15m ago      |
| 📊 Ops        Weekly report: stars +12...         1h ago       |
+---------------------------------------------------------------+
```

### 5.2 活动项字段

| 字段               | 说明                                                          |
| ------------------ | ------------------------------------------------------------- |
| Agent emoji + name | 来源 agent                                                    |
| Summary            | output 摘要，来自 session 最后一条消息或 cron deliverySummary |
| Timestamp          | 相对时间                                                      |
| Source badge       | session / cron                                                |

### 5.3 空状态

"No recent activity yet. Send a task to any agent to get started."

## 6. Outputs View

### 6.1 全屏布局

```
+---------------------------------------------------------------+
| Outputs                                              [Back]   |
+---------------------------------------------------------------+
| Filter: [All agents ▼] [All sources ▼] [Last 7 days ▼] [Search] |
+---------------------------------------------------------------+
| 🤖 Builder   📄 session   Refactored...          2m ago       |
| 🐦 Sage       🔄 cron     Daily growth report...  15m ago      |
| ...                                                           |
+---------------------------------------------------------------+
```

### 6.2 筛选器

| 筛选器 | 选项                                   |
| ------ | -------------------------------------- |
| Agent  | All agents / 具体 agent 列表           |
| Source | All / session / cron                   |
| Time   | Last 24h / 7 days / 30 days / All time |
| Search | 按 summary 关键词搜索                  |

## 7. New Agent Modal

### 7.1 步骤式导航

```
+---------------------------------------------------------------+
| New Agent                                        1 / 3        |
+---------------------------------------------------------------+
| Step 1: Choose template                                       |
| Step 2: Configure identity                                    |
| Step 3: Configure capabilities                                |
+---------------------------------------------------------------+
| [Cancel]                                  [Back] [Next/Create] |
+---------------------------------------------------------------+
```

### 7.2 Step 1: Choose Template

模板卡片网格：

```
+-------------+ +-------------+ +-------------+ +-------------+
| ✨ Blank     | | 🔨 Builder  | | 🐦 Sage     | | 📊 Ops      |
| Start fresh | | Coding      | | Social      | | Business    |
+-------------+ +-------------+ +-------------+ +-------------+
```

- 点击模板后，自动填充：name、emoji、description、system prompt、skills、MCP、toolsets。
- 选中的模板高亮显示。
- 提供 "Blank" 选项。

### 7.3 Step 2: Configure Identity

| 字段          | 类型         | 验证                                |
| ------------- | ------------ | ----------------------------------- |
| Name          | input        | 必填，`[a-z0-9_-]+`，不能为 default |
| Emoji         | input        | 可空，默认 🤖                       |
| Description   | input        | 可空                                |
| System Prompt | textarea     | 可空                                |
| Color         | color picker | 可空，默认从 name hash              |

### 7.4 Step 3: Configure Capabilities

| 字段        | 类型         | 说明                                       |
| ----------- | ------------ | ------------------------------------------ |
| Provider    | dropdown     | 从l已配置 providers 中选择                 |
| Model       | dropdown     | 根据 provider 联动过滤                     |
| Workspace   | path input   | 可空，默认当前 workspace                   |
| Skills      | multi-select | 从已安装 skills 中选择（默认加载模板推荐） |
| MCP Servers | multi-select | 从已配置 MCP 中选择                        |
| Toolsets    | chips        | 默认根据模板，可手动增减                   |

### 7.5 创建完成

- 调用 `/api/profiles/create`。
- 调用 `/api/profiles/update` 写入 description、system_prompt、workspace。
- 调用 `/api/profiles/toggle-skill` 为该 profile 开启选中的 skills（如果尚未开启）。
- 创建完成后自动打开详情面板（而不是只关闭 modal）。

## 8. Agent Detail Drawer

### 8.1 布局

使用右侧抽屏（drawer）而不是 modal，方便用户在配置时参照主页面。

```
+--------------------------------------------------+
| ← Builder                                  [✕] |
+--------------------------------------------------+
| [🔨] Builder                        [Save changes] |
| Senior full-stack engineer                       |
+--------------------------------------------------+
| [Identity] [Model] [Capabilities] [Schedule] [Activity] |
+--------------------------------------------------+
|                                                  |
| 当前 tab 内容区域                            |
|                                                  |
+--------------------------------------------------+
| Footer: Last saved 2m ago    [Delete agent]       |
+--------------------------------------------------+
```

### 8.2 Tab: Identity

| 字段          | 类型           | 说明                                              |
| ------------- | -------------- | ------------------------------------------------- |
| Emoji         | input          |                                                   |
| Name          | input          | 只读（避免改名影响路径），提供 Rename 功能        |
| Description   | input          |                                                   |
| System Prompt | textarea       | 最少 3 行，可自动扩展                             |
| Color         | color picker   | 影响 avatar 和卡片颜色                            |
| Role Template | readonly badge | 显示当前使用的模板，可 "Apply different template" |

Rename 功能：

- 点击 name 旁边的 edit icon，弹出 Rename Modal。
- 调用 `/api/profiles/rename`。

### 8.3 Tab: Model & Provider

| 字段           | 类型         | 说明                                       |
| -------------- | ------------ | ------------------------------------------ |
| Provider       | dropdown     | 可与 `/api/models` 联动                    |
| Model          | dropdown     | 根据 provider 联动                         |
| Fallback Model | dropdown     | 可选                                       |
| Temperature    | number input | 高级，默认不展示                           |
| Max Tokens     | number input | 高级，默认不展示                           |
| 检测按钮       | button       | "Test connection" 验证 provider/model 可用 |

### 8.4 Tab: Capabilities（核心）

分成几个小组件：

#### Skills Section

```
Skills                                    [Manage skills →]
■ researcher-core    ■ browser-harness    □ arxiv
■ github-pr-workflow  □ writing-plans
[+ Add skill]
```

- 每个 skill 以 chip/card 形式展示，包含 name + category + enable toggle。
- 点击 skill 展开详情：description、triggers、source path。
- [Manage skills →] 跳转到 `/skills?profile=<agentId>`。
- 空状态："No skills enabled. Add skills to extend this agent's abilities."

#### MCP Section

```
MCP Servers                               [Manage MCP →]
■ filesystem     □ browser-tools      ⚠️ github (auth error)
[+ Add MCP server]
```

- 每个 MCP server 显示 name + status（enabled/disabled/error）。
- 状态异常时显示警告和重试按钮。
- [Manage MCP →] 跳转到 `/mcp?profile=<agentId>`。

#### Toolsets Section

```
Toolsets
[Files] [Terminal] [Web] [Browser] [Vision] [Cron]
```

- 以 toggle chips 形式展示，点击切换。
- 如果某个 toolset 需要特定 skill 才能使用，给出提示。

#### Workspace & Memory Section

| 字段         | 类型                | 说明                                                    |
| ------------ | ------------------- | ------------------------------------------------------- |
| Workspace    | path input + picker | 默认当前 workspace                                      |
| Memory paths | multi path input    | wiki/memory 等路径                                      |
| Environment  | readonly            | 显示 `.env` 是否存在，提供 "Edit .env" 链接（如果支持） |

### 8.5 Tab: Schedule

- 列表展示该 agent 的所有 cron jobs。
- 每行：name、schedule、enabled toggle、next run、last run summary、[Run now] [Edit] [Delete]。
- 顶部 [+ Add scheduled job] 跳转 `/jobs/create?agent=<agentId>`。

### 8.6 Tab: Activity

- 仅显示该 agent 的 outputs，按时间倒序。
- 每项：source badge、summary、timestamp、[Open session] 链接。
- 支持日期分组。

## 9. Operations Settings Modal

### 9.1 字段

| 字段                             | 类型       | 说明                                       |
| -------------------------------- | ---------- | ------------------------------------------ |
| Default model for new agents     | dropdown   | 新建 agent 时的默认 model                  |
| Activity feed length             | number     | 5-20，默认 5                               |
| Auto-approve                     | checkbox   | 保留，但默认关闭，用于未来 workflow 自动化 |
| Default workspace for new agents | path input | 可选                                       |
| Show token/cost metrics          | checkbox   | 控制 Team Overview 中是否显示成本卡片      |

## 10. 组件列表

### 10.1 新增/改动组件

| 组件                      | 路径                                                        | 说明                                 |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------ |
| `TeamOverview`            | `src/screens/agents/components/team-overview.tsx`           | 团队统计卡片                         |
| `AgentGrid`               | 在 `operations-screen.tsx` 内                               | agent 卡片网格，支持筛选             |
| `OperationsAgentCard`     | 现有，大幅扩展                                              | agent 卡片                           |
| `AgentDetailDrawer`       | 替换 `OperationsAgentDetail`                                | 右侧抽屏详情                         |
| `IdentityTab`             | `src/screens/agents/components/tabs/identity-tab.tsx`       | identity 配置                        |
| `ModelProviderTab`        | `src/screens/agents/components/tabs/model-provider-tab.tsx` | model/provider 配置                  |
| `CapabilitiesTab`         | `src/screens/agents/components/tabs/capabilities-tab.tsx`   | skills/MCP/toolsets/workspace/memory |
| `ScheduleTab`             | `src/screens/agents/components/tabs/schedule-tab.tsx`       | cron jobs                            |
| `ActivityTab`             | `src/screens/agents/components/tabs/activity-tab.tsx`       | 该 agent 的 outputs                  |
| `NewAgentModal`           | 现有，改为三步骤                                            | 创建 agent                           |
| `TemplateGallery`         | `src/screens/agents/components/template-gallery.tsx`        | 模板选择                             |
| `OutputsView`             | 现有 `FullOutputsView`，扩展                                | 全屏 outputs                         |
| `OperationsSettingsModal` | 现有，扩展                                                  | 设置                                 |

### 10.2 可复用现有组件

- `PixelAvatar`：agent 头像。
- `AgentProgress`：进度环（保留但需要更真实的进度数据）。
- `Markdown`：chat 消息渲染。
- `ModelSelector`：已存在于 `operations-new-agent-modal.tsx` 和 `operations-agent-detail.tsx`，抽象成通用组件。
- `Tabs` / `Dialog` / `Button` / `Toast`。

## 11. 状态与错误处理

### 11.1 加载状态

- 首次加载整个页面时，卡片区域显示 skeleton grid。
- 单个 agent 的 capabilities 加载时，在 drawer 内部显示局部 skeleton。

### 11.2 错误状态

| 场景                    | 表现                        | 处理                     |
| ----------------------- | --------------------------- | ------------------------ |
| profile 列表加载失败    | 页面中央错误提示 + 重试按钮 | 重新获取                 |
| 单个 agent 配置保存失败 | Toast error                 | 保留 draft，允许重试     |
| model/provider 检测失败 | 显示警告条                  | 保存仍然允许，但提示用户 |
| MCP server 健康异常     | chip 上显示 ⚠️              | 点击展开详情和日志       |

### 11.3 空状态

| 组件           | 空状态                                                   |
| -------------- | -------------------------------------------------------- |
| Agent Grid     | "No agents yet. Create your first agent to get started." |
| Skills Section | "No skills enabled." + [Add skill]                       |
| MCP Section    | "No MCP servers configured." + [Add MCP]                 |
| Schedule Tab   | "No scheduled jobs." + [Add job]                         |
| Activity Tab   | "No activity yet."                                       |
| Outputs View   | "No outputs match your filters."                         |

## 12. 交互流程总结

1. 用户进入 Operations，看到 Team Overview + Agent Grid + Recent Activity。
2. 点击 "New Agent"，选择模板 → 填写身份 → 配置能力 → 创建完成 → 自动打开详情抽屏。
3. 点击任意 agent 卡片打开详情，切换 tab 编辑配置。
4. 保存配置时，同时落盘到 profile 的 config.yaml 和相关 skills/MCP 配置。
5. 用户可以点击 "Run task" 在卡片上发起任务，或在 Swarm 页面做更复杂的 mission 编排。
6. 在 Outputs View 中查看所有 agent 的历史产出。
