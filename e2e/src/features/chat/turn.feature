@chat @regression @P0
Feature: Chat turn ownership
  @CHAT-TURN-001
  Scenario: Busy follow-up stays queued without changing the prior reply
    Given an isolated chat session is open
    When the user starts a streaming turn
    Then the prior assistant reply stays above the new user message
    When the user queues a follow-up while streaming
    Then the queued message is not appended to the transcript
    And the prior assistant reply has no streaming caret

  @CHAT-TURN-002
  Scenario: Sending does not flash away the prior reply or duplicate the user
    Given an isolated chat session is open
    When the user starts a streaming turn
    Then the prior assistant reply remains visible during the transition
    And exactly one new user message is displayed