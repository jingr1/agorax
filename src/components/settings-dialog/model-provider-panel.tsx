'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import { Button } from '@/components/ui/button'
import { ProviderLogo } from '@/components/provider-logo'
import { CodexLoginModal } from '@/components/settings-dialog/codex-login-modal'
import { AnthropicLoginModal } from '@/components/settings-dialog/anthropic-login-modal'
import { cn } from '@/lib/utils'

export const PROVIDER_CARDS: Array<{
  id: string
  name: string
  logo: string
  models: Array<string>
  authType: 'oauth' | 'api_key' | 'none'
  envKey?: string
}> = [
  {
    id: 'ollama',
    name: 'Ollama',
    logo: '/providers/ollama.png',
    models: ['llama3.1:70b', 'qwen3:32b', 'deepseek-r1:32b'],
    authType: 'none',
  },
  {
    id: 'atomic-chat',
    name: 'Atomic Chat',
    logo: '/providers/atomic-chat.png',
    models: ['llama-3.2-3b', 'qwen2.5-7b', 'gemma-3-4b'],
    authType: 'none',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    logo: '/providers/anthropic.png',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-3-5'],
    authType: 'api_key',
    envKey: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    logo: '/providers/deepseek.png',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    authType: 'api_key',
    envKey: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'nous',
    name: 'Nous Portal',
    logo: '/providers/nous.png',
    models: [
      'xiaomi/mimo-v2-pro',
      'xiaomi/mimo-v2-omni',
      'claude-3-llama-3.1-405b',
      'claude-3-llama-3.1-70b',
    ],
    authType: 'oauth',
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    logo: '/providers/openai.png',
    models: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-4o'],
    authType: 'oauth',
  },
  {
    id: 'claude-oauth',
    name: 'Claude (OAuth)',
    logo: '/providers/anthropic.png',
    models: ['claude-sonnet-4-6', 'claude-opus-5', 'claude-haiku-3.5'],
    authType: 'oauth',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    logo: '/providers/openrouter.png',
    models: ['auto', 'deepseek/deepseek-r1', 'google/gemini-2.5-pro'],
    authType: 'api_key',
    envKey: 'OPENROUTER_API_KEY',
  },
  {
    id: 'zai',
    name: 'Z.AI / GLM',
    logo: '/providers/zhipu.png',
    models: ['glm-4-plus', 'glm-4-air'],
    authType: 'api_key',
    envKey: 'GLM_API_KEY',
  },
  {
    id: 'kimi-coding',
    name: 'Kimi',
    logo: '/providers/kimi.png',
    models: ['kimi-latest', 'moonshot-v1-128k'],
    authType: 'api_key',
    envKey: 'KIMI_API_KEY',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    logo: '/providers/minimax.png',
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-Lightning'],
    authType: 'api_key',
    envKey: 'MINIMAX_API_KEY',
  },
  {
    id: 'xiaomi',
    name: 'Xiaomi MiMo',
    logo: '/providers/xiaomi.png',
    models: ['mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2-flash'],
    authType: 'api_key',
    envKey: 'XIAOMI_API_KEY',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    logo: '/providers/nvidia.png',
    models: [
      'nvidia/nemotron-3-super-120b-a12b',
      'nvidia/llama-3.3-nemotron-super-49b-v1',
    ],
    authType: 'api_key',
    envKey: 'NVIDIA_API_KEY',
  },
]

export type ExtraCatalogProvider = {
  id: string
  name: string
  base_url?: string
  key_env?: string
  models?: Array<string>
  keyConfigured?: boolean
  maskedKey?: string
}

export type ProviderCard = (typeof PROVIDER_CARDS)[number] & {
  source?: 'builtin' | 'catalog'
  baseUrl?: string
  keyConfigured?: boolean
}

export function mergeProviderCards(
  extra: Array<ExtraCatalogProvider> = [],
): Array<ProviderCard> {
  const builtin: Array<ProviderCard> = PROVIDER_CARDS.map((card) => ({
    ...card,
    source: 'builtin',
  }))
  const builtinIds = new Set(builtin.map((card) => card.id))
  const extras: Array<ProviderCard> = extra.flatMap((entry) => {
    const id = entry.id.trim()
    if (!id || builtinIds.has(id) || id === 'manifest') return []
    return [
      {
        id,
        name: entry.name || id,
        logo: '',
        models: entry.models || [],
        authType: 'api_key' as const,
        envKey: entry.key_env || undefined,
        source: 'catalog' as const,
        baseUrl: entry.base_url,
        keyConfigured: entry.keyConfigured,
      },
    ]
  })
  return [...builtin, ...extras]
}

