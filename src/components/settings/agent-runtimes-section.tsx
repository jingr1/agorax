'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { RefreshIcon, Settings02Icon } from '@hugeicons/core-free-icons'
import { AgentIdentityAvatar } from '@/components/avatars'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  providerStatusBadge,
  type AgentProviderId,
  type AgentProviderStatusDto,
} from '@/lib/managed-agent-runtime/provider-status'
import {
  formatAgentProviderUpdateSummary,
  resolveAgentProviderUpdateRowPresentation,
} from '@/lib/managed-agent-runtime/update-summary'
import {
  redetectAgentProviderStatus,
  useAgentProviderStatus,
  useInstallAgentProvider,
  useLoginAgentProvider,
  useRestartManagedAgentDaemon,
  useSetAgentProviderEnabled,
} from '@/screens/chat/hooks/use-provider-status'
import { refreshProductUpdateStatus } from '@/lib/managed-agent-runtime/product-update-check'
import {
  readProductUpdateAutoCheckEnabled,
  writeProductUpdateAutoCheckEnabled,
} from '@/lib/managed-agent-runtime/update-check-preference'
import { useQueryClient } from '@tanstack/react-query'
import { AgentRuntimeEnvDialog } from './agent-runtime-env-dialog'

const PROVIDER_LABELS: Record<string, string> = {
  hermes: 'Hermes Agent',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  'kimi-code': 'Kimi Code',
  'deepseek-harness': 'DeepSeek',
}

/** Stable table order — never reorder by install/update badge. */
const RUNTIME_DISPLAY_ORDER: ReadonlyArray<string> = [
  'hermes',
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'kimi-code',
  'deepseek-harness',
]

function runtimeDisplayRank(providerId: string): number {
  const index = RUNTIME_DISPLAY_ORDER.indexOf(providerId)
  return index >= 0 ? index : RUNTIME_DISPLAY_ORDER.length
}

function isManagedDaemonOffline(entry: AgentProviderStatusDto): boolean {
  return (
    entry.error === 'managed_agent_daemon_unreachable' ||
    entry.update.unsupportedReason === 'managed_agent_daemon_unreachable'
  )
}

function readinessStatus(entry: AgentProviderStatusDto): {
  label: string
  dotClass: string
} {
  if (isManagedDaemonOffline(entry)) {
    return { label: '服务不可用', dotClass: 'bg-amber-500' }
  }
  if (!entry.installed) {
    return { label: '未安装', dotClass: 'bg-primary-400 dark:bg-primary-500' }
  }
  switch (entry.auth.status) {
    case 'authenticated':
    case 'configured':
      if (entry.registered) {
        return { label: '已连接', dotClass: 'bg-emerald-500' }
      }
      return { label: '已配置', dotClass: 'bg-blue-500' }
    case 'required':
    case 'unknown':
    default:
      return { label: '需要登录', dotClass: 'bg-amber-500' }
  }
}

