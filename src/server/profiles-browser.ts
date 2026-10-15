import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { parseStoredMessageContent } from '../lib/chat-message-parts'
import { getStateDir } from './workspace-state-dir'

// createRequire is the canonical ESM→CJS bridge. We need it because
// better-sqlite3 / node:sqlite are native modules and Vite runs in ESM mode.
// @ts-ignore -- LSP/tsconfig doesn't include node types but runtime has it
import { createRequire as _createRequire } from 'node:module'
const nodeRequire = _createRequire(import.meta.url)

let profileSqliteFallbackWarned = false

export type ProfileSummary = {
  name: string
  path: string
  active: boolean
  exists: boolean
  model?: string
  provider?: string
  description?: string
  systemPrompt?: string
  skillCount: number
  mcpCount: number
  sessionCount: number
  hasEnv: boolean
  updatedAt?: string
}

export type ProfileDetail = {
  name: string
  path: string
  active: boolean
  config: Record<string, unknown>
  description: string
  systemPrompt: string
  envPath?: string
  hasEnv: boolean
  sessionsDir?: string
  skillsDir?: string
}

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TEXT_REWRITE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.yaml',
  '.yml',
  '.json',
  '.jsonl',
  '.toml',
  '.env',
  '.plist',
  '.sh',
  '.js',
  '.ts',
  '.tsx',
])

function getHermesRoot(): string {
  // Prefer an explicit root. If HERMES_HOME already points at a profile dir
  // (~/.hermes/profiles/<name>), peel back to the real Hermes root so
  // active_profile + profiles/ listing still work.
  const raw =
    process.env.HERMES_HOME ??
    path.join(os.homedir(), '.hermes')
  const normalized = path.resolve(raw)
  const marker = `${path.sep}profiles${path.sep}`
  const idx = normalized.lastIndexOf(marker)
  if (idx >= 0) {
    return normalized.slice(0, idx)
  }
  return normalized
}

export function getProfilesRoot(): string {
  return path.join(getHermesRoot(), 'profiles')
}

/** Absolute HERMES_HOME path for a profile (`default` → Hermes root). */
export function resolveProfileHermesHome(name: string): string {
  const trimmed = (name || 'default').trim() || 'default'
  if (trimmed === 'default') return getHermesRoot()
  return path.join(getProfilesRoot(), trimmed)
}

/**
 * Hermes tombstone path (`profiles/.deleted/<name>`). Lives beside the profile
 * dir so a stale gateway mkdir cannot erase it after delete.
 */
export function profileTombstonePath(name: string): string {
  return path.join(getProfilesRoot(), '.deleted', name.trim())
}

/** True when `hermes profile delete` (or workspace delete) tombstoned this name. */
export function isNamedProfileDeleted(name: string): boolean {
  const trimmed = (name || '').trim()
  if (!trimmed || trimmed === 'default') return false
  return fs.existsSync(profileTombstonePath(trimmed))
}

export function markNamedProfileDeleted(name: string): void {
  const trimmed = validateProfileName(name)
  const marker = profileTombstonePath(trimmed)
  fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 })
  fs.writeFileSync(marker, 'deleted\n', 'utf-8')
}

export function clearNamedProfileDeleted(name: string): void {
  const trimmed = (name || '').trim()
  if (!trimmed || trimmed === 'default') return
  const marker = profileTombstonePath(trimmed)
  if (fs.existsSync(marker)) fs.unlinkSync(marker)
}

/** Live named profile = on-disk directory and not tombstoned. */
export function isLiveNamedProfile(name: string): boolean {
  const trimmed = (name || '').trim()
  if (!trimmed || trimmed === 'default') return true
  if (isNamedProfileDeleted(trimmed)) return false
  return fs.existsSync(resolveProfileHermesHome(trimmed))
}

function getActiveProfilePath(): string {
  return path.join(getHermesRoot(), 'active_profile')
}

/**
 * Opt-in only: also mirror Workspace selection into Hermes sticky
 * `~/.hermes/active_profile` (CLI default). Default is off so 1:1 / pool
 * switches do not stomp the machine-global sticky pointer.
 */
