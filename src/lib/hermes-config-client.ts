/**
 * Client helpers so /api/hermes-config reads/writes the correct Hermes
 * profile (default → ~/.hermes, named → profiles/<id>/).
 */

export function hermesConfigUrl(profile?: string | null): string {
  const name = (profile || '').trim()
  if (!name) return '/api/hermes-config'
  return `/api/hermes-config?profile=${encodeURIComponent(name)}`
}

export function withHermesConfigProfile<T extends Record<string, unknown>>(
  profile: string | null | undefined,
  body: T,
): T & { profile?: string } {
  const name = (profile || '').trim()
  if (!name) return body
  return { ...body, profile: name }
}
