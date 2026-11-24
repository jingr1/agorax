import { describe, expect, it } from 'vitest'
import { isHermesDurableRunId } from './hermes-durable-run-id'

describe('isHermesDurableRunId', () => {
  it('rejects empty and Workspace Stop UUIDs', () => {
    expect(isHermesDurableRunId(null)).toBe(false)
    expect(isHermesDurableRunId('')).toBe(false)
    expect(
      isHermesDurableRunId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    ).toBe(false)
  })

  it('accepts gateway run ids', () => {
    expect(isHermesDurableRunId('run_abc')).toBe(true)
    expect(isHermesDurableRunId('run-abc')).toBe(true)
    expect(isHermesDurableRunId('hermes-run-1')).toBe(true)
  })
})
