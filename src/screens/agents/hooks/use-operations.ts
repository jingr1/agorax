import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CronJob } from '@/components/cron-manager/cron-types'
import { toast } from '@/components/ui/toast'
import { fetchCronJobs } from '@/lib/cron-api'
import { fetchSessions, type GatewaySession } from '@/lib/gateway-api'
import {
  formatModelName,
  formatRelativeTime,
} from '@/screens/dashboard/lib/formatters'
import {
  AGENTS_SNAPSHOT_QUERY_KEY,
  fetchAgentsSnapshot,
  mapUnifiedToOperationsStatus,
} from '@/hooks/use-agent-snapshot'
import type { CrewMember } from '@/hooks/use-crew-status'
import {
  createAgentConsistent,
  type CreateAgentInput,
  normalizeAgentId,
} from '@/lib/create-agent'
import { agentRuntimeLabel } from '@/lib/managed-agent-runtime/agent-targets'

// Operations is backed by GET /api/agents (agents.yaml registry).
// Per-agent details: GET /api/agents/:id/capabilities (Hermes + managed).
// Create / update / delete declarations go through /api/agent-registry.

export type GatewayConfigAgent = {
  id: string
  name: string
  /** Hermes profile or managed runtime id (claude-code, codex, …). */
  runtime: string
  model: string
  provider?: string
  workspace?: string
  agentDir?: string
  description?: string
  systemPrompt?: string
  skillCount?: number
  mcpCount?: number
  role?: string
  specialty?: string
  command?: string
  args?: Array<string>
}

export type OperationsAgentMeta = {
  emoji: string
  description: string
  systemPrompt: string
  color: string
  createdAt: string
}

export type OperationsSettings = {
  defaultModel: string
  autoApprove: boolean
  activityFeedLength: number
}

export type OperationsAgentStatus =
  | 'active'
  | 'idle'
  | 'offline'
  | 'blocked'
  | 'error'
  | 'needsSetup'

export type OperationsOutputItem = {
  id: string
  agentId: string
  summary: string
  timestamp: number
  source: 'session' | 'cron'
}

export type AgentSkillItem = {
  name: string
  /** Platform catalog id when bound via agent_skills. */
  skillId?: string
  description?: string
  category?: string | null
  enabled: boolean
  path?: string
}

export type AgentMcpItem = {
  name: string
  enabled: boolean
  status?: 'ok' | 'error' | 'disabled'
  error?: string
  /** Platform library binding id when sourced from agent_mcp_servers. */
  serverId?: string
  source?: 'platform' | 'profile'
}

export type OperationsAgentHealth = {
  hasModel: boolean
  hasProvider: boolean
  hasEnv: boolean
  missingSkills: string[]
  disabledMcp: string[]
  issues: string[]
}

export type OperationsAgentResources = {
  workspace?: string
  memoryPaths: string[]
  envExists: boolean
}

export type OperationsAgentCapabilities = {
  skills: AgentSkillItem[]
  mcpServers: AgentMcpItem[]
  toolsets: string[]
}

/** Aggregated capabilities for Operations (platform + optional Hermes profile). */
type CapabilitiesResponse = {
  profile: string
  skills: AgentSkillItem[]
  mcpServers: Array<{
    name: string
    enabled: boolean
    status?: string
    transportType?: string
    url?: string
    command?: string
    error?: string
    serverId?: string
    source?: 'platform' | 'profile'
  }>
  toolsets: string[]
  workspace?: string
  envExists: boolean
  envPath?: string
  /** Hermes profile model from config.yaml (profiles/capabilities only). */
  defaultModel?: string | null
  provider?: string | null
}

export type OperationsAgentUsage = {
  sessionCount: number
  messageCount: number
  toolCallCount: number
  totalTokens: number
  estimatedCostUsd: number | null
  cronJobCount: number
  assignedTaskCount: number
  gatewayState: string
  processAlive: boolean
  telegramState: string | null
  lastSessionTitle: string | null
  lastSessionAt: number | null
}

export type OperationsAgent = GatewayConfigAgent & {
  meta: OperationsAgentMeta
  shortModel: string
  status: OperationsAgentStatus
  /** Multica-style reachability axis from /api/agents/snapshot. */
  availability: 'online' | 'unstable' | 'offline'
  /** Multica-style workload axis from /api/agents/snapshot. */
  workload: 'working' | 'queued' | 'idle'
  sessionKey: string
  sessions: GatewaySession[]
  latestSession: GatewaySession | null
  jobs: CronJob[]
  nextRunAt: number | null
  lastActivityAt: number | null
  activityLabel: string
  progressValue: number
  progressStatus: 'running' | 'queued' | 'failed' | 'complete' | 'thinking'
  recentOutputs: OperationsOutputItem[]
  /**
   * True when the agent's profile has no model configured (blank model in
   * config.yaml). Dispatching into an unconfigured agent hangs because
   * hermes-agent has nothing to call. Show 'Needs setup' state instead.
   * See #270.
   */
  needsSetup: boolean
  capabilities: OperationsAgentCapabilities
  resources: OperationsAgentResources
  health: OperationsAgentHealth
  blockedReason: string | null
  needsHuman: boolean
  runtimeState: string | null
  /** Live task title from snapshot (may be free text). */
  currentTask: string | null
  /** Swarm mission id when the worker is on a pipeline mission. */
  missionId: string | null
  /** Whether this profile is the workspace-active profile. */
  isActiveProfile: boolean
  usage: OperationsAgentUsage | null
}

