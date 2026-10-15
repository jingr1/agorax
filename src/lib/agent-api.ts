import type { AgentSession, AgentWithStatus } from './agent-types'

const API_BASE = '/api/agents'

export async function fetchAgents(): Promise<{
  agents: Array<AgentWithStatus>
}> {
  const res = await fetch(API_BASE)
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    throw new Error(`Failed to fetch agents: ${res.status} ${text}`)
  }
  return (await res.json()) as { agents: Array<AgentWithStatus> }
}

export async function fetchSessionsForAgent(
  agentId: string,
): Promise<{ sessions: Array<AgentSession> }> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(agentId)}/sessions`)
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    throw new Error(`Failed to fetch sessions: ${res.status} ${text}`)
  }
  return (await res.json()) as { sessions: Array<AgentSession> }
}

export async function createSessionForAgent(
  agentId: string,
  payload: { title?: string; model?: string } = {},
): Promise<{ sessionId: string }> {
  const res = await fetch(
    `${API_BASE}/${encodeURIComponent(agentId)}/sessions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    throw new Error(`Failed to create session: ${res.status} ${text}`)
  }
  return (await res.json()) as { sessionId: string }
}

export async function fetchManagedSessionDetail(
  agentId: string,
  sessionId: string,
): Promise<{
  session: AgentSession
  messages: Array<{
    role: string
    content: unknown
    isError?: boolean
    timestamp?: number
  }>
}> {
  const res = await fetch(
    `${API_BASE}/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
  )
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    throw new Error(`Failed to fetch session: ${res.status} ${text}`)
  }
  return (await res.json()) as {
    session: AgentSession
    messages: Array<{
      role: string
      content: unknown
      isError?: boolean
      timestamp?: number
    }>
  }
}

export async function renameManagedSession(
  agentId: string,
  sessionId: string,
  title: string,
): Promise<AgentSession> {
  const res = await fetch(
    `${API_BASE}/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    throw new Error(`Failed to rename session: ${res.status} ${text}`)
  }
  const body = (await res.json()) as { session: AgentSession }
  return body.session
}

export async function deleteManagedSession(
  agentId: string,
  sessionId: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    throw new Error(`Failed to delete session: ${res.status} ${text}`)
  }
}

export async function clearManagedSessionMessages(
  agentId: string,
  sessionId: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clearMessages: true }),
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    throw new Error(`Failed to clear messages: ${res.status} ${text}`)
  }
}

export function subscribeAgentEvents(
  onMessage: (event: unknown) => void,
  onError?: (error: Error) => void,
): () => void {
  const source = new EventSource('/api/collab-events?scope=global')
  source.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data) as unknown
      onMessage(parsed)
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }
  source.onerror = () => {
    onError?.(new Error('SSE connection error'))
  }
  return () => source.close()
}
