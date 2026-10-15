/**
 * pipeline-templates — load + validate pipelines.yaml (plan 模块 1).
 *
 * Templates define structure only: stage keys, owning agent, dependsOn
 * edges, review placement. Content is filled per task by stage-brief.ts.
 *
 * Load-time validation (all fail-fast, plan «校验放在 pipeline-templates»):
 *  - stage graph is acyclic (a cycle makes readyQueuedAssignments return []
 *    forever — the pipeline silently dies)
 *  - every dependsOn references an existing stage key
 *  - reworkTarget of a review stage references an existing stage
 *  - agent is declared in agents.yaml or is human:*
 *  - P2a: workspaceMode must be 'canonical'. 'worktree' is rejected until
 *    P2b (per-mission worktrees + git model) lands. Loading a worktree
 *    template in P2a is a hard error, not a silent fallback.
 *  - workspaceMode: worktree additionally forbids local hermes tmux workers
 *    (they can't switch cwd per mission) — enforced when P2b enables it.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as YAML from 'yaml'
import { loadAgentsRegistry } from '../agent-runtime/agents-config'
import type { AgentDeclaration } from '../agent-runtime/agents-config'

export type WorkspaceMode = 'canonical' | 'worktree'

export type PipelineStageOutcome = {
  name: string
  values: Array<string>
}

export type PipelineStage = {
  key: string
  agent: string // agents.yaml id, or human:<userId>
  kind: 'work' | 'review'
  dependsOn: Array<string>
  reworkTarget: string | null
  maxRework: number // review stage retry limit; defaults to 2
  requires: Array<string> // capability routing (P2b)
  /** Optional inline prompt template (WORKFLOW-style body). */
  prompt?: string | null
  /** Relative path under pipelines/<id>/ or repo root. */
  promptFile?: string | null
  /** Skill ids to emphasize for this stage. */
  skillRefs?: Array<string>
  /** Expected checkpoint outcome tokens. */
  outcomes?: Array<PipelineStageOutcome>
}

export type PipelineRuntimeConfig = {
  maxConcurrentTasks?: number
  maxRetryBackoffMs?: number
  stallTimeoutMs?: number
  hooks?: {
    before_stage?: string | null
    after_stage?: string | null
    timeout_ms?: number
  }
}

export type PipelineTemplate = {
  id: string
  name: string
  workspaceMode: WorkspaceMode
  stages: Array<PipelineStage>
  runtime?: PipelineRuntimeConfig
}

export type PipelinesFile = {
  version: number
  pipelines: Array<PipelineTemplate>
}

export function getPipelinesYamlPath(repoRoot?: string): string {
  return path.join(repoRoot ?? process.cwd(), 'pipelines.yaml')
}

