---
skillRefs: [architect-core, requesting-code-review]
outcomes:
  - name: REVIEW_OUTCOME
    values: [approved, changes_requested]
---
# Stage: {{ stage.key }} (agent: {{ stage.agent }})

## Task
{{ mission.title }}

## Spec (authoritative, specVersion={{ mission.specVersion }})
{{ mission.spec }}

## Acceptance criteria
{{ mission.acceptanceCriteriaText }}

## Your role at this stage
Review the build output against the spec.

## Review protocol
End with exactly one of:
  REVIEW_OUTCOME: approved
  REVIEW_OUTCOME: changes_requested  (with concrete file/line feedback)

## Depends on
{{ stage.dependsOnText }}

{{ upstream.section }}
