import { type ClientDisconnectAction } from './stream-handoff-registry'

export function shouldAbortUpstreamOnStreamClose(input: {
  explicitAbort?: boolean
  keepUpstreamAlive: boolean
  detachedHandoff: boolean
}): boolean {
  return (
    input.explicitAbort ?? (!input.keepUpstreamAlive && !input.detachedHandoff)
  )
}

export type ClientDisconnectEvaluation = {
  keepUpstreamAlive: boolean
  detachedHandoff: boolean
  runIdToUnregister: string | null
  shouldPersistHandoff: boolean
}

export function evaluateClientDisconnect(input: {
  activeRunId: string | null
  streamClosed: boolean
  /** Explicit Stop. A dropped browser/proxy socket is not a stop. */
  userStopped?: boolean
  resolveAction?: (args: { runId: string }) => ClientDisconnectAction
}): ClientDisconnectEvaluation {
  const idle: ClientDisconnectEvaluation = {
    keepUpstreamAlive: false,
    detachedHandoff: false,
    runIdToUnregister: null,
    shouldPersistHandoff: false,
  }
  if (!input.activeRunId || input.streamClosed) return idle

  if (input.userStopped) {
    return {
      keepUpstreamAlive: false,
      detachedHandoff: false,
      runIdToUnregister: input.activeRunId,
      shouldPersistHandoff: false,
    }
  }

  // Browser refresh, tunnel idle, and navigation close the SSE leg only.
  // Aborting here is what left the 10:20 turn as
  // "Operation interrupted: waiting for model response" with no reply.
  // resolveAction stays as a test/override hook; production disconnects detach.
  const resolve = input.resolveAction
  if (resolve && resolve({ runId: input.activeRunId }) === 'abort_upstream') {
    return {
      keepUpstreamAlive: false,
      detachedHandoff: false,
      runIdToUnregister: input.activeRunId,
      shouldPersistHandoff: false,
    }
  }

  return {
    keepUpstreamAlive: true,
    detachedHandoff: true,
    runIdToUnregister: null,
    shouldPersistHandoff: true,
  }
}
