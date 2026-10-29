@chat @soak @P1
Feature: 同一聊天页面耐久测试
  @CHAT-SOAK-001
  Scenario: 固定种子的连续多轮聊天不丢失或重复消息
    Given an isolated chat session is open
    When 在同一页面执行可重放的多轮聊天
    Then 耐久测试期间没有未捕获页面异常