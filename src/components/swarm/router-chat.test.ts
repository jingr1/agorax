import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(): string {
  return readFileSync(
    join(process.cwd(), 'src/components/swarm/router-chat.tsx'),
    'utf-8',
  )
}

describe('RouterChat dispatch request', () => {
  it('does not block route mission UI while waiting for worker checkpoints', () => {
    const src = source()

    expect(src).toContain("fetch('/api/swarm-dispatch'")
    expect(src).toContain('waitForCheckpoint: false')
    expect(src).toContain('allowAsync: true')
    expect(src).toContain('/api/swarm-missions?id=')
  })

  it('excludes workspace from swarm dispatch targets', () => {
    const src = source()

    expect(src).toContain("from '@/lib/swarm-workers'")
    expect(src).toContain('isSwarmDispatchWorkerId')
    expect(src).toContain('handleModeChange')
  })
})
