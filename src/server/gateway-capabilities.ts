/**
 * Probes Hermes services to detect which API groups are available.
 *
 * Control-plane refactored architecture:
 *   - Control plane: local profile directory (config.yaml, skills/, state.db,
 *     cron/, MEMORY.md). No dependency on :9119.
 *   - Runtime: current profile gateway (:8642 by default) for chat, models,
 *     live MCP, and job execution.
 *   - Dashboard (:9119): optional outbound link only. Not an ability gate.
 *
 * Legacy enhanced-fork compatibility remains for users still running the
 * older all-in-one web API on the gateway port.
 *
 * Precedence for gateway URLs:
 *   1. Runtime override saved via setGatewayUrl()
 *      (persisted to ~/.hermes/workspace-overrides.json) — set from the UI
 *      so remote / Tailscale users can relocate without a restart (#101).
 *   2. process.env.HERMES_API_URL at process start.
 *   3. Default localhost (8642).
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getStateDir } from './workspace-state-dir'
import { resolveProfileHermesHome, getActiveProfileName } from './profiles-browser'
import { normalizeMcpList } from './mcp-normalize'
import { isGatewayPoolEnabled } from './gateway-ports'

type WorkspaceOverrides = {
  claudeApiUrl?: string
  claudeDashboardUrl?: string
}

function overridesPath(): string {
  return path.join(getStateDir(), 'workspace-overrides.json')
}

function readOverrides(): WorkspaceOverrides {
  try {
    const raw = fs.readFileSync(overridesPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as WorkspaceOverrides)
      : {}
  } catch {
    return {}
  }
}

function writeOverrides(next: WorkspaceOverrides): void {
  const file = overridesPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify(next, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } catch {
    console.warn(`[gateway] failed to persist workspace overrides to ${file}`)
  }
}

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, '')
}

const _initialOverrides = readOverrides()

export let HERMES_API = normalizeUrl(
  _initialOverrides.claudeApiUrl ||
    process.env.HERMES_API_URL ||
    'http://127.0.0.1:8642',
)
export let CLAUDE_DASHBOARD_URL = normalizeUrl(
  _initialOverrides.claudeDashboardUrl ||
    process.env.HERMES_DASHBOARD_URL ||
    process.env.CLAUDE_DASHBOARD_URL ||
    'http://127.0.0.1:9119',
)

/**
 * Point in-memory chat/session traffic at a profile gateway without persisting
 * Settings → Connection. Profile switch must not overwrite Tailscale/LAN pairing.
 */
export function applyProfileGatewayRoute(url: string): string {
  const normalized = normalizeUrl(url)
  if (!normalized) return HERMES_API
  getGatewayBearerToken()
  if (normalized === HERMES_API) return HERMES_API
  HERMES_API = normalized
  if (restoreCachedCapabilities(normalized)) {
    probePromise = null
    console.log(
      `[gateway] Routed active profile to ${HERMES_API} (cached capabilities)`,
    )
    return HERMES_API
  }
  probePromise = null
  lastProbeAt = 0
  console.log(`[gateway] Routed active profile to ${HERMES_API}`)
  return HERMES_API
}

/**
 * Update the gateway URL at runtime, persist it, and reset the probe cache
 * so the next call to ensureGatewayProbed() re-detects capabilities.
 * Returns the saved URL (normalized). Pass an empty string to clear the
 * override and fall back to env/default.
 */
export function setGatewayUrl(input: string | null | undefined): string {
  const normalized = input ? normalizeUrl(input) : ''
  const overrides = readOverrides()
  if (normalized) {
    overrides.claudeApiUrl = normalized
    HERMES_API = normalized
  } else {
    delete overrides.claudeApiUrl
    HERMES_API = normalizeUrl(
      process.env.HERMES_API_URL || 'http://127.0.0.1:8642',
    )
  }
  writeOverrides(overrides)
  // Force reprobe on the next capability check.
  probePromise = null
  lastProbeAt = 0
  capabilityCacheByUrl.delete(HERMES_API)
  return HERMES_API
}

/**
 * Same as setGatewayUrl() but for the dashboard service.
 */
export function setDashboardUrl(input: string | null | undefined): string {
  const normalized = input ? normalizeUrl(input) : ''
  const overrides = readOverrides()
  if (normalized) {
    overrides.claudeDashboardUrl = normalized
    CLAUDE_DASHBOARD_URL = normalized
  } else {
    delete overrides.claudeDashboardUrl
    CLAUDE_DASHBOARD_URL = normalizeUrl(
      process.env.HERMES_DASHBOARD_URL ||
        process.env.CLAUDE_DASHBOARD_URL ||
        'http://127.0.0.1:9119',
    )
  }
  writeOverrides(overrides)
  probePromise = null
  lastProbeAt = 0
  return CLAUDE_DASHBOARD_URL
}

/** Current resolved URLs (after any runtime override). */
export function getResolvedUrls(): {
  gateway: string
  dashboard: string
  source: 'override' | 'env' | 'default'
} {
  const overrides = readOverrides()
  const source = overrides.claudeApiUrl
    ? 'override'
    : process.env.HERMES_API_URL
      ? 'env'
      : 'default'
  return { gateway: HERMES_API, dashboard: CLAUDE_DASHBOARD_URL, source }
}

export const CLAUDE_UPGRADE_INSTRUCTIONS =
  'For full features, install Hermes Agent from source (`git clone https://github.com/NousResearch/hermes-agent && cd hermes-agent && pip install -e .`), then start the gateway on :8642 (`hermes gateway run`). Sessions, skills, config, and jobs are read from the local profile directory.'

export const DASHBOARD_REQUIRED_INSTRUCTIONS =
  'Hermes gateway core APIs are healthy. Sessions, skills, config, and jobs are served from the local profile directory. The optional Agent Dashboard (:9119) can be started separately for analytics.'