type ConfigPayload = {
  ok?: boolean
  error?: string
  payload?: {
    parsed?: {
      agents?: {
        list?: unknown[]
      }
      defaultModel?: string
      [key: string]: unknown
    }
    defaultModel?: string
    [key: string]: unknown
  }
  parsed?: {
    agents?: {
      list?: unknown[]
    }
    defaultModel?: string
    [key: string]: unknown
  }
  defaultModel?: string
  [key: string]: unknown
}

const META_STORAGE_PREFIX = 'operations:agents:'
const SETTINGS_STORAGE_KEY = 'operations-settings'

const COLOR_PALETTE = [
  { body: '#3b82f6', accent: '#93c5fd' },
  { body: '#10b981', accent: '#6ee7b7' },
  { body: '#f97316', accent: '#fdba74' },
  { body: '#8b5cf6', accent: '#c4b5fd' },
  { body: '#ec4899', accent: '#f9a8d4' },
  { body: '#06b6d4', accent: '#67e8f9' },
  { body: '#eab308', accent: '#fde047' },
  { body: '#ef4444', accent: '#fca5a5' },
]

function hashString(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return hash
}

function createFallbackColor(agentId: string): string {
  return (
    COLOR_PALETTE[hashString(agentId) % COLOR_PALETTE.length]?.body ?? '#3b82f6'
  )
}

function createFallbackEmoji(agentId: string): string {
  const emojis = ['🤖', '🐦', '🔨', '✍️', '📊', '🛰️', '🧠', '🛠️']
  return emojis[hashString(agentId) % emojis.length] ?? '🤖'
}

function readTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function extractSessionText(session: GatewaySession): string {
  const lastMessage = session.lastMessage
  if (lastMessage) {
    if (typeof lastMessage.text === 'string' && lastMessage.text.trim()) {
      return lastMessage.text.trim()
    }
    if (Array.isArray(lastMessage.content)) {
      const text = lastMessage.content
        .filter((part) => !part.type || part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
        .trim()
      if (text) return text
    }
  }

  return (
    readString(session.derivedTitle) ||
    readString(session.title) ||
    readString(session.task) ||
    readString(session.initialMessage)
  )
}

function truncate(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function normalizeAgentList(input: unknown): GatewayConfigAgent[] {
  if (!Array.isArray(input)) return []

  const agents: GatewayConfigAgent[] = []

  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue
    }

    const row = entry as Record<string, unknown>
    const id = normalizeAgentId(readString(row.id) || readString(row.name))
    if (!id) continue

    agents.push({
      id,
      name: readString(row.name) || id,
      runtime: readString(row.runtime) || 'hermes',
      model: readString(row.model),
      provider: readString(row.provider),
      workspace: readString(row.workspace) || undefined,
      agentDir: readString(row.agentDir) || undefined,
      description: readString(row.description) || undefined,
      systemPrompt: readString(row.systemPrompt) || undefined,
      skillCount:
        typeof row.skillCount === 'number' ? row.skillCount : undefined,
      mcpCount: typeof row.mcpCount === 'number' ? row.mcpCount : undefined,
      role: readString(row.role) || undefined,
      specialty: readString(row.specialty) || undefined,
      command: readString(row.command) || undefined,
      args: Array.isArray(row.args)
        ? row.args.filter((v): v is string => typeof v === 'string')
        : undefined,
    })
  }

  return agents
}

function parseConfigPayload(payload: ConfigPayload): ConfigPayload {
  if (payload.payload && typeof payload.payload === 'object') {
    return payload.payload as ConfigPayload
  }
  return payload
}

// Operations agent list: GET /api/agents (agents.yaml registry).
// Hermes model/workspace come from /api/profiles/capabilities per agent.
async function fetchOperationsConfig(): Promise<
  ConfigPayload & { activeProfile: string }
> {
  const [agentsRes, profilesRes] = await Promise.all([
    fetch('/api/agents'),
    fetch('/api/profiles/list?light=1'),
  ])
  if (!agentsRes.headers.get('content-type')?.includes('json')) {
    throw new Error('/api/agents returned non-JSON')
  }
  const agentsPayload = (await agentsRes.json().catch(() => ({}))) as {
    agents?: Array<{
      agentId: string
      name?: string
      runtime?: string
      role?: string
      specialty?: string
      runtimeConfig?: {
        profile?: string
        command?: string
        args?: Array<string>
      }
    }>
    error?: string
  }
  if (!agentsRes.ok || agentsPayload.error) {
    throw new Error(agentsPayload.error || `HTTP ${agentsRes.status}`)
  }

  let activeProfile = 'default'
  if (profilesRes.ok && profilesRes.headers.get('content-type')?.includes('json')) {
    const profilesPayload = (await profilesRes.json().catch(() => ({}))) as {
      activeProfile?: string
    }
    if (profilesPayload.activeProfile) {
      activeProfile = profilesPayload.activeProfile
    }
  }

  const list = (agentsPayload.agents ?? [])
    .filter((a) => Boolean(a.agentId))
    .map((a) => ({
      id: a.agentId,
      name:
        a.agentId === 'default'
          ? 'Workspace'
          : a.name || a.agentId,
      runtime: a.runtime || 'hermes',
      model: '',
      provider: '',
      workspace: undefined,
      agentDir: undefined,
      description: '',
      systemPrompt: '',
      skillCount: 0,
      mcpCount: 0,
      role: a.role,
      specialty: a.specialty,
      command: a.runtimeConfig?.command,
      args: a.runtimeConfig?.args,
    }))

  return {
    ok: true,
    activeProfile,
    parsed: {
      agents: { list },
      defaultModel: '',
    },
  }
}

