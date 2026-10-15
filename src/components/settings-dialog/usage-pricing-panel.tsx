'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { useModelPricing } from '@/screens/dashboard/hooks/use-usage-data'
import { fetchModels } from '@/lib/gateway-api'
import { cn } from '@/lib/utils'

function formatPrice(n: string): string {
  const v = Number.parseFloat(n)
  if (!Number.isFinite(v) || v < 0) return '0.0000'
  return v.toFixed(4)
}

function modelIdFromEntry(entry: { id?: string; model?: string; alias?: string; name?: string; label?: string; displayName?: string } | string): string {
  if (typeof entry === 'string') return entry
  return entry.id || entry.model || entry.alias || entry.name || entry.label || entry.displayName || ''
}

function modelLabelFromEntry(entry: { id?: string; model?: string; alias?: string; name?: string; label?: string; displayName?: string; provider?: string } | string): string {
  if (typeof entry === 'string') return entry
  const id = entry.id || entry.model || entry.alias || ''
  const tail = id.split('/').pop() || id
  const provider = entry.provider ? `[${entry.provider}] ` : ''
  return `${provider}${tail}`
}

type PricingEntryRow = {
  modelId: string
  provider?: string
  inputPrice: string
  outputPrice: string
  cacheReadPrice: string
  cacheWritePrice: string
  inputTokenMode: 'cache-inclusive' | 'fresh-input'
  multiplier: string
}

type ApiPricingEntry = {
  modelId: string
  provider?: string
  inputCostPerMillion?: string
  outputCostPerMillion?: string
  cacheReadCostPerMillion?: string
  cacheCreationCostPerMillion?: string
  inputPrice?: string
  outputPrice?: string
  cacheReadPrice?: string
  cacheWritePrice?: string
  inputTokenMode?: 'cache-inclusive' | 'fresh-input'
  multiplier?: string
}

function emptyEntry(modelId = ''): PricingEntryRow {
  return {
    modelId,
    inputPrice: '0.0000',
    outputPrice: '0.0000',
    cacheReadPrice: '0.0000',
    cacheWritePrice: '0.0000',
    inputTokenMode: 'cache-inclusive',
    multiplier: '1',
  }
}

function parseConfig(config: import('@/screens/dashboard/hooks/use-usage-data').PricingConfig): {
  defaultMultiplier: string
  entries: PricingEntryRow[]
} {
  const entries = Object.entries(config.models ?? {}).map(([modelId, raw]) => {
    const e = raw as unknown as ApiPricingEntry
    return {
      modelId: e.modelId ?? modelId,
      provider: e.provider ?? '',
      inputPrice: formatPrice(e.inputPrice ?? e.inputCostPerMillion ?? '0'),
      outputPrice: formatPrice(e.outputPrice ?? e.outputCostPerMillion ?? '0'),
      cacheReadPrice: formatPrice(e.cacheReadPrice ?? e.cacheReadCostPerMillion ?? '0'),
      cacheWritePrice: formatPrice(e.cacheWritePrice ?? e.cacheCreationCostPerMillion ?? '0'),
      inputTokenMode: e.inputTokenMode ?? 'cache-inclusive',
      multiplier: e.multiplier ?? '1',
    }
  })
  return {
    defaultMultiplier: config.defaultMultiplier ?? '1',
    entries,
  }
}

