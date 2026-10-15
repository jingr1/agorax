import { describe, expect, it } from 'vitest'
import { listJobDeliveryTargets } from '../server/job-delivery-targets'

describe('listJobDeliveryTargets', () => {
  it('includes Hermes cron presets and global platform channels', () => {
    const targets = listJobDeliveryTargets()
    const ids = targets.map((target) => target.id)

    expect(ids).toContain('local')
    expect(ids).toContain('origin')
    expect(ids).toContain('telegram')
    expect(ids).toContain('discord')
    expect(ids).toContain('signal')

    const feishu = targets.find((target) => target.id.startsWith('feishu:'))
    if (feishu) {
      expect(feishu.label.toLowerCase()).toContain('feishu')
      expect(feishu.kind).toBe('platform')
    }
  })

  it('returns the same delivery catalog regardless of job profile', () => {
    expect(listJobDeliveryTargets()).toEqual(listJobDeliveryTargets())
  })
})
