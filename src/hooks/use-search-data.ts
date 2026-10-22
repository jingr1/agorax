/**
 * Phase 3.2: Real data for global search
 * Fetches sessions, files, and activity from existing sources
 */
import { useQuery } from '@tanstack/react-query'
import { useActiveWorkspace } from '@/hooks/use-active-workspace'
// import type { ActivityEvent } from '@/types/activity-event'
// Activity events disabled in search — SSE connection caused freezing
// import { useActivityEvents } from '@/screens/activity/use-activity-events'
import { useFeatureAvailable } from '@/hooks/use-feature-available'

const REQUEST_TIMEOUT_MS = 3_000
const SESSIONS_STALE_TIME_MS = 60_000
const FILES_STALE_TIME_MS = 2 * 60_000
const SKILLS_STALE_TIME_MS = 2 * 60_000
const AGENTS_STALE_TIME_MS = 2 * 60_000
const MISSIONS_STALE_TIME_MS = 2 * 60_000
const SEARCH_QUERY_GC_TIME_MS = 10 * 60_000
const MAX_SEARCH_FILES = 2_500
const SESSION_FTS_STALE_TIME_MS = 15_000

export type SearchSession = {
  id: string
  key: string
  friendlyId: string
  title?: string
  preview?: string
  updatedAt?: number
  source?: string | null
}

export type SearchFile = {
  id: string
  path: string
  name: string
  type: 'file' | 'folder'
}

export type SearchSkill = {
  id: string
  name: string
  description: string
  installed: boolean
}

export type SearchAgent = {
  id: string
  displayName: string
  mentionName: string
  runtime: string
  profile?: string | null
  capabilities?: Array<string>
}

export type SearchMission = {
  id: string
  missionId: string | null
  title: string
  status: string
  currentStage: string | null
  currentAssignee: string | null
}

export type SearchActivity = {
  id: string
  title: string
  detail?: string
  timestamp: number
  level: string
  source?: string
}

type SessionsApiResponse = {
  sessions?: Array<Record<string, unknown>>
}

type FilesApiResponse = {
  entries?: Array<Record<string, unknown>>
}

type SkillsApiResponse = {
  ok?: boolean
  skills?: Array<Record<string, unknown>>
}

type AgentsApiResponse = {
  ok?: boolean
  agents?: Array<Record<string, unknown>>
}

type MissionsApiResponse = {
  ok?: boolean
  missions?: Array<Record<string, unknown>>
  tasks?: Array<Record<string, unknown>>
}

type SessionSearchApiResponse = {
  ok?: boolean
  results?: Array<Record<string, unknown>>
}

type SearchQueryScope =
  | 'all'
  | 'chats'
  | 'files'
  | 'agents'
  | 'missions'
  | 'skills'
  | 'actions'

function withTimeoutSignal(querySignal?: AbortSignal): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  function handleQueryAbort() {
    controller.abort()
  }

  querySignal?.addEventListener('abort', handleQueryAbort, { once: true })

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId)
      querySignal?.removeEventListener('abort', handleQueryAbort)
    },
  }
}

async function fetchJsonWithTimeout<T>(
  input: string,
  querySignal?: AbortSignal,
): Promise<T | null> {
  const { signal, cleanup } = withTimeoutSignal(querySignal)

  try {
    const res = await fetch(input, { signal })
    if (!res.ok) return null
    const json = await res.json().catch(() => null)
    if (!json) return null
    return json as T
  } catch {
    return null
  } finally {
    cleanup()
  }
}

function flattenFileTree(
  entries: Array<Record<string, unknown>>,
  maxEntries: number,
): Array<SearchFile> {
  const flattened: Array<SearchFile> = []
  const stack = [...entries]

  while (stack.length > 0 && flattened.length < maxEntries) {
    const entry = stack.pop()
    if (!entry) continue

    const path = String(entry.path || '')
    const name = String(entry.name || '')
    const type = String(entry.type || 'file')

    if (
      path.length > 0 &&
      name.length > 0 &&
      (type === 'file' || type === 'folder')
    ) {
      flattened.push({
        id: path,
        path,
        name,
        type,
      })
    }

    if (Array.isArray(entry.children)) {
      const children = entry.children as Array<Record<string, unknown>>
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index])
      }
    }
  }

  return flattened
}

