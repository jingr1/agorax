'use client'

import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Folder01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export type WorkspaceFolderEntry = {
  name: string
  path: string
  fullPath: string
}

type FolderListResponse = {
  base: string
  current: string
  folders: Array<WorkspaceFolderEntry>
  remote?: boolean
  backend?: string
  host?: string
  error?: string
}

type FlatNode = {
  folder: WorkspaceFolderEntry
  depth: number
  isExpanded: boolean
  isLoading: boolean
  hasChildren: boolean | null
}

type WorkspaceFolderPickerProps = {
  value: string
  onChange: (path: string) => void
  className?: string
  /** Remount/refetch when the active profile changes. */
  reloadKey?: string
}

type FolderCacheEntry = {
  data?: FolderListResponse | null
  promise?: Promise<FolderListResponse | null>
}

const folderCache = new Map<string, FolderCacheEntry>()

function folderCacheKey(subPath: string, profileName: string): string {
  return `${profileName}::${subPath}`
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError'))
  )
}

async function fetchFolders(
  subPath = '',
  profileName = '',
): Promise<FolderListResponse | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 30_000)
  try {
    const params = new URLSearchParams()
    if (subPath) params.set('path', subPath)
    if (profileName) params.set('agent', profileName)
    const query = params.size ? `?${params.toString()}` : ''
    const response = await fetch(`/api/workspace/folders${query}`, {
      signal: controller.signal,
    })
    const payload = (await response.json().catch(() => null)) as
      | FolderListResponse
      | { error?: string; folders?: Array<WorkspaceFolderEntry> }
      | null
    if (!response.ok) {
      return {
        base: '',
        current: '',
        folders: [],
        error:
          payload && typeof payload === 'object' && 'error' in payload
            ? String(payload.error || 'Failed to list folders')
            : 'Failed to list folders',
      }
    }
    return payload as FolderListResponse
  } catch (error) {
    return {
      base: '',
      current: '',
      folders: [],
      error: isAbortError(error)
        ? 'Folder listing timed out. You can still type a path and click Set workspace.'
        : 'Failed to list folders. You can still type a path and click Set workspace.',
    }
  } finally {
    window.clearTimeout(timer)
  }
}

function cachedFetchFolders(
  subPath = '',
  profileName = '',
): Promise<FolderListResponse | null> {
  const key = folderCacheKey(subPath, profileName)
  const cached = folderCache.get(key)
  if (cached?.data !== undefined) return Promise.resolve(cached.data)
  if (cached?.promise) return cached.promise
  const promise = fetchFolders(subPath, profileName).then((result) => {
    folderCache.set(key, { data: result })
    return result
  })
  folderCache.set(key, { promise })
  return promise
}

export function preloadWorkspaceFolders(profileName = ''): void {
  // Defer so chat boot (sessions/history) is not blocked by home directory listing.
  const run = () => {
    void cachedFetchFolders('', profileName)
  }
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 3000 })
    return
  }
  window.setTimeout(run, 1200)
}

