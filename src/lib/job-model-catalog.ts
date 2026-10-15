import { getProviderDisplayName } from '@/lib/provider-catalog'

export type JobModelProviderOption = {
  id: string
  name: string
}

export type JobModelCatalog = {
  providers: Array<JobModelProviderOption>
  modelsByProvider: Record<string, Array<string>>
}

function readModelId(entry: Record<string, unknown>): string | null {
  for (const key of ['id', 'name', 'model'] as const) {
    const value = entry[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function readProviderId(
  entry: Record<string, unknown>,
  modelId: string,
): string {
  const provider = entry.provider ?? entry.owned_by
  if (typeof provider === 'string' && provider.trim()) return provider.trim()
  if (modelId.includes('/')) return modelId.split('/')[0] ?? 'hermes-agent'
  return 'hermes-agent'
}

export async function fetchJobModelCatalog(): Promise<JobModelCatalog> {
  const response = await fetch('/api/models')
  if (!response.ok) {
    throw new Error(`Models request failed (${response.status})`)
  }

  const payload = (await response.json()) as
    | Array<unknown>
    | {
        data?: Array<Record<string, unknown>>
        models?: Array<Record<string, unknown>>
      }

  const rawModels = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : []

  const modelsByProvider: Record<string, Set<string>> = {}

  for (const entry of rawModels) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const modelId = readModelId(record)
    if (!modelId) continue
    const providerId = readProviderId(record, modelId)
    const bucket = modelsByProvider[providerId] ?? new Set<string>()
    bucket.add(modelId)
    modelsByProvider[providerId] = bucket
  }

  const providers = Object.keys(modelsByProvider)
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      id,
      name: getProviderDisplayName(id),
    }))

  return {
    providers,
    modelsByProvider: Object.fromEntries(
      Object.entries(modelsByProvider).map(([providerId, models]) => [
        providerId,
        Array.from(models).sort((a, b) => a.localeCompare(b)),
      ]),
    ),
  }
}

export async function fetchModelsForJobProvider(
  providerId: string,
  catalog?: JobModelCatalog,
): Promise<Array<string>> {
  const normalizedProvider = providerId.trim()
  if (!normalizedProvider) return []

  const fromCatalog = catalog?.modelsByProvider[normalizedProvider]
  if (fromCatalog && fromCatalog.length > 0) return fromCatalog

  try {
    const response = await fetch(
      `/api/hermes-proxy/api/available-models?provider=${encodeURIComponent(normalizedProvider)}`,
    )
    if (response.ok) {
      const data = (await response.json()) as { models?: Array<{ id: string }> }
      const remote = (data.models ?? [])
        .map((model) => model.id)
        .filter((id) => id.trim().length > 0)
      if (remote.length > 0) return remote
    }
  } catch {
    // Fall through to empty list.
  }

  return []
}
