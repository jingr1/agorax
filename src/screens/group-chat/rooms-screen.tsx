import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { Folder01Icon, FolderAddIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { MemberAvatar } from './components/member-avatar'
import { MentionPicker } from './components/mention-picker'
import { PendingTurnCard } from './components/pending-turn-card'
import { InteractionRoomCard } from './components/interaction-room-card'
import {
  countRoomAgentProviderSiblings,
  getMemberColor,
} from './lib/avatar-utils'
import {
  GroupChatMembersContext,
  GroupChatRoomsContext,
} from './group-chat-layout'
import { writeLastRoom } from './last-room'
import {
  RoomWorkspaceField,
  shortPathLabel,
} from './components/room-workspace-field'
import type {
  PendingTurn,
  Room,
  RoomMessage,
  RoomParticipant,
} from '@/lib/group-chat-types'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/prompt-kit/markdown'
import { Button } from '@/components/ui/button'
import { ComposerPrimaryButton } from '@/screens/chat/components/composer-primary-button'
import {
  answerPendingTurn,
  sendMessage as apiSendMessage,
  dismissPendingTurn,
  listMessages,
  listPendingTurns,
  updateRoom,
} from '@/lib/group-chat-api'
import { toast } from '@/components/ui/toast'
import { useGroupChatEvents } from '@/lib/use-group-chat-events'
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
  const participants = useContext(GroupChatMembersContext)
  const [pendingTurns, setPendingTurns] = useState<Array<PendingTurn>>([])
  const [input, setInput] = useState('')
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
    if (!roomId) {
      setActiveRoom(null)
      setMessages([])
      setPendingTurns([])
      return
    }
    writeLastRoom(roomId)
    setLoading(true)
    Promise.all([listMessages(roomId), listPendingTurns(roomId)])
      .then(([msgRes, ptRes]) => {
        setActiveRoom(msgRes.room)
        setMessages(msgRes.messages)
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
    handledEventIdByRoomRef.current[roomId] = pending[pending.length - 1].id

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

  const sendingRef = useRef(false)

  async function handleSend() {
    if (!roomId || !input.trim()) return
    if (sendingRef.current) return
    sendingRef.current = true
    const content = input.trim()
    setInput('')
    try {
      const res = await apiSendMessage(roomId, { content })
      // Avoid double-append: the SSE listener will refetch messages and replace
      // the list. Only optimistically insert when the message is not already
      // present (e.g. slow network where the event has not arrived yet).
      setMessages((prev) => {
        if (prev.some((m) => m.id === res.message.id)) return prev
        return [...prev, res.message]
      })
      setActiveRoom(res.room)
    } finally {
      sendingRef.current = false
    }
  }

  async function handleAnswerTurn(turnId: string, answerText: string) {
    if (!roomId) return
    try {
      const res = await answerPendingTurn(roomId, turnId, { answerText })
      setMessages((prev) => {
        if (prev.some((m) => m.id === res.message.id)) return prev
        return [...prev, res.message]
      })
      setPendingTurns((prev) => prev.filter((t) => t.id !== turnId))
    } catch (error) {
      console.error('[group-chat] answer pending turn failed:', error)
      toast(error instanceof Error ? error.message : 'Failed to answer', {
        type: 'error',
      })
      throw error
    }
  }

  async function handleDismissTurn(turnId: string) {
    if (!roomId) return
    try {
      await dismissPendingTurn(roomId, turnId)
      setPendingTurns((prev) => prev.filter((t) => t.id !== turnId))
    } catch (error) {
      console.error('[group-chat] dismiss pending turn failed:', error)
      toast(error instanceof Error ? error.message : 'Failed to dismiss', {
        type: 'error',
      })
      throw error
    }
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

  const sidebarRoom = sidebarRooms.find((r) => r.id === roomId)
  // activeRoom still holds the previous room until this room's fetch lands.
  const currentRoom = activeRoom?.id === roomId ? activeRoom : null
  const displayTitle = sidebarRoom?.title ?? currentRoom?.title
  const displayWorkspace =
    currentRoom?.workspacePath ?? sidebarRoom?.workspacePath ?? null
  const displayMissionId =
    currentRoom?.missionId ?? sidebarRoom?.missionId ?? null

  if (!roomId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-muted">
        No room yet — create one from the sidebar.
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-surface text-fg">
      {activeRoom ? (
        <>
          <header className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="min-w-[4rem] truncate text-sm font-medium">
                  {displayTitle}
                </h1>
                <div className="flex min-w-0 max-w-[60%] shrink-0 items-center gap-2 text-xs text-fg-muted">
                  {activeRoom?.state === 'paused' ? (
                    <span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning">
                      Paused
                    </span>
                  ) : null}
                  {displayMissionId ? (
                    <span
                      className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent"
                      title={displayMissionId}
                    >
                      Mission
                    </span>
                  ) : null}
                  {displayWorkspace ? (
                    <button
                      type="button"
                      className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-fg transition-colors hover:border-accent/50 hover:bg-hover disabled:cursor-default disabled:hover:border-border disabled:hover:bg-card"
                      title={
                        displayMissionId
                          ? `${displayWorkspace} (from mission, read-only)`
                          : `${displayWorkspace} — click to change`
                      }
                      disabled={Boolean(displayMissionId)}
                      onClick={() => {
                        if (displayMissionId) return
                        setWorkspaceDraft(displayWorkspace)
                        setWorkspaceError(null)
                        setWorkspaceDialogOpen(true)
                      }}
                    >
                      <HugeiconsIcon
                        icon={Folder01Icon}
                        size={12}
                        strokeWidth={1.8}
                        className="shrink-0 text-fg-muted"
                      />
                      <span className="truncate">
                        {shortPathLabel(displayWorkspace)}
                      </span>
                    </button>
                  ) : !displayMissionId ? (
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-dashed border-accent/50 bg-accent/10 px-1.5 py-0.5 font-medium text-accent transition-colors hover:border-accent hover:bg-accent/20"
                      title="Bind a working directory for agents in this room"
                      onClick={() => {
                        setWorkspaceDraft('')
                        setWorkspaceError(null)
                        setWorkspaceDialogOpen(true)
                      }}
                    >
                      <HugeiconsIcon
                        icon={FolderAddIcon}
                        size={12}
                        strokeWidth={1.8}
                        className="shrink-0"
                      />
                      Set workspace
                    </button>
                  ) : null}
                  {statusText && (
                    <span className="truncate text-warning">{statusText}</span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
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
            </div>
          </header>

          {pendingTurns.length > 0 && (
            <div className="border-b border-border bg-warning/5 px-4 py-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-muted">
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

          <div className="min-h-0 flex-1 overflow-auto">
            <div className="mx-auto w-full max-w-[var(--chat-content-max-width)] space-y-4 px-4 py-4">
              {loading ? (
                <div className="text-sm text-fg-muted">Loading...</div>
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
          </div>

          <div className="shrink-0 px-3 pb-3 pt-2 sm:px-5">
            <div
              className="relative mx-auto flex w-full max-w-[var(--chat-content-max-width)] items-end gap-1 rounded-3xl py-1.5 pl-1 pr-1.5"
              style={{
                background: 'var(--composer-bg)',
                border: '1px solid var(--composer-border)',
                boxShadow: 'var(--theme-shadow-1)',
              }}
            >
              <MentionPicker
                value={input}
                onChange={setInput}
                onSubmit={handleSend}
                participants={participants}
                placeholder="Message... Use @name to mention"
                aria-label="Group chat message"
              />
              <ComposerPrimaryButton
                action={input.trim() ? 'send' : 'disabled'}
                onSend={() => void handleSend()}
                onStop={() => {}}
              />
            </div>
          </div>
        </>
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-fg-muted">
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
              <div className="mt-3 text-xs text-danger">{workspaceError}</div>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <DialogClose disabled={workspaceSaving}>Cancel</DialogClose>
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

type MessageBubbleProps = {
  message: RoomMessage
  participants: Array<RoomParticipant>
  roomId: string
}

// Room refetches replace every message object; compare by value so unchanged
// messages skip the Markdown re-parse.
const MessageBubble = memo(
  MessageBubbleView,
  (prev, next) =>
    prev.roomId === next.roomId &&
    prev.participants === next.participants &&
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.senderName === next.message.senderName &&
    prev.message.createdAt === next.message.createdAt,
)

function MessageBubbleView({
  message,
  participants,
  roomId,
}: MessageBubbleProps) {
  const sender = useMemo(
    () =>
      participants.find((p) => p.participantId === message.senderParticipantId),
    [participants, message.senderParticipantId],
  )
  const isHuman = message.senderKind === 'human'
  const nameColor =
    sender && !isHuman
      ? getMemberColor(sender.participantId, sender.displayName)
      : undefined
  const isInteractionCard = message.content.includes(
    'agorax:managed-interaction:v1',
  )

  return (
    <div
      className={cn(
        'flex gap-2 md:gap-3',
        isHuman ? 'flex-row-reverse' : 'items-start',
      )}
    >
      <MemberAvatar
        id={message.senderParticipantId ?? 'system'}
        name={message.senderName}
        kind={message.senderKind}
        status="idle"
        size={24}
        className="mt-0.5 shrink-0"
        runtime={sender?.runtime}
        providerSiblingCount={countRoomAgentProviderSiblings(
          participants,
          sender?.runtime,
        )}
      />
      <div
        className={cn(
          'flex min-w-0 max-w-[80%] flex-col gap-1',
          isHuman ? 'items-end' : 'items-start',
        )}
      >
        <div className="flex items-center gap-2 px-1 text-xs">
          <span
            className="font-medium text-fg"
            style={nameColor ? { color: nameColor } : undefined}
          >
            {message.senderName}
          </span>
          <span className="text-[11px] text-fg-muted tabular-nums">
            {formatTime(message.createdAt)}
          </span>
        </div>
        <div
          data-chat-message-bubble={isHuman ? 'user' : 'assistant'}
          className={cn(
            'min-w-0 max-w-full break-words px-3 py-2',
            isHuman
              ? 'rounded-2xl rounded-tr-sm'
              : 'rounded-2xl rounded-tl-sm border',
          )}
          style={
            isHuman
              ? {
                  background: 'var(--chat-user-bg)',
                  color: 'var(--chat-user-foreground)',
                }
              : {
                  background: 'var(--chat-assistant-bg)',
                  borderColor: 'var(--chat-assistant-border)',
                  color: 'var(--chat-assistant-foreground)',
                }
          }
        >
          {isInteractionCard ? (
            <InteractionRoomCard
              roomId={roomId}
              messageId={message.id}
              content={message.content}
            />
          ) : isHuman ? (
            <div className="whitespace-pre-wrap text-sm leading-relaxed">
              {message.content}
            </div>
          ) : (
            <Markdown className="text-sm">{message.content}</Markdown>
          )}
        </div>
      </div>
    </div>
  )
}
