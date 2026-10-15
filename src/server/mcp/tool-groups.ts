/**
 * MCP tool groups — P1 步骤 4 «再装满».
 *
 * Adds the review / sync / message / kanban tool groups on top of the
 * step-1 task spine. All handlers take the same McpContext (token-resolved
 * scope) and follow the same rules as the task tools:
 *  - token is the source of truth for scope (conflicting params → reject)
 *  - write tools require run_write kind
 *  - failures carry nextRequiredToolCall so the protocol survives compaction
 *
 * Sync implements the plan's two-phase protocol («双阶段 sync + 议程指纹»):
 *   member_work_sync_status  → agenda + agendaFingerprint + one-shot reportToken
 *   member_work_sync_report  → state + fingerprint + reportToken
 * reportToken idempotent replay (plan 行 802): same token + same payload hash
 * within 60s replays the FIRST response; different payload → reject; expired
 * window → reject with nextRequiredToolCall back to member_work_sync_status.
 * member_work_sync_report NEVER completes a task.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  getSwarmMission,
  markMissionAssignmentReviewed,
  recordMissionCheckpoint,
} from '../swarm-missions'
import { createCollabId, getCollabDbPath, insertCollabRow } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'
import { listKanbanCards } from '../kanban-backend'
import { publishChatEvent } from '../chat-event-bus'
import type { McpContext, McpResponse } from './mcp-handler'

// ─── shared helpers (injected by mcp-handler to avoid circular constants) ──

export type ToolDeps = {
  success: (id: string | number, result: unknown) => McpResponse
  error: (
    id: string | number,
    code: number,
    message: string,
    data?: unknown,
  ) => McpResponse
  codes: {
    INVALID_PARAMS: number
    FORBIDDEN: number
    OWNERSHIP_MISMATCH: number
    INTERNAL_ERROR: number
  }
}

// ─── kanban ─────────────────────────────────────────────────────────────

export async function handleKanbanGet(
  id: string | number,
  ctx: McpContext,
  deps: ToolDeps,
): Promise<McpResponse> {
  const cards = await listKanbanCards()
  return deps.success(id, {
    cards: cards.map((c) => ({
      id: c.id,
      title: (c as Record<string, unknown>).title ?? null,
      status: (c as Record<string, unknown>).status ?? null,
      assignee: (c as Record<string, unknown>).assignee ?? null,
    })),
    nextRequiredAction:
      'This is a read-only view. Idle agents: wait for dispatch.',
  })
}

// ─── review ─────────────────────────────────────────────────────────────
// Plan: 评审是节点。review tools move the assignment through
// checkpointed → reviewing → done(approved) / rework(changes_requested).

export function handleReviewApprove(
  id: string | number,
  params: Record<string, unknown> | undefined,
  ctx: McpContext,
  deps: ToolDeps,
): McpResponse {
  const missionId = ctx.token.taskId
  const mission = getSwarmMission(missionId)
  if (!mission)
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      `Mission not found: ${missionId}`,
    )

  // Reviewer may approve someone else's checkpointed assignment. Target comes
  // from params.assignmentId (required) — the reviewer's own token scope is
  // their review assignment, not the reviewed one.
  const targetId =
    typeof params?.assignmentId === 'string' ? params.assignmentId : null
  if (!targetId)
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      'Missing assignmentId to approve',
    )
  const target = mission.assignments.find((a) => a.id === targetId)
  if (!target)
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      `Assignment not found: ${targetId}`,
    )
  if (target.state !== 'checkpointed' && target.state !== 'reviewing') {
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      `Assignment ${targetId} is ${target.state}, not awaiting review`,
    )
  }

  const updated = markMissionAssignmentReviewed({
    missionId,
    assignmentId: targetId,
    reviewerId: ctx.token.participantId,
  })
  if (!updated)
    return deps.error(id, deps.codes.INTERNAL_ERROR, 'Failed to mark reviewed')

  publishChatEvent('review_decision', {
    missionId,
    assignmentId: targetId,
    outcome: 'approved',
    reviewerId: ctx.token.participantId,
  })
  return deps.success(id, {
    assignmentId: targetId,
    outcome: 'approved',
    state: 'done',
    nextRequiredAction:
      'Review complete. The pipeline advances downstream stages automatically.',
  })
}

export function handleReviewRequestChanges(
  id: string | number,
  params: Record<string, unknown> | undefined,
  ctx: McpContext,
  deps: ToolDeps,
): McpResponse {
  const missionId = ctx.token.taskId
  const mission = getSwarmMission(missionId)
  if (!mission)
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      `Mission not found: ${missionId}`,
    )

  const targetId =
    typeof params?.assignmentId === 'string' ? params.assignmentId : null
  if (!targetId)
    return deps.error(id, deps.codes.INVALID_PARAMS, 'Missing assignmentId')
  const feedback = typeof params?.feedback === 'string' ? params.feedback : null
  if (!feedback)
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      'Missing feedback (required for changes_requested)',
    )
  const target = mission.assignments.find((a) => a.id === targetId)
  if (!target)
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      `Assignment not found: ${targetId}`,
    )
  if (target.state !== 'checkpointed' && target.state !== 'reviewing') {
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      `Assignment ${targetId} is ${target.state}, not awaiting review`,
    )
  }

  // changes_requested: record a checkpoint carrying the review outcome; the
  // rework loop (re-dispatch to reworkTarget with retry ≤3) is 模块 1
  // review.ts — out of P1 scope. Here we flip the assignment back to
  // 'blocked' with the feedback so it never silently passes.
  recordMissionCheckpoint({
    missionId,
    assignmentId: targetId,
    workerId: target.workerId,
    checkpoint: {
      stateLabel: 'BLOCKED',
      checkpointStatus: 'blocked',
      runtimeState: 'blocked',
      filesChanged: null,
      commandsRun: null,
      result: null,
      blocker: `changes_requested by ${ctx.token.participantId}: ${feedback}`,
      nextAction: 'Rework per review feedback, then re-checkpoint',
      reviewOutcome: 'changes_requested',
      raw: feedback,
    },
    source: 'mcp-review',
  })

  publishChatEvent('review_decision', {
    missionId,
    assignmentId: targetId,
    outcome: 'changes_requested',
    reviewerId: ctx.token.participantId,
  })
  return deps.success(id, {
    assignmentId: targetId,
    outcome: 'changes_requested',
    state: 'blocked',
    nextRequiredAction:
      'Assignment sent back with feedback. Rework loop dispatch is delivered in 模块 1 review.ts.',
  })
}

// ─── message ────────────────────────────────────────────────────────────

export function handleMessageSend(
  id: string | number,
  params: Record<string, unknown> | undefined,
  ctx: McpContext,
  deps: ToolDeps,
): McpResponse {
  const roomId =
    ctx.token.roomId ??
    (typeof params?.roomId === 'string' ? params.roomId : null)
  if (!roomId)
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      'No roomId in token scope or params',
    )
  if (
    params?.roomId &&
    ctx.token.roomId &&
    params.roomId !== ctx.token.roomId
  ) {
    return deps.error(
      id,
      deps.codes.OWNERSHIP_MISMATCH,
      'params.roomId does not match token scope',
    )
  }
  const content = typeof params?.content === 'string' ? params.content : null
  if (!content?.trim())
    return deps.error(id, deps.codes.INVALID_PARAMS, 'Missing content')

  const messageId = createCollabId('msg')
  insertCollabRow(
    'room_messages',
    {
      id: messageId,
      room_id: roomId,
      sender_kind: 'agent',
      sender_participant_id: ctx.token.participantId,
      sender_name: ctx.token.participantId,
      content,
      mentions: JSON.stringify(
        Array.isArray(params?.mentions) ? params.mentions : [],
      ),
      task_refs: JSON.stringify(
        Array.isArray(params?.taskRefs) ? params.taskRefs : [],
      ),
      run_id: ctx.token.runId,
      task_id: ctx.token.taskId,
      created_at: Date.now(),
    },
    ctx.dbPath,
  )

  publishChatEvent('room_message', {
    roomId,
    messageId,
    senderKind: 'agent',
    senderParticipantId: ctx.token.participantId,
    runId: ctx.token.runId,
    taskId: ctx.token.taskId,
  })
  return deps.success(id, { messageId, roomId })
}

// ─── sync (two-phase, fingerprinted, idempotent replay) ─────────────────

const REPLAY_WINDOW_MS = 60_000

function payloadHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex')
}

/** Agenda fingerprint: hash of the mission's current assignment states. */
function agendaFingerprint(missionId: string): string {
  const mission = getSwarmMission(missionId)
  if (!mission) return payloadHash('no-mission')
  const agenda = mission.assignments.map((a) => `${a.id}:${a.state}`).join('|')
  return payloadHash(agenda)
}

