/**
 * Round-robin speaker selection and pass/reply extraction.
 *
 * Translated from upstream Bot Mode:
 *   - resolveGroupResponders
 *   - hasActionableUnreadForMember
 *   - rotateGroupSpeakers
 *   - isGroupPassText
 *   - pickGroupTurnReply
 *   - unaddressedGroupMentions
 */
import { groupMemberKey, parseMentions } from './mention-routing'
import type { GroupMember, RoomMessage } from './types'

/**
 * Decide which members should respond after the last user message.
 *
 * Wake contract:
 * - `mentioned=0 → all` applies ONLY to the last **human** message (user
 *   didn't @ anyone). Room chatter must never trigger that broadcast.
 * - Agent posts after that human may expand the set via explicit @ / @all,
 *   but never via empty mentions → everyone.
 * - autoHandoff messages never contribute mentions.
 */
export function resolveGroupResponders(
  messages: Array<RoomMessage>,
  members: Array<GroupMember>,
): Array<GroupMember> {
  let lastHumanIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.senderKind === 'human') {
      lastHumanIndex = i
      break
    }
  }

  if (lastHumanIndex < 0) {
    return respondersFromExplicitMentions(messages, members)
  }

  const lastHuman = messages[lastHumanIndex]!
  const mentioned = new Set<string>()
  let everyone = false

  if (!lastHuman.autoHandoff) {
    const humanParsed = parseMentions(lastHuman.content, members)
    if (humanParsed.everyone) everyone = true
    for (const name of humanParsed.mentioned) mentioned.add(name)

    // User didn't @ anyone → broadcast. This is the only empty→all path.
    if (!humanParsed.everyone && humanParsed.mentioned.length === 0) {
      return members
    }
  }

  // Named human @ (or autoHandoff human): collect later agent @ expansions only.
  for (let i = lastHumanIndex + 1; i < messages.length; i++) {
    const entry = messages[i]!
    // Platform auto-handoff must not drive @ responders — spawn stays with
    // the task pipeline (advance → dispatchNext).
    if (entry.autoHandoff) continue
    if (entry.senderKind === 'system') continue
    const parsed = parseMentions(entry.content, members)
    if (parsed.everyone) everyone = true
    for (const name of parsed.mentioned) mentioned.add(name)
  }

  if (everyone) return members
  if (mentioned.size === 0) return []
  return members.filter((member) => mentioned.has(groupMemberKey(member)))
}

/** Explicit @ / @all only — never empty→all (used when no human message). */
function respondersFromExplicitMentions(
  messages: Array<RoomMessage>,
  members: Array<GroupMember>,
): Array<GroupMember> {
  const mentioned = new Set<string>()
  let everyone = false
  for (const entry of messages) {
    if (entry.autoHandoff) continue
    if (entry.senderKind === 'system') continue
    const parsed = parseMentions(entry.content, members)
    if (parsed.everyone) everyone = true
    for (const name of parsed.mentioned) mentioned.add(name)
  }
  if (everyone) return members
  if (mentioned.size === 0) return []
  return members.filter((member) => mentioned.has(groupMemberKey(member)))
}

/**
 * Whether unread room lines should wake `member` for a turn.
 *
 * - Human messages are always actionable (caller already scoped responders).
 * - Agent/system lines wake only on explicit @member / @all.
 * - Sibling agent chatter without @ is noise — advance watermark, don't re-run.
 */
export function hasActionableUnreadForMember(
  unread: Array<RoomMessage>,
  member: GroupMember,
  members: Array<GroupMember>,
): boolean {
  const key = groupMemberKey(member)
  for (const entry of unread) {
    if (entry.autoHandoff) continue
    if (entry.senderKind === 'human') return true
    if (entry.senderParticipantId === member.participantId) continue
    if (entry.senderKind === 'agent' || entry.senderKind === 'system') {
      const parsed = parseMentions(entry.content, members)
      if (parsed.everyone) return true
      if (parsed.mentioned.includes(key)) return true
    }
  }
  return false
}

/**
 * Rotate the speaker order each round so the same member doesn't always go
 * first.
 */
export function rotateGroupSpeakers(
  members: Array<GroupMember>,
  round: number,
): Array<GroupMember> {
  if (members.length < 2) return members
  const shift = round % members.length
  return [...members.slice(shift), ...members.slice(0, shift)]
}

