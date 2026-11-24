/**
 * Pure text helpers for workspace agent preferences.
 * Safe for client + server (no node:fs). Loading lives under src/server/.
 */

export const AGENT_PREFERENCES_START = '<!-- agorax-agent-preferences -->'
export const AGENT_PREFERENCES_END = '<!-- /agorax-agent-preferences -->'

const PREFERENCES_BLOCK_RE =
  /<!--\s*agorax-agent-preferences\s*-->[\s\S]*?<!--\s*\/agorax-agent-preferences\s*-->\s*/i

export function hasAgentPreferences(text: string): boolean {
  return (
    text.includes(AGENT_PREFERENCES_START) ||
    /<!--\s*agorax-agent-preferences\s*-->/i.test(text)
  )
}

export function formatAgentPreferencesBlock(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  return [
    AGENT_PREFERENCES_START,
    'Workspace agent preferences (apply on every turn):',
    trimmed,
    AGENT_PREFERENCES_END,
  ].join('\n')
}

/** Prepend a preferences body (caller supplies text; empty = no-op). */
export function prependAgentPreferences(text: string, body: string): string {
  if (hasAgentPreferences(text)) return text
  const block = formatAgentPreferencesBlock(body)
  if (!block) return text
  const rest = text.trimStart()
  return rest ? `${block}\n\n${rest}` : block
}

/** Remove an injected preferences block from user-visible text. */
export function stripAgentPreferences(text: string): string {
  if (!text) return text
  return text.replace(PREFERENCES_BLOCK_RE, '').trimStart()
}
