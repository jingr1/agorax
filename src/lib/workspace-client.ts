import type { QueryClient } from '@tanstack/react-query'

/** React Query key for the active workspace scope id (agent registry id). */
export const WORKSPACE_PROFILE_QUERY_KEY = [
  'profiles',
  'workspace-profile',
] as const

export type WorkspaceCatalog = {
  path: string
  folderName: string
  source: string
  isValid: boolean
  workspaces: Array<{ name: string; path: string }>
  last: string
  agent?: string
  profile?: string
}

export type ActiveWorkspace = {
  path: string
  folderName: string
}

export type FileTreeEntry = {
  name: string
  path: string
  type: 'file' | 'folder'
  children?: Array<FileTreeEntry>
}

/**
 * Attach workspace scope. Prefer `agent=` (registry id); Hermes workers use
 * the same id as their profile so legacy `?profile=` callers still work via
 * the server's agent-or-profile resolver.
 */
export function withProfileQuery(
  basePath: string,
  profileName: string,
): string {
  if (!profileName.trim()) return basePath
  const query = new URLSearchParams()
  query.set('agent', profileName.trim())
  const join = basePath.includes('?') ? '&' : '?'
  return `${basePath}${join}${query.toString()}`
}

/** Build a files API URL that works for local and SSH workspaces. */
export function buildFilesApiUrl(
  action: 'list' | 'read' | 'download' | 'view' | 'abspath' | 'download-folder',
  filePath: string,
  profileName: string,
  extra?: Record<string, string>,
): string {
  const params = new URLSearchParams()
  params.set('action', action)
  if (filePath) params.set('path', filePath)
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value) params.set(key, value)
    }
  }
  return withProfileQuery(`/api/files?${params.toString()}`, profileName)
}

export async function fetchWorkspaceCatalog(
  profileName: string,
): Promise<WorkspaceCatalog> {
  const response = await fetch(withProfileQuery('/api/workspace', profileName))
  if (!response.ok) {
    throw new Error(`Failed to load workspace (${response.status})`)
  }
  return (await response.json()) as WorkspaceCatalog
}

export async function fetchActiveWorkspace(
  profileName: string,
): Promise<ActiveWorkspace> {
  const catalog = await fetchWorkspaceCatalog(profileName)
  return {
    path: catalog.path ?? '',
    folderName: catalog.folderName?.trim() || '',
  }
}

/** Query key includes maxDepth so shallow prefetch cannot overwrite a deep tree. */
export function fileTreeQueryKey(
  profileName: string,
  workspacePath: string,
  maxDepth: number,
) {
  return ['files', 'tree', profileName, workspacePath, maxDepth] as const
}

export async function fetchFileTree(
  profileName: string,
  maxDepth = 1,
  dirPath = '',
): Promise<Array<FileTreeEntry>> {
  const params = new URLSearchParams()
  params.set('action', 'list')
  params.set('maxDepth', String(maxDepth))
  if (dirPath) params.set('path', dirPath)
  const url = withProfileQuery(`/api/files?${params.toString()}`, profileName)
  const response = await fetch(url)
  const data = (await response.json().catch(() => null)) as {
    entries?: Array<FileTreeEntry>
    error?: string
  } | null
  if (!response.ok) {
    throw new Error(data?.error || `Failed to load files (${response.status})`)
  }
  return Array.isArray(data?.entries) ? data.entries : []
}

/** Merge lazily loaded folder children into an existing tree. */
export function patchFileTreeChildren(
  entries: Array<FileTreeEntry>,
  folderPath: string,
  children: Array<FileTreeEntry>,
): Array<FileTreeEntry> {
  return entries.map((entry) => {
    if (entry.path === folderPath) {
      return { ...entry, children }
    }
    if (entry.children?.length) {
      return {
        ...entry,
        children: patchFileTreeChildren(entry.children, folderPath, children),
      }
    }
    return entry
  })
}

export type ActivateProfileResponse = {
  ok?: boolean
  profile?: string
  workspace?: WorkspaceCatalog
  error?: string
}

export function seedWorkspaceQueries(
  queryClient: QueryClient,
  profileName: string,
  catalog: WorkspaceCatalog,
): void {
  queryClient.setQueryData(['workspace', 'active', profileName], {
    path: catalog.path ?? '',
    folderName: catalog.folderName?.trim() || '',
  } satisfies ActiveWorkspace)
  queryClient.setQueryData(
    ['workspace', 'composer-context', profileName],
    catalog,
  )
  // Phase-1 shallow tree (depth 0) — depth is part of the key so this never
  // clobbers a depth-3 cache entry used by the explorer.
  if (catalog.path) {
    void queryClient.prefetchQuery({
      queryKey: fileTreeQueryKey(profileName, catalog.path, 0),
      queryFn: () => fetchFileTree(profileName, 0),
      staleTime: 30_000,
    })
    // Kick deep tree early; explorer prefers this when ready.
    void queryClient.prefetchQuery({
      queryKey: fileTreeQueryKey(profileName, catalog.path, 3),
      queryFn: () => fetchFileTree(profileName, 3),
      staleTime: 30_000,
    })
  }
}

export async function prefetchProfileWorkspace(
  queryClient: QueryClient,
  profileName: string,
  catalog?: WorkspaceCatalog,
): Promise<void> {
  const resolved = catalog ?? (await fetchWorkspaceCatalog(profileName))
  seedWorkspaceQueries(queryClient, profileName, resolved)
  if (!resolved.path) return
  // Await shallow so first paint is warm before nested-lazy explorer mounts.
  await queryClient.prefetchQuery({
    queryKey: fileTreeQueryKey(profileName, resolved.path, 0),
    queryFn: () => fetchFileTree(profileName, 0),
    staleTime: 30_000,
  })
}
