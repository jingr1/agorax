import { createContext, useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogRoot,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@/components/ui/menu'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  MoreHorizontalIcon,
  Delete01Icon,
  Pen01Icon,
  PauseIcon,
  PlayIcon,
  Add01Icon,
} from '@hugeicons/core-free-icons'
import {
  addParticipant as apiAddParticipant,
  removeParticipant as apiRemoveParticipant,
  createRoom,
  deleteRoom,
  listAvailableAgents,
  listParticipants,
  listRooms,
  updateRoom,
} from '@/lib/group-chat-api'
import type { Room, RoomParticipant } from '@/lib/group-chat-types'
import { clearLastRoom, resolveRoomToOpen } from './last-room'
import {
  RoomWorkspaceField,
  shortPathLabel,
} from './components/room-workspace-field'
import { MemberList } from './components/member-list'
import type { AvailableAgent } from './components/member-list'
import { getInitials, getMemberColor } from './lib/avatar-utils'

const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const ROOMS_MIN_HEIGHT = 120
const MEMBERS_MIN_HEIGHT = 140

export const GroupChatRoomsContext = createContext<Array<Room>>([])

export const GroupChatMembersContext = createContext<Array<RoomParticipant>>([])

export function GroupChatLayout() {
  const navigate = useNavigate()
  const routerState = useRouterState()
  const pathname = routerState.location?.pathname ?? ''
  const roomId =
    pathname.startsWith('/group-chat/') &&
    pathname.length > '/group-chat/'.length
      ? pathname.slice('/group-chat/'.length).split(/[/?#]/)[0]
      : undefined
  const [rooms, setRooms] = useState<Array<Room>>([])
  const [createTitle, setCreateTitle] = useState('')
  const [createWorkspacePath, setCreateWorkspacePath] = useState('')
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Room | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Room | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [participants, setParticipants] = useState<Array<RoomParticipant>>([])
  const [availableAgents, setAvailableAgents] = useState<Array<AvailableAgent>>(
    [],
  )
  const roomIdRef = useRef(roomId)
  roomIdRef.current = roomId
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [roomsHeight, setRoomsHeight] = useState(320)
  const sidebarRef = useRef<HTMLElement>(null)
  const roomsSectionRef = useRef<HTMLDivElement>(null)

  // Drag writes the size straight to the DOM and commits state on release, so
  // mousemove never re-renders the layout (and the chat Outlet under it).
  const startSidebarResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      const el = sidebarRef.current
      if (!el) return
      const startX = event.clientX
      const startWidth = el.offsetWidth
      let next = startWidth
      const previousUserSelect = document.body.style.userSelect
      document.body.style.userSelect = 'none'
      const onMove = (e: MouseEvent) => {
        next = Math.min(
          SIDEBAR_MAX_WIDTH,
          Math.max(SIDEBAR_MIN_WIDTH, startWidth + (e.clientX - startX)),
        )
        el.style.width = `${next}px`
      }
      const onUp = () => {
        document.body.style.userSelect = previousUserSelect
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setSidebarWidth(next)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [],
  )

  const startSectionResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      const el = roomsSectionRef.current
      if (!el) return
      const startY = event.clientY
      const startHeight = el.offsetHeight
      const containerHeight =
        sidebarRef.current?.clientHeight ?? window.innerHeight
      const maxHeight = Math.max(
        ROOMS_MIN_HEIGHT,
        containerHeight - MEMBERS_MIN_HEIGHT,
      )
      let next = startHeight
      const previousUserSelect = document.body.style.userSelect
      document.body.style.userSelect = 'none'
      const onMove = (e: MouseEvent) => {
        next = Math.min(
          maxHeight,
          Math.max(ROOMS_MIN_HEIGHT, startHeight + (e.clientY - startY)),
        )
        el.style.height = `${next}px`
      }
      const onUp = () => {
        document.body.style.userSelect = previousUserSelect
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setRoomsHeight(next)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [],
  )

  useEffect(() => {
    void loadRooms()
    void listAvailableAgents().then((res) => setAvailableAgents(res.agents))
  }, [])

  const reloadParticipants = useCallback(async () => {
    const id = roomId
    if (!id) {
      setParticipants([])
      return
    }
    const res = await listParticipants(id)
    // Drop responses for a room the user already navigated away from.
    if (roomIdRef.current === id) setParticipants(res.participants)
  }, [roomId])

  useEffect(() => {
    setParticipants([])
    void reloadParticipants()
  }, [reloadParticipants])

  async function handleAddAgent(agent: AvailableAgent) {
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
    await reloadParticipants()
  }

  async function handleRemoveParticipant(participantId: string) {
    if (!roomId) return
    try {
      await apiRemoveParticipant(roomId, participantId)
      await reloadParticipants()
    } catch (error) {
      console.error('[group-chat] remove participant failed:', error)
    }
  }

  async function loadRooms() {
    const res = await listRooms()
    // needs_human rooms float to the top for attention.
    const sorted = [...res.rooms].sort((a, b) => {
      const aNeed = a.state === 'needs_human' ? 0 : 1
      const bNeed = b.state === 'needs_human' ? 0 : 1
      if (aNeed !== bNeed) return aNeed - bNeed
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    })
    setRooms(sorted)
  }

  async function handleCreateRoom() {
    const title = createTitle.trim()
    if (!title) return
    setCreateError(null)
    try {
      const workspacePath = createWorkspacePath.trim() || null
      const res = await createRoom({ title, workspacePath })
      setCreateTitle('')
      setCreateWorkspacePath('')
      setIsCreateOpen(false)
      await loadRooms()
      navigate({ to: '/group-chat/$roomId', params: { roomId: res.room.id } })
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : 'Failed to create room',
      )
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget || deleting) return
    const id = deleteTarget.id
    setDeleting(true)
    try {
      await deleteRoom(id)
      clearLastRoom(id)
      setDeleteTarget(null)
      const res = await listRooms()
      setRooms(res.rooms)
      if (roomId === id) {
        const next = resolveRoomToOpen(res.rooms)
        if (next) {
          navigate({
            to: '/group-chat/$roomId',
            params: { roomId: next },
            replace: true,
          })
        } else {
          navigate({ to: '/group-chat', replace: true })
        }
      }
    } finally {
      setDeleting(false)
    }
  }

  async function handleConfirmRename() {
    if (!renameTarget || renaming) return
    const title = renameTitle.trim()
    if (!title || title === renameTarget.title) {
      setRenameTarget(null)
      return
    }
    setRenaming(true)
    try {
      const res = await updateRoom(renameTarget.id, { title })
      setRooms((prev) => prev.map((r) => (r.id === res.room.id ? res.room : r)))
      setRenameTarget(null)
      setRenameTitle('')
    } finally {
      setRenaming(false)
    }
  }

  return (
    <div className="flex h-full" style={{ color: 'var(--theme-text)' }}>
      <aside
        ref={sidebarRef}
        className="relative flex shrink-0 flex-col border-r border-border bg-[var(--theme-sidebar)]"
        style={{ width: `${sidebarWidth}px` }}
      >
        <div
          ref={roomsSectionRef}
          className={cn(
            'flex min-h-0 flex-col',
            roomId ? 'shrink-0' : 'flex-1',
          )}
          style={
            roomId
              ? {
                  height: `${roomsHeight}px`,
                  maxHeight: `calc(100% - ${MEMBERS_MIN_HEIGHT}px)`,
                }
              : undefined
          }
        >
          <div className="flex shrink-0 items-center justify-between px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-primary-500">
              Rooms
            </span>
            <DialogRoot
              open={isCreateOpen}
              onOpenChange={(open) => {
                setIsCreateOpen(open)
                if (!open) {
                  setCreateError(null)
                  setCreateWorkspacePath('')
                }
              }}
            >
              <DialogTrigger
                type="button"
                className="inline-flex size-6 items-center justify-center rounded-md text-primary-500 hover:bg-primary-200"
                title="New room"
                aria-label="New room"
              >
                <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.5} />
              </DialogTrigger>
              <DialogContent className="w-[min(520px,92vw)]">
                <div className="p-4">
                  <DialogTitle className="mb-1">New Room</DialogTitle>
                  <DialogDescription className="mb-3">
                    Start a multi-agent room. Optionally bind a sticky workspace
                    — enter a project path or pick a folder.
                  </DialogDescription>
                  <div className="flex flex-col gap-3">
                    <Input
                      placeholder="Room title"
                      value={createTitle}
                      onChange={(e) => setCreateTitle(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleCreateRoom()}
                    />
                    <RoomWorkspaceField
                      value={createWorkspacePath}
                      onChange={setCreateWorkspacePath}
                    />
                    {createError ? (
                      <div className="text-xs text-danger">{createError}</div>
                    ) : null}
                    <div className="flex justify-end gap-2">
                      <DialogClose>Cancel</DialogClose>
                      <Button onClick={handleCreateRoom}>Create</Button>
                    </div>
                  </div>
                </div>
              </DialogContent>
            </DialogRoot>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <div className="space-y-0.5">
              {rooms.map((room) => {
                const isActive = roomId === room.id
                const color = getMemberColor(room.id, room.title)
                return (
                  <div
                    key={room.id}
                    className={cn(
                      'group flex items-center gap-1 rounded-lg transition-colors hover:bg-primary-200',
                      isActive && 'bg-primary-200',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        navigate({
                          to: '/group-chat/$roomId',
                          params: { roomId: room.id },
                        })
                      }
                      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left"
                    >
                      <span className="relative shrink-0">
                        <span
                          className="flex size-9 items-center justify-center rounded-full text-xs font-semibold"
                          style={{ background: `${color}26`, color }}
                        >
                          {getInitials(room.title)}
                        </span>
                        {room.state === 'needs_human' ? (
                          <span
                            className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-danger ring-2 ring-[var(--theme-sidebar)]"
                            title="Needs human"
                            aria-label="Needs human"
                          />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate text-sm font-medium',
                            isActive ? 'text-accent-500' : 'text-primary-900',
                          )}
                        >
                          {room.title}
                        </span>
                        <span
                          className="block truncate text-xs text-primary-500"
                          title={room.workspacePath ?? undefined}
                        >
                          {[
                            room.state,
                            room.missionId ? 'mission' : null,
                            room.workspacePath
                              ? shortPathLabel(room.workspacePath)
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </button>
                    <div className="shrink-0 pr-1">
                      <MenuRoot>
                        <MenuTrigger
                          type="button"
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                          }}
                          className={cn(
                            'inline-flex size-7 items-center justify-center rounded-md text-primary-700',
                            'opacity-0 transition-opacity group-hover:opacity-100 hover:bg-primary-200 dark:hover:bg-primary-800',
                            'aria-expanded:opacity-100 aria-expanded:bg-primary-200',
                            isActive && 'opacity-100',
                          )}
                          aria-label={`Room options for ${room.title}`}
                        >
                          <HugeiconsIcon
                            icon={MoreHorizontalIcon}
                            size={20}
                            strokeWidth={1.5}
                          />
                        </MenuTrigger>
                        <MenuContent side="bottom" align="end">
                          <MenuItem
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              setRenameTarget(room)
                              setRenameTitle(room.title)
                            }}
                            className="gap-2"
                          >
                            <HugeiconsIcon
                              icon={Pen01Icon}
                              size={20}
                              strokeWidth={1.5}
                            />
                            Rename
                          </MenuItem>
                          {room.state === 'paused' ? (
                            <MenuItem
                              onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                void updateRoom(room.id, {
                                  state: 'active',
                                }).then(() => loadRooms())
                              }}
                              className="gap-2"
                            >
                              <HugeiconsIcon
                                icon={PlayIcon}
                                size={20}
                                strokeWidth={1.5}
                              />
                              Resume room
                            </MenuItem>
                          ) : room.state === 'active' ? (
                            <MenuItem
                              onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                void updateRoom(room.id, {
                                  state: 'paused',
                                }).then(() => loadRooms())
                              }}
                              className="gap-2"
                            >
                              <HugeiconsIcon
                                icon={PauseIcon}
                                size={20}
                                strokeWidth={1.5}
                              />
                              Pause room
                            </MenuItem>
                          ) : null}
                          <MenuItem
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              setDeleteTarget(room)
                            }}
                            className="gap-2 text-red-700 hover:bg-red-50 dark:hover:bg-red-900/30/80 data-highlighted:bg-red-50/80"
                          >
                            <HugeiconsIcon
                              icon={Delete01Icon}
                              size={20}
                              strokeWidth={1.5}
                            />
                            Delete room
                          </MenuItem>
                        </MenuContent>
                      </MenuRoot>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
        {roomId ? (
          <>
            <div
              className="relative shrink-0"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize sidebar sections"
              onMouseDown={startSectionResize}
            >
              <div className="h-px bg-border" />
              <div className="absolute inset-x-0 -top-1.5 -bottom-1.5 z-10 cursor-row-resize" />
            </div>
            <MemberList
              participants={participants}
              availableAgents={availableAgents}
              onAdd={(agent) => void handleAddAgent(agent)}
              onRemove={(id) => void handleRemoveParticipant(id)}
            />
          </>
        ) : null}
        <div
          className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize bg-transparent hover:bg-primary-300/50"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar width"
          onMouseDown={startSidebarResize}
        />
      </aside>

      <DialogRoot
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open && !renaming) {
            setRenameTarget(null)
            setRenameTitle('')
          }
        }}
      >
        <DialogContent>
          <div className="p-4">
            <DialogTitle className="mb-1">Rename room</DialogTitle>
            <DialogDescription className="mb-3">
              Change the display name for this room.
            </DialogDescription>
            <div className="flex flex-col gap-3">
              <Input
                placeholder="Room title"
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleConfirmRename()
                }}
                disabled={renaming}
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <DialogClose disabled={renaming}>Cancel</DialogClose>
                <Button
                  disabled={renaming || !renameTitle.trim()}
                  onClick={() => void handleConfirmRename()}
                >
                  {renaming ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </DialogRoot>

      <AlertDialogRoot
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <div className="p-4">
            <AlertDialogTitle className="mb-1">Delete room?</AlertDialogTitle>
            <AlertDialogDescription className="mb-4">
              This will permanently remove "{deleteTarget?.title}" and all its
              messages, participants, and pending turns.
            </AlertDialogDescription>
            <div className="flex justify-end gap-2">
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={deleting}
                onClick={() => void handleConfirmDelete()}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </AlertDialogAction>
            </div>
          </div>
        </AlertDialogContent>
      </AlertDialogRoot>

      <main className="flex-1 min-w-0 bg-[var(--theme-bg)]">
        <GroupChatRoomsContext.Provider value={rooms}>
          <GroupChatMembersContext.Provider value={participants}>
            <Outlet />
          </GroupChatMembersContext.Provider>
        </GroupChatRoomsContext.Provider>
      </main>
    </div>
  )
}
