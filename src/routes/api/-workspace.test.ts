import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  invalidateWorkspaceCatalogCache,
  loadWorkspaceCatalog,
  saveWorkspaceSelection,
} from './workspace'
import {
  WorkspaceFolderAccessError,
  __resetHermesStateRootsForTests,
  listWorkspaceFolders,
} from '../../server/workspace-path-policy'

const originalEnv = { ...process.env }
let tempRoot = ''

async function makeDir(...parts: Array<string>) {
  const dir = path.join(...parts)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-workspace-route-'))
  // Mutate keys in place — replacing process.env wholesale breaks Node's
  // special Env object and leaves hermes-state-root caches stale.
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  process.env.HERMES_HOME = path.join(tempRoot, '.hermes')
  delete process.env.AGORAX_DIR
  delete process.env.CLAUDE_WORKSPACE_DIR
  delete process.env.HERMES_WEBUI_DEFAULT_WORKSPACE
  await fs.mkdir(process.env.HERMES_HOME, { recursive: true })
  // The catalog is cached module-side with a TTL keyed by profile only (not
  // by HERMES_HOME); each test swaps HERMES_HOME, so flush the cache.
  invalidateWorkspaceCatalogCache()
  __resetHermesStateRootsForTests()
})

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __resetHermesStateRootsForTests()
  await fs.rm(tempRoot, { recursive: true, force: true })
})

