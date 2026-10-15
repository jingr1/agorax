import { Button } from '@/components/ui/button'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { MemberAvatar } from './member-avatar'
import { countRoomAgentProviderSiblings } from '../lib/avatar-utils'
import { HugeiconsIcon } from '@hugeicons/react'
import { Delete01Icon } from '@hugeicons/core-free-icons'
import type { RoomParticipant } from '@/lib/group-chat-types'

type MemberRosterProps = {
  participants: Array<RoomParticipant>
  onRemove: (participantId: string) => void
}

export function MemberRoster({ participants, onRemove }: MemberRosterProps) {
  return (
    <div className="flex items-center gap-2">
      {participants.map((p) => (
        <DialogRoot key={p.id}>
          <TooltipProvider>
            <TooltipRoot>
              <TooltipTrigger
                type="button"
                className="relative -ml-2 first:ml-0 transition-transform hover:scale-110 hover:z-10 focus:outline-none"
              >
                <DialogTrigger type="button" className="inline-flex">
                  <MemberAvatar
                    id={p.participantId}
                    name={p.displayName}
                    kind={p.kind}
                    status={p.online ? 'idle' : 'failed'}
                    size={38}
                    runtime={p.runtime}
                    providerSiblingCount={countRoomAgentProviderSiblings(
                      participants,
                      p.runtime,
                    )}
                    showTooltip={false}
                  />
                </DialogTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                {p.displayName} (@{p.mentionName})
                {p.kind === 'human' && ' · you'}
              </TooltipContent>
            </TooltipRoot>
          </TooltipProvider>

          <DialogContent>
            <DialogTitle>{p.displayName}</DialogTitle>
            <DialogDescription>
              @{p.mentionName} · {p.kind} · {p.runtime}
            </DialogDescription>
            <div className="mt-3 flex flex-col gap-3">
              {p.kind === 'agent' && (
                <DialogClose
                  onClick={() => onRemove(p.participantId)}
                  render={
                    <Button variant="destructive" className="w-full">
                      <HugeiconsIcon
                        icon={Delete01Icon}
                        size={16}
                        strokeWidth={1.5}
                      />
                      Remove from room
                    </Button>
                  }
                />
              )}
              <div className="flex justify-end">
                <DialogClose>Close</DialogClose>
              </div>
            </div>
          </DialogContent>
        </DialogRoot>
      ))}
    </div>
  )
}
