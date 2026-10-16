import {
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'yaml'
import { z } from 'zod'
import { AGORAX_MANAGED_AGENT_BACKENDS } from '@/lib/managed-agent-runtime/agent-targets'
import { SWARM_CANONICAL_REPO } from './swarm-environment'

/** Local registry (gitignored). Seeded from agents.yaml.example. */
export const SWARM_ROSTER_PATH = join(SWARM_CANONICAL_REPO, 'agents.yaml')
/** Git-tracked template copied to agents.yaml on install / first load. */
export const SWARM_ROSTER_EXAMPLE_PATH = join(
  SWARM_CANONICAL_REPO,
  'agents.yaml.example',
)

const WORKER_ID_PATTERN = /^(swarm\d+|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/i

export function isSwarmWorkerId(value: unknown): value is string {
  return typeof value === 'string' && WORKER_ID_PATTERN.test(value.trim())
}

const WorkerIdSchema = z
  .string()
  .trim()
  .regex(
    WORKER_ID_PATTERN,
    'worker id must look like swarm13 or a semantic profile id',
  )

export const SwarmRosterWorkerSchema = z.object({
  id: WorkerIdSchema,
  name: z.string().default(''),
  role: z.string().default('Worker'),
  specialty: z.string().default(''),
  mission: z.string().default('Awaiting orchestrator dispatch.'),
  profile: WorkerIdSchema.optional(),
  /** When true (Hermes), install/chat ensure materializes ~/.hermes/profiles/<id>. */
  ensureProfile: z.boolean().default(false),
  modes: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  plugins: z.array(z.string()).default([]),
  pluginToolsets: z.array(z.string()).default([]),
  mcpServers: z.array(z.string()).default([]),
  wrapper: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  defaultCwd: z.string().optional(),
  preferredTaskTypes: z.array(z.string()).default([]),
  greenlightRequiredFor: z.array(z.string()).default([]),
  maxConcurrentTasks: z.number().int().positive().default(1),
  acceptsBroadcast: z.boolean().default(true),
  reviewRequired: z.boolean().default(false),
  runtime: z
    .enum(['hermes', 'deepseek-harness', ...AGORAX_MANAGED_AGENT_BACKENDS])
    .default('hermes'),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  execution: z.enum(['local', 'ssh']).default('local'),
  mentionName: z.string().optional(),
  displayName: z.string().optional(),
  dispatchable: z.boolean().default(true),
  enabled: z.boolean().default(true),
})

export const SwarmRosterSchema = z
  .object({
    version: z.number().int().positive().default(1),
    agents: z.array(SwarmRosterWorkerSchema).optional(),
    workers: z.array(SwarmRosterWorkerSchema).optional(),
  })
  .transform((value) => ({
    version: value.version,
    workers: value.agents ?? value.workers ?? [],
  }))

export type SwarmRosterWorker = z.infer<typeof SwarmRosterWorkerSchema>
export type SwarmRoster = z.infer<typeof SwarmRosterSchema>

export const SwarmRosterUpsertSchema = SwarmRosterWorkerSchema.extend({
  id: WorkerIdSchema,
})

export type SwarmRosterUpsert = z.infer<typeof SwarmRosterUpsertSchema>

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function defaultRoleFromId(id: string): string {
  const n = id.match(/(\d+)/)?.[1] ?? ''
  switch (n) {
    case '1':
    case '12':
      return 'PR / Issues'
    case '2':
      return 'Backend Foundation'
    case '3':
      return 'Main Session Mirror'
    case '4':
      return 'Research'
    case '5':
    case '10':
      return 'Builder'
    case '6':
    case '11':
      return 'Reviewer'
    case '7':
      return 'Docs'
    case '8':
      return 'Ops'
    case '9':
      return 'Hackathon'
    default:
      return 'Worker'
  }
}

export function fallbackRoster(ids: Array<string> = []): SwarmRoster {
  return {
    version: 1,
    workers: ids.map((id) => ({
      id,
      name: id.replace(/^swarm/i, 'Swarm'),
      role: defaultRoleFromId(id),
      specialty: '',
      mission: 'Awaiting orchestrator dispatch.',
      ensureProfile: false,
      modes: [],
      tools: [],
      skills: [],
      plugins: [],
      pluginToolsets: [],
      mcpServers: [],
      capabilities: [],
      defaultCwd: undefined,
      preferredTaskTypes: [],
      greenlightRequiredFor: [],
      maxConcurrentTasks: 1,
      acceptsBroadcast: true,
      reviewRequired: false,
      runtime: 'hermes',
      command: undefined,
      args: undefined,
      execution: 'local',
      mentionName: undefined,
      displayName: undefined,
      dispatchable: true,
      enabled: true,
    })),
  }
}

function parseRosterFile(filePath: string): SwarmRoster | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = yaml.parse(readFileSync(filePath, 'utf-8')) as unknown
    return SwarmRosterSchema.parse(raw)
  } catch {
    return null
  }
}

export function rosterPaths(repoRoot: string = SWARM_CANONICAL_REPO): {
  agents: string
  example: string
} {
  return {
    agents: join(repoRoot, 'agents.yaml'),
    example: join(repoRoot, 'agents.yaml.example'),
  }
}

/**
 * If agents.yaml is missing, copy agents.yaml.example.
 * Returns true when a copy was performed.
 */
export function ensureAgentsYamlFromExample(
  repoRoot: string = SWARM_CANONICAL_REPO,
): boolean {
  const { agents, example } = rosterPaths(repoRoot)
  if (existsSync(agents)) return false
  if (!existsSync(example)) return false
  copyFileSync(example, agents)
  return true
}