async function fetchSessions(
  querySignal?: AbortSignal,
): Promise<Array<SearchSession>> {
  const data = await fetchJsonWithTimeout<SessionsApiResponse>(
    '/api/sessions',
    querySignal,
  )
  if (!data) return []

  const sessions = Array.isArray(data.sessions) ? data.sessions : []

  return sessions.map((session) => {
    const derivedTitle =
      typeof session.derivedTitle === 'string' && session.derivedTitle.trim()
        ? session.derivedTitle.trim()
        : ''
    const friendlyId = String(session.friendlyId || session.key || 'unknown')
    const preview = typeof session.preview === 'string' ? session.preview : ''
    return {
      id: String(session.key || session.friendlyId || 'unknown'),
      key: String(session.key || ''),
      friendlyId,
      // Prefer the API-supplied derived title (chat content) over the
      // raw session id, so user queries like 'github' or 'workflow'
      // actually match what the chat is about.
      title: derivedTitle || friendlyId || 'Untitled',
      preview,
      updatedAt:
        typeof session.updatedAt === 'number'
          ? session.updatedAt
          : typeof session.startedAt === 'number'
            ? session.startedAt
            : Date.now(),
    }
  })
}

async function fetchFiles(
  querySignal?: AbortSignal,
): Promise<Array<SearchFile>> {
  const data = await fetchJsonWithTimeout<FilesApiResponse>(
    '/api/files?action=list&maxDepth=5&maxEntries=2500',
    querySignal,
  )
  if (!data) return []

  const entries = Array.isArray(data.entries) ? data.entries : []
  return flattenFileTree(entries, MAX_SEARCH_FILES)
}

async function fetchSessionSearch(
  query: string,
  querySignal?: AbortSignal,
): Promise<Array<SearchSession>> {
  const normalized = query.trim()
  if (!normalized) return []
  const data = await fetchJsonWithTimeout<SessionSearchApiResponse>(
    `/api/sessions/search?q=${encodeURIComponent(normalized)}&limit=24`,
    querySignal,
  )
  if (!data || data.ok === false) return []
  const results = Array.isArray(data.results) ? data.results : []
  return results.map((entry, index) => {
    const key = String(entry.key || entry.session_id || entry.id || '')
    const friendlyId = String(entry.friendlyId || key || 'unknown')
    return {
      id: String(entry.id || `${key}:${index}`),
      key,
      friendlyId,
      title: String(entry.title || friendlyId || 'Untitled'),
      preview: String(entry.snippet || entry.preview || ''),
      updatedAt:
        typeof entry.updatedAt === 'number'
          ? entry.updatedAt
          : typeof entry.session_started === 'number'
            ? entry.session_started
            : undefined,
      source: typeof entry.source === 'string' ? entry.source : null,
    }
  })
}

async function fetchSkills(
  querySignal?: AbortSignal,
): Promise<Array<SearchSkill>> {
  const data = await fetchJsonWithTimeout<SkillsApiResponse>(
    '/api/platform-skills',
    querySignal,
  )
  if (!data) return []
  if (typeof data.ok === 'boolean' && !data.ok) return []
  const skills = Array.isArray(data.skills) ? data.skills : []

  return skills.slice(0, 120).map((skill: Record<string, unknown>) => {
    const name = String(skill.name || 'Unknown Skill')
    const bound = Number(skill.boundAgentCount ?? 0)
    return {
      id: String(skill.id || name.toLowerCase().replaceAll(' ', '-')),
      name,
      description: String(skill.description || ''),
      // Platform catalog row; treat as installed when bound to ≥1 agent.
      installed: bound > 0 || Boolean(skill.installed),
    }
  })
}

async function fetchAgents(
  querySignal?: AbortSignal,
): Promise<Array<SearchAgent>> {
  const data = await fetchJsonWithTimeout<AgentsApiResponse>(
    '/api/available-agents',
    querySignal,
  )
  if (!data) return []
  if (typeof data.ok === 'boolean' && !data.ok) return []
  const agents = Array.isArray(data.agents) ? data.agents : []

  return agents.map((agent: Record<string, unknown>) => {
    const id = String(agent.id || 'unknown')
    const displayName =
      typeof agent.displayName === 'string' && agent.displayName.trim()
        ? agent.displayName.trim()
        : id
    return {
      id,
      displayName,
      mentionName: String(agent.mentionName || id),
      runtime: String(agent.runtime || 'unknown'),
      profile: typeof agent.profile === 'string' ? agent.profile : null,
      capabilities: Array.isArray(agent.capabilities)
        ? agent.capabilities.filter((c): c is string => typeof c === 'string')
        : undefined,
    }
  })
}

