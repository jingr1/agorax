import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'

const {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  copyFileSync,
  renameSync,
  readdirSync,
  statSync,
} = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(''),
  writeFileSync: vi.fn().mockImplementation(() => {}),
  mkdirSync: vi.fn().mockImplementation(() => {}),
  unlinkSync: vi.fn().mockImplementation(() => {}),
  copyFileSync: vi.fn().mockImplementation(() => {}),
  renameSync: vi.fn().mockImplementation(() => {}),
  readdirSync: vi.fn().mockReturnValue([]),
  statSync: vi.fn().mockReturnValue({ isFile: () => false, mtimeMs: 0 }),
}))

vi.mock('node:fs', () => ({
  default: {
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    unlinkSync,
    copyFileSync,
    renameSync,
    readdirSync,
    statSync,
  },
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  copyFileSync,
  renameSync,
  readdirSync,
  statSync,
}))

const { homedir } = vi.hoisted(() => ({
  homedir: vi.fn().mockReturnValue('/home/testuser'),
}))

vi.mock('node:os', () => ({
  default: { homedir },
  homedir,
}))

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.HERMES_HOME
  delete process.env.HERMES_HOME
  delete process.env.AGORAX_STICKY_PROFILE
  delete process.env.AGORAX_STATE_DIR
})

async function loadMod() {
  vi.resetModules()
  return import('../profiles-browser')
}

