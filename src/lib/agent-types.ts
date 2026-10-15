/**
 * Shared agent / workspace types for the unified Agent Workspace UI.
 *
 * These types intentionally decouple UI concerns from the server-side adapter
 * contracts so the chat screen can talk about "agents" and "sessions" without
 * leaking runtime internals.
 */

export type AgentRuntime =
  | 'hermes'
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'kimi'
  | 'deepseek-harness'
  | 'opencode'

/**
 * @deprecated Prefer UnifiedAgentStatus from `agent-status.ts`. This union is
 * kept for existing call-sites that render dots; new code should use the
 * canonical 'active' | 'idle' | 'offline' | 'blocked' | 'error' | 'needsSetup'.
 */
export type AgentStatus =
  | 'online'
  | 'offline'
  | 'busy'
  | 'blocked'
  | 'idle'
  | 'unknown'

export interface Agent {
  agentId: string
  name: string
  runtime: AgentRuntime
  status: AgentStatus
  execution: 'local' | 'ssh' | 'unknown'
  currentTaskId?: string
  currentMissionId?: string
  /** Registry declaration fields from agents.yaml. */
  role?: string
  specialty?: string
  /** Display-only config; secrets are stored server-side only. */
  runtimeConfig: {
    profile?: string
    command?: string
    args?: Array<string>
    capabilities: Array<string>
    maxConcurrentTasks?: number
  }
}

export type AgentSessionState =
  | 'idle'
  | 'running'
  | 'completed'
  | 'error'
  | 'paused'

export interface AgentSession {
  sessionId: string
  agentId: string
  title: string
  state: AgentSessionState
  lastMessageAt: string
  summary?: string
}

export interface AgentWithStatus extends Agent {
  probe: {
    available: boolean
    version?: string
    detail?: string
  }
  statusSnapshot?: {
    /** Raw runtime state (e.g. executing / idle / blocked) — not folded. */
    state: string
    currentTask?: string | null
    taskId?: string | null
    missionId?: string | null
    needsHuman?: boolean
    checkpointStatus?: string
    lastSummary?: string | null
    updatedAt: number | string
  }
}
