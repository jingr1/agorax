import { describe, expect, it } from 'vitest'
import {
  deriveMissionStatus,
  effectiveMissionStatus,
  normalizeMissionStatus,
} from './mission-status'

describe('mission-status', () => {
  it('normalizes legacy swarm states', () => {
    expect(normalizeMissionStatus('planning')).toBe('todo')
    expect(normalizeMissionStatus('dispatching')).toBe('ready')
    expect(normalizeMissionStatus('executing')).toBe('running')
    expect(normalizeMissionStatus('reviewing')).toBe('review')
    expect(normalizeMissionStatus('complete')).toBe('done')
    expect(normalizeMissionStatus('backlog')).toBe('todo')
    expect(normalizeMissionStatus('running')).toBe('running')
  })

  it('derives status from assignments', () => {
    const mk = (state: string, reviewRequired = false) =>
      ({
        id: state,
        workerId: 'w',
        task: '',
        rationale: null,
        dependsOn: [],
        reviewRequired,
        state,
        dispatchedAt: null,
        completedAt: null,
        reviewedAt: null,
        reviewedBy: null,
        checkpoint: null,
      }) as never

    expect(deriveMissionStatus([])).toBe('todo')
    expect(deriveMissionStatus([mk('queued')])).toBe('ready')
    expect(deriveMissionStatus([mk('dispatched')])).toBe('running')
    expect(deriveMissionStatus([mk('reviewing')])).toBe('review')
    expect(deriveMissionStatus([mk('blocked')])).toBe('blocked')
    expect(deriveMissionStatus([mk('done')])).toBe('done')
    expect(deriveMissionStatus([mk('cancelled')])).toBe('cancelled')
  })

  it('effective status prefers board pin', () => {
    expect(
      effectiveMissionStatus({
        state: 'running',
        boardLane: 'review',
        assignments: [],
      }),
    ).toBe('review')
    expect(
      effectiveMissionStatus({
        state: 'todo',
        boardLane: null,
        assignments: [
          {
            id: 'a',
            workerId: 'w',
            task: '',
            rationale: null,
            dependsOn: [],
            reviewRequired: false,
            state: 'dispatched',
            dispatchedAt: null,
            completedAt: null,
            reviewedAt: null,
            reviewedBy: null,
            checkpoint: null,
          } as never,
        ],
      }),
    ).toBe('running')
  })
})
