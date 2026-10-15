import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import {
  getRoom,
  insertMessage,
  listMessages,
  listParticipants,
  toGroupMember,
  updateRoom,
} from '../../../../server/group-chat/room-store'
import {
  expandMentionTargets,
  parseMentions,
} from '../../../../server/group-chat/mention-routing'
import { bumpRoomEpoch } from '../../../../server/group-chat/runner-state'
import { publishChatEvent } from '../../../../server/chat-event-bus'
import {
  applyUserHoldDirective,
  triggerRoomRun,
} from '../../../../server/group-chat/group-chat-runner'

export const Route = createFileRoute('/api/rooms/$roomId/messages')({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const room = getRoom(params.roomId)
        if (!room) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        return json({
          ok: true,
          room,
          messages: listMessages(params.roomId),
        })
      },
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        let room = getRoom(params.roomId)
        if (!room) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        if (room.state === 'disbanded' || room.state === 'complete') {
          return json(
            { ok: false, error: `Room is ${room.state}` },
            { status: 409 },
          )
        }
        let body: { content?: string; mentions?: Array<unknown> }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }
        const content = String(body.content ?? '').trim()
        if (!content) {
          return json({ ok: false, error: 'content required' }, { status: 400 })
        }
        const participants = listParticipants(params.roomId)
        const members = participants.map(toGroupMember)
        const parsed = parseMentions(content, members)
        const mentions = body.mentions
          ? (body.mentions as ReturnType<typeof expandMentionTargets>)
          : expandMentionTargets(parsed, params.roomId, members)

        // User speaking resumes a paused room (Bot Mode: send ignites drive).
        if (room.state === 'paused') {
          room =
            updateRoom(params.roomId, {
              state: 'active',
              updatedAt: Date.now(),
            }) ?? room
        }

        const message = insertMessage({
          roomId: params.roomId,
          senderKind: 'human',
          senderParticipantId: null,
          senderName: 'User',
          content,
          mentions,
        })

        // #93129: only user text changes holds (stop @x / @all resume / …).
        applyUserHoldDirective({
          roomId: params.roomId,
          content,
          messageId: message.id,
          members: members.filter((m) => m.kind === 'agent' || m.isBot),
        })

        bumpRoomEpoch(params.roomId)
        publishChatEvent('group_chat_message', {
          roomId: params.roomId,
          messageId: message.id,
        })

        // Fire-and-forget: one bounded drive for this user send.
        void triggerRoomRun(params.roomId)

        return json({ ok: true, room: getRoom(params.roomId) ?? room, message })
      },
    },
  },
})