/** True if the bot chose to pass. */
export function isGroupPassText(text: string | null | undefined): boolean {
  const trimmed = String(text || '').trim()
  if (!trimmed) return true
  return /^\(?\s*pass\s*\)?\.?$/i.test(trimmed)
}

/**
 * True when assistant text is a Hermes/runtime infrastructure failure that
 * was wrongly persisted as chat content (e.g. "API call failed after 3
 * retries: cannot import name …"). These must not be posted to the room or
 * they become the next mission via @mention chase.
 *
 * Match anchors are line-start / whole-message so research prose that merely
 * *mentions* ImportError is not classified as a failure.
 */
export function isGroupInfraFailureText(
  text: string | null | undefined,
): boolean {
  const trimmed = String(text || '').trim()
  if (!trimmed) return false
  return (
    /^API call failed after \d+ retries:/i.test(trimmed) ||
    /^No LLM provider configured\b/i.test(trimmed) ||
    /^cannot import name\b/i.test(trimmed) ||
    /^(ImportError|ModuleNotFoundError|AttributeError|TypeError|RuntimeError|SyntaxError):\s/i.test(
      trimmed,
    ) ||
    /^Traceback \(most recent call last\):/i.test(trimmed)
  )
}

/**
 * Pick the substantive reply from a sequence of assistant messages.
 * Scans newest-first and prefers the last non-pass answer. This handles the
 * case where a model emits an answer followed by a synthetic "(pass)".
 */
export function pickGroupTurnReply(
  messages: Array<{
    role: string
    content?: string | null
    tool_calls?: unknown
  }>,
  before: number,
): string | null {
  let passText: string | null = null

  for (let i = messages.length - 1; i >= before; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant') continue

    const text = String(msg.content ?? '').trim()

    if (isGroupPassText(text)) {
      if (passText === null) passText = text
      continue
    }

    return text
  }

  return passText
}

/**
 * Heuristic for "session still grinding" when the gateway does not expose
 * session.running/inflight to REST. A tool-loop leaves the last message as
 * either a tool result or an assistant message that still has tool_calls.
 */
export function isGroupTranscriptBusy(
  messages: Array<{ role: string; tool_calls?: unknown }>,
  before: number,
): boolean {
  if (messages.length <= before) return true
  const last = messages[messages.length - 1]
  if (!last) return false
  if (last.role === 'tool') return true
  if (last.role === 'assistant' && hasToolCalls(last.tool_calls)) return true
  return false
}

function hasToolCalls(toolCalls: unknown): boolean {
  if (!toolCalls) return false
  if (Array.isArray(toolCalls)) return toolCalls.length > 0
  if (typeof toolCalls === 'string') {
    const trimmed = toolCalls.trim()
    return trimmed.length > 0 && trimmed !== '[]' && trimmed !== 'null'
  }
  return false
}

/**
 * Find members who were @mentioned recently but have not yet replied.
 * Used to trigger bounded continuation rounds.
 */
export function unaddressedGroupMentions(
  messages: Array<RoomMessage>,
  members: Array<GroupMember>,
): Array<string> {
  // key -> index of the entry that most recently cited this member.
  const lastCited = new Map<string, number>()

  for (let i = 0; i < messages.length; i++) {
    const entry = messages[i]!
    if (entry.senderKind === 'system') continue
    if (entry.autoHandoff) continue
    const parsed = parseMentions(entry.content, members)
    if (parsed.everyone) {
      for (const member of members) {
        lastCited.set(groupMemberKey(member), i)
      }
    } else {
      for (const key of parsed.mentioned) {
        lastCited.set(key, i)
      }
    }
  }

  const memberKeyByParticipantId = new Map(
    members.map((m) => [m.participantId, groupMemberKey(m)]),
  )

  const result: Array<string> = []
  for (const [key, citedIndex] of lastCited.entries()) {
    // The member has addressed the mention if they posted after the citation.
    let answered = false
    for (let i = citedIndex + 1; i < messages.length; i++) {
      const entry = messages[i]!
      if (
        entry.senderKind === 'agent' &&
        entry.senderParticipantId &&
        memberKeyByParticipantId.get(entry.senderParticipantId) === key
      ) {
        answered = true
        break
      }
    }
    if (!answered) result.push(key)
  }

  return result
}
