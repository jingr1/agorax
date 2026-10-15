// Client-safe single source for Managed Agent backend identity: the backend
// union, the daemon catalog target ids, and the agentId -> target mapping.
// The server runtime imports from here (server -> client-safe lib is allowed);
// nothing in this module may import server-only code.

export const AGORAX_MANAGED_AGENT_BACKENDS = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'kimi',
] as const

export type AgoraxManagedAgentBackend =
  (typeof AGORAX_MANAGED_AGENT_BACKENDS)[number]

export function isAgoraxManagedAgentBackend(
  value: string,
): value is AgoraxManagedAgentBackend {
  return (AGORAX_MANAGED_AGENT_BACKENDS as readonly string[]).includes(value)
}

/** Daemon catalog (`GET /v1/agent-targets`) ids per managed backend. */
export const MANAGED_AGENT_TARGET_IDS: Record<AgoraxManagedAgentBackend, string> = {
  'claude-code': 'local:claude-code',
  codex: 'local:codex',
  cursor: 'local:cursor',
  opencode: 'local:opencode',
  kimi: 'extension:kimi-code',
}

export function agoraxAgentTargetIdForBackend(
  backend: AgoraxManagedAgentBackend,
): string {
  return MANAGED_AGENT_TARGET_IDS[backend]
}

/** Registry agentId -> managed backend (unknown ids fall back to claude-code). */
export function managedAgentBackendForAgentId(
  agentId: string,
): AgoraxManagedAgentBackend {
  switch (agentId) {
    case 'codex-impl':
    case 'codex':
      return 'codex'
    case 'cursor-impl':
    case 'cursor':
      return 'cursor'
    case 'opencode-impl':
    case 'opencode':
      return 'opencode'
    case 'kimi-impl':
    case 'kimi':
      return 'kimi'
    default:
      return 'claude-code'
  }
}

/** Registry agentId -> daemon catalog target id. */
export function managedAgentTargetId(agentId: string): string {
  return agoraxAgentTargetIdForBackend(managedAgentBackendForAgentId(agentId))
}

/**
 * Human labels for runtimes. Display-only: runtimes without a label render
 * their raw name, so a new backend never blocks on copy.
 */
export const AGENT_RUNTIME_LABELS: Record<string, string> = {
  hermes: 'Hermes Agent',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  kimi: 'Kimi',
  'deepseek-harness': 'DeepSeek',
}

export function agentRuntimeLabel(runtime: string): string {
  return AGENT_RUNTIME_LABELS[runtime] ?? runtime
}

/**
 * Target id for a registry agent, preferring its declared runtime over the
 * legacy agentId guess (whose default silently mapped unknown ids to
 * claude-code).
 */
export function managedAgentTargetIdForRuntime(
  runtime: string,
  agentId: string,
): string {
  return agoraxAgentTargetIdForBackend(
    isAgoraxManagedAgentBackend(runtime)
      ? runtime
      : managedAgentBackendForAgentId(agentId),
  )
}
