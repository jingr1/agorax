/**
 * agent-status-watcher — fs.watch all declared agent runtime.json files
 * and broadcast `agent_status` SSE events with scope=global.
 *
 * Hermes agents own a profile directory with runtime.json; CLI adapters
 * (claude-code / codex / deepseek-harness) emit agent_status directly from
 * AgentRuntimeRouter because they have no persistent runtime file.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getHermesRoot, getProfilesDir } from './hermes-paths'
import { readSwarmRuntimeFile } from './swarm-foundation'
import { publishChatEvent } from './chat-event-bus'
import { getAgentRuntimeRouter } from './agent-runtime/router'
import type { SwarmRuntime } from './swarm-foundation'

export type AgentStatusSnapshot = {
  agentId: string
  runtime: 'hermes' | 'claude-code' | 'codex' | 'deepseek-harness' | 'opencode'
  state: string
  currentTask: string | null
  taskId: string | null
  missionId: string | null
  needsHuman: boolean
  checkpointStatus: string
  lastSummary: string | null
  updatedAt: number
}

const WATCHER_STATE_KEY = '__agent_status_watcher_state__' as const
const DEBOUNCE_MS = 300

interface WatcherState {
  started: boolean
  watchers: Map<string, fs.FSWatcher>
  pending: Map<string, ReturnType<typeof setTimeout>>
}

function getState(): WatcherState {
  const g = globalThis as Record<string, unknown>
  if (!g[WATCHER_STATE_KEY]) {
    g[WATCHER_STATE_KEY] = {
      started: false,
      watchers: new Map(),
      pending: new Map(),
    }
  }
  return g[WATCHER_STATE_KEY] as WatcherState
}

/** `default` lives at ~/.hermes; other Hermes agents under profiles/<id>. */
function hermesProfilePath(agentId: string): string {
  if (agentId === 'default') return getHermesRoot()
  return path.join(getProfilesDir(), agentId)
}

function readRuntime(agentId: string): SwarmRuntime | null {
  const profilePath = hermesProfilePath(agentId)
  try {
    const { source, runtime } = readSwarmRuntimeFile(profilePath, agentId, {
      workspaceRoot: process.cwd(),
    })
    // Missing runtime.json yields an in-memory fallback with no lastOutputAt.
    // Treating that as a live snapshot + `Date.now()` made probe-down agents
    // look "unstable" forever (especially `default`, which often has no file).
    if (source === 'fallback') return null
    return runtime
  } catch {
    return null
  }
}

function buildSnapshot(
  agentId: string,
  runtime: SwarmRuntime,
): AgentStatusSnapshot {
  return {
    agentId,
    runtime: 'hermes',
    state: runtime.state,
    currentTask: runtime.currentTask ?? null,
    taskId: runtime.sessionId ?? null,
    missionId: runtime.missionId ?? null,
    needsHuman: runtime.needsHuman,
    checkpointStatus: runtime.checkpointStatus,
    lastSummary: runtime.lastSummary ?? null,
    // Never invent "now" — that falsely trips the unstable window.
    updatedAt: runtime.lastOutputAt ?? 0,
  }
}

export function publishAgentStatus(snapshot: AgentStatusSnapshot): void {
  publishChatEvent('agent_status', { ...snapshot, scope: 'global' })
}

function flushAgent(agentId: string): void {
  const runtime = readRuntime(agentId)
  if (!runtime) return
  publishAgentStatus(buildSnapshot(agentId, runtime))
}

function scheduleFlush(agentId: string): void {
  const state = getState()
  const existing = state.pending.get(agentId)
  if (existing) clearTimeout(existing)
  state.pending.set(
    agentId,
    setTimeout(() => {
      state.pending.delete(agentId)
      flushAgent(agentId)
    }, DEBOUNCE_MS),
  )
}

function watchAgent(agentId: string): void {
  const state = getState()
  if (state.watchers.has(agentId)) return
  const runtimePath = path.join(hermesProfilePath(agentId), 'runtime.json')
  if (!fs.existsSync(runtimePath)) return

  try {
    const watcher = fs.watch(runtimePath, (eventType) => {
      if (eventType === 'change') {
        scheduleFlush(agentId)
      }
    })
    watcher.on('error', (err) => {
      console.error(`[agent-status-watcher] ${agentId}:`, err)
    })
    state.watchers.set(agentId, watcher)
  } catch (err) {
    console.error(`[agent-status-watcher] failed to watch ${agentId}:`, err)
  }
}

function unwatchAgent(agentId: string): void {
  const state = getState()
  const watcher = state.watchers.get(agentId)
  if (watcher) {
    watcher.close()
    state.watchers.delete(agentId)
  }
  const pending = state.pending.get(agentId)
  if (pending) {
    clearTimeout(pending)
    state.pending.delete(agentId)
  }
}

function refreshWatchedAgents(): void {
  const router = getAgentRuntimeRouter()
  const declared = new Set(router.registry.agents.map((a) => a.id))
  for (const agentId of declared) {
    if (router.registry.byId.get(agentId)?.runtime === 'hermes') {
      watchAgent(agentId)
    }
  }
  for (const [agentId] of getState().watchers) {
    if (!declared.has(agentId)) unwatchAgent(agentId)
  }
}

export function startAgentStatusWatcher(): void {
  const state = getState()
  if (state.started) {
    refreshWatchedAgents()
    return
  }
  state.started = true
  refreshWatchedAgents()
  console.log(
    `[agent-status-watcher] watching ${state.watchers.size} declared hermes agent(s)`,
  )
}

export function stopAgentStatusWatcher(): void {
  const state = getState()
  for (const [agentId] of state.watchers) unwatchAgent(agentId)
  state.started = false
}

export function listWatchedAgents(): Array<string> {
  return [...getState().watchers.keys()]
}

export function getAgentStatusSnapshot(
  agentId: string,
): AgentStatusSnapshot | null {
  const runtime = readRuntime(agentId)
  if (!runtime) return null
  return buildSnapshot(agentId, runtime)
}
