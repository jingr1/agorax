/** @vitest-environment node */
import { describe, it, expect } from 'vitest'
import {
  applyGroupHoldDirective,
  classifyGroupHoldDirective,
  heldMemberWatermarkAdvance,
  holdAllMemberKeys,
} from '../member-holds'

describe('member-holds (#93129)', () => {
  it('classifies stop @member', () => {
    expect(
      classifyGroupHoldDirective('stop @writer', ['writer'], false),
    ).toEqual({
      hold: ['writer'],
      holdAll: false,
      release: [],
      releaseAll: false,
    })
  })

  it('classifies @all stop as holdAll', () => {
    expect(classifyGroupHoldDirective('@all stop', [], true)).toEqual({
      hold: [],
      holdAll: true,
      release: [],
      releaseAll: false,
    })
  })

  it('classifies @all resume as releaseAll', () => {
    expect(classifyGroupHoldDirective('@all resume', [], true)).toEqual({
      hold: [],
      holdAll: false,
      release: [],
      releaseAll: true,
    })
  })

  it('direct mention without stop releases that member', () => {
    expect(
      classifyGroupHoldDirective('@writer please continue', ['writer'], false),
    ).toEqual({
      hold: [],
      holdAll: false,
      release: ['writer'],
      releaseAll: false,
    })
  })

  it('applyGroupHoldDirective holds and releases', () => {
    const stamp = { at: 1, byMessageId: 'm1' }
    let holds = applyGroupHoldDirective(
      {},
      { everyone: false, mentioned: ['writer'] },
      'stop @writer',
      stamp,
      ['writer', 'researcher'],
    )
    expect(holds.writer).toEqual(stamp)

    holds = applyGroupHoldDirective(
      holds,
      { everyone: true, mentioned: [] },
      '@all resume',
      stamp,
      ['writer', 'researcher'],
    )
    expect(holds).toEqual({})
  })

  it('holdAllMemberKeys fills missing keys', () => {
    const stamp = { at: 2, byMessageId: null }
    const next = holdAllMemberKeys(
      { writer: stamp },
      ['writer', 'architect'],
      { at: 3, byMessageId: null },
    )
    expect(next.writer.at).toBe(2)
    expect(next.architect.at).toBe(3)
  })

  it('heldMemberWatermarkAdvance only when lag exists', () => {
    expect(heldMemberWatermarkAdvance(5, 5)).toBeNull()
    expect(heldMemberWatermarkAdvance(5, 8)).toBe(8)
    expect(heldMemberWatermarkAdvance(undefined, 3)).toBe(3)
  })
})
