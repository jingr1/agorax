@managed @journey @regression @P0
Feature: Managed 聊天 canonical 消息
  @MANAGED-CHAT-001
  Scenario: managed 发送后回复可见且刷新不丢失
    Given managed 聊天使用隔离会话
    When 用户发送 managed 消息 "hello managed"
    Then managed 回复 "Managed reply: hello managed" 只显示一次
    When 用户重新加载工作区页面
    Then managed 回复 "Managed reply: hello managed" 只显示一次

  @MANAGED-SESSION-CRUD-001
  Scenario: managed 会话从空列表创建后可改名读取并删除
    Given managed 聊天使用空会话列表
    When 用户发送 managed 消息 "create a managed session"
    Then 会话列表包含 "E2E created session"
    When 用户将唯一会话重命名为 "E2E renamed session"
    Then 会话列表包含 "E2E renamed session"
    When 用户重新加载工作区页面
    Then 会话列表包含 "E2E renamed session"
    When 用户删除唯一会话
    Then 会话列表不包含 "E2E renamed session"
    When 用户重新加载工作区页面
    Then 会话列表不包含 "E2E renamed session"