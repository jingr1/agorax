import type { UsageFilters, UsageRange } from './usage-types'

export type UsageQueryParams = {
  start?: string
  end?: string
  range?: '1d' | '7d' | '30d'
  agent?: string
  profile?: string
  provider?: string
  model?: string
  dataSource?: 'all' | 'hermes' | 'claude-code' | 'codex'
}

export function parseUsageFilters(
  searchParams: URLSearchParams,
): UsageFilters {
  const rangeParam = searchParams.get('range') as UsageFilters['range']['kind'] | null
  const now = Date.now()
  let range: UsageRange

  switch (rangeParam) {
    case '1d':
      range = { kind: '1d', start: now - 24 * 60 * 60 * 1000, end: now }
      break
    case '30d':
      range = { kind: '30d', start: now - 30 * 24 * 60 * 60 * 1000, end: now }
      break
    case '7d':
    default:
      range = { kind: '7d', start: now - 7 * 24 * 60 * 60 * 1000, end: now }
      break
  }

  const dataSource = (searchParams.get('dataSource') as UsageFilters['dataSource']) ?? 'all'

  return {
    range,
    agent: searchParams.get('agent')?.trim() || undefined,
    profile: searchParams.get('profile')?.trim() || undefined,
    provider: searchParams.get('provider')?.trim() || undefined,
    model: searchParams.get('model')?.trim() || undefined,
    dataSource: ['all', 'hermes', 'claude-code', 'codex'].includes(dataSource)
      ? dataSource
      : 'all',
  }
}