export function handleSyncStatus(
  id: string | number,
  ctx: McpContext,
  deps: ToolDeps,
): McpResponse {
  const missionId = ctx.token.taskId
  const mission = getSwarmMission(missionId)
  if (!mission)
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      `Mission not found: ${missionId}`,
    )
  const assignment = mission.assignments.find(
    (a) => a.id === ctx.token.assignmentId,
  )
  if (!assignment)
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      `Assignment not found: ${ctx.token.assignmentId}`,
    )

  // One-shot reportToken, persisted on the run_tokens row (consumed_* cols).
  const reportToken = `rpt_${randomUUID().replace(/-/g, '')}`
  const fingerprint = agendaFingerprint(missionId)
  const db = openSqliteDatabase(ctx.dbPath ?? getCollabDbPath(), false)
  try {
    db.prepare(
      'UPDATE run_tokens SET consumed_at = NULL, consumed_payload_hash = ?, last_response_json = NULL WHERE token_hash = ?',
    ).run(`pending:${reportToken}`, ctx.token.tokenHash)
  } finally {
    db.close()
  }

  return deps.success(id, {
    agenda: {
      missionId: mission.id,
      assignment: {
        id: assignment.id,
        state: assignment.state,
        task: assignment.task,
      },
    },
    agendaFingerprint: fingerprint,
    reportToken,
    expiresInMs: REPLAY_WINDOW_MS,
    nextRequiredAction:
      'Report within 60s via member_work_sync_report with this agendaFingerprint + reportToken.',
    nextRequiredToolCall: {
      tool: 'member_work_sync_report',
      params: { agendaFingerprint: fingerprint, reportToken },
    },
  })
}

