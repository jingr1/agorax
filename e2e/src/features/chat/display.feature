@chat @regression @P0
Feature: Chat frontend display ordering and live chrome
  保护 1:1 聊天前端显示：同戳多轮不合并、Thinking 卸除。

  @CHAT-DISPLAY-001
  Scenario: 同戳多轮历史保持 U-A 交错且回复不挤进同一气泡
    Given a multi-turn equal-timestamp chat session is open
    Then the transcript keeps interleaved user and assistant turns
    And each assistant reply stays in its own bubble

  @CHAT-DISPLAY-002
  Scenario: Thinking 在正文到达后卸除且结算后空闲
    Given an isolated chat session is open
    When the next stream turn starts with thinking only
    And the user starts a thinking-first streaming turn
    Then the live Thinking label is visible
    When the stream releases the assistant reply text
    Then the live Thinking label is gone
    And the streaming assistant reply is visible once
    When 服务端完成本轮回复
    Then 最终回复只显示一次且退出生成状态
    And the live Thinking label is gone
