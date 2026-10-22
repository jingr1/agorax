import { resolveChatGateway } from '@/server/chat-gateway'
import {
  CLAUDE_DASHBOARD_URL,
  dashboardFetch,
  ensureGatewayProbed,
  getCapabilities,
  shouldUseDashboard,
} from '@/server/gateway-capabilities'
import { listSessions } from '@/server/hermes-api'
import {
  readHermesConfigFiles,
  resolveHermesConfigPaths,
} from '@/server/hermes-config-store'
import { getLocalMessages, getLocalSession } from './local-session-store'
import { getActiveRunForSession } from './run-store'
import { lookupModelsDevContextWindow } from '@/server/hermes-model-context'
import {
  resolveMainChatSessionId,
  shouldBindMainToPortableSession,
} from '@/server/session-utils'

/** Hermes default when compression.threshold is unset (see hermes-agent config docs). */
export const DEFAULT_COMPRESSION_THRESHOLD = 0.5

export type ContextUsageSnapshot = {
  ok: true
  contextPercent: number
  maxTokens: number
  usedTokens: number
  model: string
  staticTokens: number
  conversationTokens: number
  thresholdTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheHitPercent: number | null
}

export type CompressionSettings = {
  thresholdRatio: number
  thresholdTokensCap: number
}

type ResolvedModelContext = {
  model: string
  maxTokens: number
}

const CHARS_PER_TOKEN = 3.5

/**
 * Last provider/gateway-reported context window per session.
 * Tutti-aligned: never invent a denominator from the model name; when the
 * live gateway has no length, reuse the same session's last authoritative
 * window (same model) so a brief outage does not blank the meter.
 */
type CachedSessionWindow = { maxTokens: number; model: string }
const SESSION_CONTEXT_WINDOW_CACHE = new Map<string, CachedSessionWindow>()

export function rememberSessionContextWindow(
  sessionId: string,
  maxTokens: number,
  model = '',
): void {
  const sid = sessionId.trim()
  if (!sid || !(maxTokens > 0)) return
  SESSION_CONTEXT_WINDOW_CACHE.set(sid, {
    maxTokens,
    model: model.trim(),
  })
}

export function recallSessionContextWindow(
  sessionId: string,
  model = '',
): number {
  const sid = sessionId.trim()
  if (!sid) return 0
  const entry = SESSION_CONTEXT_WINDOW_CACHE.get(sid)
  if (!entry || !(entry.maxTokens > 0)) return 0
  const want = model.trim().toLowerCase()
  const have = entry.model.trim().toLowerCase()
  if (want && have && want !== have) return 0
  return entry.maxTokens
}

/** @internal test helper */
export function clearSessionContextWindowCache(): void {
  SESSION_CONTEXT_WINDOW_CACHE.clear()
}

type MessageLike = {
  content?: unknown
  text?: unknown
  reasoning?: unknown
  tool_calls?: unknown
}

function estimateTokensFromChars(totalChars: number): number {
  return Math.ceil(Math.max(0, totalChars) / CHARS_PER_TOKEN)
}

function stringifyStructuredContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        const record = part as Record<string, unknown>
        if (typeof record.text === 'string') return record.text
        try {
          return JSON.stringify(record)
        } catch {
          return ''
        }
      })
      .join(' ')
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content)
    } catch {
      return ''
    }
  }
  return ''
}

export function estimateContextTokensFromMessages(
  messages: Array<MessageLike>,
): number {
  let totalChars = 0
  for (const msg of messages) {
    const structured = stringifyStructuredContent(msg.content)
    const topLevelText = typeof msg.text === 'string' ? msg.text : ''
    if (structured) {
      totalChars += structured.length
      if (topLevelText && topLevelText !== structured)
        totalChars += topLevelText.length
    } else if (typeof msg.content === 'string') {
      totalChars += msg.content.length
      if (topLevelText && topLevelText !== msg.content)
        totalChars += topLevelText.length
    } else if (topLevelText) {
      totalChars += topLevelText.length
    }
    if (typeof msg.reasoning === 'string') totalChars += msg.reasoning.length
    if (msg.tool_calls) {
      try {
        totalChars += JSON.stringify(msg.tool_calls).length
      } catch {
        /* ignore */
      }
    }
  }
  return estimateTokensFromChars(totalChars)
}