export const SESSIONS_API_UNAVAILABLE_MESSAGE = `Your Hermes backend does not support the sessions API. ${CLAUDE_UPGRADE_INSTRUCTIONS}`

const PROBE_TIMEOUT_MS = 3_000
const LOCAL_PROBE_TIMEOUT_MS = 2_000
/** Skip dashboard HTTP probes briefly after a failed attempt (localhost only). */
const DASHBOARD_NEGATIVE_CACHE_MS = 5 * 60_000
// Probe TTL: 120s when the gateway is healthy, 15s when it isn't. The
// shorter window during 'disconnected' state means a Docker stack where
// the workspace boots before the agent recovers within ~15s of the agent
// becoming reachable, instead of being stuck on the first failed probe
// for two minutes. See #275.
const PROBE_TTL_MS = 120_000
const PROBE_TTL_DISCONNECTED_MS = 15_000

function effectiveProbeTtl(caps: {
  health: boolean
  chatCompletions: boolean
  sessions?: boolean
}): number {
  // /health can come up before /api/sessions during a gateway restart.
  // Don't pin that incomplete probe for two minutes (looks like portable).
  if (caps.health && caps.sessions === false) return 3_000
  if (caps.health || caps.chatCompletions) return PROBE_TTL_MS
  return PROBE_TTL_DISCONNECTED_MS
}

function probeTimeoutMs(): number {
  return isLocalhostDeployment() ? LOCAL_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS
}
const DASHBOARD_TOKEN_REGEX =
  /window\._+(?:CLAUDE|HERMES)_+SESSION_+TOKEN__+\s*=\s*["']([^"']+)["']/

// ── Types ─────────────────────────────────────────────────────────

export type CoreCapabilities = {
  health: boolean
  chatCompletions: boolean
  models: boolean
  streaming: boolean
  probed: boolean
}

export type EnhancedCapabilities = {
  sessions: boolean
  enhancedChat: boolean
  skills: boolean
  memory: boolean
  config: boolean
  jobs: boolean
  mcp: boolean
  /**
   * Phase 1.5 — local-only fallback. True when the agent does NOT yet expose
   * the `/api/mcp*` runtime endpoints but the workspace can CRUD `mcp_servers`
   * via the local profile control plane (or, for non-local CP, dashboard
   * `/api/config` on loopback). Workspace routes then read/write profile
   * `config.yaml` (or dashboard config) while Test/Discover/Logs still need
   * native runtime probing. Removed once hermes-agent ships native `/api/mcp*`.
   */
  mcpFallback: boolean
  /**
   * @deprecated Always false. Conductor UI was removed; goal launch is
   * Missions → orchestrator. Kept for connection-status payload stability.
   */
  conductor: boolean
  /**
   * True when the dashboard exposes `/api/plugins/kanban/board` (the native
   * Hermes kanban plugin shipped upstream). When available, the workspace's
   * /swarm kanban surface can sync with the dashboard's kanban DB so both
   * UIs read/write the same SQLite source of truth instead of running
   * separate stores. When false, the workspace falls back to its local
   * file-backed swarm-kanban store. See v2.3.0 plan.
   */
  kanban: boolean
  /**
   * True when Hermes advertises `session_truncate` on `/v1/capabilities`.
   * Vanilla hermes-agent does not expose this REST endpoint; Workspace Edit /
   * Regenerate / `/undo` / `/retry` require it. Do not patch local hermes —
   * gate UI until upstream ships the API.
   */
  sessionTruncate: boolean
  /**
   * True when Hermes advertises `session_compress` on `/v1/capabilities`.
   * Vanilla hermes-agent has messaging-platform `/compress` slash only, not
   * this REST rewrite API. Workspace `/compress` requires it.
   */
  sessionCompress: boolean
}

export type DashboardCapabilities = {
  dashboard: {
    available: boolean
    url: string
  }
}

/** Full capabilities — backward compat with existing code */
export type GatewayCapabilities = CoreCapabilities &
  EnhancedCapabilities &
  DashboardCapabilities

export type GatewayMode =
  | 'zero-fork'
  | 'enhanced-fork'
  | 'portable'
  | 'disconnected'

export type ChatMode = 'enhanced-claude' | 'portable' | 'disconnected'

export type ConnectionStatus =
  | 'connected'
  | 'enhanced'
  | 'partial'
  | 'disconnected'

// ── State ─────────────────────────────────────────────────────────

let capabilities: GatewayCapabilities = {
  health: false,
  chatCompletions: false,
  models: false,
  streaming: false,
  sessions: false,
  enhancedChat: false,
  skills: false,
  memory: false,
  config: false,
  jobs: false,
  mcp: false,
  mcpFallback: false,
  conductor: false,
  kanban: false,
  sessionTruncate: false,
  sessionCompress: false,
  dashboard: {
    available: false,
    url: CLAUDE_DASHBOARD_URL,
  },
  probed: false,
}

let probePromise: Promise<GatewayCapabilities> | null = null
let lastProbeAt = 0
let dashboardNegativeUntil = 0
/** Per-gateway-url capability cache — avoids full reprobe on profile switch. */
const capabilityCacheByUrl = new Map<
  string,
  { caps: GatewayCapabilities; at: number }
>()

function rememberCapabilityProbe(url: string, caps: GatewayCapabilities): void {
  const normalized = normalizeUrl(url)
  if (!normalized) return
  if (!isUsableCapabilityCache(caps)) return
  capabilityCacheByUrl.set(normalized, {
    caps: { ...caps, dashboard: { ...caps.dashboard } },
    at: Date.now(),
  })
}