async function updateClaudeProfile(
  name: string,
  patch: Record<string, unknown>,
) {
  const response = await fetch('/api/profiles/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, patch }),
  })
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    error?: string
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(
      payload.error || `Failed to update profile (${response.status})`,
    )
  }
}

async function deleteClaudeProfile(name: string) {
  const response = await fetch('/api/profiles/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    error?: string
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(
      payload.error || `Failed to delete profile (${response.status})`,
    )
  }
}

function loadAgentMeta(
  agentId: string,
  fallback?: Partial<Pick<OperationsAgentMeta, 'description' | 'systemPrompt'>>,
): OperationsAgentMeta {
  const fallbackDescription = readString(fallback?.description)
  const fallbackSystemPrompt = readString(fallback?.systemPrompt)

  if (typeof window === 'undefined') {
    return {
      emoji: createFallbackEmoji(agentId),
      description: fallbackDescription,
      systemPrompt: fallbackSystemPrompt,
      color: createFallbackColor(agentId),
      createdAt: new Date().toISOString(),
    }
  }

  try {
    const raw = window.localStorage.getItem(`${META_STORAGE_PREFIX}${agentId}`)
    if (!raw) {
      return {
        emoji: createFallbackEmoji(agentId),
        description: fallbackDescription,
        systemPrompt: fallbackSystemPrompt,
        color: createFallbackColor(agentId),
        createdAt: new Date().toISOString(),
      }
    }

    const parsed = JSON.parse(raw) as Partial<OperationsAgentMeta>
    return {
      emoji: readString(parsed.emoji) || createFallbackEmoji(agentId),
      description: readString(parsed.description) || fallbackDescription,
      systemPrompt: readString(parsed.systemPrompt) || fallbackSystemPrompt,
      color: readString(parsed.color) || createFallbackColor(agentId),
      createdAt: readString(parsed.createdAt) || new Date().toISOString(),
    }
  } catch {
    return {
      emoji: createFallbackEmoji(agentId),
      description: fallbackDescription,
      systemPrompt: fallbackSystemPrompt,
      color: createFallbackColor(agentId),
      createdAt: new Date().toISOString(),
    }
  }
}

function persistAgentMeta(agentId: string, meta: OperationsAgentMeta) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(
    `${META_STORAGE_PREFIX}${agentId}`,
    JSON.stringify(meta),
  )
}

function removeAgentMeta(agentId: string) {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(`${META_STORAGE_PREFIX}${agentId}`)
}

function loadSettings(): OperationsSettings {
  if (typeof window === 'undefined') {
    return { defaultModel: '', autoApprove: false, activityFeedLength: 5 }
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) {
      return { defaultModel: '', autoApprove: false, activityFeedLength: 5 }
    }

    const parsed = JSON.parse(raw) as Partial<OperationsSettings>
    const activityFeedLength = Number(parsed.activityFeedLength)

    return {
      defaultModel: readString(parsed.defaultModel),
      autoApprove: Boolean(parsed.autoApprove),
      activityFeedLength:
        Number.isFinite(activityFeedLength) && activityFeedLength > 0
          ? Math.min(20, Math.max(1, Math.round(activityFeedLength)))
          : 5,
    }
  } catch {
    return { defaultModel: '', autoApprove: false, activityFeedLength: 5 }
  }
}

function persistSettings(settings: OperationsSettings) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
}

function getAgentJobs(agentId: string, jobs: CronJob[]): CronJob[] {
  return jobs.filter((job) => job.name?.startsWith(`ops:${agentId}:`))
}

function getAgentSessions(
  agentId: string,
  sessions: GatewaySession[],
): GatewaySession[] {
  return [...sessions]
    .filter((session) => {
      const label = readString(session.label)
      const key = readString(session.key)
      return label.includes(agentId) || key.includes(agentId)
    })
    .sort((left, right) => {
      const leftTs = readTimestamp(left.updatedAt) ?? 0
      const rightTs = readTimestamp(right.updatedAt) ?? 0
      return rightTs - leftTs
    })
}

function getAgentStatus(
  latestSession: GatewaySession | null,
  runtimeState?: string | null,
  runtimeLastOutputAt?: number | null,
  needsSetup = false,
): OperationsAgentStatus {
  if (needsSetup) return 'needsSetup'

  // Prefer the live Swarm runtime signal when available.
  const busyStates = new Set([
    'executing',
    'thinking',
    'writing',
    'reviewing',
    'syncing',
  ])
  const recentActivityThreshold = 10 * 60 * 1000
  if (runtimeState && busyStates.has(runtimeState.toLowerCase())) {
    const isStale =
      !runtimeLastOutputAt ||
      Date.now() - runtimeLastOutputAt > recentActivityThreshold
    return isStale ? 'idle' : 'active'
  }

  // Blocked is its own state, distinct from a generic error.
  if (runtimeState && runtimeState.toLowerCase() === 'blocked') {
    return 'blocked'
  }

  const errorStates = new Set(['error', 'failed'])
  if (runtimeState && errorStates.has(runtimeState.toLowerCase())) {
    return 'error'
  }

  const idleStates = new Set(['idle', 'waiting', 'stopped'])
  if (runtimeState && idleStates.has(runtimeState.toLowerCase())) {
    return 'idle'
  }

  // No runtime entry yet: fall back to session activity.
  if (!latestSession) return 'offline'

  const status = readString(latestSession.status).toLowerCase()
  if (status === 'blocked') return 'blocked'
  if (status.includes('fail') || status.includes('error')) return 'error'

  const updatedAt = readTimestamp(latestSession.updatedAt)
  if (updatedAt && Date.now() - updatedAt < 120_000) {
    return 'active'
  }

  return 'idle'
}