function stickyActiveProfileEnabled(): boolean {
  return process.env.AGORAX_STICKY_PROFILE === '1'
}

function clearStickyActiveProfile(): void {
  const activePath = getActiveProfilePath()
  if (fs.existsSync(activePath)) fs.unlinkSync(activePath)
}

/** Workspace-owned selection — not Hermes sticky. Lives under getStateDir(). */
function getSelectedProfilePath(): string {
  return path.join(getStateDir(), 'selected_profile')
}

function readSelectedProfileName(): string | null {
  const selectedPath = getSelectedProfilePath()
  if (!fs.existsSync(selectedPath)) return null
  try {
    const raw = safeReadText(selectedPath).trim()
    return raw || null
  } catch {
    return null
  }
}

function writeSelectedProfileName(name: string): void {
  const selectedPath = getSelectedProfilePath()
  fs.mkdirSync(path.dirname(selectedPath), { recursive: true })
  fs.writeFileSync(selectedPath, `${name}\n`, 'utf-8')
}

function clearSelectedProfileName(): void {
  const selectedPath = getSelectedProfilePath()
  if (fs.existsSync(selectedPath)) fs.unlinkSync(selectedPath)
}

function readStickyActiveProfileName(): string | null {
  const activePath = getActiveProfilePath()
  if (!fs.existsSync(activePath)) return null
  try {
    const raw = safeReadText(activePath).trim()
    return raw || null
  } catch {
    return null
  }
}

/**
 * Validate a profile name that will be *written* to disk. The 'default'
 * profile is reserved — callers must not create or mutate it via the UI.
 */
function validateProfileName(name: string): string {
  const trimmed = validateProfileIdentifier(name)
  if (trimmed === 'default')
    throw new Error('Default profile cannot be modified here')
  return trimmed
}

/**
 * Validate a profile name that will only be *read* (e.g. `cloneFrom` source).
 * Any existing profile name is allowed, including 'default'.
 */
function validateProfileIdentifier(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Profile name is required')
  if (
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..')
  ) {
    throw new Error('Invalid profile name')
  }
  return trimmed
}

function safeReadText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

function readYamlConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {}
  try {
    const parsed = YAML.parse(safeReadText(configPath)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function countMcpServers(config: Record<string, unknown>): number {
  const servers = config.mcp_servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers))
    return 0
  return Object.keys(servers).filter((key) => {
    const entry = (servers as Record<string, unknown>)[key]
    return entry !== null && entry !== undefined
  }).length
}

const countCache = new Map<string, { count: number; expiresAt: number }>()
const COUNT_CACHE_TTL_MS = 30_000

function countFilesRecursive(
  rootPath: string,
  predicate: (fullPath: string) => boolean,
): number {
  if (!fs.existsSync(rootPath)) return 0
  const cacheKey = rootPath
  const cached = countCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.count

  let count = 0
  const stack = [rootPath]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: Array<fs.Dirent> = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (predicate(fullPath)) count += 1
    }
  }
  countCache.set(cacheKey, {
    count,
    expiresAt: Date.now() + COUNT_CACHE_TTL_MS,
  })
  return count
}

