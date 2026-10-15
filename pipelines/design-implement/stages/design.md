---
skillRefs: [architect-core]
---
# Stage: {{ stage.key }} (agent: {{ stage.agent }})

## Task
{{ mission.title }}

## Spec (authoritative, specVersion={{ mission.specVersion }})
{{ mission.spec }}

## Acceptance criteria
{{ mission.acceptanceCriteriaText }}

## Your role at this stage
Produce the technical/content spec: wedge, bets, kill criteria, interface
definitions, file-level plan. Choose exactly one build executor lane.

## Required skills
Load and follow: architect-core

## Depends on
{{ stage.dependsOnText }}

{{ upstream.section }}
