import { describe, expect, it } from 'vitest'
import { buildSshRemoteEditorUri } from './workspace-os-open'

describe('buildSshRemoteEditorUri', () => {
  it('builds a vscode-remote URI for host aliases', () => {
    expect(
      buildSshRemoteEditorUri({
        host: 'dev-wsl',
        remotePath: '/home/ramonjing/proj',
      }),
    ).toBe('vscode-remote://ssh-remote+dev-wsl/home/ramonjing/proj')
  })

  it('includes user when provided', () => {
    expect(
      buildSshRemoteEditorUri({
        host: 'box.example',
        user: 'alice',
        remotePath: '/tmp/a',
      }),
    ).toBe('vscode-remote://ssh-remote+alice@box.example/tmp/a')
  })
})
