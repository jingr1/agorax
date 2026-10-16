import { Add01Icon, Delete01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useMemo } from 'react'
import { MemberAvatar } from './member-avatar'
import { countRoomAgentProviderSiblings } from '../lib/avatar-utils'
import type { RoomParticipant } from '@/lib/group-chat-types'
import { Button } from '@/components/ui/button'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTrigger,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@/components/ui/menu'

export type AvailableAgent = {
  id: string
  displayName: string
  mentionName?: string
  runtime?: string
  profile?: string | null
}

type MemberListProps = {
  participants: Array<RoomParticipant>
  availableAgents: Array<AvailableAgent>
  onAdd: (agent: AvailableAgent) => void
  onRemove: (participantId: string) => void
}

/** Room members section — row style mirrors the 1:1 chat AgentList. */
export function MemberList({
  participants,
  availableAgents,
  onAdd,
  onRemove,
}: MemberListProps) {
  const addable = useMemo(() => {
    const inRoom = new Set(participants.map((p) => p.participantId))
    return availableAgents.filter((agent) => !inRoom.has(agent.id))
  }, [participants, availableAgents])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-primary-500">
          Members · {participants.length}
        </span>
        <MenuRoot>
          <MenuTrigger
            type="button"
            className="inline-flex size-6 items-center justify-center rounded-md text-primary-500 hover:bg-primary-200 disabled:opacity-40"
            title="Add agent"
            aria-label="Add agent"
            disabled={addable.length === 0}
          >
            <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.5} />
          </MenuTrigger>
          <MenuContent align="end" side="bottom">
            {addable.map((agent) => (
              <MenuItem key={agent.id} onClick={() => onAdd(agent)}>
                {agent.displayName}
                {agent.runtime && agent.runtime !== 'hermes' ? (
                  <span className="ml-2 text-xs opacity-50">
                    {agent.runtime}
                  </span>
                ) : null}
              </MenuItem>
            ))}
          </MenuContent>
        </MenuRoot>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {participants.map((p) => (
          <DialogRoot key={p.id}>
            <DialogTrigger
              type="button"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-primary-200"
            >
              <MemberAvatar
                id={p.participantId}
                name={p.displayName}
                kind={p.kind}
                status={p.online ? 'idle' : 'failed'}
                size={36}
                className="shrink-0"
                runtime={p.runtime}
                providerSiblingCount={countRoomAgentProviderSiblings(
                  participants,
                  p.runtime,
                )}
                showTooltip={false}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-primary-900">
                  {p.displayName}
                </p>
                <p className="truncate text-xs text-primary-500">
                  @{p.mentionName}
                  {p.kind === 'human' ? ' · you' : ` · ${p.runtime}`}
                </p>
              </div>
            </DialogTrigger>
            <DialogContent>
              <div className="p-4">
                <DialogTitle className="mb-1">{p.displayName}</DialogTitle>
                <DialogDescription className="mb-4">
                  @{p.mentionName} · {p.kind} · {p.runtime}
                </DialogDescription>
                <div className="flex justify-end gap-2">
                  <DialogClose>Close</DialogClose>
                  {p.kind === 'agent' ? (
                    <DialogClose
                      onClick={() => onRemove(p.participantId)}
                      render={
                        <Button variant="destructive">
                          <HugeiconsIcon
                            icon={Delete01Icon}
                            size={16}
                            strokeWidth={1.5}
                          />
                          Remove from room
                        </Button>
                      }
                    />
                  ) : null}
                </div>
              </div>
            </DialogContent>
          </DialogRoot>
        ))}
      </div>
    </div>
  )
}