function restoreCachedCapabilities(url: string): boolean {
  const normalized = normalizeUrl(url)
  if (!normalized) return false
  const cached = capabilityCacheByUrl.get(normalized)
  if (!cached) return false
  if (
    Date.now() - cached.at > effectiveProbeTtl(cached.caps) ||
    !isUsableCapabilityCache(cached.caps)
  ) {
    capabilityCacheByUrl.delete(normalized)
    return false
  }
  capabilities = {
    ...cached.caps,
    dashboard: { ...cached.caps.dashboard },
  }
  lastProbeAt = cached.at
  return true
}

/** A cold/disconnected probe must not pin "no sessions" onto the next request. */
export function isUsableCapabilityCache(
  caps: Pick<GatewayCapabilities, 'health' | 'sessions' | 'chatCompletions'>,
): boolean {
  return Boolean(caps.health || caps.sessions || caps.chatCompletions)
}
let lastLoggedSummary = ''
let dashboardTokenPromise: Promise<string> | null = null
let dashboardTokenCache = ''

/** Optional bearer token for authenticated gateway endpoints.
 * Read at call time — Vite SSR can evaluate this module before .env is loaded.
 */
function readLocalApiServerKey(): string {
  return readProfileApiServerKey(getActiveProfileName() || 'default')
}

/** Read a profile's own API_SERVER_KEY from its .env file.
 *  `default` maps to the Hermes root; named profiles to ~/.hermes/profiles/<name>.
 */
export function readProfileApiServerKey(profileName: string): string {
  try {
    const name = (profileName || 'default').trim() || 'default'
    const profileHome = resolveProfileHermesHome(name)
    const raw = fs.readFileSync(path.join(profileHome, '.env'), 'utf-8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('API_SERVER_KEY=')) continue
      let value = trimmed.slice('API_SERVER_KEY='.length).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      return value
    }
  } catch {
    // missing env is fine
  }
  return ''
}

export function getGatewayBearerToken() {
  const fromEnv = (
    process.env.HERMES_API_TOKEN ||
    process.env.CLAUDE_API_TOKEN ||
    ''
  ).trim()
  if (fromEnv) {
    BEARER_TOKEN = fromEnv
    return fromEnv
  }
  const fromProfile = readLocalApiServerKey()
  if (fromProfile) {
    BEARER_TOKEN = fromProfile
    return fromProfile
  }
  return BEARER_TOKEN
}

export let BEARER_TOKEN = (
  process.env.HERMES_API_TOKEN ||
  process.env.CLAUDE_API_TOKEN ||
  ''
).trim()

