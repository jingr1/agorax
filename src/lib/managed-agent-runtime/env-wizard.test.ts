import { describe, expect, it } from 'vitest'
import type { AgentProviderStatusDto } from './provider-status'
import {
  deriveEnvWizardViewModel,
  stageRemediation,
} from './env-wizard'

function entry(
  overrides: Partial<AgentProviderStatusDto> = {},
): AgentProviderStatusDto {
  return {
    provider: 'claude-code',
    targetId: 'local:claude-code',
    registered: false,
    installed: false,
    updateAvailable: false,
    auth: { status: 'required' },
    update: {
      capability: 'unsupported',
      source: '',
      unsupportedReason: 'official_script_update_unsupported',
    },
    install: {
      kind: 'official_script',
      displayCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
      packageName: '',
      binaryName: 'claude',
      managedNpm: false,
    },
    ...overrides,
  }
}

describe('deriveEnvWizardViewModel', () => {
  it('blocks on install when CLI is missing', () => {
    const vm = deriveEnvWizardViewModel({
      entry: entry(),
      isLoading: false,
      installPending: false,
    })
    expect(vm.blockingStageId).toBe('install')
    expect(vm.canInstall).toBe(true)
    expect(stageRemediation(vm.stages[1]!)?.actionId).toBe('install')
  })

  it('blocks on login when installed but auth required', () => {
    const vm = deriveEnvWizardViewModel({
      entry: entry({
        installed: true,
        version: '1.0.0',
        binaryPath: '/usr/bin/claude',
        auth: { status: 'required' },
        login: {
          supported: true,
          displayCommand: 'claude auth login',
          command: ['claude', 'auth', 'login'],
        },
      }),
      isLoading: false,
      installPending: false,
    })
    expect(vm.blockingStageId).toBe('login')
    expect(vm.canDaemonLogin).toBe(true)
    expect(vm.loginCommand).toBe('claude auth login')
    expect(stageRemediation(vm.stages[2]!)?.actionId).toBe('login')
  })

  it('marks ready when installed, authed, and registered', () => {
    const vm = deriveEnvWizardViewModel({
      entry: entry({
        installed: true,
        registered: true,
        version: '1.0.0',
        auth: { status: 'authenticated', accountLabel: 'me@example.com' },
      }),
      isLoading: false,
      installPending: false,
    })
    expect(vm.ready).toBe(true)
    expect(vm.blockingStageId).toBeNull()
  })

  it('clears waiting-for-login when auth is already ok (stale loginInProgress)', () => {
    const vm = deriveEnvWizardViewModel({
      entry: entry({
        installed: true,
        registered: true,
        version: '1.0.0',
        binaryPath: '/usr/bin/claude',
        auth: { status: 'authenticated', accountLabel: 'me@example.com' },
        loginInProgress: true,
        login: {
          supported: true,
          displayCommand: 'claude auth login',
          command: ['claude', 'auth', 'login'],
        },
      }),
      isLoading: false,
      installPending: false,
      loginPending: true,
    })
    expect(vm.stages.find((s) => s.id === 'login')?.status).toBe('ok')
    expect(vm.stages.find((s) => s.id === 'login')?.detail).not.toBe(
      '等待授权完成…',
    )
    expect(vm.busy).toBe(false)
    expect(vm.ready).toBe(true)
    expect(vm.blockingStageId).toBeNull()
  })

  it('keeps waiting-for-login while auth is still required', () => {
    const vm = deriveEnvWizardViewModel({
      entry: entry({
        installed: true,
        version: '1.0.0',
        binaryPath: '/usr/bin/claude',
        auth: { status: 'required' },
        loginInProgress: true,
        login: {
          supported: true,
          displayCommand: 'claude auth login',
          command: ['claude', 'auth', 'login'],
        },
      }),
      isLoading: false,
      installPending: false,
      loginPending: true,
    })
    expect(vm.stages.find((s) => s.id === 'login')?.status).toBe('running')
    expect(vm.stages.find((s) => s.id === 'login')?.detail).toBe(
      '等待授权完成…（终端已结束可点重新检测）',
    )
    expect(vm.busy).toBe(true)
    expect(vm.blockingStageId).toBe('login')
  })

  it('surfaces update remediation when updateAvailable', () => {
    const vm = deriveEnvWizardViewModel({
      entry: entry({
        installed: true,
        registered: true,
        version: '1.0.0',
        latestVersion: '1.1.0',
        updateAvailable: true,
        auth: { status: 'authenticated' },
        update: { capability: 'supported', source: 'npm' },
        install: {
          kind: 'managed_npm',
          displayCommand: 'npm install -g @openai/codex',
          packageName: '@openai/codex',
          binaryName: 'codex',
          managedNpm: true,
        },
      }),
      isLoading: false,
      installPending: false,
    })
    expect(vm.blockingStageId).toBe('install')
    expect(vm.canUpgrade).toBe(true)
    expect(stageRemediation(vm.stages[1]!)?.actionId).toBe('update')
  })

  it('allows one-click install for official_script providers', () => {
    const vm = deriveEnvWizardViewModel({
      entry: entry({
        provider: 'cursor',
        install: {
          kind: 'official_script',
          displayCommand: 'curl https://cursor.com/install -fsS | bash',
          packageName: '',
          binaryName: 'cursor-agent',
          managedNpm: false,
        },
      }),
      isLoading: false,
      installPending: false,
    })
    expect(vm.canInstall).toBe(true)
  })

  it('keeps detect ok while install is pending (no redetect flicker)', () => {
    const vm = deriveEnvWizardViewModel({
      entry: entry({
        installed: false,
        auth: { status: 'unknown' },
      }),
      isLoading: true,
      installPending: true,
      redetecting: false,
    })
    expect(vm.stages.find((s) => s.id === 'detect')?.status).toBe('ok')
    expect(vm.stages.find((s) => s.id === 'install')?.status).toBe('running')
    expect(vm.blockingStageId).toBe('install')
  })
})