function RuntimeRow({
  entry,
  highlighted,
  isInstalling,
  onSetEnabled,
  onOpenEnvironment,
  togglingProvider,
}: {
  entry: AgentProviderStatusDto
  highlighted: boolean
  isInstalling: boolean
  togglingProvider: string | null
  onSetEnabled: (provider: string, enabled: boolean) => void
  onOpenEnvironment: (provider: string) => void
}) {
  const rowRef = useRef<HTMLTableRowElement>(null)
  const providerId = entry.provider
  const label = PROVIDER_LABELS[providerId] ?? providerId
  const badge = providerStatusBadge(entry)
  const { label: statusLabel, dotClass } = readinessStatus(entry)
  const isHermes = providerId === 'hermes'
  const isStub = providerId === 'deepseek-harness'
  const daemonOffline = isManagedDaemonOffline(entry)
  const installingIsUpgrade = entry.installed || badge === 'update-available'
  const isToggling = togglingProvider === providerId
  const showEnableToggle = !isHermes && !isStub && entry.installed
  const canOpenEnvironment = !isStub
  const updateSummary = formatAgentProviderUpdateSummary(
    resolveAgentProviderUpdateRowPresentation(entry),
  )

  useEffect(() => {
    if (highlighted && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
      rowRef.current.focus({ preventScroll: true })
    }
  }, [highlighted])

  return (
    <tr
      ref={rowRef}
      tabIndex={highlighted ? 0 : -1}
      data-provider={providerId}
      className={cn(
        'border-b border-[var(--theme-border)] last:border-b-0 transition-colors',
        highlighted && 'bg-[var(--theme-accent-subtle)]/60',
      )}
    >
      {/* Agent */}
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <AgentIdentityAvatar
            name={label}
            runtime={providerId}
            showInitials={false}
            size={36}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[var(--theme-text)]">
              {label}
            </p>
            <p className="truncate text-xs text-[var(--theme-muted)]">
              {isInstalling
                ? '安装进行中…'
                : daemonOffline
                  ? 'Agorax daemon 未连接'
                  : updateSummary
                    ? updateSummary
                    : entry.installed
                      ? (entry.version ?? 'Installed')
                      : (entry.install?.displayCommand ?? 'Not installed')}
            </p>
          </div>
        </div>
      </td>

      {/* Readiness — display only; install/upgrade live in Configure dialog */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              isInstalling ? 'animate-pulse bg-blue-500' : dotClass,
            )}
          />
          <span className="truncate text-sm text-[var(--theme-text)]">
            {isInstalling ? '安装中' : statusLabel}
          </span>
          {!isInstalling &&
            entry.updateAvailable &&
            entry.update.capability === 'supported' && (
              <span className="whitespace-nowrap text-xs text-amber-500">
                · 有更新
              </span>
            )}
        </div>
      </td>

      {/* Enabled */}
      <td className="px-4 py-3 text-center">
        {showEnableToggle ? (
          <Switch
            checked={entry.registered}
            disabled={isToggling || isInstalling}
            onCheckedChange={(checked) => onSetEnabled(providerId, checked)}
            aria-label={`${label} enabled`}
          />
        ) : isHermes ? (
          <Switch checked disabled aria-label={`${label} always enabled`} />
        ) : (
          <span className="text-xs text-[var(--theme-muted)]">—</span>
        )}
      </td>

      {/* Actions — open env wizard (install/upgrade live inside the dialog) */}
      <td className="px-4 py-3 text-right">
        {canOpenEnvironment ? (
          <Button
            type="button"
            size="sm"
            variant={isInstalling ? 'default' : 'outline'}
            className={cn('gap-1.5', isInstalling && 'opacity-90')}
            onClick={() => onOpenEnvironment(providerId)}
          >
            {isInstalling ? (
              <HugeiconsIcon
                icon={RefreshIcon}
                size={12}
                strokeWidth={1.5}
                className="animate-spin"
              />
            ) : (
              <HugeiconsIcon
                icon={Settings02Icon}
                size={12}
                strokeWidth={1.5}
              />
            )}
            {isInstalling
              ? installingIsUpgrade
                ? '升级中…'
                : '安装中…'
              : '配置'}
          </Button>
        ) : (
          <span className="text-xs text-[var(--theme-muted)]">—</span>
        )}
      </td>
    </tr>
  )
}

export type AgentRuntimesSectionProps = {
  highlightProvider?: string
}

