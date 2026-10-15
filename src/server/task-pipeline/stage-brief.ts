/**
 * stage-brief — per-stage instruction text (WORKFLOW-style templates).
 *
 * Prefer stage.prompt / stage.promptFile from pipelines.yaml; fall back to
 * built-in role guidance for stages without a template.
 *
 * Strict mode: unknown {{variables}} throw (Symphony WORKFLOW semantics).
 */
import type { PipelineStage } from './pipeline-templates'

export type StageBrief = {
  stageKey: string
  agent: string
  instruction: string
  specVersion: number
}

const FALLBACK_GUIDANCE: Record<string, string> = {
  research:
    'Establish facts only: competitive analysis, data validation, source tracing. ' +
    'No strategy, no recommendations. Cite evidence for every claim.',
  design:
    'Produce the technical/content spec: wedge, bets, kill criteria, interface ' +
    'definitions, file-level plan. Choose exactly one build executor lane.',
  build:
    'Implement per the spec. Code + tests + build verification. No architecture ' +
    'changes; escalate spec gaps back to the architect.',
  draft:
    'Produce the content deliverable per the spec. No unverified claims.',
  review:
    'Review the build output against the spec. Output REVIEW_OUTCOME: approved ' +
    'or REVIEW_OUTCOME: changes_requested with concrete file/line feedback.',
  harden:
    'Run harden checklist. Emit HARDEN_OUTCOME: pass or HARDEN_OUTCOME: fail with evidence.',
  execute: 'Execute the mission spec as the assigned agent.',
}

type TemplateContext = Record<string, unknown>

function lookupPath(ctx: TemplateContext, pathExpr: string): unknown {
  const parts = pathExpr.split('.')
  let cur: unknown = ctx
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** Strict Liquid-lite: {{ path }} only; unknown paths fail. */
export function renderStrictTemplate(
  template: string,
  ctx: TemplateContext,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, pathExpr) => {
    const value = lookupPath(ctx, pathExpr)
    if (value === undefined) {
      throw new Error(`template_render_error: unknown variable "${pathExpr}"`)
    }
    if (value === null) return ''
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  })
}

function fallbackGuidance(stage: PipelineStage): string {
  if (stage.kind === 'review' && stage.key === 'harden')
    return FALLBACK_GUIDANCE.harden
  if (stage.kind === 'review') return FALLBACK_GUIDANCE.review
  return (
    FALLBACK_GUIDANCE[stage.key] ??
    `Execute stage "${stage.key}" per the task spec.`
  )
}

function buildDefaultTemplate(stage: PipelineStage): string {
  const lines = [
    `# Stage: {{ stage.key }} (agent: {{ stage.agent }})`,
    ``,
    `## Task`,
    `{{ mission.title }}`,
    ``,
    `## Spec (authoritative, specVersion={{ mission.specVersion }})`,
    `{{ mission.spec }}`,
    ``,
    `## Acceptance criteria`,
    `{{ mission.acceptanceCriteriaText }}`,
    ``,
    `## Your role at this stage`,
    fallbackGuidance(stage),
  ]
  if (stage.dependsOn.length > 0) {
    lines.push(``, `## Depends on (must be complete)`, `{{ stage.dependsOnText }}`)
  }
  lines.push(``, `{{ upstream.section }}`)
  if (stage.skillRefs && stage.skillRefs.length > 0) {
    lines.push(
      ``,
      `## Required skills`,
      `Load and follow: {{ stage.skillRefsText }}`,
    )
  }
  if (stage.outcomes && stage.outcomes.length > 0) {
    lines.push(``, `## Required outcomes`)
    for (const o of stage.outcomes) {
      lines.push(`- ${o.name}: ${o.values.join(' | ')}`)
    }
  } else if (stage.kind === 'review') {
    lines.push(
      ``,
      `## Review protocol`,
      `End with exactly one of:`,
      `  REVIEW_OUTCOME: approved`,
      `  REVIEW_OUTCOME: changes_requested  (with concrete file/line feedback)`,
    )
  }
  if (stage.key === 'harden' || stage.outcomes?.some((o) => o.name === 'HARDEN_OUTCOME')) {
    lines.push(
      ``,
      `## Harden protocol`,
      `End with exactly one of:`,
      `  HARDEN_OUTCOME: pass`,
      `  HARDEN_OUTCOME: fail`,
    )
  }
  return lines.join('\n')
}

/**
 * Generate the brief for one stage.
 */
export function generateStageBrief(input: {
  stage: PipelineStage
  taskTitle: string
  spec: string
  acceptanceCriteria: Array<string>
  specVersion: number
  upstreamSummary?: string | null
  attempt?: number | null
  missionId?: string | null
  taskId?: string | null
  workerId?: string | null
}): StageBrief {
  const { stage } = input
  const acceptanceCriteriaText =
    input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
      : '- (none declared)'
  const dependsOnText = stage.dependsOn.map((d) => `- ${d}`).join('\n')
  const skillRefsText = (stage.skillRefs ?? []).join(', ')
  const upstreamSection = input.upstreamSummary
    ? `## Upstream handoff\n${input.upstreamSummary}`
    : ''

  const ctx: TemplateContext = {
    mission: {
      id: input.missionId ?? '',
      title: input.taskTitle,
      spec: input.spec.trim() || '(no spec text)',
      acceptanceCriteria: input.acceptanceCriteria,
      acceptanceCriteriaText,
      specVersion: input.specVersion,
      executionMode: 'pipeline',
    },
    task: {
      id: input.taskId ?? '',
      workerId: input.workerId ?? stage.agent,
      stageKey: stage.key,
      state: 'queued',
    },
    stage: {
      key: stage.key,
      agent: stage.agent,
      kind: stage.kind,
      dependsOn: stage.dependsOn,
      dependsOnText,
      skillRefs: stage.skillRefs ?? [],
      skillRefsText,
    },
    attempt: input.attempt ?? null,
    upstream: {
      summary: input.upstreamSummary ?? '',
      section: upstreamSection,
    },
  }

  const template = stage.prompt?.trim() || buildDefaultTemplate(stage)
  const instruction = renderStrictTemplate(template, ctx).trim()

  return {
    stageKey: stage.key,
    agent: stage.agent,
    instruction,
    specVersion: input.specVersion,
  }
}

/** True when briefSpecVersion lags mission.specVersion. */
export function isBriefStale(
  briefSpecVersion: number | null | undefined,
  missionSpecVersion: number | null | undefined,
): boolean {
  if (briefSpecVersion == null || missionSpecVersion == null) return false
  return briefSpecVersion !== missionSpecVersion
}
