import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureCollabDb } from '../collab-db'
import { listAgentSkillBindings, listPlatformSkills } from './store'
import { scanManySkillsRoots } from './scan-skill-fs'
import { addAgentSkills, upsertPlatformSkillByName } from './store'

const tmpDirs: Array<string> = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Mirrors the seed bind loop for one agent without loading agents.yaml —
 * proves local roots → catalog upsert → agent_skills.
 */
describe('seed agent local bind (unit)', () => {
  it('binds skills found under agent roots into agent_skills', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-bind-'))
    tmpDirs.push(root)
    const dbPath = path.join(root, 'collab.db')
    ensureCollabDb(dbPath)

    const skillsRoot = path.join(root, 'skills')
    fs.mkdirSync(path.join(skillsRoot, 'alpha'), { recursive: true })
    fs.writeFileSync(
      path.join(skillsRoot, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: A\n---\n\nA\n',
    )
    fs.mkdirSync(path.join(skillsRoot, 'beta'), { recursive: true })
    fs.writeFileSync(
      path.join(skillsRoot, 'beta', 'SKILL.md'),
      '---\nname: beta\ndescription: B\n---\n\nB\n',
    )

    const nameToId = new Map<string, string>()
    const scanned = scanManySkillsRoots([skillsRoot])
    for (const skill of scanned) {
      const { skill: row } = upsertPlatformSkillByName(
        {
          name: skill.name,
          description: skill.description,
          category: skill.category,
          content: skill.content,
          origin: { kind: 'profile_fs', source: skill.sourceDir },
        },
        { dbPath },
      )
      nameToId.set(skill.name.toLowerCase(), row.id)
    }

    const before = listAgentSkillBindings('developer', { dbPath }).length
    expect(before).toBe(0)
    addAgentSkills('developer', [...nameToId.values()], { dbPath })
    const bindings = listAgentSkillBindings('developer', { dbPath })
    expect(bindings.map((b) => b.name).sort()).toEqual(['alpha', 'beta'])
    expect(listPlatformSkills({ dbPath })).toHaveLength(2)
    expect(listPlatformSkills({ dbPath })[0]?.boundAgentCount).toBeGreaterThan(0)
  })
})
