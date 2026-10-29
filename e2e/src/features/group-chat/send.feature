@group-chat @regression @P0
Feature: Group chat send deduplication
  @GROUP-SEND-001
  Scenario: SSE list refresh before POST completion does not duplicate a message
    Given an isolated group chat room is open
    When the user sends a group message with its POST response held
    And the server publishes the message before the POST response
    Then the group transcript contains exactly one sent message
    When the POST response is released
    Then the group transcript contains exactly one sent message
    When the group chat is reloaded
    Then the group transcript contains exactly one sent message