import type { QueryClient } from '@tanstack/react-query'
import { PRODUCT_UPDATE_CHECK_INTERVAL_MS } from '@/lib/managed-agent-runtime/update-check-ttl'
import {
  AGENT_PROVIDER_STATUS_QUERY_KEY,
  PRODUCT_UPDATE_STATUS_QUERY_KEY,
} from '@/lib/managed-agent-runtime/query-keys'

export {
  AGENT_PROVIDER_STATUS_QUERY_KEY,
  PRODUCT_UPDATE_STATUS_QUERY_KEY,
  PRODUCT_UPDATE_CHECK_INTERVAL_MS,
}

export type ProductUpdateStatusDto = {
  id: 'workspace' | 'agent'
  label: string
  installKind: 'git' | 'desktop' | 'docker' | 'unknown'
  version: string
  path: string | null
  repoPath: string | null
  branch: string | null
  currentHead: string | null
  latestHead: string | null
  updateAvailable: boolean
  canUpdate: boolean
  state: 'current' | 'available' | 'blocked' | 'unsupported' | 'error'
  reason: string | null
  blockingFiles?: Array<string>
  updateMode: string
}

export type ProductUpdateStatusResponse = {
  ok: true
  checkedAt: number
  products: Record<'workspace' | 'agent', ProductUpdateStatusDto>
  updateAvailable: boolean
  pendingReleaseNotes?: Array<{
    product: 'workspace' | 'agent'
    label: string
    from: string | null
    to: string | null
    commits: Array<string>
  }>
}

export async function fetchProductUpdateStatus(options?: {
  refresh?: boolean
}): Promise<ProductUpdateStatusResponse | null> {
  const url = options?.refresh
    ? '/api/update/status?refresh=1'
    : '/api/update/status'
  const res = await fetch(url)
  if (!res.ok) return null
  return (await res.json()) as ProductUpdateStatusResponse
}

/**
 * Manual「检查更新」: force origin fetch, then refresh provider rows so Hermes
 * badges pick up the new local `origin/*` tips without a second fetch path.
 */
export async function refreshProductUpdateStatus(queryClient: QueryClient) {
  const status = await queryClient.fetchQuery({
    queryKey: PRODUCT_UPDATE_STATUS_QUERY_KEY,
    queryFn: () => fetchProductUpdateStatus({ refresh: true }),
  })
  await queryClient.invalidateQueries({
    queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
  })
  return status
}
