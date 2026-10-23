/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendMissionSpecFreshnessHint,
  hasMissionSpecFreshnessHint,
  missionDetailUrl,
} from './mission-spec-freshness'

describe('mission-spec-freshness', () => {
  const prevPort = process.env.PORT

  afterEach(() => {
    if (prevPort === undefined) delete process.env.PORT
    else process.env.PORT = prevPort
  })

  it('builds loopback mission detail URL', () => {
    process.env.PORT = '6734'
    expect(missionDetailUrl('mission-1')).toBe(
      'http://127.0.0.1:6734/api/missions/mission-1',
    )
  })

  it('appends freshness hint once', () => {
    process.env.PORT = '6734'
    const once = appendMissionSpecFreshnessHint('Do work', 'mission-1')
    expect(once).toContain('## Spec freshness')
    expect(once).toContain('/api/missions/mission-1')
    expect(hasMissionSpecFreshnessHint(once)).toBe(true)
    const twice = appendMissionSpecFreshnessHint(once, 'mission-1')
    expect(twice).toBe(once)
  })

  it('skips empty mission id', () => {
    expect(appendMissionSpecFreshnessHint('Do work', '  ')).toBe('Do work')
  })
})
