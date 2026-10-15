/**
 * Agorax Env wizard stages derived from the compact provider-status DTO.
 * Mirrors Agorax's detect → install → login → ready track (network/adapter are
 * folded into install/update discovery until the daemon ships full Agorax
 * availability/network/actions).
 */

import type { AgentProviderStatusDto } from './provider-status'
import { canDaemonInstallProvider } from './provider-status'

export type EnvSetupStageId = 'detect' | 'install' | 'login' | 'ready'

export type EnvSetupStepStatus =
  | 'pending'
  | 'running'
  | 'ok'
  | 'error'
  | 'skipped'

export type EnvStageActionId = 'install' | 'login' | 'redetect' | 'update'

export type EnvStageProblem =
  | 'install-missing'
  | 'login-missing'
  | 'version-floor'
  | 'update-available'
  | 'detect-failed'

export interface EnvSetupStage {
  id: EnvSetupStageId
  label: string
  status: EnvSetupStepStatus
  detail: string | null
  problem?: EnvStageProblem
}

export interface EnvWizardViewModel {
  ready: boolean
  busy: boolean
  stages: EnvSetupStage[]
  blockingStageId: EnvSetupStageId | null
  manualCommand: string | null
  loginCommand: string | null
  canDaemonLogin: boolean
  updateAvailable: boolean
  canInstall: boolean
  canUpgrade: boolean
  management: EnvManagementSnapshot
}

export interface EnvManagementSnapshot {
  binaryPath: string | null
  version: string | null
  minVersion: string | null
  recommendedVersion: string | null
  latestVersion: string | null
  authStatus: string
  accountLabel: string | null
  authMethod: string | null
  registered: boolean
  targetId: string
}

const STAGE_LABELS: Record<EnvSetupStageId, string> = {
  detect: '检测',
  install: '安装',
  login: '登录',
  ready: '就绪',
}

/** Provider CLI login commands shown when auth is required (copy fallback). */
export const PROVIDER_LOGIN_COMMANDS: Record<string, string> = {
  'claude-code': 'claude auth login',
  // Device auth avoids localhost:1455 OAuth callbacks that break on SSH /
  // remote browser clients (listener is on the server, browser is local).
  codex: 'codex login --device-auth',
  cursor: 'agent login',
  opencode: 'opencode auth login',
  'kimi-code': 'kimi login',
}

