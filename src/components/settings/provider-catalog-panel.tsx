'use client'

import { useCallback, useEffect, useState } from 'react'
import type * as React from 'react'
import { Button } from '@/components/ui/button'
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

const fieldClassName =
  'h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 text-sm text-primary-900 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100'

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

  const panelStyle: React.CSSProperties = {
    backgroundColor: 'var(--theme-card)',
    border: '1px solid var(--theme-border)',
    color: 'var(--theme-text)',
  }
  const rowStyle: React.CSSProperties = {
    backgroundColor: 'var(--theme-panel)',
    border: '1px solid var(--theme-border)',
    color: 'var(--theme-text)',
  }
  const mutedStyle: React.CSSProperties = { color: 'var(--theme-muted)' }

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
        embedded ? 'space-y-4 border-t pt-4' : 'space-y-4 rounded-xl p-4'
      }
      style={embedded ? { borderColor: 'var(--theme-border)' } : panelStyle}
    >
      <div>
        <p
          className="text-sm font-semibold"
          style={{ color: 'var(--theme-text)' }}
        >
          Add custom provider
        </p>
        <p className="mt-1 text-xs leading-relaxed" style={mutedStyle}>
          Add a named OpenAI-compatible gateway. It appears in the provider card
          grid above and is copied into every profile with URL, key, and model
          list.
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

      <div className="space-y-2 rounded-lg p-3" style={rowStyle}>
        <div className="grid gap-2 md:grid-cols-2">
          <input
            value={addName}
            onChange={(event) => setAddName(event.target.value)}
            placeholder="Title (e.g. TokenX)"
            className={fieldClassName}
          />
          <input
            value={addId}
            onChange={(event) => setAddId(event.target.value)}
            placeholder="Provider id (e.g. tokenx)"
            className={fieldClassName + ' font-mono'}
          />
          <input
            value={addUrl}
            onChange={(event) => setAddUrl(event.target.value)}
            placeholder="Base URL"
            className={fieldClassName + ' font-mono md:col-span-2'}
          />
          <input
            value={addKeyEnv}
            onChange={(event) => setAddKeyEnv(event.target.value)}
            placeholder="key_env (optional)"
            className={fieldClassName + ' font-mono'}
          />
          <input
            type="password"
            value={addKeyValue}
            onChange={(event) => setAddKeyValue(event.target.value)}
            placeholder="Secret value (optional)"
            className={fieldClassName + ' font-mono'}
          />
          <textarea
            value={addModels}
            onChange={(event) => setAddModels(event.target.value)}
            placeholder="Models (optional, one per line)"
            rows={3}
            className={fieldClassName + ' font-mono md:col-span-2 resize-y'}
          />
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
