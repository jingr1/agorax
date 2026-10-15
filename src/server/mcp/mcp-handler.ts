import { getSwarmMission } from '../swarm-missions'
import { getProject } from '../task-pipeline/projects'
import {
  isToolAllowed,
  resolveRunTokenDetailed,
  revokeRunTokensForRun,
} from './run-tokens'
import { TASK_RUN_STATUSES, completeTaskRun, startTaskRun } from './task-runs'
import * as toolGroups from './tool-groups'
import type { RunToken } from './run-tokens'
import type { TaskRunStatus } from './task-runs'

export type McpRequest = {
  jsonrpc: string
  id: string | number
  method: string
  params?: Record<string, unknown>
}

export type McpResponse = {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type McpContext = {
  token: RunToken
  dbPath?: string
}

export type RunTerminalEvent = {
  runId: string
  missionId: string
  assignmentId: string
  agentId: string
  status: TaskRunStatus
  summary: string | null
  blocker: string | null
  nextAction: string | null
  /** Git head sha reported by the agent for worktree-mode runs (P2b). */
  headSha?: string | null
}

/**
 * Hook fired after a run reaches a terminal state via task_complete.
 * Registered by the pipeline layer (advance) to propagate run state into
 * mission assignment state — keeps mcp/ free of mission-store imports
 * beyond read-only getSwarmMission, and lets tests observe completions.
 */
let onRunTerminal: ((event: RunTerminalEvent) => void) | null = null

export function setOnRunTerminalHook(
  hook: ((event: RunTerminalEvent) => void) | null,
): void {
  onRunTerminal = hook
}

const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  FORBIDDEN: -32003,
  TOKEN_EXPIRED: -32004,
  TOKEN_REVOKED: -32005,
  OWNERSHIP_MISMATCH: -32006,
} as const

function errorResponse(
  id: string | number,
  code: number,
  message: string,
  data?: unknown,
): McpResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } }
}

function successResponse(id: string | number, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result }
}

/**
 * Plan rule (行 783): the token is the source of truth for scope. If the
 * caller explicitly passes a scope field (taskId/missionId/assignmentId)
 * that disagrees with the token, REJECT — don't silently ignore it.
 * Silently agreeing would let a confused agent (post context-compaction)
 * operate on the wrong assignment without noticing.
 */
function scopeMismatch(
  params: Record<string, unknown> | undefined,
  field: 'taskId' | 'missionId' | 'assignmentId',
  expected: string | null,
): boolean {
  const value = params?.[field]
  if (value === undefined || value === null) return false
  return value !== expected
}

function requireWriteToken(
  id: string | number,
  token: RunToken,
  tool: string,
): McpResponse | null {
  if (token.kind !== 'run_write') {
    return errorResponse(
      id,
      ERROR_CODES.FORBIDDEN,
      `${tool} requires a run_write token`,
    )
  }
  if (!isToolAllowed(token, tool)) {
    return errorResponse(
      id,
      ERROR_CODES.FORBIDDEN,
      `${tool} not allowed for this token`,
    )
  }
  return null
}

