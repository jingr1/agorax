'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ModelProviderPanel } from '@/components/settings-dialog/model-provider-panel'
import {
  readModelProviderFromConfig,
  saveProfileModelProvider,
} from '@/lib/model-provider'
import { useProfiles } from '@/screens/chat/hooks/use-profiles'
import {
  ProviderCatalogPanel,
  useProviderCatalog,
} from '@/components/settings/provider-catalog-panel'
import { ProfileModelSelector } from '@/components/settings/profile-model-selector'

type ModelProviderScopePanelProps = {
  onApplied?: (providerId: string, modelId: string) => void
  /** Controlled profile scope. When provided, the caller owns the selection
   *  (e.g. the Settings page shares it with the Terminal backend config). */
  profileName?: string
  onProfileChange?: (name: string) => void
}

export function ModelProviderScopePanel({
  onApplied,
  profileName,
  onProfileChange,
}: ModelProviderScopePanelProps) {
  const queryClient = useQueryClient()
  const { profiles, activeProfileName, isReady } = useProfiles()
  const { catalog, setCatalog, refresh, postCatalog } = useProviderCatalog()
  const [internalScope, setInternalScope] = useState('')
  const scope = profileName ?? internalScope
  const handleProfileChange = useCallback(
    (name: string) => {
      if (onProfileChange) onProfileChange(name)
      else setInternalScope(name)
    },
    [onProfileChange],
  )
  const [initialProvider, setInitialProvider] = useState('')
  const [initialModel, setInitialModel] = useState('')
  const [fallbackProvider, setFallbackProvider] = useState('')
  const [fallbackModel, setFallbackModel] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectMessage, setSelectMessage] = useState<string | null>(null)

  const profileNames = useMemo(() => {
    const names = profiles.map((profile) => profile.name)
    if (!names.includes('default')) names.unshift('default')
    return Array.from(new Set(names))
  }, [profiles])

  useEffect(() => {
    if (!isReady || scope) return
    if (onProfileChange) onProfileChange(activeProfileName || 'default')
    else setInternalScope(activeProfileName || 'default')
  }, [activeProfileName, isReady, onProfileChange, scope])

  const loadScope = useCallback(
    async (profileName: string) => {
      if (!profileName) return
      setLoaded(false)
      setLoadError(null)
      try {
        const [profileRes, catalogRes] = await Promise.all([
          fetch(`/api/profiles/read?name=${encodeURIComponent(profileName)}`),
          refresh(profileName),
        ])
        const data = (await profileRes.json()) as {
          error?: string
          profile?: { config?: Record<string, unknown> }
        }
        if (!profileRes.ok) {
          throw new Error(
            data.error || `Failed to load profile (${profileRes.status})`,
          )
        }
        const mp = readModelProviderFromConfig(data.profile?.config)
        setInitialProvider(mp.provider)
        setInitialModel(mp.model)
        setFallbackProvider(catalogRes.selection?.fallbackProvider || '')
        setFallbackModel(catalogRes.selection?.fallbackModel || '')
        setLoaded(true)
      } catch (error) {
        setLoadError(
          error instanceof Error
            ? error.message
            : 'Failed to load configuration',
        )
        setLoaded(true)
      }
    },
    [refresh],
  )

  useEffect(() => {
    if (!scope) return
    void loadScope(scope)
  }, [loadScope, scope])

  const catalogProviders = catalog?.providers ?? []
  const catalogKey = catalogProviders.map((provider) => provider.id).join(',')

  return (
    <div className="space-y-4">
      <div
        className="space-y-4 rounded-xl p-4"
        style={{
          backgroundColor: 'var(--theme-card)',
          border: '1px solid var(--theme-border)',
          color: 'var(--theme-text)',
        }}
      >
        <div>
          <p
            className="text-sm font-semibold"
            style={{ color: 'var(--theme-text)' }}
          >
            Provider configuration
          </p>
          <p
            className="mt-1 text-xs leading-relaxed"
            style={{ color: 'var(--theme-muted)' }}
          >
            Built-in providers and custom_providers share this card grid. URL,
            keys, and OAuth are copied into every profile.
          </p>
        </div>

        <ModelProviderPanel
          key={`configure:${catalogKey}`}
          configureOnly
          extraProviders={catalogProviders}
          onSaveExtraProvider={async (id, patch) => {
            const data = await postCatalog({
              action: 'upsert-provider',
              id,
              ...patch,
            })
            if (data.catalog) setCatalog(data.catalog)
            return data.message || 'Provider saved'
          }}
          onSaveBuiltinKey={async (providerId, keyEnv, value) => {
            const data = await postCatalog({
              action: 'upsert-key',
              id: providerId,
              name: keyEnv,
              value,
            })
            if (data.catalog) setCatalog(data.catalog)
            return data.message || 'Key saved'
          }}
          onRemoveProvider={async (providerId) => {
            const data = await postCatalog({
              action: 'remove-provider',
              id: providerId,
            })
            if (data.catalog) setCatalog(data.catalog)
            return data.message || 'Provider removed'
          }}
        />

        <ProviderCatalogPanel
          catalog={catalog}
          onCatalog={setCatalog}
          embedded
        />
      </div>

      <ProfileModelSelector
        profileName={scope}
        profileNames={profileNames}
        activeProfileName={activeProfileName}
        isReady={isReady}
        defaultProvider={initialProvider}
        defaultModel={initialModel}
        fallbackProvider={fallbackProvider}
        fallbackModel={fallbackModel}
        catalogProviders={catalogProviders}
        loaded={loaded}
        loadError={loadError}
        message={selectMessage}
        onProfileChange={handleProfileChange}
        onSaveDefault={async (providerId, modelId) => {
          const message = await saveProfileModelProvider(
            scope,
            providerId,
            modelId,
          )
          setInitialProvider(providerId)
          setInitialModel(modelId)
          onApplied?.(providerId, modelId)
          setSelectMessage(message || 'Default saved')
          window.setTimeout(() => setSelectMessage(null), 3000)
          void queryClient.invalidateQueries({ queryKey: ['profiles', 'chat'] })
          void queryClient.invalidateQueries({ queryKey: ['claude', 'models'] })
        }}
        onSaveFallback={async (providerId, modelId) => {
          const data = await postCatalog({
            action: 'select-fallback',
            name: scope,
            providerId,
            modelId,
          })
          if (data.catalog) setCatalog(data.catalog)
          setFallbackProvider(providerId)
          setFallbackModel(modelId)
          setSelectMessage(data.message || 'Fallback saved')
          window.setTimeout(() => setSelectMessage(null), 3000)
        }}
        onClearFallback={async () => {
          const data = await postCatalog({
            action: 'select-fallback',
            name: scope,
            providerId: '',
            modelId: '',
          })
          if (data.catalog) setCatalog(data.catalog)
          setFallbackProvider('')
          setFallbackModel('')
          setSelectMessage(data.message || 'Fallback cleared')
          window.setTimeout(() => setSelectMessage(null), 3000)
        }}
      />
    </div>
  )
}
