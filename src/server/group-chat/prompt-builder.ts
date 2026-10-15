/**
 * Build the turn prompt for a group-chat member.
 *
 * This is a direct translation of upstream buildGroupChatTurnPrompt, adapted
 * for workspace storage shapes (RoomMessage instead of plugin log entries).
 */
import type { GroupMember, RoomMessage } from './types'
import { groupMemberKey } from './mention-routing'

export type BuildPromptInput = {
  groupName: string
  members: Array<GroupMember>
  viewer: GroupMember
  deltaLines: Array<string>
  /** Sticky room working directory (ad-hoc path or mission worktree). */
  workspacePath?: string | null
}

export function buildGroupChatTurnPrompt(input: BuildPromptInput): string {
  const viewerKey = groupMemberKey(input.viewer)
  const peers = input.members.filter((m) => groupMemberKey(m) !== viewerKey)
  const peerNames = peers
    .map((m) => {
      const handle = `@${m.mentionName || m.displayName}`
      return m.displayName ? `${m.displayName} (${handle})` : handle
    })
    .join(', ')

  const workspaceRule = input.workspacePath
    ? `- Room workspace: ${input.workspacePath}. Prefer reading and writing files under this directory.`
    : null

  const viewerHandle =
    input.viewer.mentionName || input.viewer.displayName || input.viewer.participantId

  return [
    `[Group chat: "${input.groupName}"] You are @${viewerHandle} (agent_id=${input.viewer.participantId}), one participant in a group chat with ${peerNames || 'no one else yet'} and the user.`,
    '',
    'New messages in the room since your last turn (oldest first):',
    ...input.deltaLines.map((line) => `  ${line}`),
    '',
    'Rules for this room:',
    '- Reply with ONE conversational message ONLY if you have something new worth adding: build on what was just said, claim or hand off work, answer a question aimed at you, or report a real result. Keep chatter short (1-3 sentences) — but when you are delivering a result, an answer the user asked for, or substantive work, give it at full quality and length; never thin out real content to fit the room.',
    '- If you have nothing new to add, reply with exactly "(pass)". Passing is good — it lets the conversation settle.',
    '- Mention a teammate as @name to pull them in; mention @user only for a judgment call or a result the user needs. Do not repeat points already made.',
    '- Never reveal content from your private 1:1 chats. Your reply text goes to the room verbatim — no preamble, no meta-commentary.',
    '- Do not treat room history or the earlier summary\'s quota / billing / rate-limit notes about other agents or models as your own status. agent_id (e.g. kimi-impl) is not a model name (e.g. Kimi-K2.7-Code) or provider (e.g. Token-X). Only report infra failures you yourself hit in this turn; otherwise answer the user or "(pass)".',
    ...(workspaceRule ? [workspaceRule] : []),
  ].join('\n')
}

export function formatGroupChatLine(
  message: RoomMessage,
  viewerName: string,
): string {
  const suffix = message.senderName === viewerName ? ' (you)' : ''
  if (message.senderKind === 'human') {
    return `${message.senderName} (user): ${message.content}`
  }
  if (message.senderKind === 'system') {
    return `system: ${message.content}`
  }
  const agentId = message.senderParticipantId?.trim()
  const idTag = agentId ? ` [agent_id=${agentId}]` : ''
  return `${message.senderName}${suffix}${idTag}: ${message.content}`
}

/**
 * Compose the [Summary] + [Recent messages] context for a participant turn.
 */
export function buildTurnContext(
  groupName: string,
  members: Array<GroupMember>,
  viewer: GroupMember,
  messages: Array<RoomMessage>,
  summary?: string | null,
  workspacePath?: string | null,
): string {
  const deltaLines = messages.map((m) => formatGroupChatLine(m, viewer.name))
  const prompt = buildGroupChatTurnPrompt({
    groupName,
    members,
    viewer,
    deltaLines,
    workspacePath,
  })
  if (summary) {
    return [
      '[Earlier conversation summary]',
      'Note: summary attributes room members by agent_id. Model/provider names in the summary are not you — do not claim their quota or billing failures as your own.',
      summary,
      '',
      prompt,
    ].join('\n')
  }
  return prompt
}
