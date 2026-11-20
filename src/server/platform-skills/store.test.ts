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
  pruneExcludedPlatformSkillFiles,
  removeAgentSkill,
  setAgentSkillEnabled,
  setAgentSkills,
  updatePlatformSkill,
  upsertPlatformSkillByName,
  withPlatformSkillDb,
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
    expect(
      listAgentSkillBindings('orchestrator', { dbPath: testDb }),
    ).toHaveLength(1)
    expect(listAgentSkillBindings('cc-impl', { dbPath: testDb })).toHaveLength(
      1,
    )
    expect(listPlatformSkills({ dbPath: testDb })[0]?.boundAgentCount).toBe(2)

    setAgentSkillEnabled('cc-impl', skill.id, false, { dbPath: testDb })
    expect(
      listComposerSkillsForAgent('cc-impl', { dbPath: testDb }),
    ).toHaveLength(0)
    expect(
      listComposerSkillsForAgent('orchestrator', { dbPath: testDb })[0]
        ?.trigger,
    ).toBe('/shared-tool')

    removeAgentSkill('orchestrator', skill.id, { dbPath: testDb })
    expect(
      listAgentSkillBindings('orchestrator', { dbPath: testDb }),
    ).toHaveLength(0)
    expect(getPlatformSkill(skill.id, { dbPath: testDb })?.name).toBe(
      'shared-tool',
    )
  })

  it('setAgentSkills replaces bindings', () => {
    const a = createPlatformSkill(
      { name: 'a', content: 'a' },
      { dbPath: testDb },
    )
    const b = createPlatformSkill(
      { name: 'b', content: 'b' },
      { dbPath: testDb },
    )
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

  it('does not overwrite platform content during source discovery', () => {
    const skill = createPlatformSkill(
      { name: 'same-name', content: 'platform edit' },
      { dbPath: testDb },
    )
    expect(() =>
      upsertPlatformSkillByName(
        { name: skill.name, content: 'old disk copy' },
        { dbPath: testDb },
      ),
    ).toThrow(/source conflict/)
    expect(getPlatformSkill(skill.id, { dbPath: testDb })?.content).toBe(
      'platform edit',
    )
  })

  it('keeps disabled bindings and respects explicit unbinding on rediscovery', () => {
    const skill = createPlatformSkill(
      { name: 'intent', content: 'x' },
      { dbPath: testDb },
    )
    addAgentSkills('alpha', [skill.id], { dbPath: testDb })
    setAgentSkillEnabled('alpha', skill.id, false, { dbPath: testDb })
    setAgentSkills('alpha', [skill.id], { dbPath: testDb })
    expect(
      listAgentSkillBindings('alpha', { dbPath: testDb })[0]?.enabled,
    ).toBe(false)
    removeAgentSkill('alpha', skill.id, { dbPath: testDb })
    addAgentSkills('alpha', [skill.id], { dbPath: testDb, discovered: true })
    expect(listAgentSkillBindings('alpha', { dbPath: testDb })).toEqual([])
    addAgentSkills('alpha', [skill.id], { dbPath: testDb })
    expect(listAgentSkillBindings('alpha', { dbPath: testDb })).toHaveLength(1)
  })

  it('rolls back invalid attachment replacement without losing existing content', () => {
    const skill = createPlatformSkill(
      {
        name: 'atomic',
        content: 'original',
        files: [{ path: 'references/keep.md', content: 'keep' }],
      },
      { dbPath: testDb },
    )
    expect(() =>
      updatePlatformSkill(
        skill.id,
        { content: 'new', files: [{ path: '../escape', content: 'bad' }] },
        { dbPath: testDb },
      ),
    ).toThrow()
    expect(getPlatformSkill(skill.id, { dbPath: testDb })?.content).toBe(
      'original',
    )
    expect(
      getPlatformSkill(skill.id, { dbPath: testDb })?.files?.[0]?.content,
    ).toBe('keep')
  })

  it('drops excluded attachments on write and prunes legacy catalog junk', () => {
    const skill = createPlatformSkill(
      {
        name: 'clean-pack',
        content: 'body',
        files: [
          { path: 'run.js', content: 'ok' },
          { path: 'node_modules/playwright/index.js', content: 'junk' },
        ],
      },
      { dbPath: testDb },
    )
    expect(getPlatformSkill(skill.id, { dbPath: testDb })?.files).toEqual([
      { path: 'run.js', content: 'ok' },
    ])
    withPlatformSkillDb(
      (db) => {
        db.prepare(
          'INSERT INTO platform_skill_files (skill_id, path, content, encoding, executable) VALUES (?, ?, ?, ?, ?)',
        ).run(
          skill.id,
          'node_modules/.bin/playwright',
          'legacy',
          'utf8',
          0,
        )
      },
      { dbPath: testDb },
    )
    expect(pruneExcludedPlatformSkillFiles({ dbPath: testDb })).toBe(1)
    expect(getPlatformSkill(skill.id, { dbPath: testDb })?.files).toEqual([
      { path: 'run.js', content: 'ok' },
    ])
  })
})