export function handleSyncReport(
  id: string | number,
  params: Record<string, unknown> | undefined,
  ctx: McpContext,
  deps: ToolDeps,
): McpResponse {
  const state = typeof params?.state === 'string' ? params.state : null
  if (!state || !['on_track', 'stuck', 'idle'].includes(state)) {
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      'state must be one of: on_track | stuck | idle',
    )
  }
  const fingerprint =
    typeof params?.agendaFingerprint === 'string'
      ? params.agendaFingerprint
      : null
  const reportToken =
    typeof params?.reportToken === 'string' ? params.reportToken : null
  if (!fingerprint || !reportToken) {
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      'Missing agendaFingerprint or reportToken',
      {
        nextRequiredToolCall: { tool: 'member_work_sync_status', params: {} },
      },
    )
  }

  // Fingerprint check first: stale agenda → reject with re-fetch guidance.
  const current = agendaFingerprint(ctx.token.taskId)
  if (fingerprint !== current) {
    return deps.error(
      id,
      deps.codes.INVALID_PARAMS,
      'agendaFingerprint stale: agenda changed, re-fetch before reporting',
      {
        nextRequiredAction: '议程已变更，请重新获取后再汇报',
        nextRequiredToolCall: { tool: 'member_work_sync_status', params: {} },
      },
    )
  }

  const db = openSqliteDatabase(ctx.dbPath ?? getCollabDbPath(), false)
  let row: Record<string, unknown> | undefined
  try {
    const rows = db
      .prepare(
        'SELECT consumed_at, consumed_payload_hash, last_response_json FROM run_tokens WHERE token_hash = ?',
      )
      .all(ctx.token.tokenHash)
    row = rows[0]
  } finally {
    db.close()
  }
  const stored =
    typeof row.consumed_payload_hash === 'string'
      ? row.consumed_payload_hash
      : null
  if (stored !== `pending:${reportToken}` && stored !== `used:${reportToken}`) {
    return deps.error(id, deps.codes.INVALID_PARAMS, 'Unknown reportToken', {
      nextRequiredToolCall: { tool: 'member_work_sync_status', params: {} },
    })
  }

  const thisPayload = payloadHash({ state, note: params?.note ?? null })
  const consumedAt =
    typeof row.consumed_at === 'number' ? row.consumed_at : null

  if (stored === `used:${reportToken}`) {
    // Already consumed: replay if same payload within window, else reject.
    const withinWindow =
      consumedAt !== null && Date.now() - consumedAt <= REPLAY_WINDOW_MS
    // The request payload hash travels inside the last_response_json envelope.
    const envelope =
      typeof row.last_response_json === 'string'
        ? (JSON.parse(row.last_response_json) as {
            ph?: string
            response?: unknown
          })
        : null
    if (withinWindow && envelope?.ph === thisPayload) {
      return deps.success(id, {
        ...(envelope.response as Record<string, unknown>),
        replayed: true,
      })
    }
    return deps.error(
      id,
      deps.codes.FORBIDDEN,
      withinWindow
        ? 'reportToken replayed with different payload — rejected as possible cross-talk'
        : 'reportToken expired',
      {
        nextRequiredToolCall: { tool: 'member_work_sync_status', params: {} },
      },
    )
  }

  // First use: consume. member_work_sync_report NEVER closes a task — it
  // only answers on_track / stuck / idle (plan 行 787).
  const response = {
    acknowledged: true,
    state,
    runId: ctx.token.runId,
    ...(state === 'stuck'
      ? {
          nextRequiredAction:
            'If blocked on the task itself, call task_complete with blocker.',
        }
      : {}),
  }
  const writeDb = openSqliteDatabase(ctx.dbPath ?? getCollabDbPath(), false)
  try {
    writeDb
      .prepare(
        'UPDATE run_tokens SET consumed_at = ?, consumed_payload_hash = ?, last_response_json = ? WHERE token_hash = ?',
      )
      .run(
        Date.now(),
        `used:${reportToken}`,
        JSON.stringify({ ph: thisPayload, response }),
        ctx.token.tokenHash,
      )
  } finally {
    writeDb.close()
  }
  return deps.success(id, response)
}
