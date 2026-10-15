---
skillRefs: [harden-gate]
outcomes:
  - name: HARDEN_OUTCOME
    values: [pass, fail]
---
# Stage: {{ stage.key }} (agent: {{ stage.agent }})

## Task
{{ mission.title }}

## Spec (authoritative, specVersion={{ mission.specVersion }})
{{ mission.spec }}

## Acceptance criteria
{{ mission.acceptanceCriteriaText }}

## Your role at this stage
Run harden checklist after review approval.

## Harden protocol
End with exactly one of:
  HARDEN_OUTCOME: pass
  HARDEN_OUTCOME: fail

## Required skills
Load and follow: harden-gate

## Depends on
{{ stage.dependsOnText }}

{{ upstream.section }}
