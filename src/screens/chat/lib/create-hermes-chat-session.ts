import { selectPendingActivationByRequestId } from '@agorax/agent-activity-core'
import {
  forgetHermesMappingCache,
  getHermesChatRuntime,
  peekHermesMappingCache,
} from '@/stores/hermes-chat-runtime'
import { deriveFriendlyIdFromKey } from '../utils'

/** Align with cold gateway probe; engine activation command allows up to 90s. */
const CREATE_SESSION_TIMEOUT_MS = 30_000
const POLL_MS = 50

export async function createHermesChatSession(input: {
  profile: string
  preferredFriendlyId?: string
  signal?: AbortSignal
}) {
  const runtime = getHermesChatRuntime(input.profile, {
    profileName: input.profile,
  })
  const clientSubmitId = crypto.randomUUID()
  const provisionalId = input.preferredFriendlyId?.trim() || clientSubmitId
  const requestId = `activate-${crypto.randomUUID()}`
  forgetHermesMappingCache(provisionalId)
  const acceptedAt = Date.now()
  const accepted = runtime.engine.activateSession({
    mode: 'new',
    requestId,
    agentSessionId: provisionalId,
    agentTargetId: 'hermes-native',
    clientSubmitId,
    ...(input.preferredFriendlyId?.trim()
      ? { optimisticTitle: input.preferredFriendlyId.trim() }
      : {}),
  })
  if (!accepted) throw new Error('Hermes Engine rejected activateSession')

  const deadline = acceptedAt + CREATE_SESSION_TIMEOUT_MS
  while (Date.now() < deadline) {
    input.signal?.throwIfAborted()
    const activation = selectPendingActivationByRequestId(
      runtime.engine.getSnapshot(),
      requestId,
    )
    if (activation?.status === 'failed') {
      throw new Error(
        activation.errorMessage?.trim() || 'Hermes create session failed',
      )
    }
    // Cache-only: command-port persistMapping writes memory before network.
    const mapping = peekHermesMappingCache(provisionalId)
    const sessionKey = mapping?.gatewaySessionId?.trim()
    if (sessionKey && (mapping?.updatedAtUnixMs ?? 0) >= acceptedAt) {
      await runtime.putMapping({
        agentSessionId: sessionKey,
        turnId: null,
        gatewaySessionId: sessionKey,
        assignmentId: null,
        hermesRunId: null,
        bridgeKind: 'hermes-native',
        updatedAtUnixMs: Date.now(),
      })
      runtime.ensureSessionHydrated(sessionKey)
      return {
        sessionKey,
        friendlyId: deriveFriendlyIdFromKey(sessionKey) || sessionKey,
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS))
  }

  const activation = selectPendingActivationByRequestId(
    runtime.engine.getSnapshot(),
    requestId,
  )
  if (activation?.status === 'failed') {
    throw new Error(
      activation.errorMessage?.trim() || 'Hermes create session failed',
    )
  }
  throw new Error('Hermes create session timed out')
}
