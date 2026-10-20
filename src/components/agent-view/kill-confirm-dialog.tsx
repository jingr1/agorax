import { useState } from 'react'
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogRoot,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from '@/components/ui/toast'
import { killAgentSession } from '@/lib/gateway-api'

type KillConfirmDialogProps = {
  open: boolean
  agentName: string
  sessionKey?: string
  onOpenChange: (open: boolean) => void
  onKilled?: () => void
}

export function KillConfirmDialog({
  open,
  agentName,
  sessionKey,
  onOpenChange,
  onKilled,
}: KillConfirmDialogProps) {
  const [pending, setPending] = useState(false)

  async function handleConfirmKill() {
    const normalizedSessionKey = sessionKey?.trim() ?? ''
    if (!normalizedSessionKey || pending) return

    setPending(true)
    try {
      await killAgentSession(normalizedSessionKey)
      toast(`${agentName} terminated`, { type: 'success' })
      onOpenChange(false)
      onKilled?.()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to terminate agent'
      toast(message, { type: 'error' })
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialogRoot
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending && !nextOpen) return
        onOpenChange(nextOpen)
      }}
    >
      <AlertDialogContent className="w-[min(420px,92vw)]">
        <div className="p-4">
          <AlertDialogTitle className="mb-1">
            Kill {agentName}?
          </AlertDialogTitle>
          <AlertDialogDescription className="mb-4">
            This will terminate the agent session immediately.
          </AlertDialogDescription>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending || !sessionKey}
              onClick={() => void handleConfirmKill()}
            >
              {pending ? 'Terminating...' : 'Kill'}
            </AlertDialogAction>
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialogRoot>
  )
}
