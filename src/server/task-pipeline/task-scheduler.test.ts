import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSwarmMission, listSwarmMissions } from '../swarm-missions'
import { publishChatEvent } from '../chat-event-bus'
import { getPipelineTemplate } from './pipeline-templates'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlPlaneStateStore } from '../control-plane-state'
import {
  __resetSchedulerStateForTests,
  availableSlots,
  claimTask,
  getSchedulerSnapshot,
  markTaskEvent,
  markTaskRunning,
  reconcileStalledTasks,
  releaseTaskClaim,
  scheduleTaskRetry,
  startTaskScheduler,
  tickTaskScheduler,
  configureSchedulerStateStore,
  ownsTaskClaim,
} from './task-scheduler'

vi.mock('../swarm-missions', () => ({
  getSwarmMission: vi.fn(() => null),
  listSwarmMissions: vi.fn(() => []),
  recordMissionAssignmentBlocked: vi.fn(),
}))

vi.mock('../chat-event-bus', () => ({ publishChatEvent: vi.fn() }))

vi.mock('./pipeline-templates', () => ({
  getPipelineTemplate: vi.fn(() => null),
}))

describe('task-scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSwarmMission).mockReturnValue(null)
    vi.mocked(getPipelineTemplate).mockReturnValue(null)
    vi.mocked(listSwarmMissions).mockReturnValue([])
    __resetSchedulerStateForTests()
  })
  afterEach(() => {
    __resetSchedulerStateForTests()
  })

  it('tracks running claims and reduces available slots', () => {
    expect(availableSlots()).toBe(10)
    markTaskRunning({ missionId: 'm1', assignmentId: 'a1' })
    expect(availableSlots()).toBe(9)
    expect(getSchedulerSnapshot().running).toHaveLength(1)
  })

  it('schedules failure retries with backoff metadata', () => {
    const entry = scheduleTaskRetry({
      missionId: 'm1',
      assignmentId: 'a1',
      kind: 'failure',
      error: 'boom',
    })
    expect(entry.attempt).toBe(1)
    expect(entry.error).toBe('boom')
    expect(getSchedulerSnapshot().retrying).toHaveLength(1)
  })

  it('does not requeue an execution whose runtime outcome is unknown', () => {
    vi.mocked(getSwarmMission).mockReturnValue({
      id: 'm1',
      assignments: [{ id: 'a1', state: 'dispatched' }],
    } as never)
    markTaskRunning({ missionId: 'm1', assignmentId: 'a1' })

    expect(reconcileStalledTasks(Date.now() + 10 * 60 * 1000)).toEqual([
      { missionId: 'm1', assignmentId: 'a1' },
    ])
    expect(publishChatEvent).toHaveBeenCalledWith(
      'assignment_stalled',
      expect.objectContaining({ assignmentId: 'a1' }),
    )
    expect(getSchedulerSnapshot().retrying).toEqual([])
    expect(getSchedulerSnapshot().running).toHaveLength(1)
  })

  it('retains a stale queued reservation while its preparation may still be running', () => {
    vi.mocked(getSwarmMission).mockReturnValue({
      id: 'm1',
      assignments: [{ id: 'a1', state: 'queued' }],
    } as never)
    expect(claimTask({ missionId: 'm1', assignmentId: 'a1' })).toBeTruthy()

    expect(reconcileStalledTasks(Date.now() + 10 * 60 * 1000)).toEqual([
      { missionId: 'm1', assignmentId: 'a1' },
    ])
    expect(getSchedulerSnapshot().running).toHaveLength(1)
    expect(getSchedulerSnapshot().retrying).toEqual([])
    expect(claimTask({ missionId: 'm1', assignmentId: 'a1' })).toBeNull()
    expect(reconcileStalledTasks(Date.now() + 20 * 60 * 1000)).toEqual([])
  })

  it('applies pipeline capacity per mission without blocking unrelated missions', () => {
    vi.mocked(getSwarmMission).mockImplementation(
      (missionId) =>
        ({
          id: missionId,
          pipelineId: 'limited',
          assignments: [],
        }) as never,
    )
    vi.mocked(getPipelineTemplate).mockReturnValue({
      runtime: { maxConcurrentTasks: 1 },
    } as never)

    expect(claimTask({ missionId: 'm1', assignmentId: 'a1' })).toBeTruthy()
    expect(claimTask({ missionId: 'm1', assignmentId: 'a2' })).toBeNull()
    expect(claimTask({ missionId: 'm2', assignmentId: 'a3' })).toBeTruthy()
    releaseTaskClaim('a1')
    expect(claimTask({ missionId: 'm1', assignmentId: 'a2' })).toBeTruthy()
  })

  it('refreshes a live reservation heartbeat', () => {
    markTaskRunning({ missionId: 'm1', assignmentId: 'a1' })
    const previous = getSchedulerSnapshot().running[0].lastEventAt
    vi.spyOn(Date, 'now').mockReturnValue(previous + 5000)
    try {
      markTaskEvent('a1')
      expect(getSchedulerSnapshot().running[0].lastEventAt).toBe(
        previous + 5000,
      )
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('restores active capacity from missions beyond the first page', () => {
    vi.mocked(listSwarmMissions).mockImplementation((_limit, offset) => {
      if (offset === 0) {
        return Array.from({ length: 100 }, (_, index) => ({
          id: `m-${index}`,
          assignments: [],
        })) as never
      }
      return [
        {
          id: 'old-active',
          assignments: [{ id: 'old-task', state: 'dispatched' }],
        },
      ] as never
    })

    startTaskScheduler()

    expect(listSwarmMissions).toHaveBeenNthCalledWith(2, 100, 100)
    expect(getSchedulerSnapshot().running).toEqual([
      expect.objectContaining({
        missionId: 'old-active',
        assignmentId: 'old-task',
      }),
    ])
    expect(availableSlots()).toBe(9)
  })

  it('releases requeued executions without releasing work still preparing to start', async () => {
    vi.mocked(getSwarmMission).mockReturnValue({
      id: 'm1',
      assignments: [{ id: 'a1', state: 'queued' }],
    } as never)
    markTaskRunning({ missionId: 'm1', assignmentId: 'a1' })

    await tickTaskScheduler()
    expect(getSchedulerSnapshot().running).toEqual([])

    expect(claimTask({ missionId: 'm1', assignmentId: 'a1' })).toBeTruthy()
    await tickTaskScheduler()
    expect(getSchedulerSnapshot().running).toHaveLength(1)
  })

  it('restores retry deadlines and fences unresolved executions after memory is rebuilt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scheduler-restart-'))
    try {
      const store = new ControlPlaneStateStore(join(root, 'state.db'))
      configureSchedulerStateStore(store)
      const claim = claimTask({ missionId: 'm1', assignmentId: 'a1' })!
      const retry = scheduleTaskRetry({ missionId: 'm1', assignmentId: 'a2', kind: 'failure', error: 'unstarted' })
      __resetSchedulerStateForTests()
      configureSchedulerStateStore(new ControlPlaneStateStore(store.dbPath))
      expect(getSchedulerSnapshot().retrying).toEqual([retry])
      expect(ownsTaskClaim(claim)).toBe(false)
      expect(claimTask({ missionId: 'm1', assignmentId: 'a1' })).toBeNull()
      vi.mocked(getSwarmMission).mockReturnValue({ id: 'm1', state: 'running', assignments: [{ id: 'a1', state: 'dispatched' }] } as never)
      await tickTaskScheduler()
      expect(getSchedulerSnapshot().running).toHaveLength(1)
      expect(store.leases('dispatch')).toHaveLength(1)
    } finally { __resetSchedulerStateForTests(); rmSync(root, { recursive: true, force: true }) }
  })
})
