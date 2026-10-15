import type { AgentProbeResult } from './types'
import {
  type AgentProviderInstallResultDto,
  type AgentProviderLoginResultDto,
  type AgentProviderStatusListDto,
} from '@/lib/managed-agent-runtime/provider-status'
import { AgoraxManagedRunStore } from './agorax-managed-run-store'
import type { AgoraxManagedPromptContentBlock } from './agorax-managed-prompt-content'
import {
  agoraxAgentTargetIdForBackend,
  type AgoraxManagedAgentBackend,
} from '@/lib/managed-agent-runtime/agent-targets'
import type {
  AgentActivityDurableMessage,
  AgentActivitySession,
} from '@agorax/agent-activity-core'
import {
  agentActivityMessageFromDaemonMessage,
  agentActivitySessionDetailFromDaemon,
  agentActivitySessionFromDaemonSession,
  type AgentActivityDaemonActivityDetail,
  type DaemonAgentSessionsListResponse,
  type DaemonCanonicalSession,
  type DaemonCreateAgentSessionRequest,
  type DaemonCreateSessionResponse,
  type DaemonProviderComposerOptionsResponse,
  type DaemonSendAgentSessionInputRequest,
  type DaemonSendInputResponse,
  type DaemonSessionActivityResponse,
  type DaemonSubmitInteractiveResponse,
} from '@agorax/agent-activity-daemon-adapter'
import { compactDaemonActivityForClient } from './compact-activity-payload'

/**
 * Fallback user identity for canonical session mapping. The daemon owns real
 * session user ids; this value is only used when a canonical session row
 * carries an empty UserID.
 */
export const AGORAX_MANAGED_AGENT_USER_ID = 'agorax-local-user'

export type AgoraxManagedAgentHttpClientOptions = {
  baseUrl: string
  workspaceId: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}

/** Transport/daemon HTTP failure that preserves the upstream status code. */
export class AgoraxManagedAgentHttpError extends Error {
  readonly status: number
  readonly path: string
  /** Daemon-reported error detail (the response body's `error` field). */
  readonly detail: string

  constructor(status: number, path: string, detail = '') {
    super(
      detail
        ? `Agorax Managed Agent request failed: ${status} ${path}: ${detail}`
        : `Agorax Managed Agent request failed: ${status} ${path}`,
    )
    this.name = 'AgoraxManagedAgentHttpError'
    this.status = status
    this.path = path
    this.detail = detail
  }
}

export type CreateAgoraxAgentSessionInput = {
  backend: AgoraxManagedAgentBackend
  agentSessionId: string
  clientSubmitId: string
  content: string
  promptContent?: Array<AgoraxManagedPromptContentBlock>
  /** UI-only text when content/promptContent carry injected skills. */
  displayPrompt?: string
  cwd?: string
  model?: string
  title?: string
  reasoningEffort?: string
  mcpEndpoint?: string
  mcpRunToken?: string
  mcpToolAllowlist?: string[]
}

export type SendAgoraxAgentInput = {
  content: string
  promptContent?: Array<AgoraxManagedPromptContentBlock>
  /** UI-only text when content/promptContent carry injected skills. */
  displayPrompt?: string
  clientSubmitId: string
}

type CanonicalSessionProjection = {
  id: string
  activeTurnId: string | null
}

type CanonicalTurnProjection = {
  turnId: string
}

type CreateSessionResponse = {
  session: CanonicalSessionProjection
}

type SendInputResponse = {
  kind: 'turn'
  session: CanonicalSessionProjection
  turnId: string
  turn: CanonicalTurnProjection
}

export { agoraxAgentTargetIdForBackend, type AgoraxManagedAgentBackend }

/**
 * Thin Agorax transport client for the embedded Managed Agent daemon API.
 *
 * It returns the embedded daemon's canonical JSON projections without creating an Agorax
 * session store or translating them into the legacy managed-chat schema.
 */
/** Share one /v1/agent-targets fetch across all managed backends in probeAll. */
const AGENT_TARGETS_CACHE_TTL_MS = 15_000

export class AgoraxManagedAgentHttpClient {
  private readonly baseUrl: string
  private readonly workspaceId: string
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof fetch
  private agentTargetsCache: {
    at: number
    agents: Array<Record<string, unknown>>
  } | null = null
  private agentTargetsInflight: Promise<Array<Record<string, unknown>>> | null =
    null