export function estimateContextTokensFromCacheRead(
  cacheReadTokens: number,
  messageCount: number,
): number {
  const assistantTurns = Math.max(1, Math.ceil((Number(messageCount) || 0) / 2))
  return Math.ceil(
    (Math.max(0, Number(cacheReadTokens) || 0) / assistantTurns) * 1.2,
  )
}

export function estimateContextTokensFromSessionUsage(
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  apiCallCount: number,
): number {
  const calls = Math.max(1, Number(apiCallCount) || 0)
  const totalInput =
    (Number(inputTokens) || 0) +
    (Number(cacheReadTokens) || 0) +
    (Number(cacheWriteTokens) || 0)
  return Math.ceil(totalInput / calls)
}

/**
 * Priority (Tutti-aligned):
 * 1. Provider/session-reported length
 * 2. Last provider-reported window cached for this session+model
 * 3. Hermes metadata backup (dashboard model/info or models.dev cache)
 * Never invent a bare 200k/1M from the model name alone.
 */
export function resolvePreferredContextWindow(
  _model: string,
  backupMaxTokens?: number,
  sessionContextLength?: number,
  cachedMaxTokens?: number,
): number {
  if (sessionContextLength && sessionContextLength > 0)
    return sessionContextLength
  if (cachedMaxTokens && cachedMaxTokens > 0) return cachedMaxTokens
  if (backupMaxTokens && backupMaxTokens > 0) return backupMaxTokens
  return 0
}

function resolveSessionContextWindow(
  sessionId: string,
  model: string,
  backupMaxTokens?: number,
  sessionContextLength?: number,
): number {
  // Only provider/session reports enter the session cache (not metadata backup).
  if (sessionContextLength && sessionContextLength > 0) {
    rememberSessionContextWindow(sessionId, sessionContextLength, model)
  }
  return resolvePreferredContextWindow(
    model,
    backupMaxTokens,
    sessionContextLength,
    recallSessionContextWindow(sessionId, model),
  )
}

function modelKeysMatch(a: string, b: string): boolean {
  const left = a.trim().toLowerCase()
  const right = b.trim().toLowerCase()
  if (!left || !right) return false
  if (left === right) return true
  const bare = (value: string) =>
    value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value
  return bare(left) === bare(right)
}

/**
 * Hermes metadata backup for a composer-selected model.
 * Dashboard /api/model/info only returns the profile default — when the
 * picker selects another model, fall through to models.dev disk cache
 * (same catalog Hermes uses).
 */
function resolveBackupContextWindow(
  preferredModel: string,
  configured: ResolvedModelContext | null,
): { model: string; maxTokens: number } {
  const preferred = preferredModel.trim()
  if (
    configured &&
    configured.maxTokens > 0 &&
    (!preferred || modelKeysMatch(preferred, configured.model))
  ) {
    return {
      model: preferred || configured.model,
      maxTokens: configured.maxTokens,
    }
  }
  if (preferred) {
    const fromCatalog = lookupModelsDevContextWindow(preferred)
    if (fromCatalog > 0) {
      return { model: preferred, maxTokens: fromCatalog }
    }
  }
  if (configured && configured.maxTokens > 0) {
    return {
      model: preferred || configured.model,
      maxTokens: configured.maxTokens,
    }
  }
  return { model: preferred || configured?.model || '', maxTokens: 0 }
}