function mapUsageFromCrew(member: CrewMember | undefined): OperationsAgentUsage | null {
  if (!member) return null
  return {
    sessionCount: member.sessionCount,
    messageCount: member.messageCount,
    toolCallCount: member.toolCallCount,
    totalTokens: member.totalTokens,
    estimatedCostUsd: member.estimatedCostUsd,
    cronJobCount: member.cronJobCount,
    assignedTaskCount: member.assignedTaskCount,
    gatewayState: member.gatewayState,
    processAlive: member.processAlive,
    telegramState: member.platforms?.telegram?.state ?? null,
    lastSessionTitle: member.lastSessionTitle,
    lastSessionAt: member.lastSessionAt,
  }
}

function getProgressStatus(
  status: OperationsAgentStatus,
  latestSession: GatewaySession | null,
): OperationsAgent['progressStatus'] {
  if (status === 'error' || status === 'blocked') return 'failed'
  if (status === 'active') return 'running'
  if (status === 'idle' || status === 'needsSetup') return 'queued'

  const sessionStatus = readString(latestSession?.status).toLowerCase()
  if (sessionStatus.includes('complete') || sessionStatus.includes('done')) {
    return 'complete'
  }
  return latestSession ? 'thinking' : 'queued'
}

function getProgressValue(
  status: OperationsAgentStatus,
  latestSession: GatewaySession | null,
): number {
  const rawProgress = latestSession?.progress
  if (typeof rawProgress === 'number' && Number.isFinite(rawProgress)) {
    return Math.max(5, Math.min(100, rawProgress))
  }
  if (status === 'active') return 72
  if (status === 'error' || status === 'blocked') return 100
  if (status === 'needsSetup') return 30
  if (latestSession) return 100
  return 18
}

