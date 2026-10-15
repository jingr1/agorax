import type { AgoraxManagedAgentBackend } from './agorax-managed-agent-bridge'
import { isAgoraxManagedAgentBackend } from './agorax-managed-agent-bridge'
import { AgoraxManagedRunStore } from './agorax-managed-run-store'
import { getAgentRuntimeRouter } from './router'

export type AgoraxManagedSessionIdentity =
  | { ok: true; backend: AgoraxManagedAgentBackend; agentSessionId: string }
  | { ok: false; status: number; error: string }

/**
 * Resolves an Agorax display session id to the canonical daemon agentSessionId
 * for a managed-backend agent declaration.
 *
 * Ownership is fail-closed (Agorax-style): a binding that belongs to a different
 * backend must not hydrate into this agent's chat pane.
 */
export async function resolveAgoraxManagedSessionIdentity(input: {
  agentId: string
  sessionId: string
  runStore?: AgoraxManagedRunStore
}): Promise<AgoraxManagedSessionIdentity> {
  const agentId = input.agentId.trim()
  const sessionId = input.sessionId.trim()
  if (!agentId || !sessionId) {
    return { ok: false, status: 400, error: 'agentId and sessionId are required' }
  }
  const declaration = getAgentRuntimeRouter().registry.byId.get(agentId)
  if (!declaration || !isAgoraxManagedAgentBackend(declaration.runtime)) {
    return { ok: false, status: 404, error: 'Managed Agent is unavailable' }
  }
  const runStore = input.runStore ?? new AgoraxManagedRunStore()
  const displayBinding = await runStore.getByDisplaySession(sessionId)
  if (displayBinding) {
    if (displayBinding.backend !== declaration.runtime) {
      return {
        ok: false,
        status: 404,
        error: 'session does not belong to this agent',
      }
    }
    return {
      ok: true,
      backend: declaration.runtime,
      agentSessionId: displayBinding.agentSessionId,
    }
  }

  const runBinding = await runStore.get(sessionId)
  if (runBinding) {
    if (runBinding.backend !== declaration.runtime) {
      return {
        ok: false,
        status: 404,
        error: 'session does not belong to this agent',
      }
    }
    return {
      ok: true,
      backend: declaration.runtime,
      agentSessionId: runBinding.agentSessionId,
    }
  }

  // Daemon-native session id (no collab display binding yet): allow through so
  // reconcile can attach; engine/sessions already filters by agentTargetId.
  return { ok: true, backend: declaration.runtime, agentSessionId: sessionId }
}
