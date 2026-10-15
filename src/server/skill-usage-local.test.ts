import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./profiles-browser', () => ({
  getProfilesRoot: vi.fn(),
}))

import { getProfilesRoot } from './profiles-browser'
import { readLocalSkillsUsage } from './skill-usage-local'

const mockProfilesRoot = vi.mocked(getProfilesRoot)

let tmpHome = ''

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-'))
  process.env.HERMES_HOME = tmpHome
  mockProfilesRoot.mockReturnValue(path.join(tmpHome, 'profiles'))
})

afterEach(() => {
  delete process.env.HERMES_HOME
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('readLocalSkillsUsage', () => {
  it('returns null when no usage files exist', () => {
    expect(readLocalSkillsUsage(30)).toBeNull()
  })

  it('aggregates default and profile skills usage', () => {
    const skillsDir = path.join(tmpHome, 'skills')
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillsDir, '.usage.json'),
      JSON.stringify({
        'systematic-debugging': {
          use_count: 3,
          view_count: 2,
          patch_count: 1,
          last_used_at: new Date().toISOString(),
        },
      }),
    )

    const profSkills = path.join(tmpHome, 'profiles', 'dev', 'skills')
    fs.mkdirSync(profSkills, { recursive: true })
    fs.writeFileSync(
      path.join(profSkills, '.usage.json'),
      JSON.stringify({
        'systematic-debugging': {
          use_count: 2,
          view_count: 0,
          patch_count: 0,
          last_used_at: new Date().toISOString(),
        },
        'llm-wiki': {
          use_count: 1,
          view_count: 0,
          patch_count: 0,
          last_used_at: new Date().toISOString(),
        },
      }),
    )

    const section = readLocalSkillsUsage(30)
    expect(section).not.toBeNull()
    expect(section!.distinctSkills).toBe(2)
    expect(section!.topSkills[0].skill).toBe('systematic-debugging')
    expect(section!.topSkills[0].totalCount).toBe(8)
  })
})