function formatUpcomingTime(timestamp: number): string {
  const diff = timestamp - Date.now()
  if (diff <= 0) return 'soon'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function slugifyJobLabel(value: string): string {
  return normalizeAgentId(value) || 'scheduled-run'
}

function buildCronOutput(
  job: CronJob,
  agentId: string,
): OperationsOutputItem | null {
  const startedAt = readTimestamp(job.lastRun?.startedAt)
  const summary = truncate(
    readString(job.lastRun?.deliverySummary) ||
      readString(job.description) ||
      readString(job.name).replace(`ops:${agentId}:`, '').replace(/-/g, ' '),
  )

  if (!startedAt || !summary) return null

  return {
    id: `cron-${job.id}`,
    agentId,
    summary,
    timestamp: startedAt,
    source: 'cron',
  }
}

function buildSessionOutput(
  session: GatewaySession,
  agentId: string,
): OperationsOutputItem | null {
  const timestamp =
    readTimestamp(session.updatedAt) ?? readTimestamp(session.createdAt)
  const summary = truncate(extractSessionText(session))
  if (!timestamp || !summary) return null

  return {
    id: `session-${readString(session.key) || timestamp}`,
    agentId,
    summary,
    timestamp,
    source: 'session',
  }
}

export function getOperationsSessionKey(agentId: string): string {
  return `agent:main:ops-${agentId}`
}

export function useOperations() {
  const queryClient = useQueryClient()
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [settings, setSettings] = useState<OperationsSettings>(() =>
    loadSettings(),
  )
  const [metaVersion, setMetaVersion] = useState(0)

  const configQuery = useQuery({
    queryKey: ['operations', 'config'],
    queryFn: fetchOperationsConfig,
    refetchInterval: 30_000,
  })

  // Unified capabilities for every registry agent (Hermes + managed).
  const capabilitiesQuery = useQuery({
    queryKey: ['operations', 'capabilities'],
    queryFn: async () => {
      const results: Record<string, CapabilitiesResponse> = {}
      const agentsRes = await fetch('/api/agents')
      if (!agentsRes.ok) return results
      const agentsPayload = (await agentsRes.json()) as {
        agents?: Array<{ agentId: string }>
      }
      await Promise.all(
        (agentsPayload.agents ?? []).map(async (agent) => {
          const agentId = agent.agentId
          if (!agentId) return
          try {
            const capsRes = await fetch(
              `/api/agents/${encodeURIComponent(agentId)}/capabilities`,
            )
            if (!capsRes.ok) return
            const caps = (await capsRes.json()) as {
              skills?: Array<{
                name: string
                skillId?: string
                description?: string
                enabled: boolean
                source?: 'platform' | 'profile'
              }>
              mcpServers?: Array<{
                name: string
                enabled: boolean
                status?: string
                transportType?: string
                serverId?: string
                source?: 'platform' | 'profile'
                error?: string
              }>
              toolsets?: string[]
              workspace?: string
              envExists?: boolean
              defaultModel?: string | null
              provider?: string | null
            }
            results[agentId] = {
              profile: agentId,
              skills: (caps.skills ?? []).map((s) => ({
                name: s.name,
                skillId: s.skillId,
                description: s.description,
                enabled: s.enabled,
              })),
              mcpServers: (caps.mcpServers ?? []).map((m) => ({
                name: m.name,
                enabled: m.enabled,
                status: m.status,
                transportType: m.transportType,
                serverId: m.serverId,
                source: m.source,
                error: m.error,
              })),
              toolsets: caps.toolsets ?? [],
              workspace: caps.workspace,
              envExists: caps.envExists ?? false,
              defaultModel: caps.defaultModel ?? null,
              provider: caps.provider ?? null,
            }
          } catch {
            /* ignore */
          }
        }),
      )
      return results
    },
    refetchInterval: 60_000,
  })

  const sessionsQuery = useQuery({
    queryKey: ['operations', 'sessions'],
    queryFn: async () => {
      const response = await fetchSessions()
      return Array.isArray(response.sessions) ? response.sessions : []
    },
    refetchInterval: 30_000,
  })

  /** Single aggregate poll for live status / KPI / currentTask (Phase 3). */
  const snapshotQuery = useQuery({
    queryKey: AGENTS_SNAPSHOT_QUERY_KEY,
    queryFn: fetchAgentsSnapshot,
    refetchInterval: 30_000,
    staleTime: 20_000,
  })

  /**
   * Usage metrics (Monitoring) — only polled when needed so Agents first paint
   * stays on the snapshot. Invalidate/refetch from Usage tab / detail open.
   */
  const [usageEnabled, setUsageEnabled] = useState(false)
  const enableUsagePolling = useCallback(() => setUsageEnabled(true), [])
  const crewUsageQuery = useQuery({
    queryKey: ['operations', 'crew-status'],
    queryFn: async () => {
      const response = await fetch('/api/crew-status')
      if (!response.ok) throw new Error(`Crew status HTTP ${response.status}`)
      return response.json() as Promise<{
        crew?: Array<CrewMember>
        fetchedAt?: number
      }>
    },
    enabled: usageEnabled,
    refetchInterval: usageEnabled ? 60_000 : false,
    staleTime: 30_000,
  })

  const cronJobsQuery = useQuery({
    queryKey: ['operations', 'cron'],
    queryFn: fetchCronJobs,
    refetchInterval: 30_000,
  })

  const agents = useMemo(() => {
    const parsed = configQuery.data?.parsed
    const allAgents = normalizeAgentList(parsed?.agents?.list)
    const HIDDEN_AGENTS = new Set([
      'main',
      'pc1-coder',
      'pc1-planner',
      'pc1-critic',
    ])
    const configAgents = allAgents.filter((a) => !HIDDEN_AGENTS.has(a.id))
    const sessions = sessionsQuery.data ?? []
    const cronJobs = cronJobsQuery.data ?? []
    const snapshotById = new Map(
      (snapshotQuery.data?.agents ?? []).map((entry) => [
        entry.agentId,
        entry,
      ]),
    )
    const capsMap = capabilitiesQuery.data ?? {}
    const crewById = new Map(
      (crewUsageQuery.data?.crew ?? []).map((member) => [member.id, member]),
    )
    const activeProfile =
      (configQuery.data as (ConfigPayload & { activeProfile?: string }) | undefined)
        ?.activeProfile ?? null

    return configAgents.map((agent) => {
      const meta = loadAgentMeta(agent.id, {
        description: agent.description,
        systemPrompt: agent.systemPrompt,
      })
      const agentSessions = getAgentSessions(agent.id, sessions)
      const latestSession = agentSessions[0] ?? null
      const snap = snapshotById.get(agent.id)
      const jobs = getAgentJobs(agent.id, cronJobs)
      const nextRunAt =
        jobs
          .filter((job) => job.enabled)
          .map((job) => readTimestamp(job.nextRunAt))
          .filter((value): value is number => value !== null)
          .sort((left, right) => left - right)[0] ?? null
      const lastActivityAt =
        readTimestamp(latestSession?.updatedAt) ??
        snap?.status?.updatedAt ??
        jobs
          .map((job) => readTimestamp(job.lastRun?.startedAt))
          .filter((value): value is number => value !== null)
          .sort((left, right) => right - left)[0] ??
        null
      const caps = capsMap[agent.id]
      const resolvedModel =
        (typeof caps?.defaultModel === 'string' && caps.defaultModel.trim()
          ? caps.defaultModel.trim()
          : '') ||
        agent.model?.trim() ||
        ''
      const resolvedProvider =
        (typeof caps?.provider === 'string' && caps.provider.trim()
          ? caps.provider.trim()
          : '') ||
        agent.provider?.trim() ||
        ''
      const resolvedAgent = {
        ...agent,
        model: resolvedModel,
        provider: resolvedProvider || undefined,
        workspace: caps?.workspace ?? agent.workspace,
      }
      const isHermes = (resolvedAgent.runtime || 'hermes') === 'hermes'
      const needsSetup =
        Boolean(snap?.status?.needsSetup) ||
        (isHermes && !resolvedModel)
      const status = snap?.status
        ? mapUnifiedToOperationsStatus(
            needsSetup ? 'needsSetup' : snap.status.unifiedStatus,
            needsSetup,
          )
        : getAgentStatus(latestSession, null, null, needsSetup)
      const availability =
        snap?.status?.availability ??
        (status === 'offline' || status === 'needsSetup'
          ? 'offline'
          : 'online')
      const workload =
        snap?.status?.workload ??
        (status === 'active'
          ? 'working'
          : status === 'blocked'
            ? 'queued'
            : 'idle')
      const recentOutputs = [
        ...agentSessions.map((session) =>
          buildSessionOutput(session, agent.id),
        ),
        ...jobs.map((job) => buildCronOutput(job, agent.id)),
      ]
        .filter((item): item is OperationsOutputItem => Boolean(item))
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, 5)

      const capabilities: OperationsAgentCapabilities = {
        skills:
          caps?.skills ??
          (agent.skillCount
            ? Array.from({ length: agent.skillCount }, (_, i) => ({
                name: `skill-${i + 1}`,
                enabled: true,
              }))
            : []),
        mcpServers: caps?.mcpServers
          ? caps.mcpServers.map((m) => ({
              name: m.name,
              enabled: m.enabled,
              status: (m.status === 'connected'
                ? 'ok'
                : m.status === 'failed'
                  ? 'error'
                  : m.enabled
                    ? 'ok'
                    : 'disabled') as 'ok' | 'error' | 'disabled',
              serverId: m.serverId,
              source: m.source,
            }))
          : agent.mcpCount
            ? Array.from({ length: agent.mcpCount }, (_, i) => ({
                name: `mcp-${i + 1}`,
                enabled: true,
                status: 'ok' as const,
              }))
            : [],
        toolsets: caps?.toolsets ?? [],
      }

      const resources: OperationsAgentResources = {
        workspace: resolvedAgent.workspace,
        memoryPaths: [],
        envExists: caps?.envExists ?? false,
      }

      const health: OperationsAgentHealth = {
        hasModel: Boolean(resolvedModel) || !isHermes,
        hasProvider: Boolean(resolvedProvider) || !isHermes,
        hasEnv: isHermes ? resources.envExists : true,
        missingSkills: [],
        disabledMcp: capabilities.mcpServers
          .filter((m) => !m.enabled)
          .map((m) => m.name),
        issues: [],
      }

      if (isHermes && !health.hasModel) health.issues.push('No model configured')
      if (isHermes && !health.hasProvider)
        health.issues.push('No provider configured')

      return {
        ...resolvedAgent,
        meta,
        shortModel: formatModelName(
          resolvedModel ||
            (isHermes ? 'Custom' : agentRuntimeLabel(resolvedAgent.runtime)),
        ),
        status,
        availability,
        workload,
        sessionKey: getOperationsSessionKey(agent.id),
        sessions: agentSessions,
        latestSession,
        jobs,
        nextRunAt,
        lastActivityAt,
        activityLabel: nextRunAt
          ? `Next ${formatUpcomingTime(nextRunAt)}`
          : lastActivityAt
            ? `Last ${formatRelativeTime(lastActivityAt)}`
            : 'No activity yet',
        progressValue: getProgressValue(status, latestSession),
        progressStatus: getProgressStatus(status, latestSession),
        recentOutputs,
        needsSetup,
        capabilities,
        resources,
        health,
        blockedReason: snap?.status?.lastSummary ?? null,
        needsHuman: snap?.status?.needsHuman ?? false,
        runtimeState: snap?.status?.state ?? null,
        currentTask: snap?.status?.currentTask ?? null,
        missionId: snap?.status?.missionId ?? null,
        isActiveProfile: activeProfile === agent.id,
        usage: mapUsageFromCrew(crewById.get(agent.id)),
      } satisfies OperationsAgent
    })
  }, [
    configQuery.data,
    sessionsQuery.data,
    cronJobsQuery.data,
    snapshotQuery.data,
    capabilitiesQuery.data,
    crewUsageQuery.data,
    metaVersion,
  ])

  const selectedAgent =
    agents.find((agent) => agent.id === selectedAgentId) ?? null

  const recentActivity = useMemo(() => {
    return agents
      .flatMap((agent) => agent.recentOutputs)
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, settings.activityFeedLength)
  }, [agents, settings.activityFeedLength])

  const createAgentMutation = useMutation({
    mutationFn: async (input: CreateAgentInput & { emoji?: string }) => {
      const result = await createAgentConsistent(input)
      if (input.runtime === 'hermes') {
        persistAgentMeta(result.id, {
          emoji: input.emoji?.trim() || createFallbackEmoji(result.id),
          description: input.description?.trim() ?? '',
          systemPrompt: input.systemPrompt?.trim() ?? '',
          color: createFallbackColor(result.id),
          createdAt: new Date().toISOString(),
        })
        setMetaVersion((value) => value + 1)
      }
      setSelectedAgentId(result.id)
      return result
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['operations', 'config'],
      })
      await queryClient.invalidateQueries({
        queryKey: AGENTS_SNAPSHOT_QUERY_KEY,
      })
      toast('Agent created', { type: 'success' })
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Failed to create agent', {
        type: 'error',
      })
    },
  })

  const activateAgentMutation = useMutation({
    mutationFn: async (agentId: string) => {
      const agent = (
        normalizeAgentList(
          (
            queryClient.getQueryData(['operations', 'config']) as
              | (ConfigPayload & { activeProfile?: string })
              | undefined
          )?.parsed?.agents?.list,
        )
      ).find((entry) => entry.id === agentId)
      if (agent && agent.runtime !== 'hermes') {
        throw new Error(
          `${agentRuntimeLabel(agent.runtime)} agents do not use Hermes profiles`,
        )
      }
      const response = await fetch('/api/profiles/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: agentId }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(
          payload.error || `Failed to activate profile (${response.status})`,
        )
      }
    },
    onSuccess: async (_data, agentId) => {
      await queryClient.invalidateQueries({
        queryKey: ['operations', 'config'],
      })
      toast(`Activated ${agentId}`, { type: 'success' })
    },
    onError: (error) => {
      toast(
        error instanceof Error ? error.message : 'Failed to activate agent',
        { type: 'error' },
      )
    },
  })

  const renameAgentMutation = useMutation({
    mutationFn: async (input: { oldName: string; newName: string }) => {
      const agent = (
        normalizeAgentList(
          (
            queryClient.getQueryData(['operations', 'config']) as
              | (ConfigPayload & { activeProfile?: string })
              | undefined
          )?.parsed?.agents?.list,
        )
      ).find((entry) => entry.id === input.oldName)
      if (agent && agent.runtime !== 'hermes') {
        throw new Error(
          `${agentRuntimeLabel(agent.runtime)} agents cannot be renamed as Hermes profiles`,
        )
      }
      const next = normalizeAgentId(input.newName)
      if (!next) throw new Error('New name is required')
      if (next === 'default') {
        throw new Error('"default" is reserved — pick another name')
      }
      const response = await fetch('/api/profiles/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldName: input.oldName, newName: next }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        profile?: { name?: string }
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(
          payload.error || `Failed to rename profile (${response.status})`,
        )
      }
      const renamed = payload.profile?.name || next
      // Move local meta under the new id.
      const meta = loadAgentMeta(input.oldName)
      removeAgentMeta(input.oldName)
      persistAgentMeta(renamed, meta)
      setMetaVersion((value) => value + 1)
      setSelectedAgentId(renamed)
      return renamed
    },
    onSuccess: async (renamed) => {
      await queryClient.invalidateQueries({
        queryKey: ['operations', 'config'],
      })
      await queryClient.invalidateQueries({
        queryKey: AGENTS_SNAPSHOT_QUERY_KEY,
      })
      toast(`Renamed to ${renamed}`, { type: 'success' })
    },
    onError: (error) => {
      toast(
        error instanceof Error ? error.message : 'Failed to rename agent',
        { type: 'error' },
      )
    },
  })

  const saveAgentMutation = useMutation({
    mutationFn: async (input: {
      agentId: string
      name: string
      model: string
      emoji: string
      systemPrompt: string
      description?: string
      role?: string
      specialty?: string
      command?: string
      args?: string
    }) => {
      const agent = (
        normalizeAgentList(
          (
            queryClient.getQueryData(['operations', 'config']) as
              | (ConfigPayload & { activeProfile?: string })
              | undefined
          )?.parsed?.agents?.list,
        )
      ).find((entry) => entry.id === input.agentId)
      const isHermes = !agent || agent.runtime === 'hermes'
      // Persist model + system prompt + display_name to the profile's config.yaml
      // so they survive across machines / clients. Managed agents keep local meta only.
      if (isHermes) {
        const patch: Record<string, unknown> = {}
        if (input.model.trim()) patch.model = input.model.trim()
        if (input.systemPrompt.trim())
          patch.system_prompt = input.systemPrompt.trim()
        if (input.name.trim()) patch.display_name = input.name.trim()
        if (Object.keys(patch).length > 0) {
          await updateClaudeProfile(input.agentId, patch)
        }
      }
      // Registry fields (role / specialty / command / args / display name) live in
      // agents.yaml via /api/agent-registry. default is system-managed.
      if (input.agentId !== 'default') {
        const registryPatch: Record<string, unknown> = {
          name: input.name.trim() || input.agentId,
          role: input.role?.trim() || 'Worker',
          specialty: input.specialty?.trim() || '',
        }
        if (!isHermes) {
          registryPatch.command = input.command?.trim() || undefined
          registryPatch.args = input.args?.trim() || ''
        }
        const response = await fetch('/api/agent-registry', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agentId: input.agentId,
            patch: registryPatch,
          }),
        })
        const payload = (await response.json().catch(() => ({}))) as {
          ok?: boolean
          error?: string
        }
        if (!response.ok || payload.ok === false) {
          throw new Error(
            payload.error || `Failed to update registry (${response.status})`,
          )
        }
      }
      const currentMeta = loadAgentMeta(input.agentId)
      persistAgentMeta(input.agentId, {
        ...currentMeta,
        emoji: input.emoji.trim() || currentMeta.emoji,
        systemPrompt: input.systemPrompt.trim(),
        description: input.description?.trim() ?? currentMeta.description,
      })
      setMetaVersion((value) => value + 1)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['operations', 'config'],
      })
      toast('Agent settings saved', { type: 'success' })
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Failed to save agent', {
        type: 'error',
      })
    },
  })

  const deleteAgentMutation = useMutation({
    mutationFn: async (agentId: string) => {
      if (agentId === 'default') {
        throw new Error('Cannot delete the default profile')
      }
      const agent = (
        normalizeAgentList(
          (
            queryClient.getQueryData(['operations', 'config']) as
              | (ConfigPayload & { activeProfile?: string })
              | undefined
          )?.parsed?.agents?.list,
        )
      ).find((entry) => entry.id === agentId)
      if (agent && agent.runtime !== 'hermes') {
        const response = await fetch('/api/agent-registry', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId }),
        })
        const payload = (await response.json().catch(() => ({}))) as {
          ok?: boolean
          error?: string
        }
        if (!response.ok || payload.ok === false) {
          throw new Error(
            payload.error || `Failed to remove agent (${response.status})`,
          )
        }
      } else {
        await deleteClaudeProfile(agentId)
      }
      removeAgentMeta(agentId)
      setMetaVersion((value) => value + 1)
      setSelectedAgentId((current) => (current === agentId ? null : current))
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['operations', 'config'],
      })
      await queryClient.invalidateQueries({
        queryKey: ['operations', 'sessions'],
      })
      toast('Agent deleted', { type: 'success' })
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Failed to delete agent', {
        type: 'error',
      })
    },
  })

  function saveAgentMeta(
    agentId: string,
    partial: Partial<OperationsAgentMeta>,
  ) {
    const nextMeta = { ...loadAgentMeta(agentId), ...partial }
    persistAgentMeta(agentId, nextMeta)
    setMetaVersion((value) => value + 1)
  }

  const toggleSkillMutation = useMutation({
    mutationFn: async (input: {
      profile: string
      name: string
      skillId?: string
      enabled: boolean
    }) => {
      const skillKey = input.skillId || input.name
      const response = await fetch(
        `/api/agents/${encodeURIComponent(input.profile)}/skills/${encodeURIComponent(skillKey)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: input.enabled }),
        },
      )
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string
      }
      if (!response.ok) {
        throw new Error(
          payload.error || `Failed to toggle skill (${response.status})`,
        )
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['operations', 'capabilities'],
      })
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Failed to toggle skill', {
        type: 'error',
      })
    },
  })

  const toggleMcpMutation = useMutation({
    mutationFn: async (input: {
      profile: string
      server: string
      enabled: boolean
      serverId?: string
    }) => {
      if (input.serverId) {
        const response = await fetch(
          `/api/agents/${encodeURIComponent(input.profile)}/mcp/${encodeURIComponent(input.serverId)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: input.enabled }),
          },
        )
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        if (!response.ok) {
          throw new Error(
            payload.error || `Failed to toggle MCP (${response.status})`,
          )
        }
        return
      }
      const response = await fetch('/api/profiles/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: input.profile,
          action: 'toggle',
          server: input.server,
          enabled: input.enabled,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(
          payload.error || `Failed to toggle MCP (${response.status})`,
        )
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['operations', 'capabilities'],
      })
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Failed to toggle MCP', {
        type: 'error',
      })
    },
  })

  const removeMcpMutation = useMutation({
    mutationFn: async (input: {
      profile: string
      server: string
      serverId?: string
    }) => {
      if (input.serverId) {
        const response = await fetch(
          `/api/agents/${encodeURIComponent(input.profile)}/mcp/${encodeURIComponent(input.serverId)}`,
          { method: 'DELETE' },
        )
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        if (!response.ok) {
          throw new Error(
            payload.error || `Failed to remove MCP (${response.status})`,
          )
        }
        return
      }
      const response = await fetch('/api/profiles/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: input.profile,
          action: 'remove',
          server: input.server,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(
          payload.error || `Failed to remove MCP (${response.status})`,
        )
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['operations', 'capabilities'],
      })
      toast('MCP server removed', { type: 'success' })
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Failed to remove MCP', {
        type: 'error',
      })
    },
  })

  function saveSettings(nextSettings: OperationsSettings) {
    setSettings(nextSettings)
    persistSettings(nextSettings)
    toast('Operations settings saved', { type: 'success' })
  }

  return {
    agents,
    selectedAgent,
    selectedAgentId,
    setSelectedAgent: setSelectedAgentId,
    configQuery,
    sessionsQuery,
    cronJobsQuery,
    capabilitiesQuery,
    snapshotQuery,
    crewUsageQuery,
    enableUsagePolling,
    healthSummary: snapshotQuery.data?.health ?? null,
    recentActivity,
    settings,
    saveSettings,
    defaultModel:
      readString(configQuery.data?.parsed?.defaultModel) ||
      settings.defaultModel,
    createAgent: createAgentMutation.mutateAsync,
    isCreatingAgent: createAgentMutation.isPending,
    saveAgent: saveAgentMutation.mutateAsync,
    isSavingAgent: saveAgentMutation.isPending,
    deleteAgent: deleteAgentMutation.mutateAsync,
    isDeletingAgent: deleteAgentMutation.isPending,
    activateAgent: activateAgentMutation.mutateAsync,
    isActivatingAgent: activateAgentMutation.isPending,
    renameAgent: renameAgentMutation.mutateAsync,
    isRenamingAgent: renameAgentMutation.isPending,
    saveAgentMeta,
    toggleSkill: toggleSkillMutation.mutateAsync,
    isTogglingSkill: toggleSkillMutation.isPending,
    toggleMcp: toggleMcpMutation.mutateAsync,
    isTogglingMcp: toggleMcpMutation.isPending,
    removeMcp: removeMcpMutation.mutateAsync,
    isRemovingMcp: removeMcpMutation.isPending,
    refreshAll: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['operations', 'config'] }),
        queryClient.invalidateQueries({ queryKey: ['operations', 'sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['operations', 'cron'] }),
        queryClient.invalidateQueries({
          queryKey: ['operations', 'capabilities'],
        }),
        queryClient.invalidateQueries({
          queryKey: AGENTS_SNAPSHOT_QUERY_KEY,
        }),
        queryClient.invalidateQueries({
          queryKey: ['operations', 'crew-status'],
        }),
      ])
    },
    slugifyJobLabel,
  }
}