function authHeaders(): Record<string, string> {
  const token = getGatewayBearerToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Resolve the current dashboard session token by scraping the dashboard root
 * HTML. The dashboard injects a fresh ephemeral token at boot, so cached or
 * manually copied env tokens become invalid after restarts.
 */
export async function fetchDashboardToken(options?: {
  force?: boolean
}): Promise<string> {
  const force = options?.force === true

  if (!shouldUseDashboard()) return ''
  if (!force && dashboardTokenCache) return dashboardTokenCache
  if (!force && dashboardTokenPromise) return dashboardTokenPromise

  dashboardTokenPromise = (async () => {
    // Dashboard injects the session token inline on `/` (root), not on
    // `/index.html` which serves the raw Vite-built HTML without the token.
    // When the dashboard requires auth (302 → /auth/login) or the login page
    // is broken (500), return empty string so protected API calls degrade
    // gracefully — the caller already handles 401/non-ok via safeJson.
    try {
      const res = await fetch(`${CLAUDE_DASHBOARD_URL}/`, {
        signal: AbortSignal.timeout(probeTimeoutMs()),
      })
      if (!res.ok) {
        console.warn(
          `[gateway] Dashboard index returned ${res.status} — token unavailable`,
        )
        return ''
      }
      const html = await res.text()
      const token = html.match(DASHBOARD_TOKEN_REGEX)?.[1]?.trim() || ''
      if (!token) {
        console.warn('[gateway] Dashboard session token not found in root HTML')
        return ''
      }
      dashboardTokenCache = token
      return token
    } catch (err) {
      console.warn(
        `[gateway] Failed to fetch dashboard token: ${err instanceof Error ? err.message : err}`,
      )
      return ''
    }
  })()

  try {
    return await dashboardTokenPromise
  } finally {
    dashboardTokenPromise = null
  }
}

export async function getDashboardToken(options?: {
  force?: boolean
}): Promise<string> {
  return fetchDashboardToken(options)
}

export async function dashboardAuthHeaders(options?: {
  force?: boolean
}): Promise<Record<string, string>> {
  const token = await getDashboardToken(options)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function withDashboardBase(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${CLAUDE_DASHBOARD_URL}${path.startsWith('/') ? path : `/${path}`}`
}

export async function dashboardFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!shouldUseDashboard()) {
    return dashboardUnavailableResponse(path)
  }
  const requestPath = withDashboardBase(path)
  const method = (init.method || 'GET').toUpperCase()
  const doFetch = async (forceToken = false) => {
    const headers = new Headers(init.headers)
    const isProtected =
      requestPath.includes('/api/') &&
      !requestPath.endsWith('/api/status') &&
      !requestPath.endsWith('/api/config/defaults') &&
      !requestPath.endsWith('/api/config/schema') &&
      !requestPath.endsWith('/api/model/info') &&
      !requestPath.endsWith('/api/dashboard/themes') &&
      !requestPath.endsWith('/api/dashboard/plugins') &&
      !requestPath.endsWith('/api/dashboard/plugins/rescan')

    if (isProtected && !headers.has('Authorization')) {
      const auth = await dashboardAuthHeaders({ force: forceToken })
      for (const [key, value] of Object.entries(auth)) {
        headers.set(key, value)
      }
    }

    return fetch(requestPath, {
      ...init,
      method,
      headers,
    })
  }

  let res = await doFetch(false)
  if (res.status === 401) {
    dashboardTokenCache = ''
    res = await doFetch(true)
  }
  return res
}

/**
 * Lightweight fetch helper that targets the gateway base URL
 * (`HERMES_API`, e.g. http://127.0.0.1:8645). Used for endpoints that
 * live on the gateway runtime rather than the dashboard, like
 * `/health/detailed`.
 */
export async function gatewayFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = /^https?:\/\//i.test(path)
    ? path
    : `${HERMES_API}${path.startsWith('/') ? path : `/${path}`}`
  const headers = new Headers(init.headers)
  for (const [k, v] of Object.entries(authHeaders())) {
    if (!headers.has(k)) headers.set(k, v)
  }
  return fetch(url, { ...init, headers })
}

// ── Local control plane detection ─────────────────────────────────

/**
 * Check whether the active profile's local directory has the files that
 * constitute a usable control plane (config.yaml or skills/ or state.db).
 * When true, sessions/skills/config/jobs capabilities are satisfied locally
 * without requiring dashboard :9119 or even a running gateway.
 */
export function hasLocalControlPlane(): boolean {
  try {
    const home =
      process.env.HERMES_HOME ||
      process.env.HERMES_HOME ||
      path.join(os.homedir(), '.hermes')
    const activePath = path.join(home, 'active_profile')
    let profileHome = home
    try {
      const active = fs.readFileSync(activePath, 'utf-8').trim()
      if (active && active !== 'default') {
        profileHome = path.join(home, 'profiles', active)
      }
    } catch {
      // default home
    }
    return (
      fs.existsSync(path.join(profileHome, 'config.yaml')) ||
      fs.existsSync(path.join(profileHome, 'skills')) ||
      fs.existsSync(path.join(profileHome, 'state.db'))
    )
  } catch {
    return false
  }
}

/**
 * Whether hot paths should attempt Hermes Dashboard (:9119).
 * Local Agorax (profile FS control plane) never depends on it unless
 * `HERMES_USE_DASHBOARD=1` is set for rare remote/debug cases.
 */
export function shouldUseDashboard(): boolean {
  if (process.env.HERMES_USE_DASHBOARD === '1') return true
  if (hasLocalControlPlane()) return false
  if (Date.now() < dashboardNegativeUntil) return false
  if (capabilities.probed && !capabilities.dashboard.available) return false
  return true
}

function dashboardUnavailableResponse(path: string): Response {
  return new Response(
    JSON.stringify({
      error: 'dashboard unavailable',
      path,
      reason: hasLocalControlPlane()
        ? 'local-control-plane'
        : 'dashboard-unreachable',
    }),
    {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

// ── Probing ───────────────────────────────────────────────────────

async function probeBooleanWithRetry(
  probeFn: () => Promise<boolean>,
  attempts = 3,
  delayMs = 300,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await probeFn()) return true
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  return false
}

/** Keep last-known-good chat capability when a reprobe races Vite HMR / profile switch. */
function preserveCoreCapabilitiesOnTransientFailure(
  previous: GatewayCapabilities,
  next: GatewayCapabilities,
  localControlPlane: boolean,
): GatewayCapabilities {
  if (!localControlPlane) return next

  const hadWorkingChat =
    previous.probed && (previous.health || previous.chatCompletions)
  const probeFailed = !next.health && !next.chatCompletions
  if (!hadWorkingChat || !probeFailed) return next

  const previousProbeAgeMs = Date.now() - lastProbeAt
  if (previousProbeAgeMs > effectiveProbeTtl(previous)) return next

  return {
    ...next,
    health: previous.health,
    chatCompletions: previous.chatCompletions,
    models: previous.models || next.models,
    streaming: previous.streaming || next.streaming,
  }
}

async function probe(probePath: string): Promise<boolean> {
  try {
    const res = await fetch(`${HERMES_API}${probePath}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(probeTimeoutMs()),
    })
    if (res.status === 404 || res.status === 403) return false
    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('text/html')) return false
    return true
  } catch {
    return false
  }
}

/**
 * Stricter probe for the legacy enhanced chat-stream endpoint.
 *
 * The previous probe used a generic GET and treated any non-404/403 status
 * as "available". That misclassified vanilla hermes-agent (which serves a
 * router-level handler that 405s/400s GETs to that path) as having the
 * enhanced fork's session-stream capability. Workspace then fell through
 * to streamChat() which posts to /api/sessions/{id}/chat/stream — vanilla
 * agent returns 404 there at runtime and chat appears to fail with
 * "Authentication error" because the bundle's error mapper is overly
 * generous about what it interprets as auth failures. See #261.
 *
 * Real enhanced-fork gateways respond to GET on the probe path with one
 * of: 405 Method Not Allowed (it's POST-only there too) but also expose
 * the path in their router; we cannot distinguish reliably from a generic
 * status code on GET, so we POST a tiny no-op body and look for a
 * structured error shape that only the fork emits.
 */
/** Read session mutation feature flags from GET /v1/capabilities. */
async function probeSessionMutationFeatures(): Promise<{
  sessionTruncate: boolean
  sessionCompress: boolean
}> {
  try {
    const res = await fetch(`${HERMES_API}/v1/capabilities`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(probeTimeoutMs()),
    })
    if (!res.ok) {
      return { sessionTruncate: false, sessionCompress: false }
    }
    const body = (await res.json()) as {
      features?: Record<string, unknown>
    }
    const features = body.features ?? {}
    return {
      sessionTruncate: features.session_truncate === true,
      sessionCompress: features.session_compress === true,
    }
  } catch {
    return { sessionTruncate: false, sessionCompress: false }
  }
}

