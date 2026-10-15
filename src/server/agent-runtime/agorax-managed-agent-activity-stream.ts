import type { AgentStreamEvent } from './types'
import {
  agoraxEventsFromManagedActivity,
  type AgoraxManagedAgentActivity,
} from './agorax-managed-agent-events'

type SocketLike = {
  on: (event: string, listener: (...args: Array<unknown>) => void) => void
  close: () => void
}

/**
 * One daemon WS frame envelope (`{"kind":"event","event":{...}}`). The daemon
 * assigns every frame a monotonic `version`, an `emittedAt` unix-ms timestamp
 * and a workspace `scope`; `payload` is the canonical activity event.
 */
export type AgoraxManagedAgentActivityEnvelope = {
  id: string
  topic: 'agent.activity.updated'
  version: number
  emittedAt: number
  scope: { workspaceId: string }
  payload: AgoraxManagedAgentActivity & {
    workspaceId: string
    agentSessionId: string
  }
}

type ActivityFrame = {
  kind: 'event'
  event: {
    topic: 'agent.activity.updated'
    payload: AgoraxManagedAgentActivityEnvelope['payload']
  }
}

/**
 * Validates one raw daemon WS frame and returns the full envelope when it
 * belongs to the requested workspace. Only `kind`, the activity topic and the
 * payload workspace identity are enforced; envelope metadata fields
 * (`id`/`version`/`emittedAt`/`scope`) are passed through verbatim so SSE
 * clients receive exactly what the daemon emitted.
 */
export function parseAgoraxManagedActivityEnvelope(
  raw: unknown,
  workspaceId: string,
): AgoraxManagedAgentActivityEnvelope | null {
  if (!raw || typeof raw !== 'object') return null
  const frame = raw as Partial<ActivityFrame>
  if (frame.kind !== 'event' || frame.event?.topic !== 'agent.activity.updated') {
    return null
  }
  const payload = frame.event.payload
  if (!payload || payload.workspaceId !== workspaceId) return null
  return frame.event as AgoraxManagedAgentActivityEnvelope
}

export function parseAgoraxManagedActivityFrame(
  raw: unknown,
  workspaceId: string,
  agentSessionId: string,
): AgoraxManagedAgentActivity | null {
  const envelope = parseAgoraxManagedActivityEnvelope(raw, workspaceId)
  if (!envelope || envelope.payload.agentSessionId !== agentSessionId) return null
  return envelope.payload
}

export type AgoraxManagedAgentActivitySocket = {
  onMessage: (listener: (raw: unknown) => void) => void
  onError: (listener: (error: Error) => void) => void
  close: () => void
}

export type AgoraxManagedAgentActivitySocketFactory = (input: {
  url: string
  workspaceId: string
}) => AgoraxManagedAgentActivitySocket

export class AgoraxManagedAgentActivityStream {
  private socket: AgoraxManagedAgentActivitySocket | null = null

  constructor(
    private readonly input: {
      url: string
      workspaceId: string
      agentSessionId: string
      runId: string
      socketFactory: AgoraxManagedAgentActivitySocketFactory
      onEvents: (events: Array<AgentStreamEvent>) => void
      onError?: (error: Error) => void
    },
  ) {}

  connect(): void {
    if (this.socket) return
    const socket = this.input.socketFactory({
      url: this.input.url,
      workspaceId: this.input.workspaceId,
    })
    this.socket = socket
    socket.onMessage((raw) => {
      const activity = parseAgoraxManagedActivityFrame(
        raw,
        this.input.workspaceId,
        this.input.agentSessionId,
      )
      if (!activity) return
      const events = agoraxEventsFromManagedActivity(
        this.input.runId,
        activity,
        this.input.workspaceId,
      )
      if (events.length > 0) this.input.onEvents(events)
    })
    socket.onError((error) => this.input.onError?.(error))
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}