function authHeaders(): Record<string, string> {
  const token = resolveChatGateway().token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function gatewayOrigin(): string {
  return resolveChatGateway().url
}

export function parseCompressionSettings(
  config: Record<string, unknown> | null | undefined,
): CompressionSettings {
  const compression = config?.compression
  if (
    !compression ||
    typeof compression !== 'object' ||
    Array.isArray(compression)
  ) {
    return {
      thresholdRatio: DEFAULT_COMPRESSION_THRESHOLD,
      thresholdTokensCap: 0,
    }
  }
  const record = compression as Record<string, unknown>
  const rawRatio = Number(record.threshold)
  const thresholdRatio =
    Number.isFinite(rawRatio) && rawRatio > 0 && rawRatio <= 1
      ? rawRatio
      : DEFAULT_COMPRESSION_THRESHOLD
  const rawCap = Number(record.threshold_tokens)
  const thresholdTokensCap =
    Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : 0
  return { thresholdRatio, thresholdTokensCap }
}

/**
 * Match Hermes agent: ratio of context window, optionally capped by
 * compression.threshold_tokens (lower of ratio vs absolute).
 */
export function computeThresholdTokens(
  maxTokens: number,
  explicitThreshold?: unknown,
  thresholdRatio: number = DEFAULT_COMPRESSION_THRESHOLD,
  thresholdTokensCap: number = 0,
): number {
  const explicit = Number(explicitThreshold) || 0
  if (explicit > 0) return explicit
  if (maxTokens <= 0) return 0
  const safeRatio =
    Number.isFinite(thresholdRatio) && thresholdRatio > 0 && thresholdRatio <= 1
      ? thresholdRatio
      : DEFAULT_COMPRESSION_THRESHOLD
  let threshold = Math.floor(maxTokens * safeRatio)
  if (thresholdTokensCap > 0) {
    threshold = Math.min(threshold, thresholdTokensCap, maxTokens)
  }
  return threshold
}

function computeCacheHitPercent(
  cacheReadTokens: number,
  cacheWriteTokens: number,
  explicit?: unknown,
): number | null {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.min(100, Math.max(0, Math.round(explicit)))
  }
  // Need both sides — read-only cumulative totals otherwise always look like 100%.
  if (cacheReadTokens <= 0 || cacheWriteTokens <= 0) return null
  const promptTotal = cacheReadTokens + cacheWriteTokens
  return Math.min(100, Math.round((cacheReadTokens / promptTotal) * 100))
}

function buildSnapshot(partial: {
  contextPercent: number
  maxTokens: number
  usedTokens: number
  model: string
  staticTokens?: number
  conversationTokens?: number
  thresholdTokens?: number
  thresholdRatio?: number
  thresholdTokensCap?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cacheHitPercent?: number | null
}): ContextUsageSnapshot {
  const maxTokens = partial.maxTokens
  const cacheReadTokens = partial.cacheReadTokens ?? 0
  const cacheWriteTokens = partial.cacheWriteTokens ?? 0
  return {
    ok: true,
    contextPercent: partial.contextPercent,
    maxTokens,
    usedTokens: partial.usedTokens,
    model: partial.model,
    staticTokens: partial.staticTokens ?? 0,
    conversationTokens: partial.conversationTokens ?? partial.usedTokens,
    thresholdTokens: computeThresholdTokens(
      maxTokens,
      partial.thresholdTokens,
      partial.thresholdRatio,
      partial.thresholdTokensCap,
    ),
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitPercent:
      partial.cacheHitPercent ??
      computeCacheHitPercent(cacheReadTokens, cacheWriteTokens),
  }
}

function configuredEmptySnapshot(
  configuredModelContext: ResolvedModelContext | null,
  compression: CompressionSettings,
): ContextUsageSnapshot {
  return buildSnapshot({
    contextPercent: 0,
    maxTokens: configuredModelContext?.maxTokens || 0,
    usedTokens: 0,
    model: configuredModelContext?.model || '',
    thresholdRatio: compression.thresholdRatio,
    thresholdTokensCap: compression.thresholdTokensCap,
  })
}

function readConfiguredContextLength(payload: Record<string, unknown>): number {
  const direct = [
    payload.effective_context_length,
    payload.config_context_length,
    payload.auto_context_length,
    payload.context_length,
  ]
    .map((value) => Number(value) || 0)
    .find((value) => value > 0)
  if (direct && direct > 0) return direct

  const capabilities = payload.capabilities
  if (
    capabilities &&
    typeof capabilities === 'object' &&
    !Array.isArray(capabilities)
  ) {
    const contextWindow = Number(
      (capabilities as Record<string, unknown>).context_window,
    )
    if (contextWindow > 0) return contextWindow
  }

  return 0
}

async function parseJsonObject(
  response: Response | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (!response?.ok) return null
  const payload = (await response.json()) as unknown
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  return payload as Record<string, unknown>
}