export function deriveEnvWizardViewModel(input: {
  entry: AgentProviderStatusDto | null
  /** True only for the first load (no entry) or an explicit redetect click. */
  isLoading: boolean
  installPending: boolean
  loginPending?: boolean
  /** Explicit user-triggered redetect; background polls must not set this. */
  redetecting?: boolean
}): EnvWizardViewModel {
  const entry = input.entry
  const installPending = input.installPending
  const loginPending = Boolean(input.loginPending || entry?.loginInProgress)
  const redetecting = Boolean(input.redetecting)
  const isStub = entry?.provider === 'deepseek-harness'
  const isHermes = entry?.provider === 'hermes'

  if (!entry) {
    return {
      ready: false,
      busy: input.isLoading || redetecting,
      stages: [
        {
          id: 'detect',
          label: STAGE_LABELS.detect,
          status: input.isLoading || redetecting ? 'running' : 'pending',
          detail: null,
        },
        {
          id: 'install',
          label: STAGE_LABELS.install,
          status: 'pending',
          detail: null,
        },
        {
          id: 'login',
          label: STAGE_LABELS.login,
          status: 'pending',
          detail: null,
        },
        {
          id: 'ready',
          label: STAGE_LABELS.ready,
          status: 'pending',
          detail: null,
        },
      ],
      blockingStageId: 'detect',
      manualCommand: null,
      loginCommand: null,
      canDaemonLogin: false,
      updateAvailable: false,
      canInstall: false,
      canUpgrade: false,
      management: emptyManagement(),
    }
  }

  if (isStub) {
    return {
      ready: false,
      busy: false,
      stages: [
        {
          id: 'detect',
          label: STAGE_LABELS.detect,
          status: 'error',
          detail: '适配器尚未交付',
          problem: 'detect-failed',
        },
        {
          id: 'install',
          label: STAGE_LABELS.install,
          status: 'skipped',
          detail: null,
        },
        {
          id: 'login',
          label: STAGE_LABELS.login,
          status: 'skipped',
          detail: null,
        },
        {
          id: 'ready',
          label: STAGE_LABELS.ready,
          status: 'pending',
          detail: null,
        },
      ],
      blockingStageId: 'detect',
      manualCommand: null,
      loginCommand: null,
      canDaemonLogin: false,
      updateAvailable: false,
      canInstall: false,
      canUpgrade: false,
      management: managementFromEntry(entry),
    }
  }

  const installed = entry.installed
  const authOk =
    entry.auth.status === 'authenticated' ||
    entry.auth.status === 'configured'
  const authRequired =
    entry.auth.status === 'required' || entry.auth.status === 'unknown'
  const updateAvailable = entry.updateAvailable === true
  const versionTooOld =
    Boolean(entry.minVersion && entry.version) &&
    entry.updateAvailable &&
    entry.minVersion != null &&
    entry.version != null
  // Prefer a concrete version compare signal when minVersion is set and
  // updateAvailable is true without a newer latest — treat as floor breach.
  const belowFloor =
    Boolean(entry.minVersion) &&
    Boolean(entry.version) &&
    updateAvailable &&
    !entry.latestVersion

  const detectStatus: EnvSetupStepStatus = redetecting
    ? 'running'
    : entry.error && !installed
      ? 'error'
      : 'ok'

  let installStatus: EnvSetupStepStatus
  let installProblem: EnvStageProblem | undefined
  if (installPending) {
    installStatus = 'running'
  } else if (!installed) {
    installStatus = 'error'
    installProblem = 'install-missing'
  } else if (belowFloor || (updateAvailable && versionTooOld)) {
    installStatus = 'error'
    installProblem = belowFloor ? 'version-floor' : 'update-available'
  } else if (updateAvailable) {
    installStatus = 'error'
    installProblem = 'update-available'
  } else {
    installStatus = 'ok'
  }

  let loginStatus: EnvSetupStepStatus
  let loginProblem: EnvStageProblem | undefined
  // Auth success wins over a stale loginInProgress lock: the web terminal may
  // already have finished while the daemon watcher has not released yet.
  const awaitingLogin = loginPending && !authOk
  if (isHermes) {
    // Hermes readiness is gateway probe; no CLI login stage.
    loginStatus = entry.registered ? 'ok' : installed ? 'error' : 'pending'
    if (loginStatus === 'error') loginProblem = 'detect-failed'
  } else if (!installed) {
    loginStatus = 'pending'
  } else if (authOk) {
    loginStatus = 'ok'
  } else if (awaitingLogin) {
    loginStatus = 'running'
  } else if (authRequired) {
    loginStatus = 'error'
    loginProblem = 'login-missing'
  } else {
    loginStatus = 'pending'
  }

  const ready =
    detectStatus === 'ok' &&
    installStatus === 'ok' &&
    loginStatus === 'ok' &&
    (isHermes ? entry.registered : entry.registered || authOk)

  const readyStatus: EnvSetupStepStatus = ready
    ? 'ok'
    : installPending || awaitingLogin || redetecting
      ? 'pending'
      : 'pending'

  const stages: EnvSetupStage[] = [
    {
      id: 'detect',
      label: STAGE_LABELS.detect,
      status: detectStatus,
      detail: entry.error && !installed ? entry.error : entry.binaryPath ?? null,
      problem: detectStatus === 'error' ? 'detect-failed' : undefined,
    },
    {
      id: 'install',
      label: STAGE_LABELS.install,
      status: installStatus,
      detail: installPending
        ? '安装进行中…'
        : installDetail(entry, installProblem),
      problem: installProblem,
    },
    {
      id: 'login',
      label: isHermes ? '网关' : STAGE_LABELS.login,
      status: loginStatus,
      detail: awaitingLogin
        ? '等待授权完成…（终端已结束可点重新检测）'
        : loginDetail(entry, isHermes),
      problem: loginProblem,
    },
    {
      id: 'ready',
      label: STAGE_LABELS.ready,
      status: readyStatus,
      detail: ready ? '可以使用' : null,
    },
  ]

  // Prefer the active install/login step over detect when reporting the
  // blocking remediation target (install polls must not revive detect).
  const blockingStageId =
    stages.find(
      (stage) =>
        stage.status === 'running' &&
        (stage.id === 'install' || stage.id === 'login'),
    )?.id ??
    stages.find((stage) => stage.status === 'error')?.id ??
    stages.find(
      (stage) => stage.status === 'running' && stage.id !== 'ready',
    )?.id ??
    null

  const canInstall =
    !isHermes &&
    !installPending &&
    !installed &&
    canDaemonInstallProvider(entry.install)
  const canUpgrade =
    !installPending &&
    installed &&
    updateAvailable &&
    entry.update.capability === 'supported'

  const loginCommand =
    entry.login?.displayCommand?.trim() ||
    (isHermes ? null : PROVIDER_LOGIN_COMMANDS[entry.provider] ?? null)
  const canDaemonLogin =
    !isHermes &&
    Boolean(entry.login?.supported) &&
    installed &&
    !awaitingLogin

  return {
    ready,
    busy: installPending || awaitingLogin || redetecting,
    stages,
    blockingStageId,
    manualCommand: entry.install?.displayCommand?.trim() || null,
    loginCommand,
    canDaemonLogin,
    updateAvailable,
    canInstall,
    canUpgrade,
    management: managementFromEntry(entry),
  }
}