async function fetchMissions(
  querySignal?: AbortSignal,
): Promise<Array<SearchMission>> {
  const data = await fetchJsonWithTimeout<MissionsApiResponse>(
    '/api/missions',
    querySignal,
  )
  if (!data) return []
  if (typeof data.ok === 'boolean' && !data.ok) return []
  const missions = Array.isArray(data.missions)
    ? data.missions
    : Array.isArray(data.tasks)
      ? data.tasks
      : []

  return missions.map((mission: Record<string, unknown>, index: number) => {
    const missionId =
      typeof mission.missionId === 'string' ? mission.missionId : null
    const title =
      typeof mission.title === 'string' && mission.title.trim()
        ? mission.title.trim()
        : 'Untitled Mission'
    return {
      id: String(mission.id || missionId || `mission-${index}`),
      missionId,
      title,
      status: String(mission.status || mission.lane || 'todo'),
      currentStage:
        typeof mission.currentStage === 'string' ? mission.currentStage : null,
      currentAssignee:
        typeof mission.currentAssignee === 'string'
          ? mission.currentAssignee
          : null,
    }
  })
}

export function useSearchData(
  scope: SearchQueryScope,
  query = '',
  enabled = true,
) {
  const sessionsAvailable = useFeatureAvailable('sessions')
  const trimmedQuery = query.trim()
  const workspaceQuery = useActiveWorkspace()
  const workspacePath = workspaceQuery.data?.path ?? ''

  // Sessions
  const sessionsQuery = useQuery({
    queryKey: ['search', 'sessions'],
    queryFn: ({ signal }) => fetchSessions(signal),
    enabled:
      enabled && sessionsAvailable && (scope === 'all' || scope === 'chats'),
    staleTime: SESSIONS_STALE_TIME_MS,
    gcTime: SEARCH_QUERY_GC_TIME_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  const sessionSearchQuery = useQuery({
    queryKey: ['search', 'sessions-fts', trimmedQuery],
    queryFn: ({ signal }) => fetchSessionSearch(trimmedQuery, signal),
    enabled:
      enabled &&
      sessionsAvailable &&
      trimmedQuery.length >= 2 &&
      (scope === 'all' || scope === 'chats'),
    staleTime: SESSION_FTS_STALE_TIME_MS,
    gcTime: SEARCH_QUERY_GC_TIME_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  // Files — deep tree is expensive; only when search UI is open.
  const filesQuery = useQuery({
    queryKey: ['search', 'files', workspacePath],
    queryFn: ({ signal }) => fetchFiles(signal),
    enabled:
      enabled &&
      (scope === 'all' || scope === 'files') &&
      Boolean(workspaceQuery.data),
    staleTime: FILES_STALE_TIME_MS,
    gcTime: SEARCH_QUERY_GC_TIME_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  // Skills — platform catalog (local control plane; no gateway skills probe).
  const skillsQuery = useQuery({
    queryKey: ['search', 'skills'],
    queryFn: ({ signal }) => fetchSkills(signal),
    enabled: enabled && (scope === 'all' || scope === 'skills'),
    staleTime: SKILLS_STALE_TIME_MS,
    gcTime: SEARCH_QUERY_GC_TIME_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  // Agents
  const agentsQuery = useQuery({
    queryKey: ['search', 'agents'],
    queryFn: ({ signal }) => fetchAgents(signal),
    enabled: enabled && (scope === 'all' || scope === 'agents'),
    staleTime: AGENTS_STALE_TIME_MS,
    gcTime: SEARCH_QUERY_GC_TIME_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  // Missions
  const missionsQuery = useQuery({
    queryKey: ['search', 'missions'],
    queryFn: ({ signal }) => fetchMissions(signal),
    enabled: enabled && (scope === 'all' || scope === 'missions'),
    staleTime: MISSIONS_STALE_TIME_MS,
    gcTime: SEARCH_QUERY_GC_TIME_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  // Activity events disabled — SSE to /api/events caused UI freeze
  const activityResults: Array<SearchActivity> = []

  return {
    sessions: sessionsQuery.data || [],
    sessionSearchResults: sessionSearchQuery.data || [],
    files: filesQuery.data || [],
    skills: skillsQuery.data || [],
    agents: agentsQuery.data || [],
    missions: missionsQuery.data || [],
    activity: activityResults,
    isLoading:
      sessionsQuery.isLoading ||
      sessionSearchQuery.isLoading ||
      filesQuery.isLoading ||
      skillsQuery.isLoading ||
      agentsQuery.isLoading ||
      missionsQuery.isLoading,
  }
}

// Client-side filtering
export function filterResults<T extends Record<string, unknown>>(
  items: Array<T>,
  query: string,
  fields: Array<keyof T>,
  maxResults = Number.POSITIVE_INFINITY,
): Array<T> {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    if (!Number.isFinite(maxResults)) return items
    return items.slice(0, Math.max(0, Math.floor(maxResults)))
  }

  const output: Array<T> = []

  for (const item of items) {
    let matched = false
    for (const field of fields) {
      const value = item[field]
      if (typeof value !== 'string') continue
      if (value.toLowerCase().includes(normalizedQuery)) {
        matched = true
        break
      }
    }

    if (!matched) continue
    output.push(item)
    if (output.length >= maxResults) break
  }

  return output
}
