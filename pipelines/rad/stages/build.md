---
skillRefs: [test-driven-development, executing-plans]
---
# Stage: {{ stage.key }} (agent: {{ stage.agent }})

## Task
{{ mission.title }}

## Spec (authoritative, specVersion={{ mission.specVersion }})
{{ mission.spec }}

## Acceptance criteria
{{ mission.acceptanceCriteriaText }}

## Your role at this stage
Implement per the spec. Code + tests + build verification. No architecture
changes; escalate spec gaps back to the architect.

## Depends on
{{ stage.dependsOnText }}

{{ upstream.section }}
