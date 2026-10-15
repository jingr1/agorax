import type {
  AgentProviderId,
  AgentProviderInstallDto,
  AgentProviderStatusDto,
  AgentProviderStatusListDto,
} from '@/lib/managed-agent-runtime/provider-status'
import { AGENT_PROVIDER_IDS } from '@/lib/managed-agent-runtime/provider-status'
import { MANAGED_AGENT_TARGET_IDS } from '@/lib/managed-agent-runtime/agent-targets'
import {
  readAgentUpdateStatus,
  type UpdateCheckOptions,
} from '../update-system'
import { probeHermesProfileGateway } from './hermes-gateway-probe'

/** Reason code / error when status is projected without a live daemon. */
export const MANAGED_AGENT_DAEMON_UNREACHABLE =
  'managed_agent_daemon_unreachable'

const OFFLINE_INSTALL: Record<AgentProviderId, AgentProviderInstallDto> = {
  'claude-code': {
    kind: 'official_script',
    displayCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
    packageName: '',
    binaryName: 'claude',
    managedNpm: false,
  },
  codex: {
    kind: 'codex_cli_latest',
    displayCommand: 'npm install -g @openai/codex --include=optional',
    packageName: '@openai/codex',
    binaryName: 'codex',
    managedNpm: true,
  },
  cursor: {
    kind: 'official_script',
    displayCommand: 'curl https://cursor.com/install -fsS | bash',
    packageName: '',
    binaryName: 'cursor-agent',
    managedNpm: false,
  },
  opencode: {
    kind: 'official_script',
    displayCommand: 'curl -fsSL https://opencode.ai/v2/install | bash',
    packageName: '@opencode/cli',
    binaryName: 'opencode',
    managedNpm: false,
  },
  'kimi-code': {
    kind: 'official_script',
    displayCommand:
      'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    packageName: '',
    binaryName: 'kimi',
    managedNpm: false,
  },
}

function offlineTargetId(provider: AgentProviderId): string {
  switch (provider) {
    case 'kimi-code':
      return MANAGED_AGENT_TARGET_IDS.kimi
    default:
      return MANAGED_AGENT_TARGET_IDS[provider]
  }
}

/** Stable catalog rows when Agorax daemon cannot be reached. */
export function offlineManagedProviderStubs(): AgentProviderStatusDto[] {
  return AGENT_PROVIDER_IDS.map((provider) => ({
    provider,
    targetId: offlineTargetId(provider),
    registered: false,
    installed: false,
    binaryPath: null,
    version: null,
    latestVersion: null,
    updateAvailable: false,
    auth: { status: 'unknown' },
    install: OFFLINE_INSTALL[provider],
    update: {
      capability: 'unsupported',
      unsupportedReason: MANAGED_AGENT_DAEMON_UNREACHABLE,
    },
    error: MANAGED_AGENT_DAEMON_UNREACHABLE,
  }))
}

/**
 * Project Hermes Agent update-system status into the same provider-status row
 * shape the Runtimes table already renders. Auth/readiness comes from a
 * lightweight gateway probe (default profile); install/upgrade capability is
 * driven by `readAgentUpdateStatus`.
 */
export async function hermesProviderStatusRow(
  options?: UpdateCheckOptions,
): Promise<AgentProviderStatusDto> {
  // Provider status is a readiness snapshot — never git-fetch here. Remote
  // tips are refreshed only by `/api/update/status` (daily / manual).
  const update = readAgentUpdateStatus({
    fetch: options?.fetch ?? 'local',
    refresh: options?.refresh,
  })
  let registered = false
  try {
    const probe = await probeHermesProfileGateway('default')
    registered = probe.available
  } catch {
    registered = false
  }
  const installed = Boolean(update.path) || update.installKind === 'git'
  return {
    provider: 'hermes',
    targetId: 'runtime:hermes',
    registered,
    installed,
    binaryPath: update.path,
    version: update.version !== 'unknown' ? update.version : null,
    latestVersion: update.latestHead
      ? update.latestHead.slice(0, 7)
      : null,
    updateAvailable: update.updateAvailable,
    auth: {
      status: registered ? 'authenticated' : 'required',
      accountLabel: update.branch,
      authMethod: 'gateway',
    },
    install: {
      kind: update.installKind,
      displayCommand: 'Settings → Runtimes → Hermes Agent → 升级',
      packageName: 'hermes-agent',
      binaryName: 'hermes',
      managedNpm: false,
    },
    update: {
      capability: update.canUpdate ? 'supported' : 'unsupported',
      source: 'git',
      currentVersion: update.version !== 'unknown' ? update.version : null,
      latestVersion: update.latestHead
        ? update.latestHead.slice(0, 7)
        : null,
      lastCheckedAt: new Date().toISOString(),
      reasonCode:
        update.state === 'error'
          ? 'hermes_update_check_failed'
          : update.canUpdate || !update.updateAvailable
            ? null
            : update.reason
              ? 'hermes_update_blocked'
              : null,
      ...(update.canUpdate
        ? {}
        : {
            unsupportedReason:
              update.reason ?? 'Hermes Agent update is not one-click safe',
          }),
    },
    ...(update.state === 'error' && update.reason
      ? { error: update.reason }
      : {}),
  }
}

/** Honest stub row — DeepSeek harness is declared but not delivered. */
export function deepseekProviderStatusStub(): AgentProviderStatusDto {
  return {
    provider: 'deepseek-harness',
    targetId: 'runtime:deepseek-harness',
    registered: false,
    installed: false,
    binaryPath: null,
    version: null,
    latestVersion: null,
    updateAvailable: false,
    auth: { status: 'unknown' },
    install: {
      kind: 'unsupported',
      displayCommand: '',
      packageName: '',
      binaryName: 'deepseek-harness',
      managedNpm: false,
    },
    update: {
      capability: 'unsupported',
      unsupportedReason: 'DeepSeek harness adapter is not delivered yet',
    },
    error: 'adapter not yet delivered',
  }
}

/**
 * Merge daemon managed-provider status with Hermes (+ honest deepseek stub).
 * When the daemon is unreachable, still return the full managed catalog as
 * offline stubs (not omitted) so Runtimes stays complete; install/enable stay
 * blocked until the daemon is back.
 *
 * When the daemon omits `install` for a known provider (older binary / host-only
 * stub), fill the catalog installer so the Runtimes dialog keeps its Install
 * button instead of silently dropping it.
 */
export async function aggregateAgentRuntimeStatus(
  daemonStatus: AgentProviderStatusListDto | null,
  options?: UpdateCheckOptions,
): Promise<AgentProviderStatusListDto> {
  const hermes = await hermesProviderStatusRow(options)
  const deepseek = deepseekProviderStatusStub()
  const managed = (
    daemonStatus?.providers ?? offlineManagedProviderStubs()
  ).map(withCatalogInstallFallback)
  const providers = [hermes, ...managed, deepseek]
  return {
    capturedAt: daemonStatus?.capturedAt ?? new Date().toISOString(),
    providers,
  }
}

function withCatalogInstallFallback(
  entry: AgentProviderStatusDto,
): AgentProviderStatusDto {
  if (entry.install) return entry
  const catalog = OFFLINE_INSTALL[entry.provider as AgentProviderId]
  if (!catalog) return entry
  return { ...entry, install: catalog }
}