export function WorkspaceFolderPicker({
  value,
  onChange,
  className,
  reloadKey = '',
}: WorkspaceFolderPickerProps) {
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [basePath, setBasePath] = useState('')
  const [remoteHost, setRemoteHost] = useState('')
  const [folders, setFolders] = useState<Array<WorkspaceFolderEntry>>([])
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [childrenCache, setChildrenCache] = useState<
    Map<string, Array<WorkspaceFolderEntry>>
  >(() => new Map())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoadFailed(false)
    setLoadError('')
    setExpandedPaths(new Set())
    setChildrenCache(new Map())
    setLoadingPaths(new Set())
    const cached = folderCache.get(folderCacheKey('', reloadKey))?.data
    if (cached) {
      setLoading(false)
      if (cached.error) {
        setLoadFailed(true)
        setLoadError(cached.error)
        setFolders([])
        setBasePath(cached.base || '')
        setRemoteHost(cached.host || '')
      } else {
        setLoadFailed(false)
        setLoadError('')
        setBasePath(cached.base)
        setRemoteHost(cached.host || '')
        setFolders(cached.folders ?? [])
      }
    } else {
      setLoading(true)
      setBasePath('')
      setRemoteHost('')
      setFolders([])
    }
    void cachedFetchFolders('', reloadKey)
      .then((res) => {
        if (cancelled) return
        setLoading(false)
        if (!res || res.error) {
          setLoadFailed(true)
          setLoadError(res?.error || 'Failed to list folders')
          setFolders([])
          if (res?.base) setBasePath(res.base)
          if (res?.host) setRemoteHost(res.host)
          return
        }
        setLoadFailed(false)
        setLoadError('')
        setBasePath(res.base)
        setRemoteHost(res.host || '')
        setFolders(res.folders ?? [])
      })
      .catch(() => {
        if (cancelled) return
        setLoading(false)
        setLoadFailed(true)
        setLoadError(
          'Failed to list folders. You can still type a path and click Set workspace.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const toggleExpand = useCallback((folder: WorkspaceFolderEntry) => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(folder.path)) {
        next.delete(folder.path)
        return next
      }
      next.add(folder.path)
      return next
    })
  }, [])

  useEffect(() => {
    const pending = [...expandedPaths].filter(
      (entryPath) =>
        !childrenCache.has(entryPath) && !loadingPaths.has(entryPath),
    )
    if (pending.length === 0) return

    setLoadingPaths((current) => {
      const next = new Set(current)
      for (const entryPath of pending) next.add(entryPath)
      return next
    })
    for (const entryPath of pending) {
      void cachedFetchFolders(entryPath, reloadKey).then((res) => {
        setChildrenCache((current) => {
          const next = new Map(current)
          next.set(entryPath, res?.folders ?? [])
          return next
        })
        setLoadingPaths((current) => {
          const next = new Set(current)
          next.delete(entryPath)
          return next
        })
      })
    }
  }, [expandedPaths, childrenCache, loadingPaths])

  const flatNodes = useMemo<Array<FlatNode>>(() => {
    const result: Array<FlatNode> = []
    function traverse(entries: Array<WorkspaceFolderEntry>, depth: number) {
      for (const folder of entries) {
        const isExpanded = expandedPaths.has(folder.path)
        const children = childrenCache.get(folder.path)
        result.push({
          folder,
          depth,
          isExpanded,
          isLoading: loadingPaths.has(folder.path),
          hasChildren: children ? children.length > 0 : null,
        })
        if (isExpanded && children && children.length > 0) {
          traverse(children, depth + 1)
        }
      }
    }
    traverse(folders, 0)
    return result
  }, [folders, expandedPaths, childrenCache, loadingPaths])

  return (
    <div
      className={cn(
        'flex max-h-[360px] flex-col overflow-hidden rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] p-2',
        className,
      )}
    >
      <Input
        size="sm"
        value={value}
        placeholder={
          remoteHost
            ? `Remote path on ${remoteHost}`
            : 'Enter project path, e.g. /home/user/project'
        }
        onChange={(event) => onChange(event.target.value)}
        className="mb-2 shrink-0"
      />
      {remoteHost ? (
        <div className="mb-2 px-1 text-[11px] text-[var(--theme-muted)]">
          Browsing SSH host {remoteHost}
        </div>
      ) : null}
      {loading ? (
        <div className="flex justify-center px-3 py-6 text-xs text-[var(--theme-muted)]">
          Loading folders…
        </div>
      ) : (
        <div className="max-h-[260px] overflow-y-auto text-[13px]">
          {basePath ? (
            <button
              type="button"
              onClick={() => onChange(basePath)}
              className={cn(
                'mb-1 flex w-full items-center gap-1 rounded-md px-2 py-1 text-left font-semibold transition-colors',
                value === basePath
                  ? 'bg-[var(--theme-accent-soft)] outline outline-1 outline-[var(--theme-accent)]'
                  : 'hover:bg-[var(--theme-card2)]',
              )}
            >
              <HugeiconsIcon icon={Folder01Icon} size={14} strokeWidth={1.8} />
              <span className="min-w-0 truncate">{basePath || '/'}</span>
            </button>
          ) : null}

          {flatNodes.map((node) => (
            <div key={node.folder.path}>
              <div
                className={cn(
                  'flex w-full items-center gap-1 rounded-md py-1 pr-2 transition-colors',
                  value === node.folder.fullPath
                    ? 'bg-[var(--theme-accent-soft)] outline outline-1 outline-[var(--theme-accent)]'
                    : 'hover:bg-[var(--theme-card2)]',
                )}
                style={{ paddingLeft: `${12 + node.depth * 16}px` }}
              >
                <button
                  type="button"
                  aria-label={
                    node.isExpanded
                      ? `Collapse ${node.folder.name}`
                      : `Expand ${node.folder.name}`
                  }
                  className="inline-flex w-3.5 shrink-0 items-center justify-center text-[10px] text-[var(--theme-muted)]"
                  onClick={() => {
                    void toggleExpand(node.folder)
                  }}
                >
                  {node.isLoading ? (
                    '…'
                  ) : (
                    <HugeiconsIcon
                      icon={
                        node.isExpanded ? ArrowDown01Icon : ArrowRight01Icon
                      }
                      size={11}
                      strokeWidth={1.8}
                    />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onChange(node.folder.fullPath)}
                  className="flex min-w-0 flex-1 items-center gap-1 text-left"
                >
                  <HugeiconsIcon
                    icon={Folder01Icon}
                    size={14}
                    strokeWidth={1.8}
                    className="shrink-0"
                  />
                  <span className="min-w-0 truncate">{node.folder.name}</span>
                </button>
              </div>
              {node.isExpanded &&
              !node.isLoading &&
              node.hasChildren === false ? (
                <div
                  className="px-2 py-0.5 text-[11px] italic text-[var(--theme-muted)]"
                  style={{ paddingLeft: `${28 + node.depth * 16}px` }}
                >
                  (Empty)
                </div>
              ) : null}
            </div>
          ))}

          {(folders.length === 0 || loadFailed) && !loading ? (
            <div className="px-3 py-4 text-center text-[var(--theme-muted)]">
              {loadError || 'No workspace folders'}
            </div>
          ) : null}
        </div>
      )}

      {value ? (
        <div className="mt-2 flex min-w-0 shrink-0 items-center gap-2 rounded-md bg-[var(--theme-accent-soft)] px-2 py-1.5 text-xs">
          <span className="shrink-0 text-[var(--theme-muted)]">Selected:</span>
          <span className="min-w-0 truncate font-mono" title={value}>
            {value}
          </span>
        </div>
      ) : null}
    </div>
  )
}
