'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  SETTINGS_CONTROL_CLASS,
  SettingsRow,
} from '@/components/settings/settings-section'
import { cn } from '@/lib/utils'

export type CatalogProvider = {
  id: string
  name: string
  base_url: string
  key_env: string
  models: Array<string>
  keyConfigured: boolean
  maskedKey: string
}

export type ProviderCatalog = {
  providers: Array<CatalogProvider>
}

export type ProfileProviderSelection = {
  provider: string
  model: string
  fallbackProvider: string
  fallbackModel: string
}

type CatalogResponse = {
  ok?: boolean
  error?: string
  catalog?: ProviderCatalog
  selection?: ProfileProviderSelection | null
  message?: string
}

async function postCatalog(
  body: Record<string, unknown>,
): Promise<CatalogResponse> {
  const res = await fetch('/api/profiles/provider-catalog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as CatalogResponse
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

export function ProviderCatalogPanel({
  onCatalog,
  embedded = false,
}: {
  catalog: ProviderCatalog | null
  onCatalog: (catalog: ProviderCatalog) => void
  embedded?: boolean
}) {
  const [addId, setAddId] = useState('')
  const [addName, setAddName] = useState('')
  const [addUrl, setAddUrl] = useState('')
  const [addKeyEnv, setAddKeyEnv] = useState('')
  const [addKeyValue, setAddKeyValue] = useState('')
  const [addModels, setAddModels] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const flash = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage(null), 3000)
  }

  const saveProvider = async (
    id: string,
    patch: {
      name?: string
      base_url?: string
      key_env?: string
      key_value?: string
      models?: Array<string>
    },
  ) => {
    setSaving(true)
    try {
      const data = await postCatalog({
        action: 'upsert-provider',
        id,
        ...patch,
      })
      if (data.catalog) onCatalog(data.catalog)
      flash(data.message || 'Saved')
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Failed to save provider')
    }
    setSaving(false)
  }

  const addProvider = async () => {
    const id = addId.trim()
    if (!id || !addUrl.trim()) return
    const models = addModels
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    await saveProvider(id, {
      name: addName.trim() || id,
      base_url: addUrl.trim(),
      key_env: addKeyEnv.trim(),
      key_value: addKeyValue,
      models,
    })
    setAddId('')
    setAddName('')
    setAddUrl('')
    setAddKeyEnv('')
    setAddKeyValue('')
    setAddModels('')
  }

  return (
    <div
      className={
        embedded
          ? 'space-y-4 border-t border-primary-200 pt-4'
          : 'space-y-4 rounded-2xl border border-primary-200 bg-primary-50/80 p-4'
      }
    >
      <div>
        <p className="text-sm font-medium text-primary-900">
          Add custom provider
        </p>
        <p className="mt-0.5 text-xs text-primary-600">
          Named OpenAI-compatible gateway — appears in the grid above and is
          copied into every profile.
        </p>
      </div>

      {message ? (
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-sm font-medium',
            message.includes('Failed') || message.includes('required')
              ? 'bg-red-500/15 text-red-500 dark:text-red-400'
              : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
          )}
        >
          {message}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <SettingsRow stacked label="Title">
          <input
            value={addName}
            onChange={(event) => setAddName(event.target.value)}
            placeholder="e.g. TokenX"
            className={SETTINGS_CONTROL_CLASS}
          />
        </SettingsRow>
        <SettingsRow stacked label="Provider id">
          <input
            value={addId}
            onChange={(event) => setAddId(event.target.value)}
            placeholder="e.g. tokenx"
            className={cn(SETTINGS_CONTROL_CLASS, 'font-mono')}
          />
        </SettingsRow>
        <div className="md:col-span-2">
          <SettingsRow stacked label="Base URL">
            <input
              value={addUrl}
              onChange={(event) => setAddUrl(event.target.value)}
              placeholder="https://host/v1"
              className={cn(SETTINGS_CONTROL_CLASS, 'font-mono')}
            />
          </SettingsRow>
        </div>
        <SettingsRow stacked label="key_env">
          <input
            value={addKeyEnv}
            onChange={(event) => setAddKeyEnv(event.target.value)}
            placeholder="optional"
            className={cn(SETTINGS_CONTROL_CLASS, 'font-mono')}
          />
        </SettingsRow>
        <SettingsRow stacked label="Secret">
          <input
            type="password"
            value={addKeyValue}
            onChange={(event) => setAddKeyValue(event.target.value)}
            placeholder="optional"
            className={SETTINGS_CONTROL_CLASS}
          />
        </SettingsRow>
        <div className="md:col-span-2">
          <SettingsRow
            stacked
            label="Models"
            description="Optional · one model id per line."
          >
            <textarea
              value={addModels}
              onChange={(event) => setAddModels(event.target.value)}
              placeholder={'Kimi-K2.7-Code\nDeepSeek-V4-Pro'}
              rows={3}
              className={cn(
                SETTINGS_CONTROL_CLASS,
                'h-auto min-h-[5rem] resize-y py-2 font-mono leading-5',
              )}
            />
          </SettingsRow>
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={saving || !addId.trim() || !addUrl.trim()}
          onClick={() => void addProvider()}
        >
          Add provider
        </Button>
      </div>
    </div>
  )
}

export function useProviderCatalog() {
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null)

  const refresh = useCallback(async (profile?: string) => {
    const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
    const res = await fetch(`/api/profiles/provider-catalog${query}`)
    const data = (await res.json()) as CatalogResponse
    if (!res.ok) throw new Error(data.error || 'Failed to load catalog')
    if (data.catalog) setCatalog(data.catalog)
    return data
  }, [])

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  return { catalog, setCatalog, refresh, postCatalog }
}
