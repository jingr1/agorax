@chat @regression @P0
Feature: Completed chat recovery
  @CHAT-RECOVERY-001 @smoke
  Scenario: Completed history renders once without a generating state
    Given an isolated chat session is open
    Then the completed conversation has no duplicated messages
    And the completed conversation is idle

  @CHAT-RECOVERY-002
  Scenario: Reload clears stale waiting state for a completed session
    Given an isolated chat session is open
    When the user reloads with stale waiting state
    Then the completed conversation is idle
    And stale waiting state is removed