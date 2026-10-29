@chat @regression
Feature: Chat send deduplication
  @CHAT-SEND-001 @P0 @smoke
  Scenario: Rapid double submit produces exactly one user message
    Given an isolated chat session is open
    When the user rapidly submits the same message twice
    Then exactly one new user message is displayed