function latestMtime(paths: Array<string>): string | undefined {
  let latest = 0
  for (const target of paths) {
    if (!fs.existsSync(target)) continue
    try {
      const stat = fs.statSync(target)
      latest = Math.max(latest, stat.mtimeMs)
    } catch {
      // ignore
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : undefined
}

function extractDescription(config: Record<string, unknown>): string {
  const direct = config.description
  if (typeof direct === 'string') return direct.trim()

  const metadata = config.metadata
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const nested = (metadata as Record<string, unknown>).description
    if (typeof nested === 'string') return nested.trim()
  }

  return ''
}

function extractSystemPrompt(
  config: Record<string, unknown>,
  profilePath: string,
): string {
  const configured = config.system_prompt
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim()
  }

  const soulPath = path.join(profilePath, 'SOUL.md')
  if (!fs.existsSync(soulPath)) return ''

  try {
    return safeReadText(soulPath).trim()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Dashboard API fallback for split-host deployments
// ---------------------------------------------------------------------------

function getDashboardUrl(): string | undefined {
  const url = process.env.HERMES_DASHBOARD_URL?.trim()
  return url || undefined
}

function getDashboardToken(): string | undefined {
  return (
    process.env.HERMES_API_TOKEN?.trim() ||
    process.env.CLAUDE_API_TOKEN?.trim() ||
    process.env.CLAUDE_DASHBOARD_TOKEN?.trim() ||
    undefined
  )
}

async function fetchDashboardProfiles(): Promise<{
  profiles: Array<ProfileSummary>
  activeProfile: string
} | null> {
  const dashboardUrl = getDashboardUrl()
  if (!dashboardUrl) return null

  try {
    const token = getDashboardToken()
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`

    const response = await fetch(`${dashboardUrl}/api/profiles`, {
      headers,
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return null

    const data = (await response.json()) as {
      profiles?: Array<{
        name: string
        model?: string
        provider?: string
        description?: string
        is_default?: boolean
        skill_count?: number
        session_count?: number
        has_env?: boolean
        updated_at?: string
      }>
    }

    if (!data.profiles || !Array.isArray(data.profiles)) return null

    const activeProfile =
      data.profiles.find((p) => p.is_default)?.name || 'default'

    const profiles: Array<ProfileSummary> = data.profiles.map((p) => ({
      name: p.name,
      path: p.is_default
        ? getHermesRoot()
        : path.join(getProfilesRoot(), p.name),
      active: p.name === activeProfile,
      exists: true,
      model: p.model,
      provider: p.provider,
      description: p.description,
      skillCount: p.skill_count ?? 0,
      mcpCount: 0,
      sessionCount: p.session_count ?? 0,
      hasEnv: p.has_env ?? false,
      updatedAt: p.updated_at,
    }))

    profiles.sort((a, b) => {
      if (a.active && !b.active) return -1
      if (!a.active && b.active) return 1
      return Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || '')
    })

    return { profiles, activeProfile }
  } catch (error) {
    // Dashboard unreachable or returned unexpected data — fall back to filesystem
    return null
  }
}

/**
 * List profiles with dashboard API fallback for split-host deployments.
 * When HERMES_DASHBOARD_URL is set and reachable, fetches from the dashboard
 * API. Falls back to filesystem reads for colocated deployments.
 */
function isLoopbackDashboardUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      host === '[::1]'
    )
  } catch {
    return false
  }
}

export async function listProfilesWithFallback(): Promise<{
  profiles: Array<ProfileSummary>
  activeProfile: string
}> {
  // Local pool deployments already have the profiles on disk. Hitting a
  // loopback dashboard first adds a multi-second timeout on every switch.
  const dashboardUrl = getDashboardUrl()
  if (dashboardUrl && !isLoopbackDashboardUrl(dashboardUrl)) {
    const dashboardResult = await fetchDashboardProfiles()
    if (dashboardResult) return dashboardResult
  }

  return {
    profiles: listProfiles(),
    activeProfile: getActiveProfileName(),
  }
}

/**
 * Read a single profile with dashboard API fallback for split-host deployments.
 */
export async function readProfileWithFallback(
  name: string,
): Promise<ProfileDetail> {
  // Try filesystem first (fast path for colocated deployments)
  const normalized = name.trim() || 'default'
  const profilePath =
    normalized === 'default'
      ? getHermesRoot()
      : path.join(getProfilesRoot(), validateProfileIdentifier(normalized))

  if (fs.existsSync(profilePath)) {
    return readProfile(normalized)
  }

  // Filesystem miss — try dashboard API for split-host deployments
  const dashboardUrl = getDashboardUrl()
  if (dashboardUrl) {
    try {
      const token = getDashboardToken()
      const headers: Record<string, string> = {}
      if (token) headers['Authorization'] = `Bearer ${token}`

      const response = await fetch(`${dashboardUrl}/api/profiles`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) {
        const data = (await response.json()) as {
          profiles?: Array<{
            name: string
            model?: string
            provider?: string
            description?: string
            is_default?: boolean
          }>
        }
        const match = data.profiles?.find(
          (p) =>
            p.name === normalized || (normalized === 'default' && p.is_default),
        )
        if (match) {
          const active = getActiveProfileName()
          return {
            name: match.name,
            path: match.is_default
              ? getHermesRoot()
              : path.join(getProfilesRoot(), match.name),
            active: match.name === active,
            config: {
              ...(match.model ? { model: match.model } : {}),
              ...(match.provider ? { provider: match.provider } : {}),
            },
            description: match.description || '',
            systemPrompt: '',
            hasEnv: false,
          }
        }
      }
    } catch {
      // Dashboard unreachable — fall through to error
    }
  }

  throw new Error('Profile not found')
}

function profileStateDbPath(name: string): string {
  const normalized = name.trim() || 'default'
  return normalized === 'default'
    ? path.join(getHermesRoot(), 'state.db')
    : path.join(getProfilesRoot(), normalized, 'state.db')
}

function openProfileStateDb(dbPath: string): {
  prepare: (sql: string) => {
    all: (...params: Array<unknown>) => Array<Record<string, unknown>>
  }
  close: () => void
} | null {
  if (!fs.existsSync(dbPath)) return null
  try {
    let Database: new (
      path: string,
      opts?: Record<string, unknown>,
    ) => {
      prepare: (sql: string) => {
        all: (...params: Array<unknown>) => Array<Record<string, unknown>>
      }
      close: () => void
    }
    let opts: Record<string, unknown> = { readonly: true }
    try {
      Database = nodeRequire('better-sqlite3')
    } catch (error) {
      Database = nodeRequire('node:sqlite').DatabaseSync
      opts = { readOnly: true }
      if (!profileSqliteFallbackWarned) {
        profileSqliteFallbackWarned = true
        console.warn(
          '[profiles] better-sqlite3 unavailable; falling back to experimental node:sqlite' +
            ` (${error instanceof Error ? error.message : String(error)}).` +
            ' Install better-sqlite3 for the supported local profile DB path.',
        )
      }
    }
    return new Database(dbPath, opts)
  } catch {
    return null
  }
}

export function listSessionsForProfile(name: string): Array<{
  key: string
  friendlyId: string
  updatedAt: number
  source: string
  title?: string | null
  messageCount?: number
  model?: string | null
}> {
  const normalized = name.trim() || 'default'
  const db = openProfileStateDb(profileStateDbPath(normalized))
  if (!db) return []

  try {
    const stmt = db.prepare(
      `SELECT id, title, model, started_at, message_count
       FROM sessions
       WHERE archived = 0 OR archived IS NULL
       ORDER BY started_at DESC
       LIMIT 100`,
    )
    const results = stmt.all()
    return results.map((r: Record<string, unknown>) => ({
      key: String(r.id ?? ''),
      friendlyId: String(r.id ?? ''),
      updatedAt: typeof r.started_at === 'number' ? r.started_at * 1000 : 0,
      source: `profile:${normalized}`,
      title: (r.title as string) || null,
      messageCount: typeof r.message_count === 'number' ? r.message_count : 0,
      model: (r.model as string) || null,
    }))
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      // ignore
    }
  }
}

/** Read session messages from a profile's local state.db — no gateway probe. */
export function getMessagesForProfile(
  name: string,
  sessionId: string,
  limit = 1000,
): Array<{
  id: string
  session_id: string
  role: string
  /** Preserves structured content blocks (incl. thinking) for toChatMessage. */
  content: string | Array<Record<string, unknown>>
  timestamp: number
  tool_calls?: unknown
  tool_call_id?: string
  tool_name?: string
}> | null {
  const sid = sessionId.trim()
  if (!sid || sid === 'new' || sid === 'main') return null
  const db = openProfileStateDb(profileStateDbPath(name))
  if (!db) return null

  try {
    const stmt = db.prepare(
      `SELECT id, session_id, role, content, tool_calls, tool_call_id, tool_name, timestamp
       FROM messages
       WHERE session_id = ?
       ORDER BY timestamp DESC, id DESC
       LIMIT ?`,
    )
    const rows = stmt.all(sid, limit)
    return [...rows].reverse().map((r) => ({
      id: String(r.id ?? ''),
      session_id: String(r.session_id ?? sid),
      role: String(r.role ?? 'assistant'),
      // Keep thinking blocks; toChatMessage normalizes via chat-message-parts.
      content: parseStoredMessageContent(r.content),
      timestamp:
        typeof r.timestamp === 'number'
          ? r.timestamp
          : Number(r.timestamp) || 0,
      tool_calls: r.tool_calls,
      tool_call_id:
        typeof r.tool_call_id === 'string' ? r.tool_call_id : undefined,
      tool_name: typeof r.tool_name === 'string' ? r.tool_name : undefined,
    }))
  } catch {
    return null
  } finally {
    try {
      db.close()
    } catch {
      // ignore
    }
  }
}

/**
 * Workspace "current profile" for UI + control-plane APIs.
 * Reads `~/.hermes/workspace/selected_profile` only — never Hermes sticky.
 * Missing / invalid selection → `default`.
 */
export function getActiveProfileName(): string {
  const selected = readSelectedProfileName()
  if (selected) {
    if (selected === 'default' || isLiveNamedProfile(selected)) return selected
    try {
      clearSelectedProfileName()
    } catch {
      /* ignore */
    }
  }
  return 'default'
}

export function readModelProviderFromConfig(config: Record<string, unknown>): {
  model: string
  provider: string
} {
  let model = ''
  let provider = ''
  if (typeof config.model === 'string') {
    model = config.model.trim()
  } else if (
    config.model &&
    typeof config.model === 'object' &&
    !Array.isArray(config.model)
  ) {
    const nested = config.model as Record<string, unknown>
    if (typeof nested.default === 'string') model = nested.default.trim()
    if (typeof nested.provider === 'string') provider = nested.provider.trim()
  }
  if (!provider && typeof config.provider === 'string') {
    provider = config.provider.trim()
  }
  return { model, provider }
}

export function applyModelProviderToConfig(
  config: Record<string, unknown>,
  providerId: string,
  modelId: string,
): void {
  config.provider = providerId
  const existing = config.model
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const next = { ...(existing as Record<string, unknown>) }
    next.default = modelId
    next.provider = providerId
    config.model = next
    return
  }
  config.model = modelId
}

function profileConfigPath(name: string): {
  normalized: string
  profilePath: string
  configPath: string
} {
  const normalized = name.trim() || 'default'
  const profilePath =
    normalized === 'default'
      ? getHermesRoot()
      : path.join(getProfilesRoot(), validateProfileName(normalized))
  return {
    normalized,
    profilePath,
    configPath: path.join(profilePath, 'config.yaml'),
  }
}

export function updateProfileModelProvider(
  name: string,
  providerId: string,
  modelId: string,
): ProfileDetail {
  const { normalized, profilePath, configPath } = profileConfigPath(name)
  if (!fs.existsSync(profilePath)) throw new Error('Profile not found')
  const current = readYamlConfig(configPath)
  applyModelProviderToConfig(current, providerId, modelId)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, YAML.stringify(current), 'utf-8')
  return readProfile(normalized)
}

export function updateAllProfilesModelProvider(
  providerId: string,
  modelId: string,
): {
  updated: Array<{ name: string; ok: boolean; error?: string }>
} {
  const updated: Array<{ name: string; ok: boolean; error?: string }> = []
  for (const profile of listProfiles()) {
    try {
      updateProfileModelProvider(profile.name, providerId, modelId)
      updated.push({ name: profile.name, ok: true })
    } catch (error) {
      updated.push({
        name: profile.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { updated }
}

/**
 * Lightweight profile listing — only returns name, active, model, provider.
 * Skips expensive recursive file counts (skills, sessions).
 */
export function listProfilesLight(): Array<ProfileSummary> {
  const profilesRoot = getProfilesRoot()
  const activeProfile = getActiveProfileName()
  const results: Array<ProfileSummary> = []

  if (fs.existsSync(profilesRoot)) {
    let entries: Array<fs.Dirent> = []
    try {
      entries = fs.readdirSync(profilesRoot, { withFileTypes: true })
    } catch {
      entries = []
    }

    for (const entry of entries) {
      const name = entry.name
      if (name === 'default' || name.startsWith('.')) continue
      if (isNamedProfileDeleted(name)) continue
      const profilePath = path.join(profilesRoot, name)
      if (!entry.isDirectory()) {
        if (!entry.isSymbolicLink()) continue
        try {
          if (!fs.statSync(profilePath).isDirectory()) continue
        } catch {
          continue
        }
      }
      const configPath = path.join(profilePath, 'config.yaml')
      const config = readYamlConfig(configPath)
      const { model: modelName, provider: providerName } =
        readModelProviderFromConfig(config)
      results.push({
        name,
        path: profilePath,
        active: name === activeProfile,
        exists: true,
        model: modelName || undefined,
        provider: providerName || undefined,
        skillCount: 0,
        mcpCount: 0,
        sessionCount: 0,
        hasEnv: fs.existsSync(path.join(profilePath, '.env')),
      })
    }
  }

  const root = getHermesRoot()
  const config = readYamlConfig(path.join(root, 'config.yaml'))
  const defaultModelProvider = readModelProviderFromConfig(config)
  results.unshift({
    name: 'default',
    path: root,
    active: activeProfile === 'default',
    exists: true,
    model: defaultModelProvider.model || undefined,
    provider: defaultModelProvider.provider || undefined,
    skillCount: 0,
    mcpCount: 0,
    sessionCount: 0,
    hasEnv: fs.existsSync(path.join(root, '.env')),
  })

  results.sort((a, b) => {
    if (a.active && !b.active) return -1
    if (!a.active && b.active) return 1
    return 0
  })
  return results
}

export function listProfiles(): Array<ProfileSummary> {
  const profilesRoot = getProfilesRoot()
  const activeProfile = getActiveProfileName()
  const results: Array<ProfileSummary> = []

  if (fs.existsSync(profilesRoot)) {
    let entries: Array<fs.Dirent> = []
    try {
      entries = fs.readdirSync(profilesRoot, { withFileTypes: true })
    } catch {
      entries = []
    }

    for (const entry of entries) {
      const name = entry.name
      if (name === 'default' || name.startsWith('.')) continue
      if (isNamedProfileDeleted(name)) continue
      const profilePath = path.join(profilesRoot, name)
      if (!entry.isDirectory()) {
        if (!entry.isSymbolicLink()) continue
        try {
          if (!fs.statSync(profilePath).isDirectory()) continue
        } catch {
          continue
        }
      }
      const configPath = path.join(profilePath, 'config.yaml')
      const envPath = path.join(profilePath, '.env')
      const skillsDir = path.join(profilePath, 'skills')
      const sessionsDir = path.join(profilePath, 'sessions')
      const config = readYamlConfig(configPath)
      const skillCount = countFilesRecursive(
        skillsDir,
        (full) => path.basename(full) === 'SKILL.md',
      )
      const mcpCount = countMcpServers(config)
      const sessionCount = countFilesRecursive(sessionsDir, (full) =>
        /\.(jsonl|json|sqlite|db)$/i.test(full),
      )
      const { model: modelName, provider: providerName } =
        readModelProviderFromConfig(config)
      results.push({
        name,
        path: profilePath,
        active: name === activeProfile,
        exists: true,
        model: modelName || undefined,
        provider: providerName || undefined,
        description: extractDescription(config) || undefined,
        systemPrompt: extractSystemPrompt(config, profilePath) || undefined,
        skillCount,
        mcpCount,
        sessionCount,
        hasEnv: fs.existsSync(envPath),
        updatedAt: latestMtime([
          profilePath,
          configPath,
          envPath,
          skillsDir,
          sessionsDir,
        ]),
      })
    }
  }

  const root = getHermesRoot()
  const config = readYamlConfig(path.join(root, 'config.yaml'))
  const defaultModelProvider = readModelProviderFromConfig(config)
  results.unshift({
    name: 'default',
    path: root,
    active: activeProfile === 'default',
    exists: true,
    model: defaultModelProvider.model || undefined,
    provider: defaultModelProvider.provider || undefined,
    description: extractDescription(config) || undefined,
    systemPrompt: extractSystemPrompt(config, root) || undefined,
    skillCount: countFilesRecursive(
      path.join(root, 'skills'),
      (full) => path.basename(full) === 'SKILL.md',
    ),
    mcpCount: countMcpServers(config),
    sessionCount: countFilesRecursive(path.join(root, 'sessions'), (full) =>
      /\.(jsonl|json|sqlite|db)$/i.test(full),
    ),
    hasEnv: fs.existsSync(path.join(root, '.env')),
    updatedAt: latestMtime([root, path.join(root, 'config.yaml')]),
  })

  results.sort((a, b) => {
    if (a.active && !b.active) return -1
    if (!a.active && b.active) return 1
    return Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || '')
  })
  return results
}

export function readProfile(name: string): ProfileDetail {
  const active = getActiveProfileName()
  const normalized = name.trim() || 'default'
  const profilePath =
    normalized === 'default'
      ? getHermesRoot()
      : path.join(getProfilesRoot(), validateProfileName(normalized))
  if (!fs.existsSync(profilePath)) throw new Error('Profile not found')
  const configPath = path.join(profilePath, 'config.yaml')
  const envPath = path.join(profilePath, '.env')
  const sessionsDir = path.join(profilePath, 'sessions')
  const skillsDir = path.join(profilePath, 'skills')
  const config = readYamlConfig(configPath)
  return {
    name: normalized,
    path: profilePath,
    active: normalized === active,
    config,
    description: extractDescription(config),
    systemPrompt: extractSystemPrompt(config, profilePath),
    envPath: fs.existsSync(envPath) ? envPath : undefined,
    hasEnv: fs.existsSync(envPath),
    sessionsDir: fs.existsSync(sessionsDir) ? sessionsDir : undefined,
    skillsDir: fs.existsSync(skillsDir) ? skillsDir : undefined,
  }
}

/**
 * Select the Workspace UI / control-plane profile.
 * Always updates workspace `selected_profile`. Hermes sticky is untouched
 * unless `AGORAX_STICKY_PROFILE=1`.
 */
export function setActiveProfile(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Profile name is required')
  const normalized =
    trimmed === 'default' ? 'default' : validateProfileName(trimmed)
  if (normalized !== 'default' && !isLiveNamedProfile(normalized)) {
    throw new Error(`Profile not found: ${normalized}`)
  }
  writeSelectedProfileName(normalized)
  if (!stickyActiveProfileEnabled()) return
  if (normalized === 'default') {
    clearStickyActiveProfile()
    return
  }
  fs.mkdirSync(getHermesRoot(), { recursive: true })
  fs.writeFileSync(getActiveProfilePath(), `${normalized}\n`, 'utf-8')
}

export function createProfile(
  name: string,
  options?: { cloneFrom?: string; model?: string; provider?: string },
): ProfileDetail {
  const normalized = validateProfileName(name)
  const profilePath = path.join(getProfilesRoot(), normalized)
  // Allow replacing an empty shell left after delete when a tombstone exists
  // (Hermes create_profile does the same). Refuse a live profile.
  if (fs.existsSync(profilePath) && !isNamedProfileDeleted(normalized)) {
    throw new Error('Profile already exists')
  }
  if (isNamedProfileDeleted(normalized) && fs.existsSync(profilePath)) {
    const hasIdentity =
      fs.existsSync(path.join(profilePath, 'config.yaml')) ||
      fs.existsSync(path.join(profilePath, '.env'))
    if (hasIdentity) throw new Error('Profile already exists')
    fs.rmSync(profilePath, { recursive: true, force: true })
  }
  clearNamedProfileDeleted(normalized)
  fs.mkdirSync(profilePath, { recursive: true })

  const configPath = path.join(profilePath, 'config.yaml')

  // Clone config from source profile if specified
  if (options?.cloneFrom) {
    const sourceName = validateProfileIdentifier(options.cloneFrom)
    // The 'default' profile lives at ~/.hermes, not ~/.hermes/profiles/default
    const sourceRoot =
      sourceName === 'default'
        ? getHermesRoot()
        : path.join(getProfilesRoot(), sourceName)
    const sourceConfigPath = path.join(sourceRoot, 'config.yaml')
    if (fs.existsSync(sourceConfigPath)) {
      fs.copyFileSync(sourceConfigPath, configPath)
    } else {
      fs.writeFileSync(
        configPath,
        YAML.stringify({ model: '', provider: '' }),
        'utf-8',
      )
    }
  } else {
    fs.writeFileSync(
      configPath,
      YAML.stringify({ model: '', provider: '' }),
      'utf-8',
    )
  }

  // Override model/provider if specified
  if (options?.model || options?.provider) {
    const config = readYamlConfig(configPath)
    if (options.model) config.model = options.model
    if (options.provider) config.provider = options.provider
    fs.writeFileSync(configPath, YAML.stringify(config), 'utf-8')
  }

  // Create subdirectories
  fs.mkdirSync(path.join(profilePath, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(profilePath, 'sessions'), { recursive: true })

  return readProfile(normalized)
}

export function deleteProfile(name: string): void {
  const normalized = validateProfileName(name)
  const profilePath = path.join(getProfilesRoot(), normalized)
  if (!fs.existsSync(profilePath) && !isNamedProfileDeleted(normalized)) {
    throw new Error('Profile not found')
  }

  // Active selection would make the next ensureActiveProfileGateway
  // respawn this profile and recreate the directory — clear it first.
  if (getActiveProfileName() === normalized) {
    setActiveProfile('default')
  }

  // Stop the live gateway before rmtree; a dying process writing
  // .clean_shutdown / logs will otherwise resurrect an empty shell.
  try {
    // Lazy require avoids a circular dependency with hermes-agent → profiles-browser.
    const { stopProfileGateway } = nodeRequire(
      './hermes-agent',
    ) as typeof import('./hermes-agent')
    stopProfileGateway(normalized)
  } catch {
    /* best-effort */
  }

  // Tombstone before remove so concurrent mkdir/list cannot relist this name.
  markNamedProfileDeleted(normalized)

  if (fs.existsSync(profilePath)) {
    const trashDir = path.join(getHermesRoot(), 'trash')
    fs.mkdirSync(trashDir, { recursive: true })
    const trashName = `${normalized}-${Date.now()}`
    try {
      fs.renameSync(profilePath, path.join(trashDir, trashName))
    } catch {
      fs.rmSync(profilePath, { recursive: true, force: true })
    }
  }
}

export function updateProfileConfig(
  name: string,
  patch: Record<string, unknown>,
): ProfileDetail {
  const normalized = name.trim() || 'default'
  const profilePath =
    normalized === 'default'
      ? getHermesRoot()
      : path.join(getProfilesRoot(), validateProfileName(normalized))
  if (!fs.existsSync(profilePath)) throw new Error('Profile not found')
  const configPath = path.join(profilePath, 'config.yaml')
  const current = readYamlConfig(configPath)

  // Deep merge helper (same deep-merge as hermes-config-route)
  function deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ) {
    for (const [key, value] of Object.entries(source)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        target[key] &&
        typeof target[key] === 'object'
      ) {
        deepMerge(
          target[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        )
      } else {
        target[key] = value
      }
    }
  }

  // Handle null values as explicit removals
  const updates = { ...patch }
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      delete current[key]
      delete updates[key]
    }
  }
  deepMerge(current, updates)

  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, YAML.stringify(current), 'utf-8')
  return readProfile(normalized)
}

export function renameProfile(oldName: string, newName: string): ProfileDetail {
  const from = validateProfileName(oldName)
  const to = validateProfileName(newName)
  const fromPath = path.join(getProfilesRoot(), from)
  const toPath = path.join(getProfilesRoot(), to)
  if (!fs.existsSync(fromPath)) throw new Error('Profile not found')
  if (fs.existsSync(toPath)) throw new Error('Target profile already exists')
  fs.renameSync(fromPath, toPath)
  if (readSelectedProfileName() === from) {
    writeSelectedProfileName(to)
  }
  if (stickyActiveProfileEnabled() && readStickyActiveProfileName() === from) {
    fs.writeFileSync(getActiveProfilePath(), `${to}\n`, 'utf-8')
  }
  return readProfile(to)
}
