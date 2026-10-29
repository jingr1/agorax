@chat @journey @regression @P0
Feature: 聊天生命周期与恢复
  @CHAT-LIFECYCLE-001 @smoke
  Scenario: 流式结束后回复完整且刷新不会重复
    Given an isolated chat session is open
    When the user starts a streaming turn
    And 服务端完成本轮回复
    Then 最终回复只显示一次且退出生成状态
    When 刷新当前聊天
    Then 最终回复只显示一次且退出生成状态

  @CHAT-LIFECYCLE-002
  Scenario: 发送失败后可重新发送并收到回复
    Given an isolated chat session is open
    When 下一次发送返回临时服务错误
    And 用户发送触发失败的消息
    Then 页面显示发送错误且允许再次发送
    When the user starts a streaming turn
    And 服务端完成本轮回复
    Then 最终回复只显示一次且退出生成状态

  @CHAT-LIFECYCLE-003
  Scenario: 流式期间切换会话不串消息
    Given an isolated chat session is open
    When the user starts a streaming turn
    And 用户切换到另一个会话
    Then 另一个会话只显示自己的历史

  @CHAT-LIFECYCLE-004
  Scenario: 停止流式输出后可以重新发送
    Given an isolated chat session is open
    When the user starts a streaming turn
    And 用户停止生成
    Then the completed conversation is idle
    When the user starts a streaming turn
    And 服务端完成本轮回复
    Then 最终回复只显示一次且退出生成状态