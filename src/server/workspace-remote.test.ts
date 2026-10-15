import { describe, expect, it } from 'vitest'
import {
  isRemotePathUnderCwd,
  isRemoteTerminalBackend,
  profileDefaultRemoteWorkspace,
  readRemoteTerminalCwd,
  remoteTerminalWorkspaceCandidate,
} from './workspace-remote'

const REMOTE_CWD = '/home/ramonjing'

describe('workspace-remote', () => {
  it('detects ssh as a remote terminal backend', () => {
    expect(isRemoteTerminalBackend({ backend: 'ssh', cwd: REMOTE_CWD })).toBe(
      true,
    )
    expect(isRemoteTerminalBackend({ backend: 'local' })).toBe(false)
    expect(isRemoteTerminalBackend({})).toBe(false)
  })

  it('reads remote terminal cwd from profile config', () => {
    expect(
      readRemoteTerminalCwd({
        terminal: { backend: 'ssh', cwd: REMOTE_CWD },
      }),
    ).toBe(REMOTE_CWD)
    expect(readRemoteTerminalCwd({ terminal: { backend: 'local' } })).toBeNull()
  })

  it('treats ssh backend as remote even without an explicit cwd (defaults to ~)', () => {
    expect(
      readRemoteTerminalCwd({
        terminal: { backend: 'ssh', ssh_host: 'dev-wsl' },
      }),
    ).toBe('~')
    expect(
      readRemoteTerminalCwd({
        terminal: { backend: 'ssh', cwd: '.' },
      }),
    ).toBe('~')
  })

  it('accepts target-side paths under terminal.cwd without local existence', () => {
    const project = `${REMOTE_CWD}/projects/demo`
    expect(remoteTerminalWorkspaceCandidate(project, REMOTE_CWD)).toBe(project)
    expect(isRemotePathUnderCwd(project, REMOTE_CWD)).toBe(true)
  })

  it('rejects stale server-local paths outside terminal.cwd', () => {
    expect(
      remoteTerminalWorkspaceCandidate(
        '/home/ramon.jing/hermes-workspace',
        REMOTE_CWD,
      ),
    ).toBeNull()
  })

  it('rejects parent escape attempts', () => {
    expect(
      remoteTerminalWorkspaceCandidate(
        `${REMOTE_CWD}/../other/projects/demo`,
        REMOTE_CWD,
      ),
    ).toBeNull()
  })

  it('defaults remote profile workspace to terminal.cwd', () => {
    expect(
      profileDefaultRemoteWorkspace(
        { terminal: { backend: 'ssh', cwd: REMOTE_CWD } },
        REMOTE_CWD,
      ),
    ).toBe(REMOTE_CWD)
  })
})