/**
 * Prefer gateway, then dashboard when allowed. Local Agorax zero-fork keeps
 * `shouldUseDashboard()` false for control-plane writes — see
 * `fetchHermesModelInfo` for the model/info exception.
 */
async function fetchGatewayJson(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const gatewayPayload = await parseJsonObject(
      await fetch(`${gatewayOrigin()}${path}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(2500),
      }),
    )
    if (gatewayPayload) return gatewayPayload

    if (!shouldUseDashboard()) return null

    return await parseJsonObject(
      await dashboardFetch(path, {
        signal: AbortSignal.timeout(2500),
      }),
    )
  } catch {
    return null
  }
}

/**
 * Hermes context windows are resolved on the Agent Dashboard web server
 * (`GET /api/model/info` → models.dev / OpenRouter / overrides), not on the
 * gateway api_server (:8642). Zero-fork still needs that read for the composer
 * meter; the endpoint is public on :9119 (no dashboard auth).
 */
async function fetchHermesModelInfo(): Promise<Record<string, unknown> | null> {
  const fromGateway = await fetchGatewayJson('/api/model/info')
  if (fromGateway) return fromGateway
  try {
    const base = (CLAUDE_DASHBOARD_URL || 'http://127.0.0.1:9119').replace(
      /\/$/,
      '',
    )
    return await parseJsonObject(
      await fetch(`${base}/api/model/info`, {
        signal: AbortSignal.timeout(2500),
      }),
    )
  } catch {
    return null
  }
}

function readLocalCompressionSettings(
  profileName?: string,
): CompressionSettings {
  try {
    const files = readHermesConfigFiles(
      resolveHermesConfigPaths(profileName),
    )
    return parseCompressionSettings(files.config)
  } catch {
    return {
      thresholdRatio: DEFAULT_COMPRESSION_THRESHOLD,
      thresholdTokensCap: 0,
    }
  }
}

async function readCompressionSettings(
  profileName?: string,
): Promise<CompressionSettings> {
  // Named Hermes agents own profiles/<id>/config.yaml. Gateway api_server
  // has no /api/config, so read the profile file directly (not root ~/.hermes).
  return readLocalCompressionSettings(profileName)
}

async function readConfiguredModelContext(): Promise<ResolvedModelContext | null> {
  try {
    const payload = await fetchHermesModelInfo()
    if (!payload) return null
    const model = typeof payload.model === 'string' ? payload.model.trim() : ''
    // Only Hermes-reported lengths (models.dev / OpenRouter / overrides).
    // No local config.yaml invent and no Agorax static model table.
    const maxTokens = readConfiguredContextLength(payload)
    if (model || maxTokens > 0) {
      return { model, maxTokens }
    }
  } catch {
    /* gateway/dashboard unreachable — caller may still use per-session cache */
  }
  return null
}

async function readGatewayRuntimeSnapshot(
  sessionId: string,
  compression: CompressionSettings,
  configuredModelContext: ResolvedModelContext | null,
): Promise<ContextUsageSnapshot | null> {
  const sid = sessionId.trim()
  if (!sid) return null
  try {
    const res = await fetch(
      `${gatewayOrigin()}/api/sessions/${encodeURIComponent(sid)}/runtime`,
      {
        headers: authHeaders(),
        signal: AbortSignal.timeout(2500),
      },
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      model?: unknown
      context_tokens?: unknown
      last_prompt_tokens?: unknown
      context_length?: unknown
      effective_context_length?: unknown
      context_percent?: unknown
      prompt_tokens?: unknown
      threshold_tokens?: unknown
      cache_read_tokens?: unknown
      cache_write_tokens?: unknown
      cache_hit_percent?: unknown
    }
    const model =
      (typeof data.model === 'string' && data.model.trim()) ||
      configuredModelContext?.model ||
      ''
    const sessionContextLength =
      Number(data.context_length) || Number(data.effective_context_length) || 0
    const maxTokens = resolveSessionContextWindow(
      sid,
      model,
      configuredModelContext?.maxTokens,
      sessionContextLength,
    )
    // Prefer true prompt-context fields. Never use cumulative total/input
    // billing tokens — those produce 0/0 or nonsense meters when context_*
    // is missing from /runtime.
    const usedTokens =
      Number(data.context_tokens) ||
      Number(data.last_prompt_tokens) ||
      Number(data.prompt_tokens) ||
      0
    const reportedPercent = Number(data.context_percent)
    const contextPercent =
      Number.isFinite(reportedPercent) && reportedPercent > 0
        ? reportedPercent
        : maxTokens > 0 && usedTokens > 0
          ? Math.round((usedTokens / maxTokens) * 1000) / 10
          : 0
    // Incomplete cache/model-only payloads must not short-circuit the meter.
    if (maxTokens <= 0) return null
    if (usedTokens <= 0 && contextPercent <= 0) return null

    return buildSnapshot({
      contextPercent,
      maxTokens,
      usedTokens,
      model,
      thresholdTokens: Number(data.threshold_tokens) || undefined,
      thresholdRatio: compression.thresholdRatio,
      thresholdTokensCap: compression.thresholdTokensCap,
      cacheReadTokens: Number(data.cache_read_tokens) || 0,
      cacheWriteTokens: Number(data.cache_write_tokens) || 0,
      cacheHitPercent:
        typeof data.cache_hit_percent === 'number'
          ? data.cache_hit_percent
          : null,
    })
  } catch {
    return null
  }
}

async function resolveRuntimeSessionId(sessionId: string): Promise<string> {
  const trimmed = sessionId.trim()
  if (trimmed !== 'main') return trimmed

  const capabilities = getCapabilities()
  if (
    shouldBindMainToPortableSession({
      sessionKey: trimmed,
      dashboardAvailable: capabilities.dashboard.available,
      enhancedChat: capabilities.enhancedChat,
    })
  ) {
    return trimmed
  }

  try {
    const sessions = await listSessions(30, 0)
    return resolveMainChatSessionId(sessions) ?? trimmed
  } catch {
    return trimmed
  }
}

function normalizeComparableText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function extractComparableLocalTurns(
  messages: Array<{ role?: string; content?: string }>,
): Array<{ role: 'user' | 'assistant'; text: string }> {
  return messages
    .filter(
      (message): message is { role: 'user' | 'assistant'; content?: string } =>
        message.role === 'user' || message.role === 'assistant',
    )
    .map((message) => ({
      role: message.role,
      text: normalizeComparableText(message.content ?? ''),
    }))
    .filter((message) => message.text.length > 0)
}

async function resolveMirroredRuntimeSessionId(
  sessionId: string,
): Promise<string | null> {
  const localSession = getLocalSession(sessionId)
  if (!localSession) return null

  const localTurns = extractComparableLocalTurns(getLocalMessages(sessionId))
  if (localTurns.length < 2) return null

  const localCreatedAt = localSession.createdAt / 1000
  const localUpdatedAt = localSession.updatedAt / 1000

  try {
    const sessions = await listSessions(20, 0)
    const candidate = sessions
      .filter((session) => {
        if (!session?.id || session.id === sessionId) return false
        if (session.source === 'local') return false

        const startedAt = Number(session.started_at) || 0
        const updatedAt = Number(session.last_active) || startedAt
        if (startedAt <= 0 || updatedAt <= 0) return false

        return (
          startedAt >= localCreatedAt - 5 &&
          startedAt <= localUpdatedAt + 300 &&
          updatedAt <= localUpdatedAt + 300
        )
      })
      .sort((a, b) => {
        const aStarted = Number(a.started_at) || 0
        const bStarted = Number(b.started_at) || 0
        const aUpdated = Number(a.last_active) || Number(a.started_at) || 0
        const bUpdated = Number(b.last_active) || Number(b.started_at) || 0
        const aStartDistance = Math.abs(aStarted - localUpdatedAt)
        const bStartDistance = Math.abs(bStarted - localUpdatedAt)
        if (aStartDistance !== bStartDistance) {
          return aStartDistance - bStartDistance
        }
        return bUpdated - aUpdated
      })[0]

    return candidate?.id ?? null
  } catch {
    return null
  }
}

export async function readContextUsage(
  sessionId = '',
  options: { model?: string; profile?: string } = {},
): Promise<ContextUsageSnapshot> {
  try {
    let sessionData: Record<string, unknown> | null = null
    let fallbackSnapshot: ContextUsageSnapshot | null = null
    const explicitSessionId = sessionId.trim()
    const preferredModel = (options.model || '').trim()
    const profileName = (options.profile || '').trim()
    const capabilities = await ensureGatewayProbed()
    const [configuredModelContext, compression] = await Promise.all([
      readConfiguredModelContext(),
      readCompressionSettings(profileName || undefined),
    ])
    const backup = resolveBackupContextWindow(
      preferredModel,
      configuredModelContext,
    )
    const backupContext: ResolvedModelContext | null =
      backup.maxTokens > 0 || backup.model
        ? { model: backup.model, maxTokens: backup.maxTokens }
        : null
    const resolvedSessionId = explicitSessionId
      ? await resolveRuntimeSessionId(explicitSessionId)
      : ''

    if (explicitSessionId) {
      const liveRuntime = await readGatewayRuntimeSnapshot(
        resolvedSessionId,
        compression,
        backupContext,
      )
      if (liveRuntime) {
        // Prefer composer-selected model label when runtime omitted it.
        if (preferredModel && !liveRuntime.model) {
          return { ...liveRuntime, model: preferredModel }
        }
        return liveRuntime
      }

      const localSession = getLocalSession(explicitSessionId)
      const localMessages = getLocalMessages(explicitSessionId)
      const activeRun = await getActiveRunForSession(explicitSessionId)
      if (localSession) {
        const mirroredRuntimeSessionId =
          await resolveMirroredRuntimeSessionId(explicitSessionId)
        if (mirroredRuntimeSessionId) {
          const mirroredRuntime = await readGatewayRuntimeSnapshot(
            mirroredRuntimeSessionId,
            compression,
            backupContext,
          )
          if (mirroredRuntime) {
            if (preferredModel && !mirroredRuntime.model) {
              return { ...mirroredRuntime, model: preferredModel }
            }
            return mirroredRuntime
          }
        }

        const pendingMessages = activeRun?.assistantText
          ? [
              ...localMessages,
              {
                role: 'assistant',
                content: activeRun.assistantText,
                text: activeRun.assistantText,
              },
            ]
          : localMessages
        const usedTokens = estimateContextTokensFromMessages(pendingMessages)
        const model =
          preferredModel ||
          localSession.model ||
          backupContext?.model ||
          ''
        const maxTokens = resolveSessionContextWindow(
          explicitSessionId,
          model,
          backupContext?.maxTokens,
        )
        const contextPercent =
          maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 1000) / 10 : 0
        fallbackSnapshot = buildSnapshot({
          contextPercent,
          maxTokens,
          usedTokens,
          model,
          thresholdRatio: compression.thresholdRatio,
          thresholdTokensCap: compression.thresholdTokensCap,
        })
      } else if (localMessages.length > 0 || activeRun?.assistantText) {
        const pendingMessages = activeRun?.assistantText
          ? [
              ...localMessages,
              {
                role: 'assistant',
                content: activeRun.assistantText,
                text: activeRun.assistantText,
              },
            ]
          : localMessages
        const usedTokens = estimateContextTokensFromMessages(pendingMessages)
        const model = preferredModel || backupContext?.model || ''
        const maxTokens = resolveSessionContextWindow(
          explicitSessionId,
          model,
          backupContext?.maxTokens,
        )
        const contextPercent =
          maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 1000) / 10 : 0
        fallbackSnapshot = buildSnapshot({
          contextPercent,
          maxTokens,
          usedTokens,
          model,
          thresholdRatio: compression.thresholdRatio,
          thresholdTokensCap: compression.thresholdTokensCap,
        })
      }
    }

    if (explicitSessionId) {
      try {
        const res = capabilities.dashboard.available
          ? await dashboardFetch(
              `/api/sessions/${encodeURIComponent(resolvedSessionId)}`,
              {
                signal: AbortSignal.timeout(3000),
              },
            )
          : await fetch(
              `${gatewayOrigin()}/api/sessions/${encodeURIComponent(resolvedSessionId)}`,
              {
                headers: authHeaders(),
                signal: AbortSignal.timeout(3000),
              },
            )
        if (res.ok) {
          const data = (await res.json()) as {
            session?: Record<string, unknown>
          } & Record<string, unknown>
          sessionData = capabilities.dashboard.available
            ? data
            : (data.session ?? null)
        }
      } catch {
        /* ignore */
      }
    }

    // If the caller asked for a specific session and neither the local store nor
    // the gateway has it, return the configured context window without inheriting
    // unrelated conversation usage from another session.
    if (explicitSessionId && !sessionData) {
      return (
        fallbackSnapshot ??
        configuredEmptySnapshot(backupContext, compression)
      )
    }

    if (!explicitSessionId) {
      return configuredEmptySnapshot(backupContext, compression)
    }

    if (!sessionData) {
      return (
        fallbackSnapshot ??
        configuredEmptySnapshot(backupContext, compression)
      )
    }

    const model =
      preferredModel ||
      String(sessionData.model || '') ||
      backupContext?.model ||
      ''
    const sessionContextLength = Number(sessionData.context_length) || 0
    const maxTokens = resolveSessionContextWindow(
      explicitSessionId,
      model,
      backupContext?.maxTokens,
      sessionContextLength,
    )
    const cacheReadTokens = Number(sessionData.cache_read_tokens) || 0
    const cacheWriteTokens = Number(sessionData.cache_write_tokens) || 0
    const inputTokens = Number(sessionData.input_tokens) || 0
    const messageCount = Number(sessionData.message_count) || 0
    const apiCallCount = Number(sessionData.api_call_count) || 0

    let usedTokens = 0
    const lastPromptTokens =
      Number(sessionData.last_prompt_tokens) ||
      Number(sessionData.context_tokens) ||
      0
    if (lastPromptTokens > 0) {
      usedTokens = lastPromptTokens
    } else if (apiCallCount > 0) {
      usedTokens = estimateContextTokensFromSessionUsage(
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        apiCallCount,
      )
    } else if (cacheReadTokens > 0 && messageCount > 0) {
      usedTokens = estimateContextTokensFromCacheRead(
        cacheReadTokens,
        messageCount,
      )
    } else if (messageCount > 0) {
      try {
        const targetSessionId =
          resolvedSessionId || String(sessionData.id || '')
        if (targetSessionId) {
          const capabilitiesNow = getCapabilities()
          const msgRes = capabilitiesNow.dashboard.available
            ? await dashboardFetch(
                `/api/sessions/${encodeURIComponent(targetSessionId)}/messages`,
                {
                  signal: AbortSignal.timeout(5000),
                },
              )
            : await fetch(
                `${gatewayOrigin()}/api/sessions/${encodeURIComponent(targetSessionId)}/messages`,
                {
                  headers: authHeaders(),
                  signal: AbortSignal.timeout(5000),
                },
              )
          if (msgRes.ok) {
            const msgData = (await msgRes.json()) as {
              items?: Array<{
                content?: string
                tool_calls?: unknown
                reasoning?: string
              }>
              messages?: Array<{
                content?: string
                tool_calls?: unknown
                reasoning?: string
              }>
            }
            const messages = capabilitiesNow.dashboard.available
              ? (msgData.messages ?? [])
              : (msgData.items ?? [])
            usedTokens = estimateContextTokensFromMessages(messages)
          }
        }
      } catch {
        /* ignore */
      }
    }

    usedTokens = Math.min(usedTokens, maxTokens)
    const contextPercent =
      maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 1000) / 10 : 0

    return buildSnapshot({
      contextPercent,
      maxTokens,
      usedTokens,
      model,
      thresholdTokens: Number(sessionData.threshold_tokens) || undefined,
      thresholdRatio: compression.thresholdRatio,
      thresholdTokensCap: compression.thresholdTokensCap,
      cacheReadTokens,
      cacheWriteTokens,
      cacheHitPercent: computeCacheHitPercent(
        cacheReadTokens,
        cacheWriteTokens,
        sessionData.cache_hit_percent,
      ),
    })
  } catch {
    // Unknown window → hide ContextIndicator (maxTokens 0). Do not invent.
    return buildSnapshot({
      contextPercent: 0,
      maxTokens: 0,
      usedTokens: 0,
      model: '',
      thresholdRatio: DEFAULT_COMPRESSION_THRESHOLD,
    })
  }
}
