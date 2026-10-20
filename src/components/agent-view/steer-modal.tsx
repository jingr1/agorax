import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/toast'
import { steerAgent } from '@/lib/gateway-api'

type SteerModalProps = {
  open: boolean
  agentName: string
  sessionKey?: string
  onOpenChange: (open: boolean) => void
}

export function SteerModal({
  open,
  agentName,
  sessionKey,
  onOpenChange,
}: SteerModalProps) {
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) {
      setMessage('')
      setPending(false)
    }
  }, [open])

  async function handleSend() {
    const trimmedMessage = message.trim()
    const normalizedSessionKey = sessionKey?.trim() ?? ''
    if (!trimmedMessage || !normalizedSessionKey || pending) return

    setPending(true)
    try {
      await steerAgent(normalizedSessionKey, trimmedMessage)
      toast(`Directive sent to ${agentName}`, { type: 'success' })
      setMessage('')
      onOpenChange(false)
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : 'Failed to send directive'
      toast(errMessage, { type: 'error' })
    } finally {
      setPending(false)
    }
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(560px,92vw)]">
        <div className="p-4">
          <DialogTitle className="mb-1">Steer: {agentName}</DialogTitle>
          <DialogDescription className="mb-3">
            Send a directive to influence this agent&apos;s next steps.
          </DialogDescription>
          <div className="flex flex-col gap-3">
            <textarea
              value={message}
              rows={5}
              placeholder="Send a directive to this agent..."
              disabled={pending}
              onChange={function onChangeMessage(event) {
                setMessage(event.target.value)
              }}
              className="w-full resize-y rounded-lg border border-primary-200 bg-primary-100/70 px-3 py-2 text-sm text-primary-900 outline-none transition-colors focus:border-accent-400 disabled:cursor-not-allowed disabled:opacity-70"
            />
            <div className="flex justify-end gap-2">
              <DialogClose disabled={pending}>Cancel</DialogClose>
              <Button
                disabled={pending || message.trim().length === 0 || !sessionKey}
                onClick={function onClickSend() {
                  void handleSend()
                }}
              >
                {pending ? 'Sending...' : 'Send'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  )
}
