/**
 * @-mention routing for group chat.
 *
 * Parses @agent, @all, @everyone, @human, @user mentions and resolves them
 * against the room's active participants. Translation of upstream
 * parseGroupChatMentions / resolveRosterMentions adapted for workspace storage.
 */
import {
  findParticipantByMention,
  listParticipants,
  toGroupMember,
} from './room-store'
import type { GroupMember, MentionTarget, RoomMessage } from './types'

export type ParsedMentions = {
  everyone: boolean
  mentioned: Array<string>
}

/**
 * Build a map of mention forms → participant key.
 * Forms include:
 *   - participantId lowercased
 *   - mention_name
 *   - display_name (whole, slugged, first word)
 */
function buildMentionIndex(members: Array<GroupMember>): Map<string, string> {
  const index = new Map<string, string>()
  for (const member of members) {
    const key = groupMemberKey(member)
    const forms = new Set<string>()

    forms.add(member.participantId.toLowerCase())
    forms.add(member.participantId.toLowerCase().replace(/[\s_-]+/g, ''))

    const handle = (member.mentionName || '').trim()
    if (handle) {
      forms.add(handle.toLowerCase())
      forms.add(handle.toLowerCase().replace(/[\s_-]+/g, ''))
    }

    const title = (member.displayName || '').trim()
    if (title) {
      forms.add(title.toLowerCase())
      forms.add(title.toLowerCase().replace(/[\s_-]+/g, ''))
      const firstWord = title.split(/\s+/)[0]
      if (firstWord) {
        forms.add(firstWord.toLowerCase())
      }
    }

    for (const form of forms) {
      if (form) index.set(form, key)
    }
  }
  return index
}

export function groupMemberKey(member: GroupMember): string {
  return `${member.kind}:${member.participantId}`
}

export function parseMentions(
  text: string,
  members: Array<GroupMember>,
): ParsedMentions {
  const source = String(text || '')
  const index = buildMentionIndex(members)
  const mentioned = new Set<string>()
  let everyone = false

  for (const match of source.matchAll(/@([a-z0-9][a-z0-9._-]*)/gi)) {
    const handle = match[1].toLowerCase()

    if (handle === 'all') {
      everyone = true
      continue
    }

    if (
      handle === 'user' ||
      handle === 'human' ||
      handle === 'me' ||
      handle === 'owner'
    ) {
      // @user / @human resolves to the human participant(s) at dispatch time.
      continue
    }

    const collapsed = handle.replace(/[._-]+/g, '')
    const resolved = index.get(handle) || index.get(collapsed)
    if (resolved) {
      mentioned.add(resolved)
    }
  }

  return { everyone, mentioned: [...mentioned] }
}

/**
 * Resolve @human / @user / @me to active human participants in the room.
 */
export function resolveHumanMentions(
  roomId: string,
  input?: { dbPath?: string },
): Array<MentionTarget> {
  const participants = listParticipants(roomId, input)
  const humans = participants.filter((p) => p.kind === 'human')
  if (humans.length === 0) return []
  return humans.map((h) => ({
    type: 'human' as const,
    participantId: h.participantId,
  }))
}

/**
 * Expand parsed mentions into concrete MentionTarget objects.
 * @all / @everyone is expanded to every active member so the persisted mention
 * list is deterministic and doesn't require callers to interpret a magic
 * `{ type: 'all' }` token.
 */
export function expandMentionTargets(
  parsed: ParsedMentions,
  _roomId: string,
  members: Array<GroupMember>,
): Array<MentionTarget> {
  // If @all/@everyone was used, expand to every active member. The runner still
  // uses parseMentions().everyone for its fast path; here we materialize the
  // full target list so room_messages.mentions is self-describing.
  if (parsed.everyone) {
    return members.map((member) => {
      if (member.kind === 'human') {
        return { type: 'human' as const, participantId: member.participantId }
      }
      return { type: 'agent' as const, participantId: member.participantId }
    })
  }

  const targets: Array<MentionTarget> = []
  const memberByKey = new Map(members.map((m) => [groupMemberKey(m), m]))

  for (const key of parsed.mentioned) {
    const member = memberByKey.get(key)
    if (!member) continue
    if (member.kind === 'human') {
      targets.push({ type: 'human', participantId: member.participantId })
    } else {
      targets.push({ type: 'agent', participantId: member.participantId })
    }
  }

  return targets
}

/**
 * Check whether a message contains a mention that resolves to a specific
 * participant key.
 */
export function isMentioned(message: RoomMessage, memberKey: string): boolean {
  if (message.mentions.some((m) => m.type === 'all')) return true
  const [kind, participantId] = memberKey.split(':')
  return message.mentions.some(
    (m) =>
      (m.type === 'agent' || m.type === 'human') &&
      m.participantId === participantId,
  )
}

/**
 * Re-parse a message's text and resolve mentions against current room members.
 */
export function resolveMentionsInMessage(
  message: RoomMessage,
  members: Array<GroupMember>,
): ParsedMentions {
  return parseMentions(message.content, members)
}
