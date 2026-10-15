import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from '@/components/ui/toast'
import { sanitizeHttpErrorText } from '@/lib/http-error'
import { AGENT_PROVIDER_STATUS_QUERY_KEY } from '@/lib/managed-agent-runtime/query-keys'
import type {
  AgentProviderId,
  AgentProviderInstallResultDto,
  AgentProviderLoginResultDto,
  AgentProviderStatusListDto,
} from '@/lib/managed-agent-runtime/provider-status'
import { useTerminalPanelStore } from '@/stores/terminal-panel-store'

export { AGENT_PROVIDER_STATUS_QUERY_KEY }

/**
 * Quote one argv token for `bash -lc`. Single-quote form so spaces/meta stay literal.
 */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * Run a oneshot login CLI inside a login shell that stays open afterwards.
 * Without this, the PTY exits immediately (many auth CLIs only open a browser),
 * the client auto-reconnects a fresh shell, and clearTerminalBuffer wipes the
 * login output — UI looks like Terminal "flashed then vanished".
 */
export function wrapLoginKeepaliveCommand(argv: Array<string>): Array<string> {
  const quoted = argv.map(shellQuote).join(' ')
  return [
    'bash',
    '-lc',
    `${quoted}; ec=$?; echo; printf '\\n[login finished — exit %s; shell stays open]\\n' "$ec"; exec bash -l`,
  ]
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const body: unknown = JSON.parse(text)
    if (body && typeof body === 'object' && 'error' in body) {
      const detail = (body as { error?: unknown }).error
      if (typeof detail === 'string' && detail.trim()) return detail.trim()
    }
  } catch {
    // Fall through to the generic sanitizer for non-JSON bodies.
  }
  return sanitizeHttpErrorText(text, fallback)
}

async function fetchProviderStatus(options?: {
  refresh?: boolean
}): Promise<AgentProviderStatusListDto> {
  const url = options?.refresh
    ? '/api/agent-runtime/status?refresh=1'
    : '/api/agent-runtime/status'
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to load agent runtime status (${response.status})`,
      ),
    )
  }
  return (await response.json()) as AgentProviderStatusListDto
}

async function installProvider(input: {
  provider: AgentProviderId | 'hermes'
  version?: string
}): Promise<AgentProviderInstallResultDto> {
  const response = await fetch('/api/agent-runtime/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      input.version
        ? { provider: input.provider, version: input.version }
        : { provider: input.provider },
    ),
  })
  if (response.status === 409) {
    // Daemon already has an install lock — not a user-facing failure. UI stays
    // in "安装中" via installInProgress from the status poll.
    return { provider: input.provider, status: 'in_progress' }
  }
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to install ${input.provider} (${response.status})`,
      ),
    )
  }
  return (await response.json()) as AgentProviderInstallResultDto
}

async function setProviderEnabled(input: {
  provider: AgentProviderId
  enabled: boolean
}): Promise<{ provider: string; enabled: boolean }> {
  const response = await fetch('/api/agent-runtime/enable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to update ${input.provider} (${response.status})`,
      ),
    )
  }
  return (await response.json()) as { provider: string; enabled: boolean }
}

async function loginProvider(input: {
  provider: AgentProviderId
}): Promise<AgentProviderLoginResultDto> {
  const response = await fetch('/api/agent-runtime/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, preferWebTerminal: true }),
  })
  if (response.status === 409) {
    return { provider: input.provider, status: 'in_progress' }
  }
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to start login for ${input.provider} (${response.status})`,
      ),
    )
  }
  return (await response.json()) as AgentProviderLoginResultDto
}

async function restartManagedAgentDaemon(): Promise<{
  ok: boolean
  healthy: boolean
  detail?: string
}> {
  const response = await fetch('/api/agent-runtime/daemon/restart', {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to restart Managed Agent daemon (${response.status})`,
      ),
    )
  }
  return (await response.json()) as {
    ok: boolean
    healthy: boolean
    detail?: string
  }
}

type UseAgentProviderStatusOptions = {
  /** Disable periodic polling when the user turns off auto-check. */
  refetchInterval?: number | false
}

/**
 * Provider readiness aggregate (daemon + local Hermes tips). Does **not**
 * git-fetch — product update checks go through
 * {@link refreshProductUpdateStatus} / `/api/update/status` only.
 */
