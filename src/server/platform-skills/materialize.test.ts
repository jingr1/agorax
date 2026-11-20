import fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { materializeHermesAgentSkills } from './materialize'
import {
  addAgentSkills,
  createPlatformSkill,
  getPlatformSkill,
  removeAgentSkill,
  updatePlatformSkill,
  withPlatformSkillDb,
} from './store'
import { listSkillDeployments } from './sync-state'
import {
  checkPlatformSkillChanges,
  createPlatformSkillSync,
  stopPlatformSkillSync,
} from './sync-loop'
import { resolveSkillDeployment } from './reconcile'
import { scanSkillsRoot } from './scan-skill-fs'
import { skillWorkingDirectory } from './deployment-tree'
import type * as CollabDb from '../collab-db'

const state = vi.hoisted(() => ({ root: '', dbPath: '' }))
const stopServices: Array<() => void> = []

vi.mock('../collab-db', async (importOriginal) => ({
  ...(await importOriginal<typeof CollabDb>()),
  getCollabDbPath: () => state.dbPath,
}))
vi.mock('../agent-runtime/router', () => ({
  getAgentRuntimeRouter: () => ({
    registry: {
      byId: new Map<string, { id: string; runtime: string; profile?: string }>([
        ...['alpha', 'beta', 'default'].map(
          (id) =>
            [
              id,
              {
                id,
                runtime: 'hermes',
                profile: id,
              },
            ] as const,
        ),
        ['managed', { id: 'managed', runtime: 'claude-code' }],
        ['codex', { id: 'codex', runtime: 'codex' }],
      ]),
      orphanProfiles: [],
    },
  }),
}))
vi.mock('../profiles-browser', () => ({
  resolveProfileHermesHome: (profile: string) => path.join(state.root, profile),
  readProfile: () => ({ config: { skills: { disabled: [] } } }),
  updateProfileConfig: () => undefined,
}))

