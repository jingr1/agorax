import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { MemberAvatar } from './components/member-avatar'
import { MemberRoster } from './components/member-roster'
import { MentionPicker } from './components/mention-picker'
import { PendingTurnCard } from './components/pending-turn-card'
import { ManagedInteractionRoomCard } from './components/managed-interaction-card'
import {
  countRoomAgentProviderSiblings,
  getMemberColor,
} from './lib/avatar-utils'
import type {
  PendingTurn,
  Room,
  RoomMessage,
  RoomParticipant,
} from '@/lib/group-chat-types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@/components/ui/menu'
import {
  answerPendingTurn,
  addParticipant as apiAddParticipant,
  removeParticipant as apiRemoveParticipant,
  sendMessage as apiSendMessage,
  dismissPendingTurn,
  listAvailableAgents,
  listMessages,
  listParticipants,
  listPendingTurns,
  updateRoom,
} from '@/lib/group-chat-api'
import { useGroupChatEvents } from '@/lib/use-group-chat-events'
import { GroupChatRoomsContext } from './group-chat-layout'
import { writeLastRoom } from './last-room'
import {
  RoomWorkspaceField,
  shortPathLabel,
} from './components/room-workspace-field'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog'

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function RoomsScreen() {
  const { roomId } = useParams({ from: '/group-chat/$roomId' })
  const sidebarRooms = useContext(GroupChatRoomsContext)
  const [activeRoom, setActiveRoom] = useState<Room | null>(null)
  const [messages, setMessages] = useState<Array<RoomMessage>>([])
  const [participants, setParticipants] = useState<Array<RoomParticipant>>([])
  const [pendingTurns, setPendingTurns] = useState<Array<PendingTurn>>([])
  const [input, setInput] = useState('')
  const [availableAgents, setAvailableAgents] = useState<
    Array<{
      id: string
      displayName: string
      mentionName?: string
      runtime?: string
      profile?: string | null
    }>
  >([])
  const [loading, setLoading] = useState(false)
  // Ephemeral turn status is per-room: switching rooms shows that room's last
  // known status instead of leaking another room's or wiping this room's.
  const [statusByRoom, setStatusByRoom] = useState<
    Record<string, string | null>
  >({})
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  const [workspaceDraft, setWorkspaceDraft] = useState('')
  const [workspaceSaving, setWorkspaceSaving] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const { events } = useGroupChatEvents(roomId)
  const statusText = roomId ? (statusByRoom[roomId] ?? null) : null

  useEffect(() => {
    listAvailableAgents().then((res) => setAvailableAgents(res.agents))
  }, [])

  useEffect(() => {
    if (!roomId) {
      setActiveRoom(null)
      setMessages([])
      setParticipants([])
      setPendingTurns([])
      return
    }
    writeLastRoom(roomId)
    setLoading(true)
    Promise.all([
      listMessages(roomId),
      listParticipants(roomId),
      listPendingTurns(roomId),
    ])
      .then(([msgRes, partRes, ptRes]) => {
        setActiveRoom(msgRes.room)
        setMessages(msgRes.messages)
        setParticipants(partRes.participants)
        setPendingTurns(ptRes.pendingTurns)
      })
      .finally(() => setLoading(false))
  }, [roomId])

  // Process *all* new SSE events, not just the latest. reply + settled often
  // land in the same React batch; looking only at lastEvent drops the refetch.
  // Cursor is per-room so revisiting a room does not replay its buffer.
  const handledEventIdByRoomRef = useRef<Record<string, number>>({})

  useEffect(() => {
    if (!roomId) return
    const handled = handledEventIdByRoomRef.current[roomId] ?? 0
    const pending = events.filter((e) => e.id > handled)
    if (pending.length === 0) return
    handledEventIdByRoomRef.current[roomId] = pending[pending.length - 1]!.id

    let refreshMessages = false
    let refreshPending = false
    let nextStatus: string | null | undefined

    for (const ev of pending) {
      // Reply/message are the primary insert signals. Also refetch on failed
      // (runner inserts a failure note but only publishes group_chat_failed)
      // and on turn/drive terminals so a dropped mid-turn reply SSE still
      // surfaces after Codex finishes — matches "refresh then it appears".
      if (
        ev.event === 'group_chat_reply' ||
        ev.event === 'group_chat_message' ||
        ev.event === 'group_chat_failed' ||
        ev.event === 'group_chat_turn_ended' ||
        ev.event === 'group_chat_settled' ||
        ev.event === 'group_chat_capped'
      ) {
        refreshMessages = true
      }
      if (
        ev.event === 'group_chat_human_attention' ||
        ev.event === 'group_chat_human_answered' ||
        ev.event === 'group_chat_human_dismissed'
      ) {
        refreshPending = true
      }
      if (ev.event === 'group_chat_turn_started') {
        nextStatus = `• ${String(ev.data.member ?? '')} is thinking...`
      } else if (ev.event === 'group_chat_settled') {
        nextStatus = 'Group settled'
      } else if (ev.event === 'group_chat_capped') {
        nextStatus = 'Cap reached'
      } else if (ev.event === 'group_chat_turn_ended') {
        nextStatus = null
      }
    }

    if (refreshMessages) {
      void listMessages(roomId).then((res) => {
        setMessages(res.messages)
        setActiveRoom(res.room)
      })
    }
    if (refreshPending) {
      void listPendingTurns(roomId).then((res) =>
        setPendingTurns(res.pendingTurns),
      )
    }
    if (nextStatus !== undefined) {
      setStatusByRoom((prev) => ({ ...prev, [roomId]: nextStatus }))
    }
  }, [events, roomId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleAddAgent(agent: {
    id: string
    displayName: string
    mentionName?: string
    runtime?: string
    profile?: string | null
  }) {
    if (!roomId) return
    const runtime = agent.runtime || 'hermes'
    // Non-Hermes runtimes never carry a Hermes profile (mirrors RoomRuntime).
    const isManaged = runtime !== 'hermes'
    await apiAddParticipant(roomId, {
      participantId: agent.id,
      kind: 'agent',
      displayName: agent.displayName,
      mentionName: agent.mentionName,
      runtime,
      profile: isManaged ? null : (agent.profile ?? null),
    })
    const res = await listParticipants(roomId)
    setParticipants(res.participants)
  }

  async function handleRemoveParticipant(participantId: string) {
    if (!roomId) return
    try {
      await apiRemoveParticipant(roomId, participantId)
      const res = await listParticipants(roomId)
      setParticipants(res.participants)
    } catch (error) {
      console.error('[group-chat] remove participant failed:', error)
      setStatusByRoom((prev) => ({
        ...prev,
        [roomId]: `Remove failed: ${error instanceof Error ? error.message : String(error)}`,
      }))
    }
  }

  async function handleSend() {
    if (!roomId || !input.trim()) return
    const content = input.trim()
    setInput('')
    const res = await apiSendMessage(roomId, { content })
    setMessages((prev) => [...prev, res.message])
    setActiveRoom(res.room)
  }

  async function handleAnswerTurn(turnId: string, answerText: string) {
    if (!roomId) return
    const res = await answerPendingTurn(roomId, turnId, { answerText })
    setMessages((prev) => [...prev, res.message])
    setPendingTurns((prev) => prev.filter((t) => t.id !== turnId))
  }

  async function handleDismissTurn(turnId: string) {
    if (!roomId) return
    await dismissPendingTurn(roomId, turnId)
    setPendingTurns((prev) => prev.filter((t) => t.id !== turnId))
  }

  async function handleSaveWorkspace() {
    if (!roomId || !activeRoom || activeRoom.missionId) return
    setWorkspaceSaving(true)
    setWorkspaceError(null)
    try {
      const res = await updateRoom(roomId, {
        workspacePath: workspaceDraft.trim() || null,
      })
      setActiveRoom(res.room)
      setWorkspaceDialogOpen(false)
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : 'Failed to update workspace',
      )
    } finally {
      setWorkspaceSaving(false)
    }
  }

  const displayTitle =
    sidebarRooms.find((r) => r.id === roomId)?.title ?? activeRoom?.title
  const displayWorkspace =
    activeRoom?.workspacePath ??
    sidebarRooms.find((r) => r.id === roomId)?.workspacePath ??
    null
  const displayMissionId =
    activeRoom?.missionId ??
    sidebarRooms.find((r) => r.id === roomId)?.missionId ??
    null

  if (!roomId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        No room yet — create one from the sidebar.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col min-w-0 bg-[var(--theme-bg)]">
      {activeRoom ? (
        <>
          <header
            className="h-16 shrink-0 px-4 border-b flex items-center justify-between"
            style={{ borderColor: 'var(--theme-border)' }}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="min-w-0">
                <h1 className="font-semibold truncate">{displayTitle}</h1>
                <div className="text-xs opacity-70 flex items-center gap-2 min-w-0">
                  <span>{participants.length} members</span>
                  {activeRoom?.state === 'paused' ? (
                    <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300 bg-amber-400/15">
                      Paused
                    </span>
                  ) : null}
                  {displayMissionId ? (
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                      style={{ background: 'rgba(59,130,246,0.15)' }}
                      title={displayMissionId}
                    >
                      Mission
                    </span>
                  ) : null}
                  {displayWorkspace ? (
                    <button
                      type="button"
                      className="truncate text-left hover:underline disabled:no-underline disabled:cursor-default"
                      title={displayWorkspace}
                      disabled={Boolean(displayMissionId)}
                      onClick={() => {
                        if (displayMissionId) return
                        setWorkspaceDraft(displayWorkspace)
                        setWorkspaceError(null)
                        setWorkspaceDialogOpen(true)
                      }}
                    >
                      {shortPathLabel(displayWorkspace)}
                    </button>
                  ) : !displayMissionId ? (
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => {
                        setWorkspaceDraft('')
                        setWorkspaceError(null)
                        setWorkspaceDialogOpen(true)
                      }}
                    >
                      Set workspace
                    </button>
                  ) : null}
                  {statusText && (
                    <span className="text-amber-400">{statusText}</span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {activeRoom?.state === 'paused' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void updateRoom(roomId, { state: 'active' }).then((res) => {
                      setActiveRoom(res.room)
                    })
                  }}
                >
                  Resume
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void updateRoom(roomId, { state: 'paused' }).then((res) => {
                      setActiveRoom(res.room)
                    })
                  }}
                >
                  Pause
                </Button>
              )}
              <MemberRoster
                participants={participants}
                onRemove={handleRemoveParticipant}
              />
              <MenuRoot>
                <MenuTrigger type="button" className="inline-flex">
                  <Button size="sm" variant="secondary">
                    + Agent
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  {availableAgents.map((agent) => (
                    <MenuItem
                      key={agent.id}
                      onClick={() => handleAddAgent(agent)}
                    >
                      {agent.displayName}
                      {agent.runtime && agent.runtime !== 'hermes' ? (
                        <span className="ml-2 opacity-50 text-xs">
                          {agent.runtime}
                        </span>
                      ) : null}
                    </MenuItem>
                  ))}
                </MenuContent>
              </MenuRoot>
            </div>
          </header>

          {pendingTurns.length > 0 && (
            <div
              className="px-4 py-3 border-b"
              style={{
                borderColor: 'var(--theme-border)',
                background: 'rgba(245,158,11,0.06)',
              }}
            >
              <div className="text-xs font-semibold uppercase tracking-wider opacity-70 mb-2">
                Human Gate
              </div>
              {pendingTurns.map((turn) => (
                <PendingTurnCard
                  key={turn.id}
                  turn={turn}
                  participants={participants}
                  onAnswer={handleAnswerTurn}
                  onDismiss={handleDismissTurn}
                />
              ))}
            </div>
          )}

          <div className="flex-1 overflow-auto p-4 space-y-4">
            {loading ? (
              <div className="text-muted-foreground">Loading...</div>
            ) : (
              messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  participants={participants}
                  roomId={roomId}
                />
              ))
            )}
            <div ref={bottomRef} />
          </div>

          <div
            className="p-3 border-t flex gap-2 relative"
            style={{ borderColor: 'var(--theme-border)' }}
          >
            <MentionPicker
              value={input}
              onChange={setInput}
              onSubmit={handleSend}
              participants={participants}
              placeholder="Message... Use @name to mention"
              aria-label="Group chat message"
            />
            <Button onClick={handleSend}>Send</Button>
          </div>
        </>
      ) : (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          {loading ? 'Loading...' : 'Room not found.'}
        </div>
      )}

      <DialogRoot
        open={workspaceDialogOpen}
        onOpenChange={setWorkspaceDialogOpen}
      >
        <DialogContent className="w-[min(520px,92vw)]">
          <div className="p-4">
            <DialogTitle className="mb-1">Room workspace</DialogTitle>
            <DialogDescription className="mb-3">
              Enter a project path or pick a folder. Managed agents spawn here;
              Hermes is reminded via the turn prompt.
            </DialogDescription>
            <RoomWorkspaceField
              value={workspaceDraft}
              onChange={setWorkspaceDraft}
            />
            {workspaceError ? (
              <div className="mt-3 text-xs text-red-400">{workspaceError}</div>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <DialogClose type="button" className="inline-flex">
                <Button variant="ghost" disabled={workspaceSaving}>
                  Cancel
                </Button>
              </DialogClose>
              <Button onClick={handleSaveWorkspace} disabled={workspaceSaving}>
                {workspaceSaving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </DialogRoot>
    </div>
  )
}

function MessageBubble({
  message,
  participants,
  roomId,
}: {
  message: RoomMessage
  participants: Array<RoomParticipant>
  roomId: string
}) {
  const sender = useMemo(
    () =>
      participants.find((p) => p.participantId === message.senderParticipantId),
    [participants, message.senderParticipantId],
  )
  const color = sender
    ? getMemberColor(sender.participantId, sender.displayName)
    : message.senderKind === 'system'
      ? '#64748b'
      : '#1A2340'
  const isHuman = message.senderKind === 'human'
  const isInteractionCard = message.content.includes(
    'agorax:managed-interaction:v1',
  )

  return (
    <div
      className={cn('flex gap-3', isHuman ? 'flex-row-reverse' : 'flex-row')}
    >
      <MemberAvatar
        id={message.senderParticipantId ?? 'system'}
        name={message.senderName}
        kind={message.senderKind}
        status="idle"
        size={36}
        runtime={sender?.runtime}
        providerSiblingCount={countRoomAgentProviderSiblings(
          participants,
          sender?.runtime,
        )}
      />
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-4 py-2.5 shadow-sm',
          isHuman ? 'rounded-br-md' : 'rounded-bl-md',
        )}
        style={{
          background: isHuman ? '#1A2340' : color + '20',
          color: isHuman ? '#E6EAF2' : 'var(--theme-text)',
          borderLeft: isHuman ? undefined : `4px solid ${color}`,
        }}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold opacity-90">
            {message.senderName}
          </span>
          <span className="text-[10px] opacity-60">
            {formatTime(message.createdAt)}
          </span>
        </div>
        {isInteractionCard ? (
          <ManagedInteractionRoomCard
            roomId={roomId}
            messageId={message.id}
            content={message.content}
          />
        ) : (
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {message.content}
          </div>
        )}
      </div>
    </div>
  )
}