  constructor(options: AgoraxManagedAgentHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.workspaceId = options.workspaceId.trim()
    this.headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    }
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async listAgentTargets(): Promise<Array<Record<string, unknown>>> {
    if (
      this.agentTargetsCache &&
      Date.now() - this.agentTargetsCache.at < AGENT_TARGETS_CACHE_TTL_MS
    ) {
      return this.agentTargetsCache.agents
    }
    if (this.agentTargetsInflight) return this.agentTargetsInflight

    this.agentTargetsInflight = (async () => {
      const response = await this.requestJson<{
        agents?: Array<Record<string, unknown>>
      }>('/v1/agent-targets', {
        method: 'GET',
        signal: AbortSignal.timeout(2_000),
      })
      const agents = Array.isArray(response.agents) ? response.agents : []
      this.agentTargetsCache = { at: Date.now(), agents }
      return agents
    })().finally(() => {
      this.agentTargetsInflight = null
    })
    return this.agentTargetsInflight
  }

  async probe(backend: AgoraxManagedAgentBackend): Promise<AgentProbeResult> {
    const agents = await this.listAgentTargets()
    const targetId = agoraxAgentTargetIdForBackend(backend)
    const target = agents.find((candidate) => candidate.id === targetId)
    if (!target) {
      return {
        available: false,
        detail: `Agorax managed target ${targetId} is not registered`,
      }
    }
    if (target.enabled === false) {
      return {
        available: false,
        detail: `Agorax managed target ${targetId} is disabled`,
      }
    }
    return {
      available: true,
      detail: `Agorax managed target ${targetId} is ready`,
    }
  }

  /** GET /v1/provider-status — the daemon's provider runtime aggregate. */
  async getProviderStatus(options?: {
    refresh?: boolean
  }): Promise<AgentProviderStatusListDto> {
    const path = options?.refresh
      ? '/v1/provider-status?refresh=1'
      : '/v1/provider-status'
    return this.requestJson<AgentProviderStatusListDto>(path, {
      method: 'GET',
    })
  }

  /** POST /v1/providers/{provider}/install — managed npm install/upgrade. */
  async installProvider(
    provider: string,
    options?: { version?: string },
  ): Promise<AgentProviderInstallResultDto> {
    const version = options?.version?.trim() ?? ''
    return this.requestJson<AgentProviderInstallResultDto>(
      `/v1/providers/${encodeURIComponent(provider)}/install`,
      {
        method: 'POST',
        body: JSON.stringify(version ? { version } : {}),
      },
    )
  }

  /** POST /v1/providers/{provider}/enable — enable or disable a provider runtime. */
  async setProviderEnabled(
    provider: string,
    enabled: boolean,
  ): Promise<{ provider: string; enabled: boolean }> {
    return this.requestJson<{ provider: string; enabled: boolean }>(
      `/v1/providers/${encodeURIComponent(provider)}/enable`,
      {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      },
    )
  }

  /** POST /v1/providers/{provider}/login — return login argv for web PTY. */
  async loginProvider(
    provider: string,
    options?: { preferWebTerminal?: boolean },
  ): Promise<AgentProviderLoginResultDto> {
    return this.requestJson<AgentProviderLoginResultDto>(
      `/v1/providers/${encodeURIComponent(provider)}/login`,
      {
        method: 'POST',
        body: JSON.stringify({
          preferWebTerminal: options?.preferWebTerminal ?? true,
        }),
      },
    )
  }

  async createSession(
    input: CreateAgoraxAgentSessionInput,
  ): Promise<CreateSessionResponse> {
    return normalizeCreateSessionResponse(await this.createSessionRaw(input))
  }

  createSessionRaw(
    input: CreateAgoraxAgentSessionInput,
    options?: { signal?: AbortSignal },
  ): Promise<DaemonCreateSessionResponse> {
    const displayPrompt = input.displayPrompt?.trim() ?? ''
    return this.createAgentSessionRequest(
      {
        agentSessionId: input.agentSessionId,
        agentTargetId: agoraxAgentTargetIdForBackend(input.backend),
        clientSubmitId: input.clientSubmitId,
        initialContent: input.promptContent ?? [
          { type: 'text', text: input.content },
        ],
        ...(displayPrompt ? { displayPrompt } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort
          ? { reasoningEffort: input.reasoningEffort }
          : {}),
        ...(input.mcpEndpoint ? { mcpEndpoint: input.mcpEndpoint } : {}),
        ...(input.mcpRunToken ? { mcpRunToken: input.mcpRunToken } : {}),
        ...(input.mcpToolAllowlist?.length
          ? { mcpToolAllowlist: input.mcpToolAllowlist }
          : {}),
      },
      options,
    )
  }