describe('platform skill deployment', () => {
  beforeEach(() => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-sync-'))
    state.dbPath = path.join(state.root, 'collab.db')
  })

  afterEach(() => {
    for (const stop of stopServices.splice(0)) stop()
    stopPlatformSkillSync()
    vi.useRealTimers()
    fs.rmSync(state.root, { recursive: true, force: true })
  })

  it('deploys links to one central working tree by default', () => {
    const skill = createPlatformSkill({ name: 'linked', content: 'original' })
    addAgentSkills('alpha', [skill.id])
    addAgentSkills('beta', [skill.id])
    materializeHermesAgentSkills('alpha')
    const alpha = path.join(state.root, 'alpha', 'skills', skill.name)
    const beta = path.join(state.root, 'beta', 'skills', skill.name)
    expect(fs.lstatSync(alpha).isSymbolicLink()).toBe(true)
    expect(fs.realpathSync(alpha)).toBe(fs.realpathSync(beta))
    fs.writeFileSync(path.join(alpha, 'SKILL.md'), 'shared edit')
    expect(fs.readFileSync(path.join(beta, 'SKILL.md'), 'utf8')).toBe(
      'shared edit',
    )
    expect(
      scanSkillsRoot(path.dirname(beta)).map((entry) => entry.name),
    ).toEqual(['linked'])
  })

  it('publishes an agent edit without overwriting it and updates other bound agents', () => {
    const skill = createPlatformSkill({
      name: 'shared',
      content: '# Original',
      files: [{ path: 'scripts/run.sh', content: 'echo original' }],
    })
    for (const agentId of ['alpha', 'beta']) {
      addAgentSkills(agentId, [skill.id])
      materializeHermesAgentSkills(agentId)
    }
    const alphaSkill = path.join(state.root, 'alpha', 'skills', 'shared')
    fs.writeFileSync(path.join(alphaSkill, 'SKILL.md'), '# Edited on alpha')
    fs.writeFileSync(path.join(alphaSkill, 'scripts/run.sh'), 'echo edited')

    materializeHermesAgentSkills('alpha')
    materializeHermesAgentSkills('beta')

    expect(fs.readFileSync(path.join(alphaSkill, 'SKILL.md'), 'utf8')).toBe(
      '# Edited on alpha',
    )
    expect(getPlatformSkill(skill.id)?.content).toBe('# Edited on alpha')
    expect(
      fs.readFileSync(
        path.join(state.root, 'beta', 'skills', 'shared', 'scripts/run.sh'),
        'utf8',
      ),
    ).toBe('echo edited')
  })

  it('preserves divergent edits and reports both conflicting targets', () => {
    const skill = createPlatformSkill({
      name: 'conflicted',
      content: 'original',
      deploymentMode: 'copy',
    })
    addAgentSkills('alpha', [skill.id])
    addAgentSkills('beta', [skill.id])
    materializeHermesAgentSkills('alpha')
    const alpha = path.join(
      state.root,
      'alpha',
      'skills',
      skill.name,
      'SKILL.md',
    )
    const beta = path.join(state.root, 'beta', 'skills', skill.name, 'SKILL.md')
    fs.writeFileSync(alpha, 'alpha edit')
    fs.writeFileSync(beta, 'beta edit')
    materializeHermesAgentSkills('alpha')
    expect(fs.readFileSync(alpha, 'utf8')).toBe('alpha edit')
    expect(fs.readFileSync(beta, 'utf8')).toBe('beta edit')
    expect(getPlatformSkill(skill.id)?.content).toBe('original')
    expect(
      listSkillDeployments(skill.id).map((result) => result.status),
    ).toEqual(['conflict', 'conflict'])
  })

  it('refuses stale catalog edits and keeps revision history', () => {
    const skill = createPlatformSkill({ name: 'versioned', content: 'one' })
    const updated = updatePlatformSkill(skill.id, {
      content: 'two',
      expectedRevision: skill.revisionId,
    })
    expect(updated.revisionId).not.toBe(skill.revisionId)
    expect(() =>
      updatePlatformSkill(skill.id, {
        content: 'stale',
        expectedRevision: skill.revisionId,
      }),
    ).toThrow(/Revision conflict/)
    expect(getPlatformSkill(skill.id)?.content).toBe('two')
  })

  it('does not replace an unmanaged directory and reports the actual state', () => {
    const skill = createPlatformSkill({ name: 'external', content: 'catalog' })
    const directory = path.join(state.root, 'alpha', 'skills', skill.name)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'SKILL.md'), 'user file')
    addAgentSkills('alpha', [skill.id])
    materializeHermesAgentSkills('alpha')
    expect(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')).toBe(
      'user file',
    )
    expect(listSkillDeployments(skill.id)[0]?.status).toBe('external-visible')
  })

  it('automatically publishes stable filesystem changes without a new binding', () => {
    const skill = createPlatformSkill({ name: 'automatic', content: 'one' })
    addAgentSkills('alpha', [skill.id])
    addAgentSkills('beta', [skill.id])
    materializeHermesAgentSkills('alpha')
    const index = path.join(
      state.root,
      'alpha',
      'skills',
      skill.name,
      'SKILL.md',
    )
    fs.writeFileSync(index, 'changed')
    checkPlatformSkillChanges()
    expect(getPlatformSkill(skill.id)?.content).toBe('one')
    checkPlatformSkillChanges()
    expect(getPlatformSkill(skill.id)?.content).toBe('changed')
    expect(
      fs.readFileSync(
        path.join(state.root, 'beta', 'skills', skill.name, 'SKILL.md'),
        'utf8',
      ),
    ).toBe('changed')
  })

  it('resolves a conflict with revision and observed-content checks', () => {
    const skill = createPlatformSkill({ name: 'resolve', content: 'one' })
    addAgentSkills('alpha', [skill.id])
    materializeHermesAgentSkills('alpha')
    const index = path.join(
      state.root,
      'alpha',
      'skills',
      skill.name,
      'SKILL.md',
    )
    fs.writeFileSync(index, 'local')
    const updated = updatePlatformSkill(skill.id, { content: 'catalog' })
    materializeHermesAgentSkills('alpha')
    const deployment = listSkillDeployments(skill.id)[0]
    const results = resolveSkillDeployment({
      skillId: skill.id,
      agentId: 'alpha',
      action: 'publish-local',
      expectedRevision: updated.revisionId!,
      observedHash: deployment.hash!,
    })
    expect(results[0]?.status).toBe('in-sync')
    expect(getPlatformSkill(skill.id)?.content).toBe('local')
  })

  it('synchronizes complete isolated managed packages without writing user homes', () => {
    const skill = createPlatformSkill({
      name: 'dual-runtime',
      content: 'one',
      files: [{ path: 'references/guide.md', content: 'guide' }],
    })
    for (const agent of ['alpha', 'managed', 'codex'])
      addAgentSkills(agent, [skill.id])
    materializeHermesAgentSkills('managed')
    const root = path.join(state.root, 'platform-skills', 'managed')
    fs.writeFileSync(
      path.join(root, 'managed', skill.name, 'references/guide.md'),
      'managed edit',
    )
    materializeHermesAgentSkills('managed')
    expect(
      fs.readFileSync(
        path.join(root, 'codex', skill.name, 'references/guide.md'),
        'utf8',
      ),
    ).toBe('managed edit')
    expect(
      fs.readFileSync(
        path.join(
          state.root,
          'alpha',
          'skills',
          skill.name,
          'references/guide.md',
        ),
        'utf8',
      ),
    ).toBe('managed edit')
  })

  it('moves a clean renamed deployment instead of leaving duplicate skill directories', () => {
    const skill = createPlatformSkill({ name: 'before', content: 'body' })
    addAgentSkills('alpha', [skill.id])
    materializeHermesAgentSkills('alpha')
    updatePlatformSkill(skill.id, { name: 'after' })
    materializeHermesAgentSkills('alpha')
    expect(
      fs.existsSync(path.join(state.root, 'alpha', 'skills', 'before')),
    ).toBe(false)
    expect(
      fs.readFileSync(
        path.join(state.root, 'alpha', 'skills', 'after', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('body')
  })

  it('recovers the old directory if a process stopped between backup and swap', () => {
    const skill = createPlatformSkill({ name: 'recoverable', content: 'body' })
    addAgentSkills('alpha', [skill.id])
    materializeHermesAgentSkills('alpha')
    const directory = path.join(state.root, 'alpha', 'skills', skill.name)
    fs.renameSync(directory, `${directory}.agorax-backup`)
    materializeHermesAgentSkills('alpha')
    expect(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')).toBe(
      'body',
    )
    expect(fs.existsSync(`${directory}.agorax-backup`)).toBe(false)
  })

  it('switches link/copy modes without changing central content', () => {
    const skill = createPlatformSkill({ name: 'switch-mode', content: 'body' })
    addAgentSkills('alpha', [skill.id])
    materializeHermesAgentSkills('alpha')
    const directory = path.join(state.root, 'alpha', 'skills', skill.name)
    const central = fs.realpathSync(directory)
    updatePlatformSkill(skill.id, { deploymentMode: 'copy' })
    materializeHermesAgentSkills('alpha')
    expect(fs.lstatSync(directory).isDirectory()).toBe(true)
    expect(listSkillDeployments(skill.id)[0]?.actualMode).toBe('copy')
    fs.writeFileSync(path.join(directory, 'SKILL.md'), 'copy edit')
    updatePlatformSkill(skill.id, { deploymentMode: 'symlink' })
    materializeHermesAgentSkills('alpha')
    expect(fs.lstatSync(directory).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(central, 'SKILL.md'), 'utf8')).toBe(
      'copy edit',
    )
  })

  it.each(['alpha', 'managed'])('unlinks unbound %s without deleting the shared tree', (agentId) => {
    const skill = createPlatformSkill({ name: 'unlink', content: 'shared' })
    addAgentSkills(agentId, [skill.id])
    materializeHermesAgentSkills(agentId)
    const directory = agentId === 'alpha' ? path.join(state.root, 'alpha', 'skills', skill.name) : path.join(state.root, 'platform-skills', 'managed', agentId, skill.name)
    const central = fs.realpathSync(directory)
    removeAgentSkill(agentId, skill.id)
    materializeHermesAgentSkills(agentId)
    expect(fs.existsSync(directory)).toBe(false)
    expect(fs.readFileSync(path.join(central, 'SKILL.md'), 'utf8')).toBe(
      'shared',
    )
  })

  it('publishes a filesystem event after debounce without waiting for the periodic check', async () => {
    const skill = createPlatformSkill({ name: 'events', content: 'original' })
    addAgentSkills('alpha', [skill.id])
    materializeHermesAgentSkills('alpha')
    const service = createPlatformSkillSync({
      debounceMs: 20,
      fallbackMs: 60_000,
    })
    stopServices.push(service.stop)
    service.start()
    fs.writeFileSync(
      path.join(state.root, 'alpha', 'skills', skill.name, 'SKILL.md'),
      'event edit',
    )
    await vi.waitFor(
      () => expect(getPlatformSkill(skill.id)?.content).toBe('event edit'),
      { timeout: 3_000, interval: 25 },
    )
  })

  it('coalesces events and still checks when native watching is unavailable', async () => {
    vi.useFakeTimers()
    const skill = createPlatformSkill({
      name: 'poll-fallback',
      content: 'original',
      deploymentMode: 'copy',
    })
    addAgentSkills('alpha', [skill.id])
    materializeHermesAgentSkills('alpha')
    const watch = vi.fn(() => {
      throw new Error('watch unavailable')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const service = createPlatformSkillSync({
      watchDirectory: watch,
      debounceMs: 50,
      fallbackMs: 1_000,
    })
    stopServices.push(() => {
      service.stop()
      warn.mockRestore()
    })
    service.start()
    await vi.advanceTimersByTimeAsync(500)
    fs.writeFileSync(
      path.join(state.root, 'alpha', 'skills', skill.name, 'SKILL.md'),
      'fallback edit',
    )
    await vi.advanceTimersByTimeAsync(1_200)
    expect(getPlatformSkill(skill.id)?.content).toBe('fallback edit')
    service.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records a Copy fallback and honors an explicit refusal to fall back', () => {
    const skill = createPlatformSkill({
      name: 'link-permission',
      content: 'body',
    })
    addAgentSkills('alpha', [skill.id])
    const link = vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('Link permission denied'), {
        code: 'EPERM',
      })
    })
    try {
      materializeHermesAgentSkills('alpha')
      const directory = path.join(state.root, 'alpha', 'skills', skill.name)
      expect(fs.lstatSync(directory).isDirectory()).toBe(true)
      expect(listSkillDeployments(skill.id)[0]).toMatchObject({
        actualMode: 'copy',
        message: expect.stringContaining('EPERM'),
      })
      updatePlatformSkill(skill.id, { allowCopyFallback: false })
      materializeHermesAgentSkills('alpha')
      expect(listSkillDeployments(skill.id)[0]?.status).toBe('error')
      expect(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')).toBe(
        'body',
      )
    } finally {
      link.mockRestore()
    }
  })

  it('coalesces a burst of writes and ignores its own unchanged events', async () => {
    vi.useFakeTimers()
    const skill = createPlatformSkill({ name: 'burst', content: 'original' })
    addAgentSkills('alpha', [skill.id])
    materializeHermesAgentSkills('alpha')
    const listeners = new Map<string, (filename?: string) => void>()
    const close = vi.fn()
    const service = createPlatformSkillSync({
      watchDirectory: (root, changed) => {
        listeners.set(root, changed)
        return { close }
      },
    })
    stopServices.push(service.stop)
    service.start()
    await vi.advanceTimersByTimeAsync(1_000)
    const central = skillWorkingDirectory(skill.id)
    const notify = () =>
      listeners.get(path.dirname(central))?.(path.join(skill.id, 'SKILL.md'))
    fs.writeFileSync(path.join(central, 'SKILL.md'), 'partial')
    notify()
    await vi.advanceTimersByTimeAsync(400)
    expect(getPlatformSkill(skill.id)?.content).toBe('original')
    fs.writeFileSync(path.join(central, 'SKILL.md'), 'final')
    notify()
    await vi.advanceTimersByTimeAsync(499)
    expect(getPlatformSkill(skill.id)?.content).toBe('original')
    await vi.advanceTimersByTimeAsync(301)
    expect(getPlatformSkill(skill.id)?.content).toBe('final')
    const count = () =>
      Number(
        withPlatformSkillDb(
          (db) =>
            db
              .prepare('SELECT COUNT(*) AS count FROM skill_sync_operations')
              .get()?.count,
        ),
      )
    const completed = count()
    notify()
    notify()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(count()).toBe(completed)
    service.stop()
    expect(close).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves a foreign symlink and its destination when binding and unbinding', () => {
    const skill = createPlatformSkill({
      name: 'foreign-link',
      content: 'catalog',
    })
    const foreign = path.join(state.root, 'foreign')
    fs.mkdirSync(foreign, { recursive: true })
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), 'user content')
    const target = path.join(state.root, 'alpha', 'skills', skill.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(
      foreign,
      target,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    addAgentSkills('alpha', [skill.id])
    materializeHermesAgentSkills('alpha')
    expect(listSkillDeployments(skill.id)[0]?.status).toBe('external-visible')
    removeAgentSkill('alpha', skill.id)
    materializeHermesAgentSkills('alpha')
    expect(fs.readlinkSync(target)).toBeTruthy()
    expect(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8')).toBe(
      'user content',
    )
  })

  it('checks a replaced deployment before fallback even if its first native event is lost', async () => {
    vi.useFakeTimers()
    const skill = createPlatformSkill({ name: 'replaced-watch', content: 'original' })
    addAgentSkills('alpha', [skill.id])
    materializeHermesAgentSkills('alpha')
    const service = createPlatformSkillSync({ watchDirectory: () => ({ close: () => undefined }), fallbackMs: 60_000 })
    stopServices.push(service.stop)
    service.start()
    await vi.advanceTimersByTimeAsync(1_000)
    updatePlatformSkill(skill.id, { deploymentMode: 'copy' })
    materializeHermesAgentSkills('alpha')
    fs.writeFileSync(path.join(state.root, 'alpha', 'skills', skill.name, 'SKILL.md'), 'edited immediately after replacement')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(getPlatformSkill(skill.id)?.content).toBe('edited immediately after replacement')
  })

  it('keeps unmanaged category directories external-visible without SKILL.md', () => {
    const skill = createPlatformSkill({
      name: 'github',
      content: 'catalog github skill',
    })
    const category = path.join(state.root, 'alpha', 'skills', skill.name)
    fs.mkdirSync(path.join(category, 'github-pr-workflow'), { recursive: true })
    fs.writeFileSync(
      path.join(category, 'github-pr-workflow', 'SKILL.md'),
      '# nested\n',
    )
    fs.writeFileSync(path.join(category, 'DESCRIPTION.md'), 'category\n')
    addAgentSkills('alpha', [skill.id])
    materializeHermesAgentSkills('alpha')
    expect(listSkillDeployments(skill.id)[0]).toMatchObject({
      status: 'external-visible',
      message: 'Existing directory is not managed by Agorax',
    })
    expect(fs.existsSync(path.join(category, 'DESCRIPTION.md'))).toBe(true)
  })

  it('settles foreign links without fallback requeue storms', async () => {
    vi.useFakeTimers()
    const skill = createPlatformSkill({
      name: 'foreign-stable',
      content: 'catalog',
    })
    const foreign = path.join(state.root, 'foreign-stable')
    fs.mkdirSync(foreign, { recursive: true })
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), 'user content')
    const target = path.join(state.root, 'alpha', 'skills', skill.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(
      foreign,
      target,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    addAgentSkills('alpha', [skill.id])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const service = createPlatformSkillSync({
      watchDirectory: () => ({ close: () => undefined }),
      debounceMs: 20,
      fallbackMs: 1_000,
      idleGapMs: 20,
    })
    stopServices.push(() => {
      service.stop()
      warn.mockRestore()
    })
    service.start()
    await vi.advanceTimersByTimeAsync(500)
    checkPlatformSkillChanges()
    checkPlatformSkillChanges()
    expect(listSkillDeployments(skill.id)[0]?.status).toBe('external-visible')
    const warnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes('watcher/sync'),
    ).length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(
      warn.mock.calls.filter((call) =>
        String(call[0]).includes('watcher/sync'),
      ).length,
    ).toBe(warnings)
  })
})