export function stageRemediation(stage: EnvSetupStage): {
  actionId: EnvStageActionId
  problem: EnvStageProblem
} | null {
  if (!stage.problem) return null
  switch (stage.id) {
    case 'detect':
      return { actionId: 'redetect', problem: stage.problem }
    case 'install':
      if (stage.problem === 'update-available') {
        return { actionId: 'update', problem: stage.problem }
      }
      return { actionId: 'install', problem: stage.problem }
    case 'login':
      // Hermes gateway failures use detect-failed → redetect, not login.
      if (stage.problem === 'detect-failed') {
        return { actionId: 'redetect', problem: stage.problem }
      }
      return { actionId: 'login', problem: stage.problem }
    default:
      return null
  }
}

export function remediationLabel(problem: EnvStageProblem): string {
  switch (problem) {
    case 'install-missing':
      return '安装'
    case 'update-available':
    case 'version-floor':
      return '升级'
    case 'login-missing':
      return '登录'
    case 'detect-failed':
      return '重新检测'
  }
}

function installDetail(
  entry: AgentProviderStatusDto,
  problem: EnvStageProblem | undefined,
): string | null {
  if (problem === 'version-floor' && entry.version && entry.minVersion) {
    return `${entry.version}（需要 ≥ ${entry.minVersion}）`
  }
  if (problem === 'update-available' && entry.version && entry.latestVersion) {
    return `${entry.version} → ${entry.latestVersion}`
  }
  if (entry.version) {
    return [entry.version, entry.binaryPath].filter(Boolean).join(' · ')
  }
  return entry.install?.displayCommand ?? null
}

function loginDetail(
  entry: AgentProviderStatusDto,
  isHermes: boolean,
): string | null {
  if (isHermes) {
    return entry.registered ? 'Gateway 已连接' : 'Gateway 未探测到'
  }
  const parts = [
    entry.auth.accountLabel,
    entry.auth.authMethod,
    entry.auth.status === 'unknown' || entry.auth.status === 'required'
      ? null
      : entry.auth.status,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

function managementFromEntry(
  entry: AgentProviderStatusDto,
): EnvManagementSnapshot {
  return {
    binaryPath: entry.binaryPath ?? null,
    version: entry.version ?? null,
    minVersion: entry.minVersion ?? null,
    recommendedVersion: entry.recommendedVersion ?? null,
    latestVersion: entry.latestVersion ?? null,
    authStatus: entry.auth.status,
    accountLabel: entry.auth.accountLabel ?? null,
    authMethod: entry.auth.authMethod ?? null,
    registered: entry.registered,
    targetId: entry.targetId,
  }
}

function emptyManagement(): EnvManagementSnapshot {
  return {
    binaryPath: null,
    version: null,
    minVersion: null,
    recommendedVersion: null,
    latestVersion: null,
    authStatus: 'unknown',
    accountLabel: null,
    authMethod: null,
    registered: false,
    targetId: '',
  }
}