describe('profiles-browser', () => {
  describe('listProfiles', () => {
    it('includes symlinked profiles when the target is a directory', async () => {
      const root = path.join('/home/testuser', '.hermes')
      const profilesRoot = path.join(root, 'profiles')
      const kayPath = path.join(profilesRoot, 'kay')
      const brokenPath = path.join(profilesRoot, 'broken')

      existsSync.mockImplementation((p: string) => {
        return (
          p === root || p === profilesRoot || p === kayPath || p === brokenPath
        )
      })
      readdirSync.mockImplementation((p: string) => {
        if (p === profilesRoot) {
          return [
            {
              name: 'kay',
              isDirectory: () => false,
              isSymbolicLink: () => true,
            },
            {
              name: 'broken',
              isDirectory: () => false,
              isSymbolicLink: () => true,
            },
            {
              name: 'README.md',
              isDirectory: () => false,
              isSymbolicLink: () => false,
            },
          ] as never
        }
        return []
      })
      statSync.mockImplementation((p: string) => {
        if (p === kayPath)
          return {
            isDirectory: () => true,
            isFile: () => false,
            mtimeMs: 0,
          } as never
        if (p === brokenPath) throw new Error('broken symlink')
        return {
          isDirectory: () => false,
          isFile: () => false,
          mtimeMs: 0,
        } as never
      })

      const mod = await loadMod()
      const names = mod.listProfiles().map((profile) => profile.name)

      expect(names).toContain('default')
      expect(names).toContain('kay')
      expect(names).not.toContain('broken')
      expect(names).not.toContain('README.md')
    })
  })

  describe('setActiveProfile', () => {
    const selectedPath = path.join(
      '/home/testuser',
      '.hermes',
      'workspace',
      'selected_profile',
    )
    const stickyPath = path.join('/home/testuser', '.hermes', 'active_profile')
    const jarvisHome = path.join(
      '/home/testuser',
      '.hermes',
      'profiles',
      'jarvis',
    )

    it('writes workspace selected_profile and does not touch sticky by default', async () => {
      existsSync.mockImplementation((p: string) => {
        if (p === jarvisHome) return true
        return false
      })

      const mod = await loadMod()
      mod.setActiveProfile('jarvis')
      expect(writeFileSync).toHaveBeenCalledWith(
        selectedPath,
        'jarvis\n',
        'utf-8',
      )
      expect(writeFileSync).not.toHaveBeenCalledWith(
        stickyPath,
        expect.anything(),
        'utf-8',
      )
    })

    it('mirrors sticky active_profile when AGORAX_STICKY_PROFILE=1', async () => {
      process.env.AGORAX_STICKY_PROFILE = '1'

      existsSync.mockImplementation((p: string) => {
        if (p === jarvisHome) return true
        return false
      })

      const mod = await loadMod()
      mod.setActiveProfile('jarvis')
      expect(writeFileSync).toHaveBeenCalledWith(
        selectedPath,
        'jarvis\n',
        'utf-8',
      )
      expect(writeFileSync).toHaveBeenCalledWith(
        stickyPath,
        'jarvis\n',
        'utf-8',
      )

      delete process.env.AGORAX_STICKY_PROFILE
    })

    it('writes selected default without clearing sticky unless opt-in', async () => {
      existsSync.mockImplementation((p: string) => {
        if (p === stickyPath) return true
        return false
      })

      const mod = await loadMod()
      mod.setActiveProfile('default')
      expect(writeFileSync).toHaveBeenCalledWith(
        selectedPath,
        'default\n',
        'utf-8',
      )
      expect(unlinkSync).not.toHaveBeenCalledWith(stickyPath)
    })

    it('clears sticky when setting default with AGORAX_STICKY_PROFILE=1', async () => {
      process.env.AGORAX_STICKY_PROFILE = '1'
      existsSync.mockImplementation((p: string) => {
        if (p === stickyPath) return true
        return false
      })

      const mod = await loadMod()
      mod.setActiveProfile('default')
      expect(unlinkSync).toHaveBeenCalledWith(stickyPath)
      delete process.env.AGORAX_STICKY_PROFILE
    })

    it('resolves profile HERMES_HOME paths', async () => {
      const mod = await loadMod()
      expect(mod.resolveProfileHermesHome('default')).toBe(
        path.join('/home/testuser', '.hermes'),
      )
      expect(mod.resolveProfileHermesHome('writer')).toBe(
        path.join('/home/testuser', '.hermes', 'profiles', 'writer'),
      )
    })

    it('prefers selected_profile and ignores sticky', async () => {
      existsSync.mockImplementation((p: string) => {
        if (p === selectedPath) return true
        if (p === stickyPath) return true
        if (p === jarvisHome) return true
        return false
      })
      readFileSync.mockImplementation((p: string) => {
        if (p === selectedPath) return 'jarvis\n'
        if (p === stickyPath) return 'default\n'
        return ''
      })

      const mod = await loadMod()
      expect(mod.getActiveProfileName()).toBe('jarvis')
    })

    it('defaults to default when selected_profile is missing even if sticky is set', async () => {
      existsSync.mockImplementation((p: string) => {
        if (p === stickyPath) return true
        if (p === jarvisHome) return true
        return false
      })
      readFileSync.mockImplementation((p: string) => {
        if (p === stickyPath) return 'jarvis\n'
        return ''
      })

      const mod = await loadMod()
      expect(mod.getActiveProfileName()).toBe('default')
    })

    it('heals selected_profile when the named profile is missing', async () => {
      existsSync.mockImplementation((p: string) => {
        if (p === selectedPath) return true
        return false
      })
      readFileSync.mockImplementation((p: string) => {
        if (p === selectedPath) return 'swarmtest1\n'
        return ''
      })

      const mod = await loadMod()
      expect(mod.getActiveProfileName()).toBe('default')
      expect(unlinkSync).toHaveBeenCalledWith(selectedPath)
    })

    it('treats tombstoned profiles as not live', async () => {
      existsSync.mockImplementation((p: string) => {
        if (
          p ===
          path.join(
            '/home/testuser',
            '.hermes',
            'profiles',
            '.deleted',
            'swarmtest1',
          )
        )
          return true
        if (
          p === path.join('/home/testuser', '.hermes', 'profiles', 'swarmtest1')
        )
          return true
        return false
      })

      const mod = await loadMod()
      expect(mod.isNamedProfileDeleted('swarmtest1')).toBe(true)
      expect(mod.isLiveNamedProfile('swarmtest1')).toBe(false)
    })
  })

  describe('renameProfile', () => {
    it('retargets selected_profile on rename and skips sticky by default', async () => {
      const profilesRoot = path.join('/home/testuser', '.hermes', 'profiles')
      const oldPath = path.join(profilesRoot, 'jarvis')
      const newPath = path.join(profilesRoot, 'friday')
      const configPath = path.join(newPath, 'config.yaml')
      const selectedPath = path.join(
        '/home/testuser',
        '.hermes',
        'workspace',
        'selected_profile',
      )
      let renamedOnDisk = false

      renameSync.mockImplementation(() => {
        renamedOnDisk = true
      })
      existsSync.mockImplementation((p: string) => {
        if (p === oldPath) return true
        if (p === newPath) return renamedOnDisk
        if (p === configPath) return renamedOnDisk
        if (p === selectedPath) return true
        return false
      })
      readFileSync.mockImplementation((p: string) => {
        if (p === selectedPath) return 'jarvis\n'
        if (p === configPath) return 'model: named-model\n'
        return ''
      })

      const mod = await loadMod()
      const renamed = mod.renameProfile('jarvis', 'friday')

      expect(renameSync).toHaveBeenCalledWith(oldPath, newPath)
      expect(writeFileSync).toHaveBeenCalledWith(
        selectedPath,
        'friday\n',
        'utf-8',
      )
      expect(writeFileSync).not.toHaveBeenCalledWith(
        path.join('/home/testuser', '.hermes', 'active_profile'),
        expect.anything(),
        'utf-8',
      )
      expect(renamed.name).toBe('friday')
    })
  })

  describe('updateProfileConfig', () => {
    it('deep-merges nested objects instead of overwriting', async () => {
      const root = path.join('/home/testuser', '.hermes')
      const configPath = path.join(root, 'config.yaml')
      const existingYaml =
        'model:\n  default: gpt-4\n  provider: openai\n  extra: keep-me\ntopLevel: stay\n'

      existsSync.mockImplementation((p: string) => {
        return p === configPath || p === root
      })
      readFileSync.mockImplementation((p: string) => {
        if (p === configPath) return existingYaml
        return ''
      })

      const mod = await loadMod()
      mod.updateProfileConfig('default', {
        model: { provider: 'nous' },
      })

      const writtenCall = writeFileSync.mock.calls.find((call) =>
        (call[0] as string).endsWith('config.yaml'),
      )
      expect(writtenCall).toBeDefined()
      const writtenYaml = writtenCall![1] as string
      expect(writtenYaml).toContain('default: gpt-4')
      expect(writtenYaml).toContain('provider: nous')
      expect(writtenYaml).toContain('extra: keep-me')
      expect(writtenYaml).toContain('topLevel: stay')
    })

    it('handles null as explicit deletion of keys', async () => {
      const root = path.join('/home/testuser', '.hermes')
      const configPath = path.join(root, 'config.yaml')
      const existingYaml =
        'model:\n  default: gpt-4\n  provider: openai\napi_key: secret\n'

      existsSync.mockImplementation((p: string) => {
        return p === configPath || p === root
      })
      readFileSync.mockImplementation((p: string) => {
        if (p === configPath) return existingYaml
        return ''
      })

      const mod = await loadMod()
      mod.updateProfileConfig('default', {
        api_key: null,
      })

      const writtenCall = writeFileSync.mock.calls.find((call) =>
        (call[0] as string).endsWith('config.yaml'),
      )
      expect(writtenCall).toBeDefined()
      const writtenYaml = writtenCall![1] as string
      expect(writtenYaml).not.toContain('api_key:')
      expect(writtenYaml).toContain('model:')
      expect(writtenYaml).toContain('default: gpt-4')
      expect(writtenYaml).toContain('provider: openai')
    })
  })
})