export function UsagePricingPanel() {
  const queryClient = useQueryClient()
  const { data: config, isLoading } = useModelPricing()
  const [defaultMultiplier, setDefaultMultiplier] = useState('1')
  const [entries, setEntries] = useState<PricingEntryRow[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const modelsQuery = useQuery({
    queryKey: ['models', 'catalog'],
    queryFn: fetchModels,
    staleTime: 60_000,
  })

  const availableModels = useMemo(() => {
    const raw = modelsQuery.data?.models ?? []
    return raw
      .map((m) => ({
        id: modelIdFromEntry(m),
        label: modelLabelFromEntry(m),
      }))
      .filter((m) => m.id)
  }, [modelsQuery.data])

  useEffect(() => {
    if (!config) return
    const parsed = parseConfig(config)
    setDefaultMultiplier(parsed.defaultMultiplier)
    setEntries(parsed.entries)
  }, [config])

  const saveMutation = useMutation({
    mutationFn: async (payload: { defaultMultiplier: string; entries: PricingEntryRow[] }) => {
      const models: Record<string, ApiPricingEntry> = {}
      for (const e of payload.entries) {
        if (!e.modelId.trim()) continue
        models[e.modelId] = {
          modelId: e.modelId,
          provider: e.provider,
          inputCostPerMillion: formatPrice(e.inputPrice),
          outputCostPerMillion: formatPrice(e.outputPrice),
          cacheReadCostPerMillion: formatPrice(e.cacheReadPrice),
          cacheCreationCostPerMillion: formatPrice(e.cacheWritePrice),
          inputTokenMode: e.inputTokenMode,
          multiplier: e.multiplier,
        }
      }
      const res = await fetch('/api/usage/pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set-multiplier',
          multiplier: payload.defaultMultiplier,
        }),
      })
      if (!res.ok) throw new Error(`Failed to save multiplier: ${res.status}`)

      for (const e of Object.values(models)) {
        const r = await fetch('/api/usage/pricing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set-model', entry: e }),
        })
        if (!r.ok) throw new Error(`Failed to save ${e.modelId}: ${r.status}`)
      }

      return payload
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['usage', 'pricing'] })
      setMessage('Saved')
      setTimeout(() => setMessage(null), 2000)
    },
    onError: (err) => {
      setMessage(err instanceof Error ? err.message : 'Save failed')
    },
  })

  function addEntry() {
    const id = selectedModel.trim()
    if (!id) return
    if (entries.some((e) => e.modelId === id)) {
      setMessage('Model already exists')
      return
    }
    setEntries((prev) => [...prev, emptyEntry(id)])
    setSelectedModel('')
  }

  function removeEntry(modelId: string) {
    setEntries((prev) => prev.filter((e) => e.modelId !== modelId))
  }

  function updateEntry(modelId: string, patch: Partial<PricingEntryRow>) {
    setEntries((prev) =>
      prev.map((e) => (e.modelId === modelId ? { ...e, ...patch } : e)),
    )
  }

  const hasChanges = useMemo(() => {
    if (!config) return false
    const parsed = parseConfig(config)
    if (parsed.defaultMultiplier !== defaultMultiplier) return true
    if (parsed.entries.length !== entries.length) return true
    for (let i = 0; i < parsed.entries.length; i++) {
      const a = parsed.entries[i]
      const b = entries[i]
      if (
        a.modelId !== b.modelId ||
        a.provider !== b.provider ||
        a.inputPrice !== b.inputPrice ||
        a.outputPrice !== b.outputPrice ||
        a.cacheReadPrice !== b.cacheReadPrice ||
        a.cacheWritePrice !== b.cacheWritePrice ||
        a.inputTokenMode !== b.inputTokenMode ||
        a.multiplier !== b.multiplier
      ) {
        return true
      }
    }
    return false
  }, [config, defaultMultiplier, entries])

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-40 animate-pulse rounded bg-primary-100/70 dark:bg-neutral-800" />
        <div className="h-32 animate-pulse rounded bg-primary-100/70 dark:bg-neutral-800" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-primary-900 dark:text-neutral-100">
          Usage pricing
        </h3>
        <p className="text-xs text-primary-500 dark:text-neutral-400">
          Override per-model cost and token accounting for the dashboard usage cards.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-primary-700 dark:text-neutral-300">
          Default multiplier
        </label>
        <Input
          type="number"
          min="0"
          step="0.01"
          value={defaultMultiplier}
          onChange={(e) => setDefaultMultiplier(e.target.value)}
          className="w-28"
        />
      </div>

      <div className="space-y-2">
        {entries.map((entry) => (
          <div
            key={entry.modelId}
            className="rounded-lg border border-primary-200 bg-primary-50/40 p-3 dark:border-neutral-700 dark:bg-neutral-800/40"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-primary-900 dark:text-neutral-100">
                  {entry.modelId}
                </div>
                {entry.provider ? (
                  <div className="text-xs text-primary-500 dark:text-neutral-400">
                    {entry.provider}
                  </div>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeEntry(entry.modelId)}
                className="text-red-500 hover:text-red-600"
              >
                Remove
              </Button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-primary-500 dark:text-neutral-400">
                  Input $/1M
                </span>
                <Input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={entry.inputPrice}
                  onChange={(e) =>
                    updateEntry(entry.modelId, { inputPrice: e.target.value })
                  }
                />
              </label>
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-primary-500 dark:text-neutral-400">
                  Output $/1M
                </span>
                <Input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={entry.outputPrice}
                  onChange={(e) =>
                    updateEntry(entry.modelId, { outputPrice: e.target.value })
                  }
                />
              </label>
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-primary-500 dark:text-neutral-400">
                  Cache read $/1M
                </span>
                <Input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={entry.cacheReadPrice}
                  onChange={(e) =>
                    updateEntry(entry.modelId, { cacheReadPrice: e.target.value })
                  }
                />
              </label>
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-primary-500 dark:text-neutral-400">
                  Cache write $/1M
                </span>
                <Input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={entry.cacheWritePrice}
                  onChange={(e) =>
                    updateEntry(entry.modelId, { cacheWritePrice: e.target.value })
                  }
                />
              </label>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-primary-500 dark:text-neutral-400">
                  Input mode
                </span>
                <select
                  value={entry.inputTokenMode}
                  onChange={(e) =>
                    updateEntry(entry.modelId, {
                      inputTokenMode: e.target.value as PricingEntryRow['inputTokenMode'],
                    })
                  }
                  className="w-full rounded-md border border-primary-200 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700"
                >
                  <option value="cache-inclusive">cache-inclusive</option>
                  <option value="fresh-input">fresh-input</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-primary-500 dark:text-neutral-400">
                  Multiplier
                </span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={entry.multiplier}
                  onChange={(e) =>
                    updateEntry(entry.modelId, { multiplier: e.target.value })
                  }
                />
              </label>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Select value={selectedModel} onValueChange={(v) => setSelectedModel(v ?? '')}>
          <SelectTrigger className="flex-1 bg-[var(--theme-card)] text-[var(--theme-text)] border-[var(--theme-border)]">
            <SelectValue placeholder="Select a model…" />
          </SelectTrigger>
          <SelectContent className="bg-[var(--theme-card)] text-[var(--theme-text)] border-[var(--theme-border)]">
            {availableModels.map((m) => (
              <SelectItem
                key={m.id}
                value={m.id}
                className="text-[var(--theme-text)] hover:bg-[var(--theme-accent-subtle)] focus:bg-[var(--theme-accent-subtle)] data-[state=checked]:bg-[var(--theme-accent-subtle)]"
              >
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="secondary" onClick={addEntry} disabled={!selectedModel}>
          Add model
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Button
          onClick={() =>
            saveMutation.mutate({ defaultMultiplier, entries })
          }
          disabled={!hasChanges || saveMutation.isPending}
        >
          {saveMutation.isPending ? 'Saving…' : 'Save'}
        </Button>
        {message ? (
          <span
            className={cn(
              'text-xs',
              message === 'Saved'
                ? 'text-green-500'
                : 'text-red-500',
            )}
          >
            {message}
          </span>
        ) : null}
      </div>
    </div>
  )
}
