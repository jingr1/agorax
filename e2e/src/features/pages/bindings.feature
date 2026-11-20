@workspace @bindings @regression @P0
Feature: Agent 双轨能力绑定
  @BIND-MCP-001
  Scenario Outline: Agent <agent> 绑定 MCP 后刷新可见并能解除
    Given 工作区使用隔离页面数据
    When 用户打开工作区页面 "/mcp"
    And 用户切换页面标签 "Agents"
    And 用户选择 "Agent" 下的 "<agent>"
    And 用户在页面中点击 "+ E2E Browser MCP"
    Then 页面上有 "Remove" 按钮
    When 用户重新加载工作区页面
    And 用户切换页面标签 "Agents"
    And 用户选择 "Agent" 下的 "<agent>"
    Then 页面上有 "Remove" 按钮
    When 用户在页面中点击 "Remove"
    And 用户确认 Agent "<agent>" 的 MCP 解除
    Then 页面业务内容包含 "<empty>"
    And 页面上有 "+ E2E Browser MCP" 按钮

    Examples:
      | agent   | empty                    |
      | default | No MCP servers installed |
      | cc-impl | No MCP servers assigned  |

  @BIND-SKILL-001
  Scenario Outline: Agent <name> 添加 Skill 后刷新保留并能移除
    Given 工作区使用未绑定 Skill 的隔离数据
    When 用户打开工作区页面 "/skills/e2e-browser"
    And 用户在页面中点击 "添加到智能体"
    And 用户选择 Skill 目标 "<name>" runtime "<runtime>"
    And 用户确认添加 Skill
    Then 页面业务内容包含 "<name>"
    When 用户重新加载工作区页面
    Then 页面业务内容包含 "<name>"
    When 用户在页面中点击 "移除"
    Then 页面业务内容包含 "尚未绑定任何智能体。"

    Examples:
      | name        | runtime     |
      | E2E Hermes  | hermes      |
      | E2E Managed | claude-code |