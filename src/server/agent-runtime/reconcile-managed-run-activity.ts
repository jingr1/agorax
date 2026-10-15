/**
 * HTTP fallback when the managed-agent WS misses a terminal turn_update.
 *
 * Group-chat drain normally ends on WS `run_exited`. When the daemon settles
 * the turn but the terminal frame is dropped/rejected, drain would otherwise
 * sit until the soft timeout and report "empty reply". GET .../activity is the
 * authoritative aggregate — use it to recover assistant text or turn errors.
 */
import { assistantTextFromActivityMessage } from './agorax-managed-agent-events'
import { AgoraxManagedAgentHttpClient } from './agorax-managed-agent-http-client'
import { AgoraxManagedRunStore } from './agorax-managed-run-store'

export type ReconciledManagedRun = {
  settled: boolean
  text: string
  error: string | null
  outcome: string | null
  exitCode: number | null
}

export type ReconcileManagedRunActivity = (
  runId: string,
) => Promise<ReconciledManagedRun | null>

function clientFromEnv(): AgoraxManagedAgentHttpClient | null {
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
  const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
  if (!baseUrl || !workspaceId) return null
  return new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
}

/**
 * Pull the latest settled turn facts for a display runId.
 * Returns null when env/binding/activity is unavailable (fail closed: caller
 * keeps the WS/timeout path).
 */
export async function reconcileManagedRunActivity(
  runId: string,
  deps?: {
    runStore?: AgoraxManagedRunStore
    client?: AgoraxManagedAgentHttpClient | null
  },
): Promise<ReconciledManagedRun | null> {
  const client = deps?.client !== undefined ? deps.client : clientFromEnv()
  if (!client) return null
  const runStore = deps?.runStore ?? new AgoraxManagedRunStore()
  const binding = await runStore.get(runId)
  if (!binding?.agentSessionId) return null

  try {
    const detail = await client.getSessionDetail(binding.agentSessionId)
    return reconciledFromSessionDetail(detail)
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : String(error)
    console.warn(
      `[reconcile-managed-run-activity] getSessionDetail failed run=${runId} session=${binding.agentSessionId}: ${detail}; trying raw activity`,
    )
    try {
      const raw = await client.getActivitySnapshot(binding.agentSessionId)
      return reconciledFromRawActivity(raw)
    } catch (rawError) {
      const rawDetail =
        rawError instanceof Error ? rawError.message : String(rawError)
      console.warn(
        `[reconcile-managed-run-activity] raw activity also failed run=${runId}: ${rawDetail}`,
      )
      return null
    }
  }
}

function reconciledFromSessionDetail(detail: {
  session: {
    latestTurn?: {
      turnId?: string
      phase?: string
      outcome?: string | null
      error?: { message?: string } | null
      updatedAtUnixMs?: number
    } | null
  }
  turns: Array<{
    turnId?: string
    phase?: string
    outcome?: string | null
    error?: { message?: string } | null
    updatedAtUnixMs?: number
  }>
  messages: Array<{
    turnId?: string
    role?: string
    payload?: unknown
  }>
}): ReconciledManagedRun {
  const turn =
    detail.session.latestTurn ??
    detail.turns
      .slice()
      .sort((a, b) => (b.updatedAtUnixMs ?? 0) - (a.updatedAtUnixMs ?? 0))[0] ??
    null
  if (!turn || turn.phase !== 'settled') {
    return {
      settled: false,
      text: '',
      error: null,
      outcome: null,
      exitCode: null,
    }
  }

  let text = ''
  for (const message of detail.messages) {
    if (turn.turnId && message.turnId && message.turnId !== turn.turnId) {
      continue
    }
    const snap = assistantTextFromActivityMessage(message)
    if (snap) text = snap
  }

  const error = turn.error?.message?.trim() || null
  const outcome = turn.outcome ?? null
  const exitCode = outcome === 'completed' ? 0 : outcome == null ? null : 1

  return { settled: true, text, error, outcome, exitCode }
}

/**
 * Best-effort PascalCase / camelCase parse when the full daemon-adapter
 * mapping rejects the aggregate (e.g. blank turn Origin). Enough to surface
 * quota/rate-limit failures into group chat instead of silent soft-timeout.
 */
function reconciledFromRawActivity(raw: unknown): ReconciledManagedRun | null {
  if (!raw || typeof raw !== 'object') return null
  const root = raw as Record<string, unknown>
  const turns = Array.isArray(root.turns) ? root.turns : []
  if (turns.length === 0) {
    return {
      settled: false,
      text: '',
      error: null,
      outcome: null,
      exitCode: null,
    }
  }

  type RawTurn = {
    phase: string
    outcome: string
    error: string
    turnId: string
    updated: number
  }
  const parsed: Array<RawTurn> = []
  for (const entry of turns) {
    if (!entry || typeof entry !== 'object') continue
    const t = entry as Record<string, unknown>
    const phase = stringField(t, 'Phase', 'phase')
    parsed.push({
      phase,
      outcome: stringField(t, 'Outcome', 'outcome'),
      error: stringField(t, 'ErrorMessage', 'errorMessage'),
      turnId: stringField(t, 'TurnID', 'turnId'),
      updated:
        numberField(t, 'UpdatedAtUnixMS', 'updatedAtUnixMs') ??
        numberField(t, 'SettledAtUnixMS', 'settledAtUnixMs') ??
        0,
    })
  }
  parsed.sort((a, b) => b.updated - a.updated)
  const turn = parsed.find((t) => t.phase === 'settled') ?? parsed[0]
  if (!turn || turn.phase !== 'settled') {
    return {
      settled: false,
      text: '',
      error: null,
      outcome: null,
      exitCode: null,
    }
  }

  let text = ''
  const messages = Array.isArray(root.messages) ? root.messages : []
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue
    const m = entry as Record<string, unknown>
    const role = stringField(m, 'Role', 'role').toLowerCase()
    if (role !== 'assistant') continue
    const msgTurnId = stringField(m, 'TurnID', 'turnId')
    if (turn.turnId && msgTurnId && msgTurnId !== turn.turnId) continue
    const payload = m.Payload ?? m.payload
    const snap = assistantTextFromActivityMessage({
      role: 'assistant',
      payload,
    })
    if (snap) text = snap
  }

  const error = turn.error.trim() || null
  const outcome = turn.outcome.trim() || null
  const exitCode =
    outcome === 'completed' ? 0 : !outcome ? null : 1

  return { settled: true, text, error, outcome, exitCode }
}

function stringField(
  record: Record<string, unknown>,
  pascal: string,
  camel: string,
): string {
  const value = record[pascal] ?? record[camel]
  return typeof value === 'string' ? value.trim() : ''
}

function numberField(
  record: Record<string, unknown>,
  pascal: string,
  camel: string,
): number | null {
  const value = record[pascal] ?? record[camel]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