function parseRosterAt(
  filePath: string,
  ids: Array<string> = [],
): SwarmRoster {
  const parsed = parseRosterFile(filePath)
  if (!parsed) return fallbackRoster(ids)
  const byId = new Map(parsed.workers.map((worker) => [worker.id, worker]))
  for (const fallback of fallbackRoster(ids).workers) {
    if (!byId.has(fallback.id)) byId.set(fallback.id, fallback)
  }
  return { version: parsed.version, workers: [...byId.values()] }
}

/** Template ids (agents.yaml.example) — UI cannot delete these. */
export function isBuiltinAgentId(
  agentId: string,
  repoRoot: string = SWARM_CANONICAL_REPO,
): boolean {
  if (agentId === 'default') return true
  const example = parseRosterFile(rosterPaths(repoRoot).example)
  return Boolean(example?.workers.some((worker) => worker.id === agentId))
}

/** Hermes agents with ensureProfile: true in local agents.yaml. */
export function listEnsureProfileAgentIds(
  repoRoot: string = SWARM_CANONICAL_REPO,
): Array<string> {
  ensureAgentsYamlFromExample(repoRoot)
  return readSwarmRoster([], repoRoot)
    .workers.filter(
      (w) =>
        w.runtime === 'hermes' &&
        w.ensureProfile === true &&
        w.id !== 'default' &&
        w.enabled !== false,
    )
    .map((w) => w.id)
}

export function readSwarmRoster(
  ids: Array<string> = [],
  repoRoot: string = SWARM_CANONICAL_REPO,
): SwarmRoster {
  ensureAgentsYamlFromExample(repoRoot)
  const { agents } = rosterPaths(repoRoot)
  if (!existsSync(agents)) return fallbackRoster(ids)
  return parseRosterAt(agents, ids)
}

export function writeSwarmRoster(
  roster: SwarmRoster,
  repoRoot: string = SWARM_CANONICAL_REPO,
): void {
  const parsed = SwarmRosterSchema.parse(roster)
  writeFileSync(
    rosterPaths(repoRoot).agents,
    yaml.stringify(
      {
        version: parsed.version,
        agents: parsed.workers,
      },
      { lineWidth: 0 },
    ),
  )
}

function sortWorkers(workers: Array<SwarmRosterWorker>): Array<SwarmRosterWorker> {
  return [...workers].sort((a, b) => {
    const na = parseInt(a.id.replace(/\D/g, ''), 10) || 0
    const nb = parseInt(b.id.replace(/\D/g, ''), 10) || 0
    if (na !== nb) return na - nb
    return a.id.localeCompare(b.id)
  })
}

export function upsertSwarmRosterWorker(
  input: SwarmRosterUpsert,
  ids: Array<string> = [],
  repoRoot: string = SWARM_CANONICAL_REPO,
): SwarmRoster {
  const nextWorker = SwarmRosterUpsertSchema.parse(input)
  const current = readSwarmRoster(ids, repoRoot)
  const byId = new Map(current.workers.map((worker) => [worker.id, worker]))
  byId.set(nextWorker.id, nextWorker)
  const next: SwarmRoster = {
    version: current.version || 1,
    workers: sortWorkers([...byId.values()]),
  }
  writeSwarmRoster(next, repoRoot)
  return next
}

export function deleteSwarmRosterWorker(
  workerId: string,
  ids: Array<string> = [],
  repoRoot: string = SWARM_CANONICAL_REPO,
): SwarmRoster {
  if (isBuiltinAgentId(workerId, repoRoot)) {
    throw new Error(
      `Builtin agent "${workerId}" is defined in agents.yaml.example and cannot be deleted`,
    )
  }
  const current = readSwarmRoster(ids, repoRoot)
  const next: SwarmRoster = {
    version: current.version || 1,
    workers: current.workers.filter((worker) => worker.id !== workerId),
  }
  if (next.workers.length === current.workers.length) {
    throw new Error(`Worker ${workerId} not found in swarm roster`)
  }
  writeSwarmRoster(next, repoRoot)
  return next
}

export function patchSwarmRosterWorker(
  workerId: string,
  patch: Partial<SwarmRosterWorker>,
  ids: Array<string> = [],
  repoRoot: string = SWARM_CANONICAL_REPO,
): SwarmRoster {
  const current = readSwarmRoster(ids, repoRoot)
  const existing = current.workers.find((worker) => worker.id === workerId)
  if (!existing) throw new Error(`Worker ${workerId} not found in swarm roster`)
  const updated = SwarmRosterWorkerSchema.parse({
    ...existing,
    ...patch,
    id: workerId,
  })
  const byId = new Map(current.workers.map((worker) => [worker.id, worker]))
  byId.set(workerId, updated)
  const next: SwarmRoster = {
    version: current.version || 1,
    workers: sortWorkers([...byId.values()]),
  }
  writeSwarmRoster(next, repoRoot)
  return next
}

export function rosterByWorkerId(
  ids: Array<string> = [],
): Map<string, SwarmRosterWorker> {
  return new Map(
    readSwarmRoster(ids).workers.map((worker) => [worker.id, worker]),
  )
}

export function resolveSwarmWorkerDisplayName(
  workerId: string,
  worker?: Pick<SwarmRosterWorker, 'name'> | null,
): string {
  return worker
    ? worker.name.trim() || titleCase(workerId)
    : titleCase(workerId)
}

export function formatSwarmWorkerLabel(
  workerId: string,
  worker?: Pick<SwarmRosterWorker, 'name' | 'role'> | null,
): string {
  const displayName = resolveSwarmWorkerDisplayName(workerId, worker)
  const role = worker
    ? worker.role.trim() || defaultRoleFromId(workerId)
    : defaultRoleFromId(workerId)
  return `${displayName} — ${role}`
}
