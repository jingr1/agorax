/**
 * Agorax agent identity avatars — provider base art in a circular frame.
 *
 * Assets live under `/public/agent-avatars/`. When a provider owns more than
 * one agent, the UI overlays the agent's two-letter initials on the base icon.
 */

export const AGENT_AVATAR_PROVIDER_KEYS = [
  'hermes',
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'openclaw',
  'kimi',
  'deepseek-harness',
  'agorax',
  'fallback',
] as const

export type AgentAvatarProviderKey = (typeof AGENT_AVATAR_PROVIDER_KEYS)[number]

/** Agorax brand mark used for Agorax itself and unknown providers. */
const AGORAX_AVATAR_SRC = '/agent-avatars/agorax-rounded.png'

/** Circular-ready PNG URLs under `public/agent-avatars/`. */
export const AGENT_AVATAR_ASSET_URLS: Record<AgentAvatarProviderKey, string> = {
  // Hermes swarm roles share the Hermes mark; multiple agents are distinguished
  // by the two-letter initials badge.
  hermes: '/agent-avatars/hermes-rounded.png',
  'claude-code': '/agent-avatars/claude-rounded.png',
  codex: '/agent-avatars/codex-rounded.png',
  cursor: '/agent-avatars/cursor-rounded.png',
  opencode: '/agent-avatars/opencode-rounded.png',
  openclaw: '/agent-avatars/openclaw-rounded.png',
  kimi: '/agent-avatars/kimi-rounded.png',
  'deepseek-harness': '/agent-avatars/deepseek-rounded.png',
  agorax: AGORAX_AVATAR_SRC,
  fallback: AGORAX_AVATAR_SRC,
}

const RUNTIME_ALIASES: Record<string, AgentAvatarProviderKey> = {
  hermes: 'hermes',
  'claude-code': 'claude-code',
  claudecode: 'claude-code',
  'cc-impl': 'claude-code',
  codex: 'codex',
  'codex-impl': 'codex',
  cursor: 'cursor',
  'cursor-impl': 'cursor',
  opencode: 'opencode',
  'opencode-impl': 'opencode',
  openclaw: 'openclaw',
  kimi: 'kimi',
  'kimi-impl': 'kimi',
  'kimi-code': 'kimi',
  'deepseek-harness': 'deepseek-harness',
  deepseek: 'deepseek-harness',
  'ds-harness': 'deepseek-harness',
  agorax: 'agorax',
}

export type AgentIdentityAvatarPresentation = {
  /** Accessible label (agent display name). */
  label: string
  /** Provider base art URL. */
  src: string
  /** Normalized provider key used for the base art. */
  provider: AgentAvatarProviderKey
  /**
   * Two-letter badge when this provider has multiple agents; otherwise null
   * (single-agent providers show the bare circular icon).
   */
  initials: string | null
}

export function normalizeAgentAvatarProvider(
  runtime: string | null | undefined,
): AgentAvatarProviderKey {
  const key = runtime?.trim().toLowerCase() ?? ''
  if (!key) return 'fallback'
  return RUNTIME_ALIASES[key] ?? 'fallback'
}

export function resolveAgentAvatarSrc(
  runtime: string | null | undefined,
): string {
  return AGENT_AVATAR_ASSET_URLS[normalizeAgentAvatarProvider(runtime)]
}

/**
 * Two letters from an agent display name.
 * - Multi-word: first letter of the first two words (Orchestrator → OR)
 * - Single word: first two graphemes (Aider → AI, kimi → KI)
 */
export function agentNameInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '??'

  const words = trimmed
    .split(/[\s_\-./]+/)
    .map((part) => part.trim())
    .filter(Boolean)

  if (words.length >= 2) {
    const a = Array.from(words[0]!)[0]
    const b = Array.from(words[1]!)[0]
    return `${a ?? '?'}${b ?? '?'}`.toUpperCase()
  }

  const chars = Array.from(words[0] ?? trimmed)
  if (chars.length >= 2) {
    return `${chars[0]}${chars[1]}`.toUpperCase()
  }
  return `${chars[0] ?? '?'}${chars[0] ?? '?'}`.toUpperCase()
}

export function countAgentsByProvider(
  agents: ReadonlyArray<{ runtime: string }>,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const agent of agents) {
    const key = normalizeAgentAvatarProvider(agent.runtime)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export function projectAgentIdentityAvatar(input: {
  name: string
  runtime?: string | null
  /** How many agents share this provider in the current roster. Default 1. */
  providerSiblingCount?: number
  /** Force the initials badge on/off; overrides sibling-count heuristic. */
  showInitials?: boolean
}): AgentIdentityAvatarPresentation {
  const provider = normalizeAgentAvatarProvider(input.runtime)
  const siblingCount = Math.max(1, Math.trunc(input.providerSiblingCount ?? 1))
  const showInitials =
    input.showInitials ?? siblingCount > 1
  const initials = showInitials ? agentNameInitials(input.name) : null

  return {
    label: input.name.trim() || provider,
    src: AGENT_AVATAR_ASSET_URLS[provider],
    provider,
    initials,
  }
}