export function isProviderKeyConfigured(
  card: Pick<ProviderCard, 'envKey' | 'keyConfigured'>,
  configuredKeys: Record<string, string>,
): boolean {
  if (card.keyConfigured) return true
  const keyEnv = card.envKey?.trim()
  if (!keyEnv) return false
  return Boolean(configuredKeys[keyEnv])
}

export function getProviderCardStatus(
  card: Pick<
    ProviderCard,
    'id' | 'source' | 'authType' | 'envKey' | 'keyConfigured' | 'baseUrl'
  >,
  configuredKeys: Record<string, string>,
  localOnline = false,
): { label: string; verified: boolean; hasKey: boolean } {
  if (card.authType === 'oauth') {
    const oauthKey = configuredKeys[`__oauth:${card.id}`]
    if (oauthKey) {
      return { label: 'Connected', verified: true, hasKey: true }
    }
    return { label: 'OAuth', verified: false, hasKey: false }
  }
  if (card.authType === 'none') {
    return {
      label: localOnline ? '🟢 Detected' : 'Local',
      verified: localOnline,
      hasKey: localOnline,
    }
  }
  if (card.source === 'catalog') {
    const keyConfigured = isProviderKeyConfigured(card, configuredKeys)
    return {
      label: keyConfigured ? 'Key set' : card.baseUrl ? 'Configured' : 'Added',
      verified: keyConfigured || Boolean(card.baseUrl),
      hasKey: keyConfigured,
    }
  }
  const keyConfigured = isProviderKeyConfigured(card, configuredKeys)
  return {
    label: keyConfigured ? 'Key set' : 'Key required',
    verified: keyConfigured,
    hasKey: keyConfigured,
  }
}

export type ProviderClickAction = 'select' | 'oauth' | 'local' | 'ignore'

export function getProviderClickAction(input: {
  providerId?: string
  authType: 'oauth' | 'api_key' | 'none'
  hasKey: boolean
}): ProviderClickAction {
  if (input.authType === 'oauth') return 'oauth'
  if (input.authType === 'none') return 'local'
  return input.hasKey ? 'select' : 'ignore'
}

const LOCAL_PROVIDER_SETUP: Partial<
  Record<string, { baseUrl: string; unavailableMessage: string }>
> = {
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    unavailableMessage:
      'No Ollama endpoint detected at http://127.0.0.1:11434/v1.',
  },
  'atomic-chat': {
    baseUrl: 'http://127.0.0.1:1337/v1',
    unavailableMessage:
      'No Atomic Chat endpoint detected at http://127.0.0.1:1337/v1.',
  },
}

export type OAuthStatus = 'idle' | 'starting' | 'pending' | 'success' | 'error'

const DEFAULT_OAUTH_EXPIRES_SECONDS = 600
const DEFAULT_OAUTH_POLL_INTERVAL_SECONDS = 3

export function getOAuthStartButtonLabel(status: OAuthStatus): string {
  return status === 'starting' || status === 'pending'
    ? 'Waiting...'
    : 'Start OAuth'
}

type OAuthDeviceCodeResponse = {
  device_code?: string
  user_code?: string
  verification_uri_complete?: string
  interval?: number
  expires_in?: number
  error?: string
}

type OAuthPollResponse = {
  status?: string
  message?: string
}

export type ModelProviderPanelProps = {
  initialProvider?: string
  initialModel?: string
  banner?: string
  configPathLabel?: string
  showApiKeys?: boolean
  confirmLabel?: string
  configureOnly?: boolean
  extraProviders?: Array<ExtraCatalogProvider>
  onSaveExtraProvider?: (
    id: string,
    patch: {
      name?: string
      base_url?: string
      key_env?: string
      key_value?: string
      models?: Array<string>
    },
  ) => Promise<string | void>
  onSaveBuiltinKey?: (
    providerId: string,
    keyEnv: string,
    value: string,
  ) => Promise<string | void>
  onRemoveProvider?: (providerId: string) => Promise<string | void>
  onSetDefault?: (providerId: string, modelId: string) => Promise<string | void>
}