  /**
   * POST .../agent-sessions with a pre-built daemon request DTO, returning
   * the daemon response in its wire DTO shape (`DaemonCreateSessionResponse`).
   * Canonical mapping happens in the activity adapter, which owns the core
   * projection.
   */
  createAgentSessionRequest(
    request: DaemonCreateAgentSessionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<DaemonCreateSessionResponse> {
    return this.requestJson<DaemonCreateSessionResponse>(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions`,
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
      options?.signal,
    )
  }

  sendInput(
    agentSessionId: string,
    input: SendAgoraxAgentInput,
    options?: { signal?: AbortSignal },
  ): Promise<SendInputResponse> {
    return this.sendInputRaw(agentSessionId, input, options).then((response) =>
      normalizeSendInputResponse(response, agentSessionId),
    )
  }

  sendInputRaw(
    agentSessionId: string,
    input: SendAgoraxAgentInput,
    options?: { signal?: AbortSignal },
  ): Promise<DaemonSendInputResponse> {
    const displayPrompt = input.displayPrompt?.trim() ?? ''
    return this.sendAgentSessionInputRequest(
      agentSessionId,
      {
        clientSubmitId: input.clientSubmitId,
        content: input.promptContent ?? [{ type: 'text', text: input.content }],
        ...(displayPrompt ? { displayPrompt } : {}),
      },
      options,
    )
  }

  /** POST .../input with a pre-built daemon request DTO, un-normalized. */
  sendAgentSessionInputRequest(
    agentSessionId: string,
    request: DaemonSendAgentSessionInputRequest,
    options?: { signal?: AbortSignal },
  ): Promise<DaemonSendInputResponse> {
    return this.requestJson<DaemonSendInputResponse>(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/input`,
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
      options?.signal,
    )
  }

  async createSessionForRun(input: {
    runId: string
    session: CreateAgoraxAgentSessionInput
    runStore: AgoraxManagedRunStore
  }): Promise<CreateSessionResponse> {
    const response = await this.createSession(input.session)
    await input.runStore.bind({
      runId: input.runId,
      backend: input.session.backend,
      agentSessionId: response.session.id,
      ...(response.session.activeTurnId
        ? { turnId: response.session.activeTurnId }
        : {}),
    })
    return response
  }

  /**
   * Canonical activity detail for one session: the daemon's GET .../activity
   * aggregate mapped through the daemon-adapter into a core detail snapshot
   * (with messages and interactions). The daemon exposes no standalone
   * session-get route; the activity aggregate is the authoritative read.
   */
  async getSessionDetail(
    agentSessionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<AgentActivityDaemonActivityDetail> {
    const activity = await this.requestJson<DaemonSessionActivityResponse>(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/activity`,
      { method: 'GET' },
      options?.signal,
    )
    // Drop injected skill bodies from the UI wire (displayPrompt stays).
    const compact = compactDaemonActivityForClient(
      activity as unknown as Record<string, unknown>,
    ) as unknown as DaemonSessionActivityResponse
    return agentActivitySessionDetailFromDaemon(
      this.workspaceId,
      agentSessionId,
      compact,
      { currentUserId: AGORAX_MANAGED_AGENT_USER_ID },
    )
  }

  /**
   * Canonical session list for this client's workspace (empty list when the
   * workspace has no sessions). PascalCase daemon rows are mapped through the
   * daemon-adapter; the response never exposes wire field names.
   */
  async listSessions(options?: {
    signal?: AbortSignal
    /** When set, only map sessions for this daemon target (avoids O(workspace) map cost). */
    agentTargetId?: string
  }): Promise<AgentActivitySession[]> {
    const response = await this.requestJson<DaemonAgentSessionsListResponse>(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions`,
      { method: 'GET' },
      options?.signal,
    )
    const sessions = Array.isArray(response.sessions) ? response.sessions : []
    const target = options?.agentTargetId?.trim()
    const filtered = target
      ? sessions.filter((session) => session.AgentTargetID === target)
      : sessions
    return filtered.map((session) =>
      agentActivitySessionFromDaemonSession(this.workspaceId, session, {
        currentUserId: AGORAX_MANAGED_AGENT_USER_ID,
      }),
    )
  }

  /**
   * One page of canonical durable messages plus the messageVersion
   * high-water cursor. Reads ascend from `afterVersion` (daemon activity
   * paging; default page size and hard cap are owned by the daemon).
   */
  async listSessionMessages(
    agentSessionId: string,
    options?: { afterVersion?: number; limit?: number; signal?: AbortSignal },
  ): Promise<{
    messages: AgentActivityDurableMessage[]
    latestVersion: number
    hasMore: boolean
  }> {
    const query = new URLSearchParams()
    if (options?.afterVersion !== undefined) {
      query.set('afterVersion', String(options.afterVersion))
    }
    if (options?.limit !== undefined) query.set('limit', String(options.limit))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const activityRaw = await this.requestJson<DaemonSessionActivityResponse>(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/activity${suffix}`,
      { method: 'GET' },
      options?.signal,
    )
    const activity = compactDaemonActivityForClient(
      activityRaw as unknown as Record<string, unknown>,
    ) as unknown as DaemonSessionActivityResponse
    if (
      typeof activity.messageVersion !== 'number' ||
      !Number.isSafeInteger(activity.messageVersion) ||
      activity.messageVersion < 0 ||
      typeof activity.hasMoreMessages !== 'boolean'
    ) {
      throw new Error(
        'Agorax Managed Agent activity response is missing the messageVersion/hasMoreMessages paging cursor',
      )
    }
    const messages = Array.isArray(activity.messages) ? activity.messages : []
    return {
      messages: messages.map((message) =>
        agentActivityMessageFromDaemonMessage(this.workspaceId, message),
      ),
      latestVersion: activity.messageVersion,
      hasMore: activity.hasMoreMessages,
    }
  }

  async getActivitySnapshot(agentSessionId: string): Promise<unknown> {
    const activity = await this.requestJson(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/activity`,
      { method: 'GET' },
    )
    return compactDaemonActivityForClient(
      activity as Record<string, unknown>,
    )
  }

  listInteractions(agentSessionId: string): Promise<{
    workspaceId: string
    agentSessionId: string
    interactions: Array<unknown>
  }> {
    return this.requestJson(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/interactions`,
      { method: 'GET' },
    )
  }

  cancelTurn(agentSessionId: string, turnId: string): Promise<unknown> {
    return this.requestJson(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
      { method: 'POST' },
    )
  }

  respondToInteraction(input: {
    agentSessionId: string
    turnId: string
    requestId: string
    action?: string
    optionId?: string
    payload?: Record<string, unknown>
  }): Promise<unknown> {
    return this.respondToInteractionRaw(input)
  }

  /** POST .../interactions/{requestId}/response, un-normalized wire DTO. */
  respondToInteractionRaw(
    input: {
      agentSessionId: string
      turnId: string
      requestId: string
      action?: string
      optionId?: string
      payload?: Record<string, unknown>
    },
    options?: { signal?: AbortSignal },
  ): Promise<DaemonSubmitInteractiveResponse> {
    return this.requestJson<DaemonSubmitInteractiveResponse>(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(input.agentSessionId)}/turns/${encodeURIComponent(input.turnId)}/interactions/${encodeURIComponent(input.requestId)}/response`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...(input.action ? { action: input.action } : {}),
          ...(input.optionId ? { optionId: input.optionId } : {}),
          ...(input.payload ? { payload: input.payload } : {}),
        }),
      },
      options?.signal,
    )
  }

  updateTitle(
    agentSessionId: string,
    title: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ Canonical?: DaemonCanonicalSession }> {
    return this.requestJson(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/title`,
      { method: 'PATCH', body: JSON.stringify({ title }) },
      options?.signal,
    )
  }

  deleteSession(
    agentSessionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<{
    Deleted?: boolean
    CleanupFailed?: boolean
    CanonicalRemoved?: boolean
  }> {
    return this.requestJson(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}`,
      { method: 'DELETE' },
      options?.signal,
    )
  }

  updatePin(
    agentSessionId: string,
    pinned: boolean,
    options?: { signal?: AbortSignal },
  ): Promise<{ Canonical?: DaemonCanonicalSession }> {
    return this.requestJson(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/pin`,
      { method: 'POST', body: JSON.stringify({ pinned }) },
      options?.signal,
    )
  }

  updateSettings(
    agentSessionId: string,
    settings: { model?: string; reasoningEffort?: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ Canonical?: DaemonCanonicalSession }> {
    return this.requestJson(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/settings`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...(settings.model !== undefined ? { model: settings.model } : {}),
          ...(settings.reasoningEffort !== undefined
            ? { reasoningEffort: settings.reasoningEffort }
            : {}),
        }),
      },
      options?.signal,
    )
  }

  /**
   * Rebind an idle ACP session onto a new composer workspace cwd.
   * Daemon closes the live provider connection and session/new with the path.
   */
  remountSessionCwd(
    agentSessionId: string,
    cwd: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ remounted?: boolean; live?: boolean }> {
    return this.requestJson(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/cwd`,
      {
        method: 'POST',
        body: JSON.stringify({ cwd }),
      },
      options?.signal,
    )
  }

  getComposerOptions(input: {
    agentSessionId?: string | null
    provider?: string
    model?: string | null
    signal?: AbortSignal
  }): Promise<DaemonProviderComposerOptionsResponse> {
    const sessionId = input.agentSessionId?.trim()
    if (sessionId) {
      return this.requestJson(
        `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(sessionId)}/composer-options`,
        { method: 'GET' },
        input.signal,
      )
    }
    const provider = input.provider?.trim()
    if (!provider) {
      throw new Error('composer-options requires agentSessionId or provider')
    }
    const query = new URLSearchParams()
    if (input.model?.trim()) query.set('model', input.model.trim())
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return this.requestJson(
      `/v1/agent-providers/${encodeURIComponent(provider)}/composer-options${suffix}`,
      { method: 'GET' },
      input.signal,
    )
  }

  submitPlanDecision(
    input: {
      agentSessionId: string
      turnId: string
      requestId: string
      promptKind: string
      action: string
      idempotencyKey: string
    },
    options?: { signal?: AbortSignal },
  ): Promise<{ operation?: Record<string, unknown> }> {
    return this.requestJson(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(input.agentSessionId)}/turns/${encodeURIComponent(input.turnId)}/plan-decisions/${encodeURIComponent(input.requestId)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          promptKind: input.promptKind,
          action: input.action,
          idempotencyKey: input.idempotencyKey,
        }),
      },
      options?.signal,
    )
  }

  getGoal(
    agentSessionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    return this.requestJson(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/goal`,
      { method: 'GET' },
      options?.signal,
    )
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        ...(signal ? { signal } : {}),
        headers: {
          ...this.headers,
          ...(init.headers ?? {}),
        },
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // Node undici collapses connection-refused into bare "fetch failed".
      throw new Error(
        `managed agent daemon unreachable at ${this.baseUrl}${path} (${detail}); start with pnpm dev:managed-agent`,
      )
    }
    if (!response.ok) {
      throw new AgoraxManagedAgentHttpError(
        response.status,
        path,
        await readDaemonErrorDetail(response),
      )
    }
    return (await response.json()) as T
  }
}