/** Topological cycle check over stage keys (Kahn). */
function assertAcyclicStages(template: PipelineTemplate): void {
  const keys = new Set(template.stages.map((s) => s.key))
  const indegree = new Map<string, number>()
  const edges = new Map<string, Array<string>>()
  for (const s of template.stages) indegree.set(s.key, 0)
  for (const s of template.stages) {
    for (const dep of s.dependsOn) {
      if (!keys.has(dep)) continue
      indegree.set(s.key, (indegree.get(s.key) ?? 0) + 1)
      const list = edges.get(dep) ?? []
      list.push(s.key)
      edges.set(dep, list)
    }
  }
  const queue = template.stages
    .filter((s) => (indegree.get(s.key) ?? 0) === 0)
    .map((s) => s.key)
  let visited = 0
  while (queue.length > 0) {
    const cur = queue.pop()!
    visited++
    for (const next of edges.get(cur) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }
  if (visited < keys.size) {
    const cyclic = template.stages
      .filter((s) => (indegree.get(s.key) ?? 0) > 0)
      .map((s) => s.key)
    throw new Error(
      `pipeline ${template.id}: stage dependsOn cycle among: ${cyclic.join(', ')}`,
    )
  }
}

export function validatePipelineTemplate(
  template: PipelineTemplate,
  knownAgentIds: Set<string>,
  agentById?: Map<string, AgentDeclaration>,
): Array<string> {
  const errors: Array<string> = []
  const keys = new Set(template.stages.map((s) => s.key))

  if (keys.size !== template.stages.length) {
    errors.push(`pipeline ${template.id}: duplicate stage keys`)
  }
  if (template.workspaceMode !== 'canonical') {
    // workspaceMode is typed canonical|worktree; runtime YAML may widen it.
    if ((template.workspaceMode as string) !== 'worktree') {
      errors.push(
        `pipeline ${template.id}: unknown workspaceMode "${String(template.workspaceMode)}"`,
      )
    }
  }
  // P2b: worktree mode is now enabled. Forbid local hermes tmux workers
  // because they cannot switch cwd per mission.
  const isWorktreeMode = template.workspaceMode === 'worktree'
  for (const stage of template.stages) {
    if (!stage.agent.startsWith('human:') && !knownAgentIds.has(stage.agent)) {
      errors.push(
        `pipeline ${template.id} stage ${stage.key}: agent "${stage.agent}" not declared in agents.yaml`,
      )
    }
    if (isWorktreeMode && agentById) {
      const agent = agentById.get(stage.agent)
      if (agent && agent.runtime === 'hermes' && agent.execution !== 'ssh') {
        errors.push(
          `pipeline ${template.id} stage ${stage.key}: workspaceMode=worktree forbids local hermes tmux worker "${stage.agent}". ` +
            `Use a managed CLI adapter or an ssh-locality hermes agent.`,
        )
      }
    }
    for (const dep of stage.dependsOn) {
      if (!keys.has(dep))
        errors.push(
          `pipeline ${template.id} stage ${stage.key}: unknown dependsOn "${dep}"`,
        )
    }
    if (stage.kind === 'review') {
      if (stage.reworkTarget && !keys.has(stage.reworkTarget)) {
        errors.push(
          `pipeline ${template.id} stage ${stage.key}: unknown reworkTarget "${stage.reworkTarget}"`,
        )
      }
      if (
        !Number.isFinite(stage.maxRework) ||
        stage.maxRework < 0 ||
        Math.floor(stage.maxRework) !== stage.maxRework
      ) {
        errors.push(
          `pipeline ${template.id} stage ${stage.key}: maxRework must be a non-negative integer`,
        )
      }
    }
  }
  try {
    assertAcyclicStages(template)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return errors
}

export function loadPipelineTemplates(input?: {
  repoRoot?: string
  rawYaml?: string
  agentIds?: Set<string>
}): PipelinesFile {
  const filePath = getPipelinesYamlPath(input?.repoRoot)
  const raw =
    input?.rawYaml ??
    (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null)
  if (raw === null) return { version: 1, pipelines: [] }

  const doc = YAML.parse(raw) as {
    version?: number
    pipelines?: Array<Record<string, unknown>>
  } | null

  const registry = loadAgentsRegistry({ repoRoot: input?.repoRoot })
  const knownAgentIds =
    input?.agentIds ?? new Set(registry.agents.map((a) => a.id))

  const pipelines: Array<PipelineTemplate> = (doc?.pipelines ?? []).map(
    (p) => {
      const runtimeRaw = (p.runtime as Record<string, unknown> | undefined) ?? {}
      const hooksRaw =
        (runtimeRaw.hooks as Record<string, unknown> | undefined) ?? {}
      const runtime: PipelineRuntimeConfig | undefined =
        Object.keys(runtimeRaw).length > 0
          ? {
              maxConcurrentTasks:
                typeof runtimeRaw.maxConcurrentTasks === 'number'
                  ? runtimeRaw.maxConcurrentTasks
                  : undefined,
              maxRetryBackoffMs:
                typeof runtimeRaw.maxRetryBackoffMs === 'number'
                  ? runtimeRaw.maxRetryBackoffMs
                  : undefined,
              stallTimeoutMs:
                typeof runtimeRaw.stallTimeoutMs === 'number'
                  ? runtimeRaw.stallTimeoutMs
                  : undefined,
              hooks: {
                before_stage:
                  typeof hooksRaw.before_stage === 'string'
                    ? hooksRaw.before_stage
                    : null,
                after_stage:
                  typeof hooksRaw.after_stage === 'string'
                    ? hooksRaw.after_stage
                    : null,
                timeout_ms:
                  typeof hooksRaw.timeout_ms === 'number'
                    ? hooksRaw.timeout_ms
                    : undefined,
              },
            }
          : undefined

      const pipelineId = String(p.id ?? '')
      return {
        id: pipelineId,
        name: String(p.name ?? p.id ?? ''),
        workspaceMode: (p.workspaceMode === 'worktree'
          ? 'worktree'
          : 'canonical') as WorkspaceMode,
        runtime,
        stages: (
          (p.stages as Array<Record<string, unknown>> | undefined) ?? []
        ).map((s) => {
          const rawMaxRework = s.maxRework
          let maxRework = 2
          if (rawMaxRework !== undefined && rawMaxRework !== null) {
            const parsed = Number(rawMaxRework)
            if (Number.isFinite(parsed) && parsed >= 0) {
              maxRework = Math.floor(parsed)
            }
          }
          const promptFile = s.promptFile ? String(s.promptFile) : null
          let prompt =
            typeof s.prompt === 'string' ? (s.prompt as string) : null
          if (!prompt && promptFile) {
            const abs = path.isAbsolute(promptFile)
              ? promptFile
              : path.join(
                  input?.repoRoot ?? process.cwd(),
                  'pipelines',
                  pipelineId,
                  promptFile.replace(/^\.\//, ''),
                )
            const alt = path.join(
              input?.repoRoot ?? process.cwd(),
              promptFile.replace(/^\.\//, ''),
            )
            const filePath = fs.existsSync(abs)
              ? abs
              : fs.existsSync(alt)
                ? alt
                : null
            if (filePath) {
              const rawPrompt = fs.readFileSync(filePath, 'utf-8')
              // Strip optional YAML front matter
              prompt = rawPrompt.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
            }
          }
          const outcomesRaw = Array.isArray(s.outcomes) ? s.outcomes : []
          return {
            key: String(s.key ?? ''),
            agent: String(s.agent ?? ''),
            kind: s.kind === 'review' ? ('review' as const) : ('work' as const),
            dependsOn: Array.isArray(s.dependsOn)
              ? s.dependsOn.map(String)
              : [],
            reworkTarget: s.reworkTarget ? String(s.reworkTarget) : null,
            maxRework,
            requires: Array.isArray(s.requires) ? s.requires.map(String) : [],
            prompt,
            promptFile,
            skillRefs: Array.isArray(s.skillRefs)
              ? s.skillRefs.map(String)
              : [],
            outcomes: outcomesRaw.map((o) => {
              const row = o as Record<string, unknown>
              return {
                name: String(row.name ?? ''),
                values: Array.isArray(row.values)
                  ? row.values.map(String)
                  : [],
              }
            }),
          }
        }),
      }
    },
  )

  const allErrors: Array<string> = []
  for (const template of pipelines) {
    allErrors.push(
      ...validatePipelineTemplate(template, knownAgentIds, registry.byId),
    )
  }
  if (allErrors.length > 0) {
    throw new Error(
      `pipelines.yaml validation failed:\n  - ${allErrors.join('\n  - ')}`,
    )
  }
  return { version: doc?.version ?? 1, pipelines }
}

export function getPipelineTemplate(
  id: string,
  input?: { repoRoot?: string },
): PipelineTemplate | null {
  return loadPipelineTemplates(input).pipelines.find((p) => p.id === id) ?? null
}
