export function readModelProviderFromConfig(
  config: Record<string, unknown> | undefined | null,
): { model: string; provider: string } {
  if (!config) return { model: '', provider: '' }
  let model = ''
  let provider = ''
  if (typeof config.model === 'string') {
    model = config.model.trim()
  } else if (
    config.model &&
    typeof config.model === 'object' &&
    !Array.isArray(config.model)
  ) {
    const nested = config.model as Record<string, unknown>
    if (typeof nested.default === 'string') model = nested.default.trim()
    if (typeof nested.provider === 'string') provider = nested.provider.trim()
  }
  if (!provider && typeof config.provider === 'string') {
    provider = config.provider.trim()
  }
  return { model, provider }
}

export function profileConfigPathLabel(profileName: string): string {
  const name = profileName.trim() || 'default'
  return name === 'default'
    ? '~/.hermes/config.yaml'
    : `~/.hermes/profiles/${name}/config.yaml`
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

export async function saveProfileModelProvider(
  name: string,
  providerId: string,
  modelId: string,
): Promise<string> {
  const res = await fetch('/api/profiles/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, providerId, modelId }),
  })
  const data = await readJson(res)
  if (!res.ok) {
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : `Failed to save (${res.status})`,
    )
  }
  return `Default model updated for profile ${name.trim() || 'default'}.`
}

export async function saveAllProfilesModelProvider(
  providerId: string,
  modelId: string,
): Promise<string> {
  const res = await fetch('/api/profiles/update-all-model-provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, modelId }),
  })
  const data = await readJson(res)
  if (!res.ok) {
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : `Failed to save (${res.status})`,
    )
  }
  return typeof data.message === 'string'
    ? data.message
    : 'Default model updated for all profiles.'
}
