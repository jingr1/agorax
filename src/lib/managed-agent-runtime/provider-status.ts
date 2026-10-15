/**
 * Client-safe contracts for the Managed Agent daemon provider runtime
 * surfaces: `GET /v1/provider-status` (detection aggregate) and
 * `POST /v1/providers/{provider}/install` (managed npm install). The server
 * runtime imports from here; nothing in this module may import server-only
 * code.
 */

/** Provider ids reported by the daemon status aggregate. */
export const AGENT_PROVIDER_IDS = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'kimi-code',
] as const

export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number]

export interface AgentProviderAuthDto {
  status: 'authenticated' | 'configured' | 'required' | 'unknown' | string
  accountLabel?: string | null
  authMethod?: string | null
}

export interface AgentProviderInstallDto {
  kind: string
  displayCommand: string
  packageName: string
  binaryName: string
  /** True when the daemon install path is managed npm / codex-cli-latest. */
  managedNpm: boolean
}

/** True when POST /providers/{id}/install can drive this installer. */
export function canDaemonInstallProvider(
  install: AgentProviderInstallDto | null | undefined,
): boolean {
  if (!install) return false
  return (
    install.managedNpm ||
    install.kind === 'official_script' ||
    install.kind === 'codex_cli_latest'
  )
}

export interface AgentProviderUpdateDto {
  capability: string
  source?: string
  unsupportedReason?: string
  /** Mirrors installed CLI version when the daemon projects it onto update. */
  currentVersion?: string | null
  /** Registry latest when discovery succeeded; null when not checked / failed. */
  latestVersion?: string | null
  /** ISO timestamp of the last update-metadata probe (Agorax parity). */
  lastCheckedAt?: string | null
  /** Non-fatal discovery / compare reason (e.g. registry_unreachable). */
  reasonCode?: string | null
}

export interface AgentProviderLoginDto {
  supported: boolean
  displayCommand: string
  command?: Array<string>
}

export interface AgentProviderStatusDto {
  provider: AgentProviderId | string
  targetId: string
  registered: boolean
  installed: boolean
  /** True while the daemon holds the managed npm install lock for this provider. */
  installInProgress?: boolean
  /** True while the daemon is watching an interactive login it launched. */
  loginInProgress?: boolean
  binaryPath?: string | null
  version?: string | null
  minVersion?: string
  recommendedVersion?: string
  latestVersion?: string | null
  updateAvailable: boolean
  auth: AgentProviderAuthDto
  install?: AgentProviderInstallDto
  login?: AgentProviderLoginDto
  update: AgentProviderUpdateDto
  error?: string
}

export interface AgentProviderStatusListDto {
  capturedAt: string
  providers: Array<AgentProviderStatusDto>
}

export interface AgentProviderInstallResultDto {
  provider: string
  /** in_progress = daemon already installing; UI should stay in "安装中". */
  status: 'installed' | 'already' | 'in_progress'
  version?: string
  binaryPath?: string
  command?: Array<string>
  registry?: string
}

export interface AgentProviderLoginResultDto {
  provider: string
  status: 'started' | 'already' | 'in_progress'
  mode?: 'terminal' | 'detached' | 'command' | string
  command?: Array<string>
  displayCommand?: string
}

/** Badge states the agent list renders for a non-Hermes runtime row. */
export type AgentProviderBadge = 'ready' | 'update-available' | 'not-installed' | 'unknown'

export const AGENT_PROVIDER_BADGE_LABELS: Record<AgentProviderBadge, string> = {
  ready: '就绪',
  'update-available': '需升级',
  'not-installed': '未安装',
  unknown: '未知',
}

/**
 * Maps a daemon status entry to the badge shown in the agent list. Installed
 * trumps auth problems: a reachable CLI with a broken login still renders as
 * ready here so the badge stays an install/upgrade signal, not an auth one.
 */
export function providerStatusBadge(
  entry: Pick<AgentProviderStatusDto, 'installed' | 'updateAvailable' | 'error'> | undefined,
): AgentProviderBadge {
  if (!entry) return 'unknown'
  if (!entry.installed) return 'not-installed'
  if (entry.updateAvailable) return 'update-available'
  if (entry.error) return 'unknown'
  return 'ready'
}

/**
 * Maps an AgentRuntime (agents.yaml runtime field) to the daemon provider id,
 * or null when the runtime has no daemon-side provider detection (hermes and
 * deepseek-harness today).
 */
export function providerIdForAgentRuntime(runtime: string): AgentProviderId | null {
  switch (runtime) {
    case 'claude-code':
    case 'codex':
    case 'cursor':
    case 'opencode':
      return runtime
    case 'kimi':
      return 'kimi-code'
    default:
      return null
  }
}