async function probeEnhancedChatStream(): Promise<boolean> {
  try {
    const res = await fetch(
      `${HERMES_API}/api/sessions/__probe__/chat/stream`,
      {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(probeTimeoutMs()),
      },
    )
    // Vanilla hermes-agent has no such endpoint — dashboard layer 404s,
    // gateway 404s, anything in between 404s. Enhanced fork accepts POST
    // and returns either a 4xx structured error (validation) or starts a
    // stream; either way the path is registered.
    if (res.status === 404 || res.status === 403) return false
    // 405 = the path exists but POST is wrong. That's still vanilla — no
    // enhanced fork would 405 a POST to its own chat/stream endpoint.
    if (res.status === 405) return false
    // 401 means auth gate is wired; treat as available so token-gated
    // setups don't get downgraded by a missing token at probe time.
    return true
  } catch {
    return false
  }
}

async function probeChatCompletions(): Promise<boolean> {
  try {
    const getRes = await fetch(`${HERMES_API}/v1/chat/completions`, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(probeTimeoutMs()),
    })
    if (getRes.status === 405) return true
    if (getRes.ok) return true
    if (getRes.status === 400 || getRes.status === 422) return true
    if (getRes.status === 404) {
      // Some OpenAI-compatible backends (e.g. `hermes proxy`) only route POST
      // for /v1/chat/completions and return 404 — not 405 — for GET. Confirm
      // the endpoint exists with a lightweight POST: an empty body triggers a
      // validation error (400/422) on a real endpoint and 404 on an absent one.
      // No tokens are spent because the request fails validation before inference.
      try {
        const postRes = await fetch(`${HERMES_API}/v1/chat/completions`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(probeTimeoutMs()),
        })
        return postRes.status !== 404
      } catch {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * Strict MCP capability probe.
 *
 * Per plan §Open Questions #4: probing `dashboard.available || /api/mcp` is
 * insufficient. The probe must hit `GET /api/mcp` directly and verify both:
 *   1. 200 OK
 *   2. Body parses through normalizeMcpList (i.e. shape is recognizable)
 * If the dashboard is up but `/api/mcp` is absent (404) or returns a
 * malformed body, capability is `false`.
 */
async function probeMcp(dashboardAvailable: boolean): Promise<boolean> {
  const validate = async (res: Response): Promise<boolean> => {
    if (!res.ok) return false
    const body = (await res.json().catch(() => null)) as unknown
    if (body === null) return false
    // Empty list is a valid configured-zero state — still indicates the
    // endpoint is real. The shape check is "does the normalizer accept it
    // without throwing", which it does for `{servers: []}`, `[]`, etc.
    void normalizeMcpList(body)
    return true
  }
  // Skip the dashboard hop when it already failed — otherwise a hung
  // :9119 listener adds a full probe timeout before we try the gateway.
  if (dashboardAvailable) {
    // Use dashboardFetch so the probe goes through the same authenticated path
    // workspace routes use at runtime — otherwise an auth-protected dashboard
    // /api/mcp would falsely report capability=false (Codex MAJOR finding).
    try {
      const res = await dashboardFetch('/api/mcp', {
        signal: AbortSignal.timeout(probeTimeoutMs()),
      })
      if (await validate(res)) return true
    } catch {
      // fall through to gateway path
    }
  }
  try {
    const res = await fetch(`${HERMES_API}/api/mcp`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(probeTimeoutMs()),
    })
    return await validate(res)
  } catch {
    return false
  }
}

/**
 * Conservative loopback check. Returns true ONLY when:
 *   1. Both `HERMES_API` and `CLAUDE_DASHBOARD_URL` resolve to a loopback host
 *      (`127.0.0.1`, `::1`, or `localhost`).
 *   2. Workspace `HOST` env is unset OR loopback. Any non-loopback `HOST`
 *      (including `0.0.0.0`) disables fallback so we never silently expose a
 *      remote-deploy to plaintext config.yaml writes.
 *
 * On any parse failure we return false. Better to under-enable than to
 * silently enable on a remote deployment.
 */
export function isLocalhostDeployment(): boolean {
  const isLoopbackHost = (host: string): boolean => {
    const h = host.trim().toLowerCase()
    if (!h) return false
    return (
      h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '[::1]'
    )
  }
  const isLoopbackUrl = (raw: string): boolean => {
    try {
      const u = new URL(raw)
      return isLoopbackHost(u.hostname)
    } catch {
      return false
    }
  }
  const host = (process.env.HOST || '').trim()
  if (host && !isLoopbackHost(host)) return false
  return isLoopbackUrl(HERMES_API) && isLoopbackUrl(CLAUDE_DASHBOARD_URL)
}

/**
 * Probe whether the dashboard's `/api/config` payload includes an
 * `mcp_servers` entry. The presence of the key (even if empty) signals that
 * config-fallback CRUD is safe to expose.
 *
 * Used as part of the `mcpFallback` capability gate.
 */
async function probeMcpConfigKey(): Promise<boolean> {
  try {
    const { getConfig } = await import('./hermes-dashboard-api')
    const cfg = await getConfig()
    if (typeof cfg !== 'object') return false
    if ('mcp_servers' in cfg) return true
    const inner =
      cfg.config && typeof cfg.config === 'object'
        ? (cfg.config as Record<string, unknown>)
        : null
    return inner ? 'mcp_servers' in inner : false
  } catch {
    return false
  }
}

async function probeDashboard(): Promise<{ available: boolean; url: string }> {
  if (Date.now() < dashboardNegativeUntil) {
    return { available: false, url: CLAUDE_DASHBOARD_URL }
  }
  try {
    const res = await fetch(`${CLAUDE_DASHBOARD_URL}/api/status`, {
      signal: AbortSignal.timeout(probeTimeoutMs()),
    })
    if (!res.ok) {
      dashboardNegativeUntil = Date.now() + DASHBOARD_NEGATIVE_CACHE_MS
      return { available: false, url: CLAUDE_DASHBOARD_URL }
    }
    const body = (await res.json()) as { version?: string }
    if (!body.version) {
      dashboardNegativeUntil = Date.now() + DASHBOARD_NEGATIVE_CACHE_MS
      return { available: false, url: CLAUDE_DASHBOARD_URL }
    }
    dashboardNegativeUntil = 0
    // Token scrape is deferred to the first authenticated dashboard call.
    // Blocking probe on HTML fetch adds another timeout when :9119 hangs.
    return { available: true, url: CLAUDE_DASHBOARD_URL }
  } catch {
    dashboardNegativeUntil = Date.now() + DASHBOARD_NEGATIVE_CACHE_MS
    return { available: false, url: CLAUDE_DASHBOARD_URL }
  }
}

/**
 * Lightweight probe for the upstream Hermes kanban plugin. When the dashboard
 * exposes `/api/plugins/kanban/board` we assume the kanban plugin is loaded
 * and the workspace can sync its /swarm kanban surface with the dashboard's
 * SQLite-backed kanban DB. Mounted by hermes_cli.web_server
 * `_mount_plugin_api_routes()`. See v2.3.0 plan.
 */
async function probeKanban(dashboardAvailable: boolean): Promise<boolean> {
  if (!dashboardAvailable) return false
  try {
    const res = await dashboardFetch('/api/plugins/kanban/board', {
      method: 'GET',
      signal: AbortSignal.timeout(probeTimeoutMs()),
    })
    if (res.status === 404 || res.status === 405) return false
    // The plugin route is unauthenticated by design (loopback-only), so
    // 200 is the normal success. Some auth setups may return 401 — still
    // means the route exists.
    return true
  } catch {
    return false
  }
}

// Vanilla hermes-agent 0.10.0 satisfies: health, chatCompletions, models, streaming,
// sessions, skills, config, jobs. Dashboard-only endpoints (themes/plugins) and the
// legacy enhanced-fork chat stream are optional — their absence should not emit the
// "Missing Hermes APIs detected" warning, which only applies to critical gaps.
const OPTIONAL_APIS = new Set([
  'jobs',
  'chatCompletions',
  'streaming',
  'memory',
  'dashboard',
  'enhancedChat',
  'mcp',
  'mcpFallback',
  'sessionTruncate',
  'sessionCompress',
])

const DASHBOARD_BACKED_APIS = new Set([
  'sessions',
  'skills',
  'config',
  'jobs',
  'mcp',
  'mcpFallback',
  'conductor',
  'kanban',
])

export function getCapabilityWarningMessage(
  next: GatewayCapabilities,
  criticalMissing: string[],
): string | null {
  if (criticalMissing.length === 0 || !next.health) {
    return null
  }

  return `[gateway] Missing Hermes APIs detected. ${CLAUDE_UPGRADE_INSTRUCTIONS}`
}

function logCapabilities(next: GatewayCapabilities): void {
  const core: Array<string> = []
  const enhanced: Array<string> = []
  const missing: Array<string> = []
  const optionalMissing: Array<string> = []

  const coreKeys: Array<keyof CoreCapabilities> = [
    'health',
    'chatCompletions',
    'models',
    'streaming',
  ]
  const enhancedKeys: Array<keyof EnhancedCapabilities> = [
    'sessions',
    'enhancedChat',
    'skills',
    'memory',
    'config',
    'jobs',
    'mcp',
    'mcpFallback',
  ]

  for (const key of coreKeys) {
    if (next[key]) core.push(key)
    else if (OPTIONAL_APIS.has(key)) optionalMissing.push(key)
    else missing.push(key)
  }
  for (const key of enhancedKeys) {
    if (next[key]) enhanced.push(key)
    else if (OPTIONAL_APIS.has(key)) optionalMissing.push(key)
    else missing.push(key)
  }
  if (next.dashboard.available) core.push('dashboard')
  else optionalMissing.push('dashboard')

  const mode = getGatewayMode()
  const summary = `[gateway] gateway=${HERMES_API} dashboard=${next.dashboard.url} mode=${mode} core=[${core.join(', ')}] enhanced=[${enhanced.join(', ')}] missing=[${missing.join(', ')}] optional=[${optionalMissing.join(', ')}]`
  if (summary === lastLoggedSummary) return
  lastLoggedSummary = summary
  console.log(summary)

  const criticalMissing = missing.filter((key) => !OPTIONAL_APIS.has(key))
  const warning = getCapabilityWarningMessage(next, criticalMissing)
  if (warning) {
    console.warn(warning)
  }
}

async function autoDetectGatewayUrl(): Promise<void> {
  if (isGatewayPoolEnabled()) {
    // The pool already has a stable port per profile. Probes must not
    // swing the process-global URL onto whichever profile is selected.
    return
  }

  if (process.env.HERMES_API_URL) return

  const candidates = [
    'http://127.0.0.1:8642',
    'http://127.0.0.1:8643',
    'http://127.0.0.1:8645',
  ]

  for (const candidate of candidates) {
    try {
      const res = await fetch(`${candidate}/health`, {
        signal: AbortSignal.timeout(probeTimeoutMs()),
      })
      if (res.ok) {
        HERMES_API = candidate
        console.log(`[gateway] Connected to Hermes gateway at ${HERMES_API}`)
        return
      }
    } catch {
      // continue
    }
  }

  console.warn(
    '[gateway] Could not reach Hermes gateway on 8645, 8642, or 8643. ' +
      'If you run the workspace on a different machine (Tailscale / VPN / LAN), ' +
      'set HERMES_API_URL=http://<reachable-host>:8642 in .env and restart. ' +
      'Also set API_SERVER_HOST=0.0.0.0 on the gateway so remote peers can connect.',
  )
}

async function autoDetectDashboardUrl(): Promise<void> {
  // Mirror autoDetectGatewayUrl: skip discovery when the dashboard URL was set
  // explicitly. HERMES_DASHBOARD_URL is the documented primary var (see the
  // resolution order at the top of this file); CLAUDE_DASHBOARD_URL is the
  // legacy alias. Probing only the hard-coded :9119 candidate when
  // HERMES_DASHBOARD_URL points elsewhere lets a co-located dashboard on the
  // default port silently override the operator's explicit choice — e.g. in a
  // multi-user setup it attaches to another user's dashboard and leaks their
  // session list. Honor both vars so an explicit setting always wins.
  if (process.env.HERMES_DASHBOARD_URL || process.env.CLAUDE_DASHBOARD_URL)
    return
  if (Date.now() < dashboardNegativeUntil) return

  const candidates = ['http://127.0.0.1:9119']
  for (const candidate of candidates) {
    try {
      const res = await fetch(`${candidate}/api/status`, {
        signal: AbortSignal.timeout(probeTimeoutMs()),
      })
      if (res.ok) {
        CLAUDE_DASHBOARD_URL = candidate
        dashboardNegativeUntil = 0
        return
      }
      dashboardNegativeUntil = Date.now() + DASHBOARD_NEGATIVE_CACHE_MS
    } catch {
      dashboardNegativeUntil = Date.now() + DASHBOARD_NEGATIVE_CACHE_MS
      // continue
    }
  }
}

let enhancedProbePromise: Promise<void> | null = null

async function fillEnhancedCapabilities(input: {
  dashboardAvailable: boolean
  legacyConfig: boolean
}): Promise<void> {
  const localControlPlane = hasLocalControlPlane()
  // Zero-fork: control plane is local; do not block startup on :9119 token
  // scraping or dashboard-only endpoints (Kanban/MCP via dashboard).
  const probeDashboardBacked = !localControlPlane && input.dashboardAvailable

  const [mcp, kanban] = await Promise.all([
    probeMcp(probeDashboardBacked),
    probeDashboardBacked
      ? probeKanban(input.dashboardAvailable)
      : Promise.resolve(false),
  ])
  const conductor = false

  // Local Agorax control plane: profile config.yaml is always writable for
  // mcp_servers — do not require dashboard /api/config or native gateway MCP.
  const mcpFallback = mcp
    ? false
    : localControlPlane
      ? true
      : input.dashboardAvailable &&
        isLocalhostDeployment() &&
        (await probeMcpConfigKey())

  capabilities = {
    ...capabilities,
    mcp,
    mcpFallback,
    conductor,
    kanban,
  }
  logCapabilities(capabilities)
}

export async function probeGateway(options?: {
  force?: boolean
  /** When true, await MCP/conductor/kanban probes. Default false (background). */
  waitForEnhanced?: boolean
}): Promise<GatewayCapabilities> {
  const force = options?.force === true
  const waitForEnhanced = options?.waitForEnhanced === true
  if (!force && capabilities.probed) {
    if (waitForEnhanced && enhancedProbePromise) await enhancedProbePromise
    return capabilities
  }
  if (probePromise) {
    await probePromise
    if (waitForEnhanced && enhancedProbePromise) await enhancedProbePromise
    return capabilities
  }

  probePromise = (async () => {
    try {
      await Promise.all([autoDetectGatewayUrl(), autoDetectDashboardUrl()])

      const previousCapabilities = {
        ...capabilities,
        dashboard: { ...capabilities.dashboard },
      }
      const localControlPlane = hasLocalControlPlane()

      const [
        health,
        chatCompletions,
        models,
        sessionsFirst,
        enhancedChat,
        legacySkills,
        legacyConfig,
        legacyJobs,
        dashboard,
        sessionMutation,
      ] = await Promise.all([
        probeBooleanWithRetry(() => probe('/health')),
        probeBooleanWithRetry(() => probeChatCompletions()),
        probeBooleanWithRetry(() => probe('/v1/models')),
        probe('/api/sessions'),
        probeEnhancedChatStream(),
        probe('/api/skills'),
        probe('/api/config'),
        probe('/api/jobs'),
        localControlPlane
          ? Promise.resolve({
              available: false,
              url: CLAUDE_DASHBOARD_URL,
            })
          : probeDashboard(),
        probeSessionMutationFeatures(),
      ])

      let legacySessions = sessionsFirst
      if (health && !legacySessions) {
        await new Promise((resolveRetry) => setTimeout(resolveRetry, 250))
        legacySessions = await probe('/api/sessions')
      }

      // Control-plane refactor: sessions, skills, config, jobs are satisfied
      // by the local profile directory (state.db, skills/, config.yaml,
      // cron/jobs.json). Gateway probes serve as fallback, not primary.
      // Dashboard availability is informational only — not a capability gate.
      capabilities = preserveCoreCapabilitiesOnTransientFailure(
        previousCapabilities,
        {
          health,
          chatCompletions,
          models,
          streaming: chatCompletions,
          probed: true,
          sessions: localControlPlane || legacySessions,
          enhancedChat,
          skills: localControlPlane || legacySkills,
          // Memory is always available: workspace reads $HERMES_HOME/MEMORY.md +
          // memory/*.md + memories/*.md directly from the local filesystem.
          // No remote gateway endpoint is required.
          memory: true,
          config: localControlPlane || legacyConfig,
          jobs: localControlPlane || legacyJobs,
          mcp: false,
          // Local CP can manage MCP via profile config.yaml immediately —
          // do not wait for enhanced probe (avoids /mcp "Not available").
          mcpFallback: localControlPlane,
          conductor: false,
          kanban: false,
          sessionTruncate: sessionMutation.sessionTruncate,
          sessionCompress: sessionMutation.sessionCompress,
          dashboard,
        },
        localControlPlane,
      )
      lastProbeAt = Date.now()
      // Log after enhanced probes so a slow dashboard during Vite boot is not
      // reported as "start the dashboard" and then immediately contradicted.

      // Dashboard availability is informational — enhanced probes (MCP,
      // conductor, kanban) still benefit from the dashboard when present
      // but their absence no longer blocks core functionality.
      enhancedProbePromise = fillEnhancedCapabilities({
        dashboardAvailable: dashboard.available,
        legacyConfig,
      }).catch((error) => {
        console.warn(
          `[gateway] enhanced probe failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      })

      return capabilities
    } catch (error) {
      console.warn(
        `[gateway] probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return capabilities
    }
  })()

  try {
    await probePromise
    if (waitForEnhanced && enhancedProbePromise) await enhancedProbePromise
    rememberCapabilityProbe(HERMES_API, capabilities)
    return capabilities
  } finally {
    probePromise = null
  }
}

export async function ensureGatewayProbed(): Promise<GatewayCapabilities> {
  const isStale = Date.now() - lastProbeAt > effectiveProbeTtl(capabilities)
  if (!capabilities.probed || isStale) {
    return probeGateway({ force: isStale, waitForEnhanced: false })
  }
  return capabilities
}

/** Await tier-3 probes (MCP, conductor, kanban). Use on those feature surfaces only. */
export async function ensureGatewayEnhancedProbed(): Promise<GatewayCapabilities> {
  await ensureGatewayProbed()
  if (enhancedProbePromise) {
    await enhancedProbePromise
    return capabilities
  }
  const caps = getCapabilities()
  if (!caps.probed) return caps
  enhancedProbePromise = fillEnhancedCapabilities({
    dashboardAvailable: caps.dashboard.available,
    legacyConfig: caps.config,
  }).catch((error) => {
    console.warn(
      `[gateway] enhanced probe failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  })
  await enhancedProbePromise
  return capabilities
}

/** After a profile switch or cold start, do not trust a disconnected probe. */
export async function ensureSessionsCapability(): Promise<GatewayCapabilities> {
  let caps = await ensureGatewayProbed()
  if (caps.sessions) return caps
  caps = await probeGateway({ force: true })
  if (caps.sessions) return caps
  await new Promise((resolve) => setTimeout(resolve, 400))
  return probeGateway({ force: true })
}

export async function ensureGatewayCoreProbed(): Promise<GatewayCapabilities> {
  const isStale = Date.now() - lastProbeAt > effectiveProbeTtl(capabilities)
  if (!capabilities.probed || isStale) {
    return probeGateway({ force: isStale, waitForEnhanced: false })
  }
  return capabilities
}

/**
 * Force-reprobe regardless of TTL. Used by the UI 'Reconnect' action
 * and by any tool that wants to validate the current state immediately
 * (for example after a docker compose restart). See #275.
 */
export async function forceReprobeGateway(): Promise<GatewayCapabilities> {
  dashboardNegativeUntil = 0
  return probeGateway({ force: true, waitForEnhanced: true })
}

// ── Accessors ─────────────────────────────────────────────────────

export function getCapabilities(): GatewayCapabilities {
  return capabilities
}

export function getCoreCapabilities(): CoreCapabilities {
  return {
    health: capabilities.health,
    chatCompletions: capabilities.chatCompletions,
    models: capabilities.models,
    streaming: capabilities.streaming,
    probed: capabilities.probed,
  }
}

export function getEnhancedCapabilities(): EnhancedCapabilities {
  return {
    sessions: capabilities.sessions,
    enhancedChat: capabilities.enhancedChat,
    skills: capabilities.skills,
    memory: capabilities.memory,
    config: capabilities.config,
    jobs: capabilities.jobs,
    mcp: capabilities.mcp,
    mcpFallback: capabilities.mcpFallback,
    conductor: capabilities.conductor,
    kanban: capabilities.kanban,
    sessionTruncate: capabilities.sessionTruncate,
    sessionCompress: capabilities.sessionCompress,
  }
}

export function getGatewayMode(): GatewayMode {
  // 'zero-fork' = gateway can do inference AND control plane is satisfied
  // (local profile files or gateway endpoints). Dashboard :9119 is NOT
  // required — the control plane reads config.yaml, skills/, state.db
  // directly from the profile directory.
  if (capabilities.chatCompletions && capabilities.sessions) {
    return 'zero-fork'
  }
  if (capabilities.sessions && capabilities.enhancedChat) {
    return 'enhanced-fork'
  }
  if (capabilities.chatCompletions || capabilities.health) return 'portable'
  return 'disconnected'
}

/**
 * UI-facing chat transport mode:
 * - enhanced-claude: legacy fork session streaming API available
 * - portable: OpenAI-compatible /v1/chat/completions transport
 * - disconnected: no usable chat backend
 */
export function getChatMode(): ChatMode {
  if (capabilities.enhancedChat) return 'enhanced-claude'
  if (capabilities.chatCompletions || capabilities.health) return 'portable'
  return 'disconnected'
}

export function getConnectionStatus(): ConnectionStatus {
  if (!capabilities.health && !capabilities.chatCompletions) {
    // Local control plane alone doesn't mean connected — we need a gateway
    return 'disconnected'
  }
  const enhanced =
    capabilities.sessions && capabilities.skills && capabilities.config
  if (enhanced) return 'enhanced'
  if (capabilities.chatCompletions || capabilities.sessions) return 'partial'
  return 'connected'
}

export function isClaudeConnected(): boolean {
  return capabilities.health || capabilities.chatCompletions
}
