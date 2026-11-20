@workspace @journey @regression
Feature: 已有工作区页面
  @PAGE-DASHBOARD-001 @P0 @smoke
  Scenario: 从 Dashboard 开始新的聊天
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/dashboard"
    Then 工作区主标题为 "Agorax"
    When 用户在页面中点击 "New Chat"
    Then 页面路由应为 "/chat/new"
    And 聊天输入框可用

  @PAGE-NAVIGATION-001 @P0 @smoke
  Scenario Outline: 已有页面 <path> 可加载且显示业务标题
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "<path>"
    Then 工作区主标题为 "<heading>"

    Examples:
      | path                | heading     |
      | /agents             | Agents      |
      | /skills             | Skills      |
      | /mcp                | MCP Servers |
      | /jobs               | Jobs        |
      | /memory             | Memory      |
      | /missions           | Missions    |
      | /swarm              | Swarm       |
      | /files              | Files       |
      | /settings/providers | Settings    |
      | /settings           | Settings    |
      | /echo-studio        | Echo Studio |

  @PAGE-REDIRECT-001 @P1
  Scenario Outline: 历史入口 <old> 进入当前页面
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "<old>"
    Then 页面路由应为 "<current>"
    And 工作区主标题为 "<heading>"

    Examples:
      | old              | current   | heading  |
      | /operations      | /agents   | Agents   |
      | /profiles        | /agents   | Agents   |
      | /tasks           | /missions | Missions |
      | /mission-control | /missions | Missions |
      | /conductor       | /missions | Missions |
      | /swarm2          | /swarm    | Swarm    |
      | /settings/agents/cc-impl | /agents?agent=cc-impl | Agents |

  @PAGE-GROUP-001 @P0
  Scenario: 没有群聊时显示可操作空态
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/group-chat"
    Then 页面业务内容包含 "No room yet — create one from the sidebar."
    And 页面上有 "New room" 按钮

  @PAGE-AGENTS-001 @P0
  Scenario: Agents 页面同时显示 Hermes 和 managed Agent
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/agents"
    Then 页面业务内容包含 "Workspace"
    And 页面业务内容包含 "E2E Managed"

  @PAGE-SEARCH-001 @P0
  Scenario Outline: 页面 <path> 搜索筛选固定列表条目
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "<path>"
    Then 页面业务内容包含 "<visible>"
    And 页面业务内容包含 "<hidden>"
    When 用户在搜索框 "<placeholder>" 输入 "<query>"
    Then 页面业务内容包含 "<visible>"
    And 页面业务内容不包含 "<hidden>"
    When 用户在搜索框 "<placeholder>" 输入 ""
    Then 页面业务内容包含 "<hidden>"

    Examples:
      | path    | placeholder            | query   | visible           | hidden            |
      | /jobs   | Search jobs...         | daily   | E2E daily report  | E2E weekly review |
      | /skills | 搜索 skills…           | Browser | E2E Browser Skill | E2E Writer Skill  |
      | /mcp    | Search library by name | Browser | E2E Browser MCP   | E2E Files MCP     |

  @PAGE-FILES-001 @P0
  Scenario: 在文件树打开 Markdown 文件预览
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/files"
    And 用户选择工作区文件 "README.md"
    Then 页面业务内容包含 "Isolated file preview."

  @PAGE-MEMORY-001 @P0
  Scenario: Memory 读取当前 Agent 的持久记忆
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/memory"
    Then 页面业务内容包含 "E2E durable memory"
    And 页面业务内容包含 "Always keep test fixtures isolated."

  @PAGE-MCP-001 @P0
  Scenario Outline: MCP Agent 绑定页支持 <agent>
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/mcp"
    And 用户切换页面标签 "Agents"
    And 用户选择 "Agent" 下的 "<agent>"
    Then 页面业务内容包含 "<empty>"

    Examples:
      | agent   | empty                    |
      | default | No MCP servers installed |
      | cc-impl | No MCP servers assigned  |

  @PAGE-SETTINGS-001 @P1
  Scenario: Settings 搜索不存在的设置得到零匹配
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/settings/providers"
    And 用户在搜索框 "Search settings, paths, or descriptions" 输入 "e2e-no-such-setting"
    Then 页面业务内容包含 "0 matching settings"

  @PAGE-TERMINAL-001 @P0
  Scenario: Terminal 可以创建独立标签页
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/terminal"
    Then 页面上有 "New terminal tab" 按钮
    When 用户新增终端标签页
    Then 终端新增一个标签页

  @PAGE-JOBS-002 @P0
  Scenario: 暂停的定时任务刷新后保留状态并可以恢复
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/jobs"
    Then 页面业务内容包含 "E2E daily report"
    And 页面业务内容包含 "E2E weekly review"
    When 用户在搜索框 "Search jobs..." 输入 "daily"
    Then 页面业务内容不包含 "E2E weekly review"
    When 用户在页面中点击 "Pause"
    Then 页面上有 "Resume" 按钮
    When 用户重新加载工作区页面
    Then 页面业务内容包含 "E2E weekly review"
    When 用户在搜索框 "Search jobs..." 输入 "daily"
    Then 页面业务内容不包含 "E2E weekly review"
    Then 页面上有 "Resume" 按钮
    When 用户在页面中点击 "Resume"
    Then 页面上有 "Pause" 按钮

  @PAGE-SKILLS-002 @P0
  Scenario Outline: Agent <agent> 的 Skill 启用状态刷新后保留
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/skills"
    And 用户选择 "按智能体筛选" 下的 "<agent>"
    Then "启用 E2E Browser Skill" 开关为关闭
    When 用户切换 "启用 E2E Browser Skill" 开关
    Then "启用 E2E Browser Skill" 开关为开启
    When 用户重新加载工作区页面
    And 用户选择 "按智能体筛选" 下的 "<agent>"
    Then "启用 E2E Browser Skill" 开关为开启

    Examples:
      | agent   |
      | default |
      | cc-impl |

  @PAGE-FORMS-001 @P1
  Scenario Outline: 页面 <path> 的创建表单可以打开并取消
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "<path>"
    And 用户打开页面创建表单 "<button>"
    Then 页面显示表单标题 "<title>"
    When 用户取消表单 "<cancel>"
    Then 页面不再显示表单标题 "<title>"

    Examples:
      | path      | button         | title          | cancel |
      | /agents   | New Agent      | New Agent      | Cancel |
      | /skills   | 新建 skill     | 新建 skill     | Escape |
      | /mcp      | Add to Library | Add MCP Server | Cancel |
      | /jobs     | New Job        | Create Job     | Cancel |
      | /missions | Create Mission | Create Mission | Cancel |

  @PAGE-MEMORY-002 @P1
  Scenario Outline: Memory 可以切换到 <tab>
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/memory"
    And 用户切换页面标签 "<tab>"
    Then 页面业务内容包含 "<content>"

    Examples:
      | tab                | content                      |
      | Knowledge          | Knowledge Pages (0)          |
      | External providers | No external memory providers |

  @PAGE-SWARM-001 @P1
  Scenario: Swarm 可以打开并关闭工作流帮助
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/swarm"
    And 用户打开页面创建表单 "How it works"
    Then 页面显示表单标题 "How Swarm works"
    When 用户取消表单 "Close How Swarm works"
    Then 页面不再显示表单标题 "How Swarm works"

  @PAGE-ECHO-001 @P1
  Scenario: Echo Studio 在缺少必填信息时不能生成页面
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/echo-studio"
    Then 页面生成按钮不可用
    When 用户在搜索框 "e.g. tool-analytics" 输入 "e2e-page"
    And 用户在搜索框 "e.g. Tool Analytics" 输入 "E2E Page"
    Then 页面生成按钮不可用

  @PAGE-SKILLS-DETAIL-001 @P0
  Scenario: 从 Skills 列表进入详情并取消编辑
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/skills"
    And 用户打开列表条目 "E2E Browser Skill"
    Then 页面路由应为 "/skills/e2e-browser"
    And 详情页标题为 "E2E Browser Skill"
    When 用户在页面中点击 "编辑"
    Then 页面上有 "保存" 按钮
    When 用户在页面中点击 "取消"
    Then 页面上有 "编辑" 按钮