export function ModelProviderPanel({
  initialProvider = '',
  initialModel = '',
  banner,
  configPathLabel = '~/.hermes/config.yaml',
  showApiKeys = false,
  confirmLabel = 'Set as default',
  configureOnly = false,
  extraProviders = [],
  onSaveExtraProvider,
  onSaveBuiltinKey,
  onRemoveProvider,
  onSetDefault,
}: ModelProviderPanelProps) {
  const [activeProvider, setActiveProvider] = useState(initialProvider)
  const [activeModel, setActiveModel] = useState(initialModel)
  const [defaultProvider, setDefaultProvider] = useState(initialProvider)
  const [defaultModelId, setDefaultModelId] = useState(initialModel)
  const [availableModels, setAvailableModels] = useState<Array<string>>([])
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [configuredKeys, setConfiguredKeys] = useState<Record<string, string>>(
    {},
  )
  const [oauthProviderId, setOauthProviderId] = useState<string | null>(null)
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus>('idle')
  const [oauthMessage, setOauthMessage] = useState('')
  const [oauthUserCode, setOauthUserCode] = useState('')
  const [oauthVerificationUri, setOauthVerificationUri] = useState('')
  const oauthAbortRef = useRef<AbortController | null>(null)
  const [localProviderId, setLocalProviderId] = useState<string | null>(null)
  const [localDiscovery, setLocalDiscovery] = useState<{
    providers: Array<{
      id: string
      name: string
      online: boolean
      modelCount: number
      configured: boolean
      needsRestart: boolean
    }>
    models: Array<{ id: string; name: string; provider: string }>
  } | null>(null)

  const cards = useMemo(
    () => mergeProviderCards(extraProviders),
    [extraProviders],
  )
  const [extraDraft, setExtraDraft] = useState({
    base_url: '',
    key_env: '',
    key_value: '',
    models: [] as Array<string>,
  })
  const [newModelInput, setNewModelInput] = useState('')
  const [builtinKeyValue, setBuiltinKeyValue] = useState('')

  const activeCard = cards.find((card) => card.id === activeProvider)

  const fetchModelsForProvider = useCallback(
    (providerId: string) => {
      if (localDiscovery) {
        const discovered = localDiscovery.models
          .filter((m) => m.provider === providerId)
          .map((m) => m.id)
        if (discovered.length > 0) {
          setAvailableModels(discovered)
          return
        }
      }
      const card = mergeProviderCards(extraProviders).find(
        (p) => p.id === providerId,
      )
      const fallbackModels = card?.models || []

      const tryModelsEndpoint = () => {
        fetch('/api/models')
          .then((r) => r.json())
          .then((d: { models?: Array<{ id: string; provider?: string }> }) => {
            const all = d.models || []
            const filtered = all
              .filter((m) => m.provider === providerId)
              .map((m) => m.id)
            setAvailableModels(filtered.length > 0 ? filtered : fallbackModels)
          })
          .catch(() => setAvailableModels(fallbackModels))
      }

      fetch(
        `/api/hermes-proxy/api/available-models?provider=${encodeURIComponent(providerId)}`,
      )
        .then((r) => r.json())
        .then((d: { models?: Array<{ id: string }> }) => {
          const models = (d.models || []).map((m) => m.id)
          if (models.length > 0) {
            setAvailableModels(models)
          } else {
            tryModelsEndpoint()
          }
        })
        .catch(() => tryModelsEndpoint())
    },
    [extraProviders, localDiscovery],
  )

  useEffect(() => {
    setActiveProvider(initialProvider)
    setActiveModel(initialModel)
    setDefaultProvider(initialProvider)
    setDefaultModelId(initialModel)
    if (initialProvider) fetchModelsForProvider(initialProvider)
  }, [fetchModelsForProvider, initialModel, initialProvider])

  useEffect(() => {
    const extra = extraProviders.find((entry) => entry.id === activeProvider)
    if (!extra) return
    setExtraDraft({
      base_url: extra.base_url || '',
      key_env: extra.key_env || '',
      key_value: '',
      models: [...(extra.models || [])],
    })
    setNewModelInput('')
  }, [activeProvider, extraProviders])

  useEffect(() => {
    fetch('/api/local-providers')
      .then((r) => r.json())
      .then((d: { ok?: boolean } & Record<string, unknown>) => {
        if (d.ok) setLocalDiscovery(d as typeof localDiscovery)
      })
      .catch(() => {})
  }, [])

  const refreshKeys = async () => {
    const ref = await fetch('/api/hermes-config')
    const d = await ref.json()
    const providers = Array.isArray(d.providers) ? d.providers : []
    const keys: Record<string, string> = {}
    for (const p of providers) {
      const envKey = p.envKeys?.[0]
      if (p.configured && envKey) {
        keys[envKey] = p.maskedCredentials?.[envKey] || '••••'
      }
      if (
        p.kind === 'oauth' &&
        p.authenticated &&
        p.maskedCredentials?.['auth-profiles']
      ) {
        keys[`__oauth:${p.id}`] = p.maskedCredentials['auth-profiles']
      }
    }
    setConfiguredKeys(keys)
  }

  useEffect(() => {
    void refreshKeys().catch(() => {})
  }, [])

  useEffect(() => {
    setConfiguredKeys((prev) => {
      const next = { ...prev }
      for (const provider of extraProviders) {
        if (!provider.key_env) continue
        if (provider.keyConfigured) {
          next[provider.key_env] = provider.maskedKey || '••••'
        } else {
          delete next[provider.key_env]
        }
      }
      return next
    })
  }, [extraProviders])

  const saveGlobal = async (
    updates:
      | { config?: Record<string, unknown>; env?: Record<string, string> }
      | { action: string; [key: string]: unknown },
  ) => {
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch('/api/hermes-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      const r = (await res.json()) as { message?: string }
      setMsg(r.message || 'Saved')
      await refreshKeys()
      setTimeout(() => setMsg(null), 3000)
    } catch {
      setMsg('Failed to save')
    }
    setSaving(false)
  }

  const setDefaultModel = async (providerId: string, modelId: string) => {
    if (!onSetDefault) return
    setSaving(true)
    setMsg(null)
    try {
      const message = await onSetDefault(providerId, modelId)
      setDefaultProvider(providerId)
      setDefaultModelId(modelId)
      setActiveProvider(providerId)
      setActiveModel(modelId)
      setMsg(message || 'Default model updated.')
      setTimeout(() => setMsg(null), 3000)
    } catch {
      setMsg('Failed to save')
    }
    setSaving(false)
  }

  const addCatalogModel = () => {
    const model = newModelInput.trim()
    if (!model) return
    setExtraDraft((prev) => ({
      ...prev,
      models: prev.models.includes(model)
        ? prev.models
        : [...prev.models, model],
    }))
    setNewModelInput('')
  }

  const selectProvider = (providerId: string, model?: string) => {
    setOauthProviderId(null)
    setLocalProviderId(null)
    if (providerId !== activeProvider) setActiveModel('')
    setActiveProvider(providerId)
    if (model) setActiveModel(model)
    else fetchModelsForProvider(providerId)
  }

  const clearProviderPreview = () => {
    setActiveProvider('')
    setActiveModel('')
    setAvailableModels([])
  }

  const abortOAuth = () => {
    oauthAbortRef.current?.abort()
    oauthAbortRef.current = null
  }

  const resetOAuthState = (providerId: string) => {
    abortOAuth()
    setOauthProviderId(providerId)
    setLocalProviderId(null)
    clearProviderPreview()
    setOauthStatus('idle')
    setOauthMessage('')
    setOauthUserCode('')
    setOauthVerificationUri('')
    setMsg(null)
  }

  const showLocalProviderSetup = (providerId: string) => {
    abortOAuth()
    setOauthProviderId(null)
    setLocalProviderId(providerId)
    clearProviderPreview()
    setMsg(null)
  }

  useEffect(() => {
    return () => abortOAuth()
  }, [])

  const sleepUnlessAborted = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })

  const [showCodexModal, setShowCodexModal] = useState(false)
  const [showAnthropicModal, setShowAnthropicModal] = useState(false)

  const startOAuthFlow = async () => {
    const provider = cards.find((p) => p.id === oauthProviderId)
    if (!provider) return

    abortOAuth()
    const controller = new AbortController()
    oauthAbortRef.current = controller
    const { signal } = controller

    setOauthStatus('starting')
    setOauthMessage(`Starting ${provider.name} OAuth...`)
    setOauthUserCode('')
    setOauthVerificationUri('')

    try {
      const codeRes = await fetch('/api/oauth/device-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: provider.id }),
        signal,
      })
      const codeData = (await codeRes.json()) as OAuthDeviceCodeResponse
      if (!codeRes.ok || codeData.error || !codeData.device_code) {
        throw new Error(codeData.error || 'Could not start OAuth device flow')
      }

      const verificationUri = codeData.verification_uri_complete || ''
      setOauthStatus('pending')
      setOauthUserCode(codeData.user_code || '')
      setOauthVerificationUri(verificationUri)
      setOauthMessage(
        verificationUri
          ? `Authorize ${provider.name} in the browser, then return here.`
          : `Enter the user code to authorize ${provider.name}.`,
      )

      if (verificationUri) {
        window.open(verificationUri, '_blank', 'noopener,noreferrer')
      }

      const expiresInSeconds =
        codeData.expires_in || DEFAULT_OAUTH_EXPIRES_SECONDS
      const intervalSeconds = Math.max(
        1,
        codeData.interval || DEFAULT_OAUTH_POLL_INTERVAL_SECONDS,
      )
      const deadline = Date.now() + expiresInSeconds * 1000
      const intervalMs = intervalSeconds * 1000

      while (Date.now() < deadline) {
        await sleepUnlessAborted(intervalMs, signal)
        const pollRes = await fetch('/api/oauth/poll-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: provider.id,
            deviceCode: codeData.device_code,
          }),
          signal,
        })
        const pollData = (await pollRes.json()) as OAuthPollResponse
        if (pollData.status === 'pending') continue
        if (pollData.status === 'success') {
          setOauthStatus('success')
          setOauthMessage(
            `${provider.name} OAuth is connected. TUI and WebUI will use the shared Hermes credentials.`,
          )
          await refreshKeys()
          return
        }
        throw new Error(pollData.message || 'OAuth authorization failed')
      }

      throw new Error('OAuth authorization timed out')
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return
      setOauthStatus('error')
      setOauthMessage(
        error instanceof Error ? error.message : 'OAuth authorization failed',
      )
    } finally {
      if (oauthAbortRef.current === controller) {
        oauthAbortRef.current = null
      }
    }
  }

  const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--theme-card)',
    border: '1px solid var(--theme-border)',
    color: 'var(--theme-text)',
  }
  const mutedStyle: React.CSSProperties = { color: 'var(--theme-muted)' }

  return (
    <div className="space-y-5">
      {banner ? (
        <div className="rounded-lg border border-primary-200 bg-primary-50/80 px-3 py-2 text-xs text-primary-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
          {banner}
        </div>
      ) : null}
      {msg && (
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-sm font-medium',
            msg.includes('Failed')
              ? 'bg-red-500/15 text-red-400'
              : 'bg-green-500/15 text-green-400',
          )}
        >
          {msg}
        </div>
      )}

      <div>
        <p
          className="mb-1 text-xs font-semibold uppercase tracking-wider"
          style={mutedStyle}
        >
          Provider
        </p>
        <p className="mb-3 text-[11px]" style={mutedStyle}>
          {configureOnly
            ? 'Configure URL, keys, and OAuth for each provider. Settings are copied into every profile.'
            : 'Select your AI provider. OAuth providers authenticate via browser.'}
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {cards.map((p) => {
            const isActive =
              (oauthProviderId || localProviderId || activeProvider) === p.id
            const localOnline =
              localDiscovery?.providers.find((lp) => lp.id === p.id)?.online ===
              true
            const status = getProviderCardStatus(p, configuredKeys, localOnline)
            const { label, verified, hasKey } = status
            const missingKey =
              !configureOnly &&
              p.authType === 'api_key' &&
              !verified &&
              p.source !== 'catalog'
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  if (p.id === 'openai-codex') {
                    setShowCodexModal(true)
                    return
                  }
                  if (p.id === 'claude-oauth') {
                    setShowAnthropicModal(true)
                    return
                  }
                  if (configureOnly && p.authType === 'api_key' && p.envKey) {
                    selectProvider(p.id)
                    setBuiltinKeyValue('')
                    return
                  }
                  if (p.source === 'catalog') {
                    selectProvider(p.id)
                    return
                  }
                  const action = getProviderClickAction({
                    providerId: p.id,
                    authType: p.authType,
                    hasKey,
                  })
                  if (action === 'oauth') {
                    if (p.id === 'openai-codex') {
                      setShowCodexModal(true)
                      return
                    }
                    if (p.id === 'claude-oauth') {
                      setShowAnthropicModal(true)
                      return
                    }
                    resetOAuthState(p.id)
                    return
                  }
                  if (action === 'local') {
                    showLocalProviderSetup(p.id)
                    return
                  }
                  if (action === 'select') selectProvider(p.id)
                }}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-xl px-3 py-2.5 text-left transition-all',
                  isActive
                    ? 'ring-2 ring-accent-500 shadow-md'
                    : 'hover:brightness-110',
                  missingKey && 'opacity-60',
                )}
                style={cardStyle}
              >
                <div className="flex w-full items-center justify-between">
                  <ProviderLogo provider={p.id} size={32} />
                  {isActive ? (
                    <span className="size-2 rounded-full bg-green-500" />
                  ) : missingKey ? (
                    <span className="size-2 rounded-full bg-red-500/60" />
                  ) : verified ? (
                    <span className="size-2 rounded-full bg-green-500/40" />
                  ) : null}
                </div>
                <span className="mt-1 text-xs font-semibold">{p.name}</span>
                <span className="text-[9px]" style={mutedStyle}>
                  {label}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {configureOnly &&
      onSaveBuiltinKey &&
      activeCard?.source === 'builtin' &&
      activeCard.authType === 'api_key' &&
      activeCard.envKey ? (
        <div className="space-y-2 rounded-xl px-3 py-2.5" style={cardStyle}>
          <p className="text-sm font-semibold">{activeCard.name}</p>
          <label className="block space-y-1">
            <span className="text-xs font-medium" style={mutedStyle}>
              key_env
            </span>
            <input
              value={activeCard.envKey}
              readOnly
              className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 font-mono text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium" style={mutedStyle}>
              Secret value
            </span>
            <input
              type="password"
              value={builtinKeyValue}
              onChange={(event) => setBuiltinKeyValue(event.target.value)}
              placeholder={
                isProviderKeyConfigured(activeCard, configuredKeys)
                  ? 'Leave blank to keep'
                  : 'Paste API key'
              }
              className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 font-mono text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </label>
          <div className="flex justify-end gap-2">
            {onRemoveProvider ? (
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  void (async () => {
                    setSaving(true)
                    try {
                      const message = await onRemoveProvider(activeProvider)
                      setMsg(message || 'Provider cleared')
                      setBuiltinKeyValue('')
                      if (activeCard.envKey) {
                        setConfiguredKeys((prev) => {
                          const next = { ...prev }
                          delete next[activeCard.envKey!]
                          return next
                        })
                      }
                      await refreshKeys()
                      window.setTimeout(() => setMsg(null), 3000)
                    } catch {
                      setMsg('Failed to remove')
                    }
                    setSaving(false)
                  })()
                }}
              >
                Remove provider
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={saving || !builtinKeyValue.trim()}
              onClick={() => {
                void (async () => {
                  setSaving(true)
                  try {
                    const message = await onSaveBuiltinKey(
                      activeProvider,
                      activeCard.envKey!,
                      builtinKeyValue,
                    )
                    setMsg(message || 'Key saved')
                    setBuiltinKeyValue('')
                    await refreshKeys()
                    window.setTimeout(() => setMsg(null), 3000)
                  } catch {
                    setMsg('Failed to save')
                  }
                  setSaving(false)
                })()
              }}
            >
              Save key
            </Button>
          </div>
        </div>
      ) : null}

      {onSaveExtraProvider && activeCard?.source === 'catalog' ? (
        <div className="space-y-2 rounded-xl px-3 py-2.5" style={cardStyle}>
          <p className="text-sm font-semibold">
            {activeCard?.name || activeProvider}
          </p>
          {(() => {
            const catalogKeyEnv = extraDraft.key_env || activeCard?.envKey || ''
            const catalogKeyConfigured = isProviderKeyConfigured(
              {
                envKey: catalogKeyEnv,
                keyConfigured: activeCard?.keyConfigured,
              },
              configuredKeys,
            )
            return (
              <>
                <label className="block space-y-1">
                  <span className="text-xs font-medium" style={mutedStyle}>
                    Base URL
                  </span>
                  <input
                    value={extraDraft.base_url}
                    onChange={(event) =>
                      setExtraDraft((prev) => ({
                        ...prev,
                        base_url: event.target.value,
                      }))
                    }
                    placeholder="https://host/v1"
                    className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 font-mono text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                  />
                </label>
                <div className="grid gap-2 md:grid-cols-2">
                  <input
                    value={extraDraft.key_env}
                    onChange={(event) =>
                      setExtraDraft((prev) => ({
                        ...prev,
                        key_env: event.target.value,
                      }))
                    }
                    placeholder="key_env (optional)"
                    className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 font-mono text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                  />
                  <input
                    type="password"
                    value={extraDraft.key_value}
                    onChange={(event) =>
                      setExtraDraft((prev) => ({
                        ...prev,
                        key_value: event.target.value,
                      }))
                    }
                    placeholder={
                      catalogKeyConfigured
                        ? 'Leave blank to keep'
                        : 'Paste API key'
                    }
                    className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 font-mono text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                  />
                </div>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium" style={mutedStyle}>
                    Models
                  </span>
                  {extraDraft.models.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {extraDraft.models.map((model) => (
                        <span
                          key={model}
                          className="inline-flex items-center gap-1 rounded-md border border-primary-200 bg-primary-50 px-2 py-1 font-mono text-xs text-primary-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                        >
                          {model}
                          <button
                            type="button"
                            aria-label={`Remove ${model}`}
                            className="text-primary-500 hover:text-red-500 dark:text-neutral-400"
                            onClick={() =>
                              setExtraDraft((prev) => ({
                                ...prev,
                                models: prev.models.filter(
                                  (entry) => entry !== model,
                                ),
                              }))
                            }
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs" style={mutedStyle}>
                      No models yet. Add model ids used by this gateway.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <input
                      value={newModelInput}
                      onChange={(event) => setNewModelInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          addCatalogModel()
                        }
                      }}
                      placeholder="e.g. Kimi-K2.7-Code"
                      className="h-9 min-w-0 flex-1 rounded-lg border border-primary-200 bg-primary-50 px-3 font-mono text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!newModelInput.trim()}
                      onClick={addCatalogModel}
                    >
                      Add model
                    </Button>
                  </div>
                </label>
              </>
            )
          })()}
          <div className="flex justify-end gap-2">
            {onRemoveProvider ? (
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  void (async () => {
                    setSaving(true)
                    try {
                      const message = await onRemoveProvider(activeProvider)
                      setMsg(message || 'Provider removed')
                      setActiveProvider('')
                      setExtraDraft({
                        base_url: '',
                        key_env: '',
                        key_value: '',
                        models: [],
                      })
                      setNewModelInput('')
                      await refreshKeys()
                      window.setTimeout(() => setMsg(null), 3000)
                    } catch {
                      setMsg('Failed to remove')
                    }
                    setSaving(false)
                  })()
                }}
              >
                Remove provider
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={saving}
              onClick={() => {
                void (async () => {
                  setSaving(true)
                  try {
                    const message = await onSaveExtraProvider(
                      activeProvider,
                      extraDraft,
                    )
                    setMsg(message || 'Provider saved')
                    setExtraDraft((prev) => ({ ...prev, key_value: '' }))
                    window.setTimeout(() => setMsg(null), 3000)
                  } catch {
                    setMsg('Failed to save')
                  }
                  setSaving(false)
                })()
              }}
            >
              Save provider
            </Button>
          </div>
        </div>
      ) : null}

      {oauthProviderId ? (
        <div className="rounded-xl px-3 py-2.5" style={cardStyle}>
          {(() => {
            const provider = cards.find((p) => p.id === oauthProviderId)
            if (!provider) return null
            return (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-semibold">{provider.name} OAuth</p>
                  <Button
                    size="sm"
                    disabled={
                      oauthStatus === 'starting' || oauthStatus === 'pending'
                    }
                    onClick={() => {
                      void startOAuthFlow()
                    }}
                  >
                    {getOAuthStartButtonLabel(oauthStatus)}
                  </Button>
                </div>
                <div className="rounded-lg border border-primary-200 bg-primary-50/80 px-3 py-2 text-xs text-primary-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
                  {oauthMessage || 'Start the browser-based OAuth flow.'}
                  {oauthUserCode ? (
                    <div className="mt-2">
                      User code:{' '}
                      <code className="rounded bg-black/10 px-1 py-0.5 font-mono dark:bg-white/10">
                        {oauthUserCode}
                      </code>
                    </div>
                  ) : null}
                  {oauthVerificationUri ? (
                    <a
                      href={oauthVerificationUri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-block font-medium underline underline-offset-2"
                    >
                      Open authorization page
                    </a>
                  ) : null}
                </div>
              </div>
            )
          })()}
        </div>
      ) : null}

      {localProviderId ? (
        <div className="rounded-xl px-3 py-2.5" style={cardStyle}>
          {(() => {
            const provider = cards.find((p) => p.id === localProviderId)
            if (!provider) return null
            const disc = localDiscovery?.providers.find(
              (lp) => lp.id === provider.id,
            )
            const models =
              localDiscovery?.models.filter(
                (m) => m.provider === provider.id,
              ) || []
            const setup = LOCAL_PROVIDER_SETUP[provider.id] || {
              baseUrl: 'local OpenAI-compatible endpoint',
              unavailableMessage: 'No local endpoint detected.',
            }
            return (
              <div className="space-y-3">
                <p className="text-sm font-semibold">{provider.name}</p>
                <div className="rounded-lg border border-primary-200 bg-primary-50/80 px-3 py-2 text-xs text-primary-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
                  {disc?.online ? (
                    <>
                      Detected {disc.modelCount} model
                      {disc.modelCount === 1 ? '' : 's'} at{' '}
                      <code className="rounded bg-black/10 px-1 py-0.5 font-mono dark:bg-white/10">
                        {setup.baseUrl}
                      </code>
                      .
                    </>
                  ) : (
                    setup.unavailableMessage
                  )}
                </div>
                {models.length > 0 ? (
                  <div>
                    <p
                      className="mb-2 text-xs font-semibold uppercase tracking-wider"
                      style={mutedStyle}
                    >
                      Detected Models
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {models.map((model) => (
                        <button
                          key={model.id}
                          type="button"
                          aria-pressed={
                            activeProvider === provider.id &&
                            activeModel === model.id
                          }
                          onClick={() => {
                            setActiveProvider(provider.id)
                            setActiveModel(model.id)
                          }}
                          className={cn(
                            'rounded-lg px-3 py-1.5 text-xs font-medium transition-all hover:brightness-110',
                            activeProvider === provider.id &&
                              activeModel === model.id
                              ? 'ring-2 ring-accent-500'
                              : '',
                          )}
                          style={cardStyle}
                        >
                          {model.id}
                          {defaultProvider === provider.id &&
                          defaultModelId === model.id
                            ? ' · default'
                            : ''}
                        </button>
                      ))}
                    </div>
                    {activeProvider === provider.id &&
                    activeModel &&
                    !configureOnly &&
                    (defaultProvider !== provider.id ||
                      activeModel !== defaultModelId) ? (
                      <div className="mt-2">
                        <Button
                          size="sm"
                          disabled={saving}
                          onClick={() =>
                            void setDefaultModel(provider.id, activeModel)
                          }
                        >
                          {confirmLabel}: {provider.id} · {activeModel}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })()}
        </div>
      ) : null}

      {!configureOnly &&
      !oauthProviderId &&
      !localProviderId &&
      activeProvider ? (
        <div>
          <p
            className="mb-1 text-xs font-semibold uppercase tracking-wider"
            style={mutedStyle}
          >
            Model — pick one, then confirm below
          </p>
          <div className="flex flex-wrap gap-2">
            {(availableModels.length > 0
              ? availableModels
              : localDiscovery?.models
                  .filter((m) => m.provider === activeProvider)
                  .map((m) => m.id) ||
                cards.find((p) => p.id === activeProvider)?.models ||
                []
            ).map((model) => (
              <button
                key={model}
                type="button"
                aria-pressed={activeModel === model}
                onClick={() => setActiveModel(model)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs font-medium transition-all',
                  activeModel === model
                    ? 'ring-2 ring-accent-500'
                    : 'hover:brightness-110',
                  defaultProvider === activeProvider && defaultModelId === model
                    ? 'border border-accent-500/40'
                    : '',
                )}
                style={cardStyle}
              >
                {model}
                {defaultProvider === activeProvider && defaultModelId === model
                  ? ' · default'
                  : ''}
              </button>
            ))}
          </div>
          {activeModel &&
          (activeProvider !== defaultProvider ||
            activeModel !== defaultModelId) ? (
            <div className="mt-2">
              <Button
                size="sm"
                disabled={saving}
                onClick={() =>
                  void setDefaultModel(activeProvider, activeModel)
                }
              >
                {confirmLabel}: {activeProvider} · {activeModel}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {showApiKeys && !configureOnly ? (
        <div>
          <p
            className="mb-1 text-xs font-semibold uppercase tracking-wider"
            style={mutedStyle}
          >
            API Keys
          </p>
          <p className="mb-2 text-[11px]" style={mutedStyle}>
            API keys are global and stored in ~/.hermes/.env
          </p>
          <div className="space-y-1.5">
            {cards
              .filter((p) => p.envKey)
              .map((p) => {
                const key = p.envKey!
                const hasKey = !!configuredKeys[key]
                const isEditing = editingKey === key
                return (
                  <div
                    key={p.id}
                    className="flex items-center gap-3 rounded-xl px-3 py-2.5"
                    style={cardStyle}
                  >
                    <ProviderLogo
                      provider={p.id}
                      size={28}
                      className="rounded-md"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{p.name}</div>
                      <div className="text-[11px] font-mono" style={mutedStyle}>
                        {isEditing ? (
                          <input
                            type="password"
                            value={keyInput}
                            onChange={(e) => setKeyInput(e.target.value)}
                            placeholder={`Paste ${key}`}
                            className="w-full rounded border-0 bg-transparent py-0.5 text-[11px] outline-none"
                            style={{ color: 'var(--theme-text)' }}
                          />
                        ) : hasKey ? (
                          configuredKeys[key]
                        ) : (
                          'Not configured'
                        )}
                      </div>
                    </div>
                    {isEditing ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (keyInput)
                            void saveGlobal({ env: { [key]: keyInput } })
                          setEditingKey(null)
                          setKeyInput('')
                        }}
                        className="rounded-lg bg-accent-500 px-2 py-1 text-[11px] font-medium text-white"
                      >
                        Save
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingKey(key)
                          setKeyInput('')
                        }}
                        className="text-xs font-medium"
                        style={{ color: 'var(--theme-accent)' }}
                      >
                        {hasKey ? 'Update' : 'Add'}
                      </button>
                    )}
                  </div>
                )
              })}
          </div>
        </div>
      ) : null}

      {!configureOnly ? (
        <div className="rounded-xl px-3 py-2.5" style={cardStyle}>
          <div className="mb-2 flex items-center gap-2">
            <span className="size-2 animate-pulse rounded-full bg-green-500" />
            <span
              className="text-xs font-semibold uppercase tracking-wider"
              style={mutedStyle}
            >
              Runtime
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <span style={mutedStyle}>Model</span>
            <span className="font-mono font-medium">
              {defaultModelId || activeModel || '—'}
            </span>
            <span style={mutedStyle}>Provider</span>
            <span className="font-mono font-medium">
              {cards.find((p) => p.id === (defaultProvider || activeProvider))
                ?.name ||
                defaultProvider ||
                activeProvider ||
                '—'}
            </span>
            <span style={mutedStyle}>Config</span>
            <span className="font-mono font-medium">{configPathLabel}</span>
          </div>
        </div>
      ) : null}

      <CodexLoginModal
        open={showCodexModal}
        onClose={() => setShowCodexModal(false)}
        onSuccess={() => {
          setShowCodexModal(false)
          void refreshKeys()
        }}
      />
      <AnthropicLoginModal
        open={showAnthropicModal}
        onClose={() => setShowAnthropicModal(false)}
        onSuccess={() => {
          setShowAnthropicModal(false)
          void refreshKeys()
        }}
      />
    </div>
  )
}