export async function handleMcpRequest(
  request: McpRequest,
  dbPath?: string,
): Promise<McpResponse> {
  const { id, method, params } = request

  if (request.jsonrpc !== '2.0') {
    return errorResponse(
      id,
      ERROR_CODES.INVALID_REQUEST,
      'Invalid JSON-RPC version',
    )
  }
  if (typeof method !== 'string' || method.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.INVALID_REQUEST,
      'method must be a non-empty string',
    )
  }

  const token = typeof params?.token === 'string' ? params.token : null
  if (!token) {
    return errorResponse(id, ERROR_CODES.UNAUTHORIZED, 'Missing token')
  }

  const resolved = resolveRunTokenDetailed(token, dbPath)
  if (resolved.ok !== true) {
    // NOTE: failed resolutions are a token-enumeration probe point. The HTTP
    // route layer is responsible for audit logging / rate limiting.
    const reason: 'unknown' | 'expired' | 'revoked' = resolved.reason
    switch (reason) {
      case 'expired':
        return errorResponse(
          id,
          ERROR_CODES.TOKEN_EXPIRED,
          'Token expired; request a new run token from the dispatcher',
        )
      case 'revoked':
        return errorResponse(
          id,
          ERROR_CODES.TOKEN_REVOKED,
          'Token revoked (run ended or reassigned); if you are still working, request reassignment',
        )
      default:
        return errorResponse(id, ERROR_CODES.FORBIDDEN, 'Invalid token')
    }
  }

  const ctx: McpContext = { token: resolved.token, dbPath }

  switch (method) {
    case 'task_get':
      return handleTaskGet(id, params, ctx)
    case 'task_start':
      return handleTaskStart(id, params, ctx)
    case 'task_complete':
      return handleTaskComplete(id, params, ctx)
    // ── P1 步骤 4 tool groups ──
    case 'kanban_get': {
      if (!isToolAllowed(ctx.token, 'kanban_get')) {
        return errorResponse(
          id,
          ERROR_CODES.FORBIDDEN,
          'kanban_get not allowed for this token',
        )
      }
      return toolGroups.handleKanbanGet(id, ctx, toolDeps)
    }
    case 'review_approve': {
      const gate = requireWriteToken(id, ctx.token, 'review_approve')
      if (gate) return gate
      return toolGroups.handleReviewApprove(id, params, ctx, toolDeps)
    }
    case 'review_request_changes': {
      const gate = requireWriteToken(id, ctx.token, 'review_request_changes')
      if (gate) return gate
      return toolGroups.handleReviewRequestChanges(id, params, ctx, toolDeps)
    }
    case 'message_send': {
      const gate = requireWriteToken(id, ctx.token, 'message_send')
      if (gate) return gate
      return toolGroups.handleMessageSend(id, params, ctx, toolDeps)
    }
    case 'member_work_sync_status': {
      if (!isToolAllowed(ctx.token, 'member_work_sync_status')) {
        return errorResponse(
          id,
          ERROR_CODES.FORBIDDEN,
          'member_work_sync_status not allowed for this token',
        )
      }
      return toolGroups.handleSyncStatus(id, ctx, toolDeps)
    }
    case 'member_work_sync_report': {
      const gate = requireWriteToken(id, ctx.token, 'member_work_sync_report')
      if (gate) return gate
      return toolGroups.handleSyncReport(id, params, ctx, toolDeps)
    }
    default:
      return errorResponse(
        id,
        ERROR_CODES.METHOD_NOT_FOUND,
        `Unknown method: ${method}`,
      )
  }
}

const toolDeps: toolGroups.ToolDeps = {
  success: successResponse,
  error: errorResponse,
  codes: {
    INVALID_PARAMS: ERROR_CODES.INVALID_PARAMS,
    FORBIDDEN: ERROR_CODES.FORBIDDEN,
    OWNERSHIP_MISMATCH: ERROR_CODES.OWNERSHIP_MISMATCH,
    INTERNAL_ERROR: ERROR_CODES.INTERNAL_ERROR,
  },
}

function handleTaskGet(
  id: string | number,
  params: Record<string, unknown> | undefined,
  ctx: McpContext,
): McpResponse {
  if (!isToolAllowed(ctx.token, 'task_get')) {
    return errorResponse(
      id,
      ERROR_CODES.FORBIDDEN,
      'task_get not allowed for this token',
    )
  }
  if (scopeMismatch(params, 'assignmentId', ctx.token.assignmentId)) {
    return errorResponse(
      id,
      ERROR_CODES.OWNERSHIP_MISMATCH,
      'params.assignmentId does not match token scope',
    )
  }
  if (
    scopeMismatch(params, 'missionId', ctx.token.taskId) ||
    scopeMismatch(params, 'taskId', ctx.token.taskId)
  ) {
    return errorResponse(
      id,
      ERROR_CODES.OWNERSHIP_MISMATCH,
      'params.taskId/missionId does not match token scope',
    )
  }

  // token.taskId carries the missionId for task tools (see RunToken.taskId).
  const missionId = ctx.token.taskId
  const mission = getSwarmMission(missionId)
  if (!mission) {
    return errorResponse(
      id,
      ERROR_CODES.INVALID_PARAMS,
      `Mission not found: ${missionId}`,
    )
  }

  const assignment = mission.assignments.find(
    (item) => item.id === ctx.token.assignmentId,
  )
  if (!assignment) {
    return errorResponse(
      id,
      ERROR_CODES.INVALID_PARAMS,
      `Assignment not found: ${ctx.token.assignmentId}`,
    )
  }

  return successResponse(id, {
    missionId: mission.id,
    missionTitle: mission.title,
    assignment: {
      id: assignment.id,
      workerId: assignment.workerId,
      task: assignment.task,
      rationale: assignment.rationale,
      dependsOn: assignment.dependsOn,
      state: assignment.state,
    },
    // Plan (行 805): tool responses embed the next step so the protocol
    // survives context compaction.
    nextRequiredAction:
      'Call task_start to begin this run before doing any work.',
    nextRequiredToolCall: { tool: 'task_start', params: {} },
  })
}

