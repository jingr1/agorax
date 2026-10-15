import { afterEach, describe, expect, it } from 'vitest'
import {
  buildRemoteSshCommand,
  buildSshArgs,
  listSshFileTree,
  listSshWorkspaceFolders,
  resolveRemoteListTarget,
  setSshRunnerForTests,
  sshControlPath,
} from './ssh-terminal'

const SSH_CONFIG = {
  terminal: {
    backend: 'ssh',
    cwd: '/home/ramonjing',
    ssh_host: 'dev-wsl',
    ssh_user: 'ramonjing',
    ssh_port: 2222,
    ssh_key: '/tmp/id_test',
  },
}

afterEach(() => {
  setSshRunnerForTests(null)
})

describe('ssh workspace folder listing', () => {
  it('lists remote directories under terminal.cwd', async () => {
    setSshRunnerForTests(async (_ssh, argv) => {
      expect(argv[0]).toBe('/bin/ls')
      expect(argv).toContain('/home/ramonjing')
      return {
        stdout: Buffer.from('projects/\n.cache/\nsrc/\nREADME.md\n'),
        stderr: '',
        code: 0,
      }
    })

    const listing = await listSshWorkspaceFolders(SSH_CONFIG, '')
    expect(listing.base).toBe('/home/ramonjing')
    expect(listing.remote).toBe(true)
    expect(listing.host).toBe('ramonjing@dev-wsl')
    expect(listing.folders.map((folder) => folder.name)).toEqual([
      'projects',
      'src',
    ])
    expect(listing.folders[0]?.fullPath).toBe('/home/ramonjing/projects')
  })

  it('rejects listing outside remote cwd', () => {
    expect(() =>
      resolveRemoteListTarget(
        '/home/ramon.jing/hermes-workspace',
        '/home/ramonjing',
      ),
    ).toThrow('Access denied')
  })

  it('uses a Workspace-owned ControlMaster socket instead of ~/.ssh/config', () => {
    const ssh = {
      host: 'dev-wsl',
      user: 'ramonjing',
      key: '/tmp/id_test',
      port: 2222,
      cwd: '/home/ramonjing',
    }
    const args = buildSshArgs(ssh, ['/bin/ls', '-1p', '--', '/home/ramonjing'])
    expect(args).toContain('ControlMaster=auto')
    expect(args).toContain(`ControlPath=${sshControlPath(ssh)}`)
    expect(args).toContain('IdentitiesOnly=yes')
  })

  it('quotes the remote command so ssh does not split find arguments', () => {
    expect(
      buildRemoteSshCommand([
        'find',
        '/home/ramonjing/vhl_dyn_sim',
        '-mindepth',
        '1',
        '-type',
        'd',
      ]),
    ).toBe("'find' '/home/ramonjing/vhl_dyn_sim' '-mindepth' '1' '-type' 'd'")
  })

  it('builds a remote file tree from find -printf output', async () => {
    setSshRunnerForTests(async (_ssh, argv) => {
      expect(argv[0]).toBe('find')
      expect(argv[1]).toBe('/home/ramonjing/vhl_dyn_sim')
      return {
        stdout: Buffer.from(
          [
            'd\t/home/ramonjing/vhl_dyn_sim/scripts',
            'f\t/home/ramonjing/vhl_dyn_sim/README.md',
            'd\t/home/ramonjing/vhl_dyn_sim/.venv',
            '',
          ].join('\n'),
        ),
        stderr: '',
        code: 0,
      }
    })

    const tree = await listSshFileTree({
      config: SSH_CONFIG,
      workspaceRoot: '/home/ramonjing/vhl_dyn_sim',
      dirPath: '/home/ramonjing/vhl_dyn_sim',
      maxDepth: 3,
    })
    expect(tree.map((entry) => entry.name)).toEqual(['scripts', 'README.md'])
    expect(tree.find((entry) => entry.name === 'README.md')?.type).toBe('file')
  })

  it('uses shallow ls for maxDepth 1 file trees', async () => {
    setSshRunnerForTests(async (_ssh, argv) => {
      expect(argv[0]).toBe('/bin/ls')
      expect(argv).toContain('/home/ramonjing/vhl_dyn_sim')
      return {
        stdout: Buffer.from('scripts/\nREADME.md\n'),
        stderr: '',
        code: 0,
      }
    })

    const tree = await listSshFileTree({
      config: SSH_CONFIG,
      workspaceRoot: '/home/ramonjing/vhl_dyn_sim',
      dirPath: '/home/ramonjing/vhl_dyn_sim',
      maxDepth: 1,
    })
    expect(tree.map((entry) => entry.name)).toEqual(['scripts', 'README.md'])
  })
})
