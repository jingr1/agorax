'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  CheckmarkCircle02Icon,
  Copy01Icon,
  Loading03Icon,
  RefreshIcon,
  Alert02Icon,
} from '@hugeicons/core-free-icons'
import { AgentIdentityAvatar } from '@/components/avatars'
import { Button } from '@/components/ui/button'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/toast'
import { writeTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import type { AgentProviderStatusDto } from '@/lib/managed-agent-runtime/provider-status'
import {
  deriveEnvWizardViewModel,
  remediationLabel,
  stageRemediation,
  type EnvSetupStage,
  type EnvSetupStepStatus,
  type EnvStageActionId,
} from '@/lib/managed-agent-runtime/env-wizard'

const PROVIDER_LABELS: Record<string, string> = {
  hermes: 'Hermes Agent',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  'kimi-code': 'Kimi Code',
  'deepseek-harness': 'DeepSeek',
}

function StageIcon({ status }: { status: EnvSetupStepStatus }) {
  if (status === 'ok') {
    return (
      <HugeiconsIcon
        icon={CheckmarkCircle02Icon}
        size={16}
        className="text-emerald-500"
      />
    )
  }
  if (status === 'running') {
    return (
      <HugeiconsIcon
        icon={Loading03Icon}
        size={16}
        className="animate-spin text-blue-500"
      />
    )
  }
  if (status === 'error') {
    return (
      <HugeiconsIcon
        icon={Alert02Icon}
        size={16}
        className="text-amber-500"
      />
    )
  }
  return (
    <span
      aria-hidden
      className="inline-block size-4 rounded-full border border-[var(--theme-border)]"
    />
  )
}

function ManagementPanel({
  management,
}: {
  management: ReturnType<typeof deriveEnvWizardViewModel>['management']
}) {
  const rows: Array<[string, string]> = [
    ['Target', management.targetId || '—'],
    ['Binary', management.binaryPath || '—'],
    ['Version', management.version || '—'],
    ['Min', management.minVersion || '—'],
    ['Recommended', management.recommendedVersion || '—'],
    ['Latest', management.latestVersion || '—'],
    ['Auth', management.authStatus],
    ['Account', management.accountLabel || '—'],
    ['Method', management.authMethod || '—'],
    ['Enabled', management.registered ? 'yes' : 'no'],
  ]
  return (
    <div className="mt-4 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-panel)] p-3">
      <p className="mb-2 text-xs font-medium text-[var(--theme-muted)]">
        管理详情
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[var(--theme-muted)]">{label}</dt>
            <dd className="truncate font-mono text-[var(--theme-text)]">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export type AgentRuntimeEnvDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  entry: AgentProviderStatusDto | null
  /** First load only (no cached entry yet). */
  isLoading: boolean
  isInstalling: boolean
  isLoggingIn: boolean
  onRedetect: () => void | Promise<unknown>
  onInstall: (provider: string, version?: string) => void
  onLogin: (provider: string) => void
}

export function AgentRuntimeEnvDialog({
  open,
  onOpenChange,
  entry,
  isLoading,
  isInstalling,
  isLoggingIn,
  onRedetect,
  onInstall,
  onLogin,
}: AgentRuntimeEnvDialogProps) {
  const [copied, setCopied] = useState<string | null>(null)
  const [redetecting, setRedetecting] = useState(false)
  // One detect per dialog-open session for a given provider. Background
  // install/login polls must not count as another detect.
  const detectedSessionRef = useRef<string | null>(null)
  const label =
    PROVIDER_LABELS[entry?.provider ?? ''] ?? entry?.provider ?? 'Runtime'
  const providerKey = entry?.provider ?? null

  const viewModel = useMemo(
    () =>
      deriveEnvWizardViewModel({
        entry,
        isLoading,
        installPending: isInstalling,
        loginPending: isLoggingIn,
        redetecting,
      }),
    [entry, isLoading, isInstalling, isLoggingIn, redetecting],
  )

  const runDetect = async () => {
    setRedetecting(true)
    try {
      await onRedetect()
    } finally {
      setRedetecting(false)
    }
  }

  useEffect(() => {
    if (!open) {
      setCopied(null)
      setRedetecting(false)
      detectedSessionRef.current = null
      return
    }
    if (!providerKey) return
    if (detectedSessionRef.current === providerKey) return
    detectedSessionRef.current = providerKey
    let cancelled = false
    setRedetecting(true)
    void Promise.resolve(onRedetect()).finally(() => {
      if (!cancelled) setRedetecting(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, providerKey, onRedetect])

  const handleRedetect = async () => {
    await runDetect()
  }

  const copyText = async (text: string, key: string) => {
    const value = text.trim()
    if (!value) {
      toast('没有可复制的命令', { type: 'warning' })
      return
    }
    try {
      await writeTextToClipboard(value)
      setCopied(key)
      toast('已复制到剪贴板', { type: 'success', duration: 2000 })
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast('复制失败，请手动选择命令', { type: 'error' })
    }
  }

  const runAction = (actionId: EnvStageActionId, stage: EnvSetupStage) => {
    if (!entry) return
    if (actionId === 'redetect') {
      void handleRedetect()
      return
    }
    if (actionId === 'install') {
      onInstall(entry.provider)
      return
    }
    if (actionId === 'update') {
      onInstall(entry.provider, 'latest')
      return
    }
    if (actionId === 'login') {
      if (viewModel.canDaemonLogin) {
        onLogin(entry.provider)
        return
      }
      if (viewModel.loginCommand) {
        void copyText(viewModel.loginCommand, `login:${stage.id}`)
        return
      }
      toast('当前运行时不支持登录操作', { type: 'warning' })
    }
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(560px,92vw)]">
        <div className="flex items-start gap-3 border-b border-[var(--theme-border)] px-5 py-4">
          <AgentIdentityAvatar
            name={label}
            runtime={entry?.provider ?? 'hermes'}
            showInitials={false}
            size={36}
          />
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base">
              配置 {label} 环境
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">
              {viewModel.ready
                ? `${label} 已就绪，可在下方查看管理详情或重新检测。`
                : `按步骤检测、安装并登录 ${label}。`}
            </DialogDescription>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!viewModel.ready || viewModel.busy ? (
            <p className="mb-3 text-sm text-[var(--theme-muted)]">
              {isInstalling
                ? `正在安装/升级 ${label}…`
                : isLoggingIn
                  ? `正在等待 ${label} 登录授权…`
                  : redetecting || isLoading
                    ? `正在检测 ${label}…`
                    : `完成剩余步骤以启用 ${label}`}
            </p>
          ) : null}

          <ol className="m-0 flex list-none flex-col divide-y divide-[var(--theme-border)] p-0">
            {viewModel.stages.map((stage) => {
              const remediation =
                viewModel.blockingStageId === stage.id
                  ? stageRemediation(stage)
                  : null
              const dimmed =
                stage.status === 'pending' || stage.status === 'skipped'
              return (
                <li
                  key={stage.id}
                  data-stage={stage.id}
                  data-status={stage.status}
                  className={cn(
                    'flex items-center gap-2.5 py-3',
                    dimmed && !remediation && 'opacity-50',
                  )}
                >
                  <StageIcon status={stage.status} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 text-sm font-medium text-[var(--theme-text)]">
                        {stage.label}
                      </span>
                      {stage.detail ? (
                        <span className="truncate text-xs text-[var(--theme-muted)]">
                          {stage.detail}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  {remediation ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant={
                          remediation.actionId === 'login' &&
                          !viewModel.canDaemonLogin
                            ? 'outline'
                            : 'default'
                        }
                        disabled={
                          (viewModel.busy &&
                            remediation.actionId !== 'login' &&
                            remediation.actionId !== 'redetect') ||
                          (remediation.actionId === 'login' && isLoggingIn) ||
                          (remediation.actionId === 'install' &&
                            !viewModel.canInstall) ||
                          (remediation.actionId === 'update' &&
                            !viewModel.canUpgrade)
                        }
                        title={
                          remediation.actionId === 'install' &&
                          !viewModel.canInstall
                            ? '当前运行时不支持一键安装，请使用下方手动命令'
                            : undefined
                        }
                        className="h-7 gap-1 px-2.5 text-[11px]"
                        onClick={() => {
                          if (
                            remediation.actionId === 'install' &&
                            !viewModel.canInstall
                          ) {
                            return
                          }
                          if (
                            remediation.actionId === 'update' &&
                            !viewModel.canUpgrade
                          ) {
                            return
                          }
                          runAction(remediation.actionId, stage)
                        }}
                      >
                        {remediation.actionId === 'login' && isLoggingIn
                          ? '登录中…'
                          : remediation.actionId === 'login' &&
                              copied === `login:${stage.id}`
                            ? '已复制'
                            : remediationLabel(remediation.problem)}
                      </Button>
                      {remediation.actionId === 'login' &&
                      viewModel.canDaemonLogin &&
                      viewModel.loginCommand ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 px-2 text-[11px]"
                          onClick={() =>
                            void copyText(
                              viewModel.loginCommand!,
                              `login-copy:${stage.id}`,
                            )
                          }
                        >
                          <HugeiconsIcon icon={Copy01Icon} size={12} />
                          {copied === `login-copy:${stage.id}`
                            ? '已复制'
                            : '复制命令'}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>

          {viewModel.manualCommand && !entry?.installed ? (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--theme-border)] px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-xs text-[var(--theme-text)]">
                {viewModel.manualCommand}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() =>
                  void copyText(viewModel.manualCommand!, 'manual')
                }
              >
                <HugeiconsIcon icon={Copy01Icon} size={12} />
                {copied === 'manual' ? '已复制' : '复制'}
              </Button>
            </div>
          ) : null}

          <ManagementPanel management={viewModel.management} />
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--theme-border)] px-5 py-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={viewModel.busy && !isLoggingIn}
            className="h-8 gap-1.5 text-xs"
            onClick={() => {
              void handleRedetect()
            }}
          >
            <HugeiconsIcon
              icon={RefreshIcon}
              size={14}
              className={cn(redetecting && 'animate-spin')}
            />
            重新检测
          </Button>
          {viewModel.canUpgrade ? (
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              disabled={isInstalling}
              onClick={() => entry && onInstall(entry.provider, 'latest')}
            >
              升级
            </Button>
          ) : viewModel.canInstall ? (
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              disabled={isInstalling}
              onClick={() => entry && onInstall(entry.provider)}
            >
              安装
            </Button>
          ) : null}
          <DialogClose className="h-8 text-xs">关闭</DialogClose>
        </div>
      </DialogContent>
    </DialogRoot>
  )
}