function handleTaskStart(
  id: string | number,
  params: Record<string, unknown> | undefined,
  ctx: McpContext,
): McpResponse {
  const gate = requireWriteToken(id, ctx.token, 'task_start')
  if (gate) return gate
  if (scopeMismatch(params, 'assignmentId', ctx.token.assignmentId)) {
    return errorResponse(
      id,
      ERROR_CODES.OWNERSHIP_MISMATCH,
      'params.assignmentId does not match token scope',
    )
  }
  if (
    scopeMismatch(params, 'missionId', ctx.token.taskId) ||
    scopeMismatch(params, 'taskId', ctx.token.taskId)
  ) {
    return errorResponse(
      id,
      ERROR_CODES.OWNERSHIP_MISMATCH,
      'params.taskId/missionId does not match token scope',
    )
  }

  const missionId = ctx.token.taskId
  const mission = getSwarmMission(missionId)
  if (!mission) {
    return errorResponse(
      id,
      ERROR_CODES.INVALID_PARAMS,
      `Mission not found: ${missionId}`,
    )
  }

  const assignment = mission.assignments.find(
    (item) => item.id === ctx.token.assignmentId,
  )
  if (!assignment) {
    return errorResponse(
      id,
      ERROR_CODES.INVALID_PARAMS,
      `Assignment not found: ${ctx.token.assignmentId}`,
    )
  }

  // Ownership: token.participantId must match assignment.workerId
  if (assignment.workerId !== ctx.token.participantId) {
    return errorResponse(
      id,
      ERROR_CODES.OWNERSHIP_MISMATCH,
      'Token does not own this assignment',
    )
  }

  // Token granularity = one run: the run record's id IS the token's runId,
  // assigned by the dispatcher at issue time. Re-using the same token for a
  // second task_start hits the PRIMARY KEY conflict → idempotent duplicate.
  try {
    const gitContext = ctx.token.context as
      | {
          projectId?: string
          baseRef?: string
          worktreePath?: string
          branch?: string
        }
      | undefined
    let run = startTaskRun({
      runId: ctx.token.runId,
      taskId: mission.id,
      missionId: mission.id,
      assignmentId: assignment.id,
      agentId: ctx.token.participantId,
      runtime: 'mcp',
      dbPath: ctx.dbPath,
    })
    if (gitContext?.projectId && gitContext?.worktreePath) {
      // P2b: record worktree metadata so task_complete/advance can compute git fields.
      const project = getProject(gitContext.projectId)
      if (project) {
        run = startTaskRun({
          runId: ctx.token.runId,
          taskId: mission.id,
          missionId: mission.id,
          assignmentId: assignment.id,
          agentId: ctx.token.participantId,
          runtime: 'mcp',
          projectId: gitContext.projectId,
          branch: gitContext.branch ?? null,
          baseRef: gitContext.baseRef ?? null,
          worktreePath: gitContext.worktreePath,
          dbPath: ctx.dbPath,
        })
      }
    }

    return successResponse(id, {
      runId: run.id,
      status: 'running',
      startedAt: run.startedAt,
      nextRequiredAction:
        'Work the assignment, then call task_complete with this runId (and blocker/nextAction if stuck).',
      nextRequiredToolCall: {
        tool: 'task_complete',
        params: { runId: run.id },
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/UNIQUE|PRIMARY KEY/i.test(message)) {
      return errorResponse(
        id,
        ERROR_CODES.INVALID_PARAMS,
        `Run already started: ${ctx.token.runId}. This token is bound to one run; request a new token for another attempt.`,
      )
    }
    return errorResponse(
      id,
      ERROR_CODES.INTERNAL_ERROR,
      `Failed to start run: ${message}`,
    )
  }
}

function handleTaskComplete(
  id: string | number,
  params: Record<string, unknown> | undefined,
  ctx: McpContext,
): McpResponse {
  const gate = requireWriteToken(id, ctx.token, 'task_complete')
  if (gate) return gate
  if (scopeMismatch(params, 'assignmentId', ctx.token.assignmentId)) {
    return errorResponse(
      id,
      ERROR_CODES.OWNERSHIP_MISMATCH,
      'params.assignmentId does not match token scope',
    )
  }
  if (
    scopeMismatch(params, 'missionId', ctx.token.taskId) ||
    scopeMismatch(params, 'taskId', ctx.token.taskId)
  ) {
    return errorResponse(
      id,
      ERROR_CODES.OWNERSHIP_MISMATCH,
      'params.taskId/missionId does not match token scope',
    )
  }

  const missionId = ctx.token.taskId
  const mission = getSwarmMission(missionId)
  if (!mission) {
    return errorResponse(
      id,
      ERROR_CODES.INVALID_PARAMS,
      `Mission not found: ${missionId}`,
    )
  }

  const assignment = mission.assignments.find(
    (item) => item.id === ctx.token.assignmentId,
  )
  if (!assignment) {
    return errorResponse(
      id,
      ERROR_CODES.INVALID_PARAMS,
      `Assignment not found: ${ctx.token.assignmentId}`,
    )
  }

  if (assignment.workerId !== ctx.token.participantId) {
    return errorResponse(
      id,
      ERROR_CODES.OWNERSHIP_MISMATCH,
      'Token does not own this assignment',
    )
  }

  const runId = typeof params?.runId === 'string' ? params.runId : null
  if (!runId) {
    return errorResponse(id, ERROR_CODES.INVALID_PARAMS, 'Missing runId')
  }
  // The token is bound to exactly one run; completing a different runId is a
  // confused-agent signal, reject it.
  if (runId !== ctx.token.runId) {
    return errorResponse(
      id,
      ERROR_CODES.OWNERSHIP_MISMATCH,
      'runId does not match token scope',
    )
  }

  const summary = typeof params?.summary === 'string' ? params.summary : null
  const blocker = typeof params?.blocker === 'string' ? params.blocker : null
  const nextAction =
    typeof params?.nextAction === 'string' ? params.nextAction : null
  const headSha = typeof params?.headSha === 'string' ? params.headSha : null

  // Explicit status wins; fall back to the legacy blocker→blocked / done rule.
  const explicitStatus =
    typeof params?.status === 'string' ? params.status : null
  let status: TaskRunStatus
  if (explicitStatus !== null) {
    if (
      !TASK_RUN_STATUSES.includes(explicitStatus as TaskRunStatus) ||
      explicitStatus === 'running'
    ) {
      return errorResponse(
        id,
        ERROR_CODES.INVALID_PARAMS,
        `Invalid status: ${explicitStatus}. Allowed: done | blocked | needs_input | failed | cancelled`,
      )
    }
    status = explicitStatus as TaskRunStatus
  } else {
    status = blocker ? 'blocked' : 'done'
  }
  // needs_input / blocked open pending_turns via advance → openAttentionForMission.

  const completed = completeTaskRun({
    runId,
    status,
    assignmentId: assignment.id,
    agentId: ctx.token.participantId,
    summary,
    blocker,
    nextAction,
    headSha,
    dbPath: ctx.dbPath,
  })

  if (!completed) {
    return errorResponse(
      id,
      ERROR_CODES.INVALID_PARAMS,
      `Run not completable: ${runId} (unknown, not running, or not owned by this token)`,
    )
  }

  // Plan (行 774/780): run_write token dies with the run. A zombie process
  // holding this token gets 403 from here on.
  revokeRunTokensForRun(runId, ctx.dbPath)

  // Propagate into the mission state machine (registered by the pipeline
  // layer). Errors here must not fail the MCP call — the run IS complete;
  // a hook failure leaves the assignment recoverable via reconcile.
  try {
    onRunTerminal?.({
      runId,
      missionId: mission.id,
      assignmentId: assignment.id,
      agentId: ctx.token.participantId,
      status,
      summary,
      blocker,
      nextAction,
      headSha,
    })
  } catch (error) {
    console.error('[mcp] onRunTerminal hook failed', error)
  }

  return successResponse(id, {
    runId,
    status,
    completedAt: Date.now(),
  })
}
