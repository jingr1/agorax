import { describe, expect, it } from 'vitest'
import { workerIdFromSwarmSessionName } from './swarm-tmux-restart'

describe('swarm-tmux-restart', () => {
  it('parses swarm session names into worker ids', () => {
    expect(workerIdFromSwarmSessionName('swarm-researcher')).toBe('researcher')
    expect(workerIdFromSwarmSessionName('swarm-architect')).toBe('architect')
    expect(workerIdFromSwarmSessionName('clawteam-first-team')).toBeNull()
    expect(workerIdFromSwarmSessionName('swarm-')).toBeNull()
  })
})
