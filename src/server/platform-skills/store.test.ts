import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureCollabDb, getCollabDbVersion } from '../collab-db'
import {
  addAgentSkills,
  createPlatformSkill,
  deletePlatformSkill,
  getPlatformSkill,
  listAgentSkillBindings,
  listComposerSkillsForAgent,
  listPlatformSkills,
  removeAgentSkill,
  setAgentSkillEnabled,
  setAgentSkills,
  upsertPlatformSkillByName,
} from './store'

let tempRoot: string
let testDb: string

describe('platform-skills store', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'platform-skills-'))
    testDb = join(tempRoot, 'collab.db')
    ensureCollabDb(testDb)
  })

  afterEach(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('applies schema migration v7', () => {
    expect(getCollabDbVersion(testDb)).toBeGreaterThanOrEqual(7)
  })

  it('creates and lists platform skills', () => {
    const skill = createPlatformSkill(
      {
        name: 'Reviewer',
        description: 'Code review',
        content: '# Review\nDo careful reviews.',
        files: [{ path: 'refs/checklist.md', content: '- tests\n' }],
      },
      { dbPath: testDb },
    )
    expect(skill.name).toBe('reviewer')
    expect(skill.files?.[0]?.path).toBe('refs/checklist.md')
    const listed = listPlatformSkills({ dbPath: testDb })
    expect(listed).toHaveLength(1)
    expect(listed[0]?.boundAgentCount).toBe(0)
  })

  it('reuses one skill across agents via agent_skills', () => {
    const { skill } = upsertPlatformSkillByName(
      { name: 'shared-tool', content: 'body' },
      { dbPath: testDb },
    )
    addAgentSkills('orchestrator', [skill.id], { dbPath: testDb })
    addAgentSkills('cc-impl', [skill.name], { dbPath: testDb })
    expect(listAgentSkillBindings('orchestrator', { dbPath: testDb })).toHaveLength(
      1,
    )
    expect(listAgentSkillBindings('cc-impl', { dbPath: testDb })).toHaveLength(1)
    expect(listPlatformSkills({ dbPath: testDb })[0]?.boundAgentCount).toBe(2)

    setAgentSkillEnabled('cc-impl', skill.id, false, { dbPath: testDb })
    expect(
      listComposerSkillsForAgent('cc-impl', { dbPath: testDb }),
    ).toHaveLength(0)
    expect(
      listComposerSkillsForAgent('orchestrator', { dbPath: testDb })[0]?.trigger,
    ).toBe('/shared-tool')

    removeAgentSkill('orchestrator', skill.id, { dbPath: testDb })
    expect(listAgentSkillBindings('orchestrator', { dbPath: testDb })).toHaveLength(
      0,
    )
    expect(getPlatformSkill(skill.id, { dbPath: testDb })?.name).toBe('shared-tool')
  })

  it('setAgentSkills replaces bindings', () => {
    const a = createPlatformSkill({ name: 'a', content: 'a' }, { dbPath: testDb })
    const b = createPlatformSkill({ name: 'b', content: 'b' }, { dbPath: testDb })
    setAgentSkills('developer', [a.id, b.id], { dbPath: testDb })
    setAgentSkills('developer', [b.id], { dbPath: testDb })
    const bindings = listAgentSkillBindings('developer', { dbPath: testDb })
    expect(bindings.map((x) => x.name)).toEqual(['b'])
  })

  it('deletes skill and cascades bindings', () => {
    const skill = createPlatformSkill(
      { name: 'gone', content: 'x' },
      { dbPath: testDb },
    )
    addAgentSkills('writer', [skill.id], { dbPath: testDb })
    expect(deletePlatformSkill(skill.id, { dbPath: testDb })).toBe(true)
    expect(listAgentSkillBindings('writer', { dbPath: testDb })).toHaveLength(0)
  })
})