export function useAgentProviderStatus(
  options?: UseAgentProviderStatusOptions,
) {
  return useQuery({
    queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
    queryFn: () => fetchProviderStatus(),
    retry: false,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      if (options?.refetchInterval === false) return false
      const providers = query.state.data?.providers ?? []
      if (
        providers.some(
          (entry) => entry.installInProgress || entry.loginInProgress,
        )
      ) {
        return 2_000
      }
      // No daily git-fetch poll here — install/login progress only.
      // Product updates: UpdateCenterNotifier + Runtimes「检查更新」.
      return false
    },
  })
}

/**
 * Full re-detect: bypasses daemon readiness cache + react-query staleTime so
 * Runtimes「重新检测」re-resolves CLIs (install/auth/version) from disk.
 */
export async function redetectAgentProviderStatus(
  queryClient: QueryClient,
): Promise<AgentProviderStatusListDto> {
  const data = await fetchProviderStatus({ refresh: true })
  queryClient.setQueryData(AGENT_PROVIDER_STATUS_QUERY_KEY, data)
  return data
}

/** Force-restart the local Agorax managed-agent daemon and refresh status. */
export function useRestartManagedAgentDaemon() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: restartManagedAgentDaemon,
    onSuccess: async () => {
      toast('Agorax daemon 已重启')
      await redetectAgentProviderStatus(queryClient)
    },
    onError: (error) => {
      toast(
        error instanceof Error ? error.message : 'Agorax daemon 重启失败',
      )
    },
  })
}

/** Installs/upgrades one provider runtime and refreshes the status poll. */
export function useInstallAgentProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: installProvider,
    onSuccess: (result, input) => {
      if (result.status === 'in_progress') {
        // Refresh once so installInProgress is visible — not a wizard redetect.
        void queryClient.invalidateQueries({
          queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
        })
        return
      }
      toast(
        result.status === 'already'
          ? `${input.provider} is already up to date`
          : `Installed ${input.provider}${result.version ? ` ${result.version}` : ''}`,
      )
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Install failed')
    },
    onSettled: () => {
      // Silent status refresh after install finishes (update installed/auth).
      // Env wizard only shows "detect" on open / explicit 重新检测.
      void queryClient.invalidateQueries({
        queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
      })
    },
  })
}

/** Enables/disables one provider runtime and refreshes the status poll. */
export function useSetAgentProviderEnabled() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: setProviderEnabled,
    onSuccess: (_, input) => {
      toast(`${input.enabled ? 'Enabled' : 'Disabled'} ${input.provider}`)
      void queryClient.invalidateQueries({
        queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
      })
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Update failed')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
      })
    },
  })
}

/** Launches interactive provider login via the managed daemon. */
export function useLoginAgentProvider() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: loginProvider,
    onSuccess: (result, input) => {
      void queryClient.invalidateQueries({
        queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
      })
      if (result.status === 'already') {
        toast(`${input.provider} 已登录`)
        return
      }
      if (result.status === 'in_progress') {
        toast(`${input.provider} 登录进行中…`, { type: 'info' })
        return
      }
      const argv =
        Array.isArray(result.command) && result.command.length > 0
          ? result.command
          : null
      if (argv) {
        const store = useTerminalPanelStore.getState()
        // Fullscreen `/terminal` owns the login PTY. Do not open the chat
        // bottom panel — that mounts a second TerminalWorkspace which races
        // for pendingCommand, then clears the buffer on oneshot exit.
        store.setPanelOpen(false)
        store.createTab('~', {
          title: `${input.provider} 登录`,
          command: wrapLoginKeepaliveCommand(argv),
          openPanel: false,
        })
        void navigate({ to: '/terminal' })
        toast(`已在 Agorax 终端打开 ${input.provider} 登录，请在终端内完成授权`, {
          type: 'info',
          duration: 8000,
        })
        return
      }
      toast(
        result.mode === 'terminal'
          ? `已打开终端，请完成 ${input.provider} 登录`
          : `已启动 ${input.provider} 登录，请在浏览器/弹出窗口中完成授权`,
        { type: 'info', duration: 8000 },
      )
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Login failed', {
        type: 'error',
      })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
      })
    },
  })
}
