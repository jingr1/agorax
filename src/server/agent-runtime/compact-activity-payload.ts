/**
 * Shrink daemon activity / message payloads before they cross the UI wire.
 *
 * Activate injects platform-skill bodies into provider `content` while keeping
 * a short `displayPrompt` for the chat bubble. Without compaction, GET detail
 * can be multi-MB for a single user turn and freezes sidebar attach.
 */

const SKILL_BLOCK_RE =
  /<!--\s*agorax-platform-skills\s*-->[\s\S]*?<!--\s*\/agorax-platform-skills\s*-->/gi

/** Max chars kept for a text block when no displayPrompt is available. */
export const MANAGED_ACTIVITY_TEXT_SOFT_LIMIT = 32_768

export function stripAgoraxPlatformSkillBlocks(text: string): string {
  if (!text.includes('agorax-platform-skills')) return text
  return text.replace(SKILL_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

function compactText(text: string, limit = MANAGED_ACTIVITY_TEXT_SOFT_LIMIT): string {
  const stripped = stripAgoraxPlatformSkillBlocks(text)
  if (stripped.length <= limit) return stripped
  return `${stripped.slice(0, limit)}\n\n…[truncated ${stripped.length - limit} chars for wire transfer]`
}

function compactContentBlocks(content: unknown, displayPrompt: string | null): unknown {
  if (!Array.isArray(content)) return content
  if (displayPrompt) {
    return [{ type: 'text', text: displayPrompt }]
  }
  return content.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return block
    const row = block as Record<string, unknown>
    if (typeof row.text !== 'string') return block
    return { ...row, text: compactText(row.text) }
  })
}

/**
 * Compact one daemon-shaped message (PascalCase or camelCase payload).
 * Prefers `displayPrompt` over injected skill bodies for `content` / `text`.
 */
export function compactDaemonMessageForClient<T>(message: T): T {
  if (!message || typeof message !== 'object') return message
  const row = message as Record<string, unknown>
  const payloadKey = 'Payload' in row ? 'Payload' : 'payload' in row ? 'payload' : null
  if (!payloadKey) return message
  const payload = row[payloadKey]
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return message
  const p = payload as Record<string, unknown>
  const display =
    typeof p.displayPrompt === 'string' && p.displayPrompt.trim()
      ? p.displayPrompt.trim()
      : null
  const next: Record<string, unknown> = { ...p }
  if ('content' in next) {
    next.content = compactContentBlocks(next.content, display)
  }
  if (typeof next.text === 'string') {
    next.text = display ?? compactText(next.text)
  }
  return { ...row, [payloadKey]: next } as T
}

export function compactDaemonMessagesForClient<T>(messages: Array<T> | unknown): Array<T> {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => compactDaemonMessageForClient(message as T))
}

/** Compact a daemon activity aggregate (`session` + `messages` + …). */
export function compactDaemonActivityForClient(
  activity: Record<string, unknown>,
): Record<string, unknown> {
  const messagesKey = 'messages' in activity ? 'messages' : 'Messages' in activity ? 'Messages' : null
  if (!messagesKey) return activity
  return {
    ...activity,
    [messagesKey]: compactDaemonMessagesForClient(activity[messagesKey]),
  }
}