export function AgentRuntimesSection({
  highlightProvider,
}: AgentRuntimesSectionProps) {
  const [autoCheck, setAutoCheck] = useState(() =>
    readProductUpdateAutoCheckEnabled(),
  )
  // Only spin on an explicit click — install invalidateQueries used to flip
  // isFetching and make「检查更新」look like it was checking again.
  const [manualRefreshing, setManualRefreshing] = useState(false)
  const [installingIds, setInstallingIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [envProvider, setEnvProvider] = useState<string | null>(null)
  const queryClient = useQueryClient()
  // Provider status is local/daemon only — no git fetch. Product update checks
  // share UpdateCenterNotifier's `/api/update/status` path.
  const statusQuery = useAgentProviderStatus()
  const installMutation = useInstallAgentProvider()
  const loginMutation = useLoginAgentProvider()
  const enableMutation = useSetAgentProviderEnabled()
  const restartDaemonMutation = useRestartManagedAgentDaemon()

  const daemonOffline = useMemo(
    () =>
      (statusQuery.data?.providers ?? []).some(
        (entry) =>
          entry.provider !== 'hermes' &&
          entry.provider !== 'deepseek-harness' &&
          isManagedDaemonOffline(entry),
      ) || Boolean(statusQuery.error),
    [statusQuery.data?.providers, statusQuery.error],
  )

  useEffect(() => {
    setInstallingIds((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const entry of statusQuery.data?.providers ?? []) {
        if (entry.installInProgress) {
          if (!next.has(entry.provider)) {
            next.add(entry.provider)
            changed = true
          }
          continue
        }
        const mutationBusy =
          installMutation.isPending &&
          installMutation.variables?.provider === entry.provider
        if (mutationBusy) continue
        // Keep sticky row until mutation settles *and* daemon cleared the lock.
        // Clearing in onSuccess/onError raced the status refetch and hid「升级中」.
        if (next.delete(entry.provider)) changed = true
      }
      return changed ? next : prev
    })
  }, [
    statusQuery.data,
    installMutation.isPending,
    installMutation.variables?.provider,
  ])

  const sorted = useMemo(() => {
    const list = statusQuery.data?.providers ?? []
    return [...list].sort((a, b) => {
      const diff =
        runtimeDisplayRank(a.provider) - runtimeDisplayRank(b.provider)
      if (diff !== 0) return diff
      return (a.provider as string).localeCompare(b.provider as string)
    })
  }, [statusQuery.data?.providers])

  const envEntry =
    sorted.find((entry) => entry.provider === envProvider) ?? null

  const handleInstall = (provider: string, version?: string) => {
    if (installingIds.has(provider)) return
    if (
      statusQuery.data?.providers.some(
        (entry) => entry.provider === provider && entry.installInProgress,
      )
    ) {
      return
    }
    setInstallingIds((prev) => new Set(prev).add(provider))
    installMutation.mutate(
      version
        ? { provider: provider as AgentProviderId, version }
        : { provider: provider as AgentProviderId },
      // Sticky「升级中」is cleared only by the status sync effect above once
      // the mutation settles and installInProgress is false — not here.
    )
  }

  const handleLogin = (provider: string) => {
    loginMutation.mutate({ provider: provider as AgentProviderId })
  }

  const handleRedetect = useCallback(
    () => redetectAgentProviderStatus(queryClient),
    [queryClient],
  )

  const handleSetEnabled = (provider: string, enabled: boolean) => {
    if (provider === 'hermes' || provider === 'deepseek-harness') return
    enableMutation.mutate({ provider: provider as AgentProviderId, enabled })
  }

  return (
    <div className="space-y-4">
      {daemonOffline ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--theme-text)]">
              Agorax daemon 未连接
            </p>
            <p className="text-xs text-[var(--theme-muted)]">
              Managed Agent 服务（:8788）不可用时无法安装/登录。可一键重启本地
              daemon。
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0 gap-1.5 text-xs"
            disabled={restartDaemonMutation.isPending}
            onClick={() => restartDaemonMutation.mutate()}
          >
            <HugeiconsIcon
              icon={RefreshIcon}
              size={14}
              strokeWidth={1.5}
              className={cn(restartDaemonMutation.isPending && 'animate-spin')}
            />
            {restartDaemonMutation.isPending ? '重启中…' : '重启 daemon'}
          </Button>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3">
          <Switch
            checked={autoCheck}
            onCheckedChange={(checked) => {
              setAutoCheck(checked)
              writeProductUpdateAutoCheckEnabled(checked)
            }}
            aria-label="自动检查更新"
          />
          <div>
            <p className="text-sm font-medium text-[var(--theme-text)]">
              自动检查更新
            </p>
            <p className="text-xs text-[var(--theme-muted)]">
              每天一次自动检查更新；点「检查更新」立即检查更新。
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={manualRefreshing}
          onClick={() => {
            setManualRefreshing(true)
            void refreshProductUpdateStatus(queryClient).finally(() =>
              setManualRefreshing(false),
            )
          }}
          className="gap-1.5"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={14}
            strokeWidth={1.5}
            className={cn(manualRefreshing && 'animate-spin')}
          />
          检查更新
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] shadow-sm">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[32%]" />
            <col className="w-[28%]" />
            <col className="w-[16%]" />
            <col className="w-[24%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-[var(--theme-border)] bg-[var(--theme-panel)] text-xs text-[var(--theme-muted)]">
              <th className="px-4 py-2 text-left font-medium">智能体</th>
              <th className="px-4 py-2 text-left font-medium">就绪状态</th>
              <th className="px-4 py-2 text-center font-medium">启用状态</th>
              <th className="px-4 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {statusQuery.isPending ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-sm text-[var(--theme-muted)]"
                >
                  加载中…
                </td>
              </tr>
            ) : statusQuery.error ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center">
                  <p className="text-sm text-[var(--theme-text)]">
                    无法加载运行时状态，请确认 Agorax daemon 正在运行。
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    disabled={restartDaemonMutation.isPending}
                    onClick={() => restartDaemonMutation.mutate()}
                  >
                    {restartDaemonMutation.isPending
                      ? '重启中…'
                      : '重启 daemon'}
                  </Button>
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-6 text-sm text-[var(--theme-muted)]"
                >
                  没有报告任何 managed runtime。
                </td>
              </tr>
            ) : (
              sorted.map((entry) => (
                <RuntimeRow
                  key={entry.provider}
                  entry={entry}
                  highlighted={highlightProvider === entry.provider}
                  isInstalling={
                    installingIds.has(entry.provider) ||
                    Boolean(entry.installInProgress) ||
                    (installMutation.isPending &&
                      installMutation.variables?.provider === entry.provider)
                  }
                  togglingProvider={
                    enableMutation.isPending && enableMutation.variables
                      ? enableMutation.variables.provider
                      : null
                  }
                  onSetEnabled={handleSetEnabled}
                  onOpenEnvironment={setEnvProvider}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <AgentRuntimeEnvDialog
        open={envProvider != null}
        onOpenChange={(next) => {
          if (!next) setEnvProvider(null)
        }}
        entry={envEntry}
        isLoading={statusQuery.isPending && !envEntry}
        isInstalling={
          envProvider != null &&
          (installingIds.has(envProvider) ||
            Boolean(envEntry?.installInProgress) ||
            (installMutation.isPending &&
              installMutation.variables?.provider === envProvider))
        }
        isLoggingIn={
          envProvider != null &&
          envEntry?.auth.status !== 'authenticated' &&
          envEntry?.auth.status !== 'configured' &&
          (Boolean(envEntry?.loginInProgress) ||
            (loginMutation.isPending &&
              loginMutation.variables?.provider === envProvider))
        }
        onRedetect={handleRedetect}
        onInstall={handleInstall}
        onLogin={handleLogin}
      />
    </div>
  )
}