describe('workspace API catalog semantics', () => {
  it('uses the Hermes profile default workspace instead of ~/.hermes state', async () => {
    const project = await makeDir(tempRoot, 'workspace')
    await fs.writeFile(
      path.join(process.env.HERMES_HOME!, 'config.yaml'),
      `default_workspace: ${JSON.stringify(project)}\n`,
      'utf-8',
    )

    const catalog = await loadWorkspaceCatalog()

    expect(catalog).toMatchObject({
      path: project,
      folderName: 'Home',
      source: 'config.default_workspace',
      isValid: true,
      last: project,
    })
    expect(catalog.workspaces).toEqual([{ name: 'Home', path: project }])
    expect(catalog.path).not.toBe(process.env.HERMES_HOME)
  })

  it('ignores legacy persisted Hermes state paths as workspaces', async () => {
    const project = await makeDir(tempRoot, 'workspace')
    await fs.writeFile(
      path.join(process.env.HERMES_HOME!, 'config.yaml'),
      `default_workspace: ${JSON.stringify(project)}
`,
      'utf-8',
    )
    await fs.mkdir(path.join(process.env.HERMES_HOME!, 'webui_state'), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(process.env.HERMES_HOME!, 'webui_state', 'workspaces.json'),
      JSON.stringify({
        workspaces: [
          { name: 'Bad Hermes Home', path: process.env.HERMES_HOME },
          { name: 'Home', path: project },
        ],
        last: process.env.HERMES_HOME,
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(process.env.HERMES_HOME!, 'webui_state', 'last_workspace.txt'),
      `${process.env.HERMES_HOME}
`,
      'utf-8',
    )

    const catalog = await loadWorkspaceCatalog()

    expect(catalog.path).toBe(project)
    expect(catalog.workspaces).toEqual([{ name: 'Home', path: project }])
  })

  it('rejects manual selection of Hermes state directories', async () => {
    await expect(
      saveWorkspaceSelection({ path: process.env.HERMES_HOME!, name: 'State' }),
    ).rejects.toThrow('cannot be used as workspaces')
  })

  it('rejects manual selection of system directories', async () => {
    await expect(
      saveWorkspaceSelection({ path: '/', name: 'Root' }),
    ).rejects.toThrow('System directories cannot be used as workspaces')
  })

  it('honors HERMES_HOME as the profile root when HERMES_HOME is unset', async () => {
    const claudeHome = path.join(tempRoot, '.claude-home')
    const project = await makeDir(tempRoot, 'claude-workspace')
    delete process.env.HERMES_HOME
    process.env.HERMES_HOME = claudeHome
    await fs.mkdir(claudeHome, { recursive: true })
    await fs.writeFile(
      path.join(claudeHome, 'config.yaml'),
      `default_workspace: ${JSON.stringify(project)}
`,
      'utf-8',
    )

    const catalog = await loadWorkspaceCatalog()

    expect(catalog.path).toBe(project)
    await saveWorkspaceSelection({ path: project, name: 'Claude Workspace' })
    await expect(
      fs.readFile(
        path.join(claudeHome, 'webui_state', 'last_workspace.txt'),
        'utf-8',
      ),
    ).resolves.toBe(`${project}
`)
  })

  it('persists the selected workspace in profile-local Web UI state', async () => {
    const homeProject = await makeDir(tempRoot, 'workspace')
    const selectedProject = await makeDir(tempRoot, 'client-app')
    process.env.HERMES_WEBUI_DEFAULT_WORKSPACE = homeProject

    const saved = await saveWorkspaceSelection({
      path: selectedProject,
      name: 'Client App',
    })

    expect(saved.path).toBe(selectedProject)
    expect(saved.folderName).toBe('Client App')
    expect(saved.workspaces).toContainEqual({
      name: 'Client App',
      path: selectedProject,
    })
    await expect(
      fs.readFile(
        path.join(
          process.env.HERMES_HOME!,
          'webui_state',
          'last_workspace.txt',
        ),
        'utf-8',
      ),
    ).resolves.toBe(`${selectedProject}\n`)
  })

  it('uses remote terminal.cwd when SSH backend has stale local workspace paths', async () => {
    const remoteCwd = '/home/ramonjing'
    const staleLocal = await makeDir(tempRoot, 'hermes-workspace')
    await fs.writeFile(
      path.join(process.env.HERMES_HOME!, 'config.yaml'),
      `terminal:
  backend: ssh
  cwd: ${remoteCwd}
`,
      'utf-8',
    )
    await fs.mkdir(path.join(process.env.HERMES_HOME!, 'webui_state'), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(process.env.HERMES_HOME!, 'webui_state', 'workspaces.json'),
      JSON.stringify({
        workspaces: [{ name: 'Workspace', path: staleLocal }],
        last: staleLocal,
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(process.env.HERMES_HOME!, 'webui_state', 'last_workspace.txt'),
      `${staleLocal}\n`,
      'utf-8',
    )

    const catalog = await loadWorkspaceCatalog()

    expect(catalog.path).toBe(remoteCwd)
    expect(catalog.workspaces).toEqual([{ name: 'Home', path: remoteCwd }])
    expect(catalog.source).toBe('config.terminal.cwd')
  })

  it('accepts remote workspace selection under terminal.cwd without local stat', async () => {
    const remoteCwd = '/home/ramonjing'
    const remoteProject = `${remoteCwd}/projects/demo`
    await fs.writeFile(
      path.join(process.env.HERMES_HOME!, 'config.yaml'),
      `terminal:
  backend: ssh
  cwd: ${remoteCwd}
`,
      'utf-8',
    )

    const saved = await saveWorkspaceSelection({
      path: remoteProject,
      name: 'Demo',
    })

    expect(saved.path).toBe(remoteProject)
    expect(saved.workspaces).toContainEqual({
      name: 'Demo',
      path: remoteProject,
    })
  })

  it('loads workspace state from an explicit profile without active_profile', async () => {
    const localProject = await makeDir(tempRoot, 'local-app')
    const sshProfileDir = path.join(
      process.env.HERMES_HOME!,
      'profiles',
      'gpussh',
    )
    await fs.mkdir(sshProfileDir, { recursive: true })
    await fs.writeFile(
      path.join(sshProfileDir, 'config.yaml'),
      `terminal:
  backend: ssh
  cwd: /home/ramonjing
  ssh_host: dev-wsl
`,
      'utf-8',
    )
    await fs.mkdir(path.join(sshProfileDir, 'webui_state'), { recursive: true })
    await fs.writeFile(
      path.join(sshProfileDir, 'webui_state', 'workspaces.json'),
      JSON.stringify({
        workspaces: [{ name: 'Remote', path: '/home/ramonjing/vhl_dyn_sim' }],
        last: '/home/ramonjing/vhl_dyn_sim',
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(process.env.HERMES_HOME!, 'active_profile'),
      'default\n',
      'utf-8',
    )
    await fs.writeFile(
      path.join(process.env.HERMES_HOME!, 'config.yaml'),
      `default_workspace: ${JSON.stringify(localProject)}\n`,
      'utf-8',
    )

    const localCatalog = await loadWorkspaceCatalog('default')
    const sshCatalog = await loadWorkspaceCatalog('gpussh')

    expect(localCatalog.path).toBe(localProject)
    expect(sshCatalog.path).toBe('/home/ramonjing/vhl_dyn_sim')
    expect(sshCatalog.profile).toBe('gpussh')
  })

  it('keeps managed-agent workspace state separate from Hermes profiles', async () => {
    const hermesProject = await makeDir(tempRoot, 'hermes-app')
    const managedProject = await makeDir(tempRoot, 'claude-app')
    process.env.HERMES_WEBUI_DEFAULT_WORKSPACE = hermesProject

    await saveWorkspaceSelection({
      path: hermesProject,
      name: 'Hermes App',
      agent: 'default',
    })
    await saveWorkspaceSelection({
      path: managedProject,
      name: 'Claude App',
      agent: 'cc-impl',
    })

    const hermesCatalog = await loadWorkspaceCatalog('default')
    const managedCatalog = await loadWorkspaceCatalog('cc-impl')

    expect(hermesCatalog.path).toBe(hermesProject)
    expect(hermesCatalog.agent).toBe('default')
    expect(managedCatalog.path).toBe(managedProject)
    expect(managedCatalog.agent).toBe('cc-impl')
    expect(managedCatalog.path).not.toBe(hermesCatalog.path)

    await expect(
      fs.readFile(
        path.join(
          process.env.HERMES_HOME!,
          'workspace',
          'agents',
          'cc-impl',
          'webui_state',
          'last_workspace.txt',
        ),
        'utf-8',
      ),
    ).resolves.toBe(`${managedProject}\n`)
    await expect(
      fs.readFile(
        path.join(
          process.env.HERMES_HOME!,
          'webui_state',
          'last_workspace.txt',
        ),
        'utf-8',
      ),
    ).resolves.toBe(`${hermesProject}\n`)
  })
})

describe('workspace folder listing', () => {
  beforeEach(() => {
    process.env.WORKSPACE_BASE = tempRoot
  })

  afterEach(() => {
    delete process.env.WORKSPACE_BASE
  })

  it('lists directories under the browse base, including dot folders', async () => {
    await makeDir(tempRoot, 'project', 'src')
    await makeDir(tempRoot, '.cache')
    await fs.writeFile(path.join(tempRoot, 'readme.txt'), 'x')

    const root = await listWorkspaceFolders('')

    expect(root.base).toBe(path.resolve(tempRoot))
    expect(root.current).toBe('')
    expect(root.folders.map((folder) => folder.name).sort()).toEqual([
      '.cache',
      'project',
    ])
    expect(
      root.folders.find((folder) => folder.name === '.hermes'),
    ).toBeUndefined()
  })

  it('expands a subdirectory with a relative path', async () => {
    await makeDir(tempRoot, 'project', 'src')
    await makeDir(tempRoot, 'project', 'docs')

    const child = await listWorkspaceFolders('project')

    expect(child.current).toBe('project')
    expect(child.folders.map((folder) => folder.name).sort()).toEqual([
      'docs',
      'src',
    ])
    expect(child.folders[0]?.path).toMatch(/^project\//)
    expect(child.folders[0]?.fullPath).toContain(path.join('project'))
  })

  it('rejects path traversal outside the browse base', async () => {
    await expect(listWorkspaceFolders('..')).rejects.toMatchObject({
      status: 403,
    })
    await expect(listWorkspaceFolders('../')).rejects.toBeInstanceOf(
      WorkspaceFolderAccessError,
    )
  })

  it('rejects Hermes state directories and missing paths', async () => {
    await expect(
      listWorkspaceFolders(process.env.HERMES_HOME!),
    ).rejects.toMatchObject({ status: 403 })
    await expect(listWorkspaceFolders('missing-dir')).rejects.toMatchObject({
      status: 404,
    })
  })
})
