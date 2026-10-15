import { describe, expect, it } from 'vitest'
import {
  buildTimelineFromEvents,
  formatMissionEventTitle,
  taskSummaryLine,
} from './mission-detail-format'

describe('taskSummaryLine', () => {
  it('skips Stage heading and returns Task title', () => {
    const brief = [
      '# Stage: research',
      '## Task test',
      '## Spec',
      'Do the research.',
    ].join('\n')
    expect(taskSummaryLine(brief)).toBe('Task test')
  })

  it('truncates long prose', () => {
    const long = 'x'.repeat(140)
    expect(taskSummaryLine(long, 40).endsWith('…')).toBe(true)
    expect(taskSummaryLine(long, 40).length).toBe(40)
  })
})

describe('formatMissionEventTitle', () => {
  it('prefers message over type', () => {
    expect(
      formatMissionEventTitle({
        type: 'continuation',
        at: 1,
        message: 'Queued continuation assign_1 for researcher',
      }),
    ).toBe('Queued continuation assign_1 for researcher')
  })
})

describe('buildTimelineFromEvents', () => {
  it('folds consecutive continuation events', () => {
    const items = buildTimelineFromEvents([
      {
        type: 'continuation',
        at: 300,
        message: 'Queued continuation c for architect',
        workerId: 'architect',
      },
      {
        type: 'continuation',
        at: 200,
        message: 'Queued continuation b for architect',
        workerId: 'architect',
      },
      {
        type: 'assignment_dispatched',
        at: 100,
        message: 'Dispatched a to researcher',
        workerId: 'researcher',
      },
      {
        type: 'continuation',
        at: 50,
        message: 'Queued continuation early',
        workerId: 'developer',
      },
    ])
    const continuations = items.filter((i) => i.id.startsWith('continuation-'))
    // newest block of 2 + older single = 2 rows
    expect(continuations).toHaveLength(2)
    expect(continuations[0]?.count).toBe(2)
    expect(continuations[1]?.count).toBeUndefined()
    expect(items.some((i) => i.title.includes('Dispatched'))).toBe(true)
  })
})