/** Best-effort extraction of the daemon JSON error body's `error` field. */
async function readDaemonErrorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && 'error' in body) {
      const detail = (body as { error?: unknown }).error
      if (typeof detail === 'string' && detail.trim()) return detail.trim()
    }
  } catch {
    // Non-JSON or unreadable error bodies keep the generic status message.
  }
  return ''
}

function normalizeCreateSessionResponse(value: unknown): CreateSessionResponse {
  const record = asRecord(value)
  const canonical = asRecord(record?.Canonical) ?? asRecord(record?.session)
  const id = stringValue(canonical?.ID) || stringValue(canonical?.id)
  const activeTurnId =
    stringValue(canonical?.ActiveTurnID) ||
    stringValue(canonical?.activeTurnId) ||
    stringValue(record?.TurnID)
  if (!id)
    throw new Error(
      'Agorax Managed Agent create response has no canonical session id',
    )
  return { session: { id, activeTurnId: activeTurnId || null } }
}

function normalizeSendInputResponse(
  value: unknown,
  requestedSessionId: string,
): SendInputResponse {
  const record = asRecord(value)
  const canonical = asRecord(record?.Canonical) ?? asRecord(record?.session)
  const turn = asRecord(record?.Turn) ?? asRecord(record?.turn)
  const id =
    stringValue(canonical?.ID) ||
    stringValue(canonical?.id) ||
    requestedSessionId.trim()
  const turnId =
    stringValue(record?.TurnID) ||
    stringValue(record?.turnId) ||
    stringValue(turn?.TurnID) ||
    stringValue(turn?.turnId)
  if (!id || !turnId)
    throw new Error(
      'Agorax Managed Agent send response has incomplete canonical identity',
    )
  return {
    kind: 'turn',
    session: { id, activeTurnId: stringValue(canonical?.ActiveTurnID) || null },
    turnId,
    turn: { turnId },
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
