import type {
  AgentProbeResult,
  AgentRunInput,
  AgentStreamEvent,
  McpHandshake,
} from './types'
import type {
  AgoraxManagedAgentBackend,
  AgoraxManagedAgentTransport,
} from './agorax-managed-agent-bridge'
import { AgoraxManagedAgentActivityStream } from './agorax-managed-agent-activity-stream'
import { AgoraxManagedAgentHttpClient } from './agorax-managed-agent-http-client'
import { AgoraxManagedRunStore } from './agorax-managed-run-store'
import WebSocket from 'ws'

type Queue = {
  events: AgentStreamEvent[]
  waiters: Array<() => void>
  done: boolean
  close: () => void
}

export type AgoraxManagedAgentTransportOptions = {
  baseUrl: string
  workspaceId: string
  runStore?: AgoraxManagedRunStore
  socketFactory: ConstructorParameters<
    typeof AgoraxManagedAgentActivityStream
  >[0]['socketFactory']
  fetchImpl?: typeof fetch
}

export function createAgoraxManagedAgentTransportFromEnv():
  | AgoraxManagedAgentTransport
  | null {
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
  const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
  if (!baseUrl || !workspaceId) return null

  return createAgoraxManagedAgentTransport({
    baseUrl,
    workspaceId,
    socketFactory: ({ url }) => {
      const socket = new WebSocket(url)
      return {
        onMessage: (listener) => {
          socket.on('message', (data) => {
            try {
              const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
              listener(JSON.parse(text) as unknown)
            } catch {
              // Ignore malformed frames; canonical protocol validation happens at the boundary.
            }
          })
        },
        onError: (listener) => {
          socket.on('error', (error) =>
            listener(error instanceof Error ? error : new Error(String(error))),
          )
        },
        close: () => socket.close(),
      }
    },
  })
}

function activityUrl(baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, '')
  return url.replace(/^http/, 'ws') + '/v1/events/ws'
}

export function createAgoraxManagedAgentTransport(
  options: AgoraxManagedAgentTransportOptions,
): AgoraxManagedAgentTransport {
  const client = new AgoraxManagedAgentHttpClient(options)
  const runStore = options.runStore ?? new AgoraxManagedRunStore()
  const queues = new Map<string, Queue>()

  const ensureQueue = (runId: string, binding: { agentSessionId: string }): Queue => {
    const existing = queues.get(runId)
    if (existing) return existing
    const queue: Queue = {
      events: [],
      waiters: [],
      done: false,
      close: () => undefined,
    }
    const stream = new AgoraxManagedAgentActivityStream({
      url: activityUrl(options.baseUrl),
      workspaceId: options.workspaceId,
      agentSessionId: binding.agentSessionId,
      runId,
      socketFactory: options.socketFactory,
      onEvents: (events) => {
        queue.events.push(...events)
        for (const wake of queue.waiters.splice(0)) wake()
      },
      onError: (error) => {
        queue.events.push({ type: 'error', runId, message: error.message })
        queue.done = true
        for (const wake of queue.waiters.splice(0)) wake()
      },
    })
    stream.connect()
    queue.close = () => {
      if (queue.done) return
      queue.done = true
      stream.close()
      for (const wake of queue.waiters.splice(0)) wake()
    }
    queues.set(runId, queue)
    return queue
  }

  return {
    probe: (backend: AgoraxManagedAgentBackend): Promise<AgentProbeResult> =>
      client.probe(backend),
    startRun: async ({ backend, run, mcp }: { backend: AgoraxManagedAgentBackend; run: AgentRunInput; mcp: McpHandshake }) => {
      const displaySessionId = run.taskId?.trim()
      const existing = displaySessionId
        ? await runStore.getByDisplaySession(displaySessionId)
        : null
      const displayPrompt = run.displayPrompt?.trim() ?? ''
      if (existing && existing.backend === backend) {
        const response = await client.sendInput(existing.agentSessionId, {
          clientSubmitId: run.runId,
          content: run.task,
          ...(run.content ? { promptContent: run.content } : {}),
          ...(displayPrompt ? { displayPrompt } : {}),
        })
        await runStore.bind({
          runId: run.runId,
          backend,
          agentSessionId: existing.agentSessionId,
          ...(displaySessionId ? { displaySessionId } : {}),
          turnId: response.turnId,
        })
        ensureQueue(run.runId, { agentSessionId: existing.agentSessionId })
        return { runId: run.runId }
      }
      const response = await client.createSessionForRun({
        runId: run.runId,
        runStore,
        session: {
          backend,
          agentSessionId: run.runId,
          clientSubmitId: run.runId,
          content: run.task,
          ...(run.content ? { promptContent: run.content } : {}),
          ...(displayPrompt ? { displayPrompt } : {}),
          ...(run.cwd ? { cwd: run.cwd } : {}),
          ...(run.model ? { model: run.model } : {}),
          ...(run.effort ? { reasoningEffort: run.effort } : {}),
          ...(mcp.endpoint ? { mcpEndpoint: mcp.endpoint } : {}),
          ...(mcp.runToken ? { mcpRunToken: mcp.runToken } : {}),
          ...(mcp.toolAllowlist?.length
            ? { mcpToolAllowlist: [...mcp.toolAllowlist] }
            : {}),
        },
      })
      if (displaySessionId) {
        await runStore.bind({
          runId: run.runId,
          backend,
          agentSessionId: response.session.id,
          displaySessionId,
          ...(response.session.activeTurnId ? { turnId: response.session.activeTurnId } : {}),
        })
      }
      ensureQueue(run.runId, { agentSessionId: response.session.id })
      return { runId: run.runId }
    },
    streamEvents: async function* ({ runId }: { backend: AgoraxManagedAgentBackend; runId: string }) {
      const binding = await runStore.get(runId)
      if (!binding) return
      const queue = ensureQueue(runId, binding)
      let cursor = 0
      while (!queue.done || cursor < queue.events.length) {
        while (cursor < queue.events.length) yield queue.events[cursor++]!
        if (!queue.done) await new Promise<void>((wake) => queue.waiters.push(wake))
      }
      queues.delete(runId)
    },
    interrupt: async ({ runId }: { backend: AgoraxManagedAgentBackend; runId: string; reason: string }) => {
      const binding = await runStore.get(runId)
      if (!binding?.turnId) return
      await client.cancelTurn(binding.agentSessionId, binding.turnId)
      queues.get(runId)?.close()
    },
  }
}