/**
 * Split a composer / session-store model key into Hermes chat fields.
 *
 * Agorax persists Hermes picks as `provider/model` (e.g. `tokenx/DeepSeek-V4-Flash`).
 * Gateway session-chat expects separate `model` + `provider` — sending the
 * combined string as `model` alone often fails resolution and falls back to
 * the profile default (so the picker label changes but the turn still runs
 * the old model).
 */
export type ChatModelRef = {
  /** Bare model id for Hermes `model` */
  model: string
  /** Provider slug for Hermes `provider`, when known */
  provider?: string
  /** Original trimmed key from the client */
  raw: string
}

export function parseChatModelRef(
  value: string | null | undefined,
): ChatModelRef | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null

  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) {
    return { model: raw, raw }
  }

  const provider = raw.slice(0, slash).trim()
  const model = raw.slice(slash + 1).trim()
  if (!provider || !model) {
    return { model: raw, raw }
  }

  return { provider, model, raw }
}

/** Fields to forward on Hermes session chat / stream bodies. */
export function hermesChatModelFields(
  value: string | null | undefined,
): { model?: string; provider?: string } {
  const ref = parseChatModelRef(value)
  if (!ref) return {}
  return {
    model: ref.model,
    ...(ref.provider ? { provider: ref.provider } : {}),
  }
}
