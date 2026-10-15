import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Delete01Icon,
  Download01Icon,
  File01Icon,
  Folder01Icon,
  Image01Icon,
  Pen01Icon,
  PlusSignIcon,
  RefreshIcon,
  SourceCodeIcon,
  Upload01Icon,
} from '@hugeicons/core-free-icons'
import { FilePanelPreview } from './file-panel-preview'
import { classifyFilePreviewKind } from './file-kind'
import { cn } from '@/lib/utils'
import { useActiveWorkspace } from '@/hooks/use-active-workspace'
import {
  buildFilesApiUrl,
  fetchFileTree,
  fileTreeQueryKey,
  withProfileQuery,
} from '@/lib/workspace-client'
import { useProfiles } from '@/screens/chat/hooks/use-profiles'
import {
  ScrollAreaCorner,
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '@/components/ui/scroll-area'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toast'
import {
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export type FileEntry = {
  name: string
  path: string
  type: 'file' | 'folder'
  children?: Array<FileEntry>
}

type FileExplorerSidebarProps = {
  collapsed: boolean
  onToggle: () => void
  onInsertReference: (reference: string) => void
  // When provided, clicking a file calls this instead of opening the built-in
  // modal preview — lets parents (e.g. the /files route) render the file in
  // their own side editor.
  onOpenFile?: (entry: FileEntry) => void
  // Path of the currently-open file, used to highlight the row.
  activePath?: string | null
  /** Dock on the left or right edge of the content area. Default: right. */
  side?: 'left' | 'right'
  hidden?: boolean
  className?: string
}

type ContextMenuState = {
  x: number
  y: number
  entry: FileEntry
}

type PromptState = {
  mode: 'rename' | 'new-file' | 'new-folder'
  targetPath: string
  defaultValue?: string
}

const ROOT_LABEL = 'Workspace'
const PANEL_MIN_WIDTH = 180
const PANEL_MAX_WIDTH = 1200
const PANEL_DEFAULT_WIDTH = 280
const PANEL_WIDTH_STORAGE_KEY = 'hermes-workspace-files-panel-w'
const WS_DRAG_MIME = 'application/x-hermes-workspace-file'

function readStoredPanelWidth(): number {
  try {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY))
    if (
      Number.isFinite(saved) &&
      saved >= PANEL_MIN_WIDTH &&
      saved <= PANEL_MAX_WIDTH
    ) {
      return Math.round(saved)
    }
  } catch {
    /* ignore */
  }
  return PANEL_DEFAULT_WIDTH
}

async function postFilesJson(
  profileName: string,
  body: Record<string, unknown>,
) {
  const res = await fetch(withProfileQuery('/api/files', profileName), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean
    path?: string
    error?: string
    mode?: string
    remote?: boolean
  } | null
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`)
  }
  return data
}

async function uploadFilesToPath(
  profileName: string,
  targetPath: string,
  files: Array<File | { file: File; relativePath: string }>,
) {
  for (const item of files) {
    const file = item instanceof File ? item : item.file
    const relativePath = item instanceof File ? '' : item.relativePath
    const form = new FormData()
    form.append('action', 'upload')
    form.append('path', targetPath)
    if (relativePath) form.append('relativePath', relativePath)
    form.append('file', file)
    const res = await fetch(withProfileQuery('/api/files', profileName), {
      method: 'POST',
      body: form,
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: string
      } | null
      throw new Error(data?.error || `Upload failed (${res.status})`)
    }
  }
}

type FileSystemEntryLike = {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (
    success: (file: File) => void,
    error?: (err: DOMException) => void,
  ) => void
  createReader?: () => {
    readEntries: (
      success: (entries: Array<FileSystemEntryLike>) => void,
      error?: (err: DOMException) => void,
    ) => void
  }
}

async function readAllDirectoryEntries(
  reader: NonNullable<FileSystemEntryLike['createReader']> extends () => infer R
    ? R
    : never,
): Promise<Array<FileSystemEntryLike>> {
  const all: Array<FileSystemEntryLike> = []
  for (;;) {
    const batch = await new Promise<Array<FileSystemEntryLike>>(
      (resolve, reject) => {
        reader.readEntries(resolve, reject)
      },
    )
    if (!batch.length) break
    all.push(...batch)
  }
  return all
}

async function collectOsDropFiles(
  dataTransfer: DataTransfer,
): Promise<Array<{ file: File; relativePath: string }>> {
  const items = Array.from(dataTransfer.items || [])
  const hasEntries = items.some(
    (item) =>
      typeof (item as DataTransferItem & { webkitGetAsEntry?: () => unknown })
        .webkitGetAsEntry === 'function',
  )
  if (!hasEntries) {
    return Array.from(dataTransfer.files || []).map((file) => ({
      file,
      relativePath: file.name,
    }))
  }

  const out: Array<{ file: File; relativePath: string }> = []

  async function walk(entry: FileSystemEntryLike, prefix: string) {
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((resolve, reject) => {
        entry.file!(resolve, reject)
      })
      out.push({
        file,
        relativePath: prefix ? `${prefix}/${entry.name}` : entry.name,
      })
      return
    }
    if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader()
      const children = await readAllDirectoryEntries(reader)
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
      for (const child of children) {
        await walk(child, nextPrefix)
      }
    }
  }

  for (const item of items) {
    const entry = (
      item as DataTransferItem & {
        webkitGetAsEntry?: () => FileSystemEntryLike | null
      }
    ).webkitGetAsEntry?.()
    if (!entry) continue
    await walk(entry, '')
  }

  if (out.length === 0) {
    return Array.from(dataTransfer.files || []).map((file) => ({
      file,
      relativePath: file.name,
    }))
  }
  return out
}

function createTargetDir(entry: FileEntry) {
  return entry.type === 'folder' ? entry.path : getParentPath(entry.path)
}

function joinUnder(parent: string, name: string) {
  const clean = name.trim()
  if (!clean) return ''
  return parent ? `${parent}/${clean}` : clean
}

function isOsFilesDrag(event: React.DragEvent) {
  return Array.from(event.dataTransfer?.types || []).includes('Files')
}

function isWorkspaceMoveDrag(event: React.DragEvent) {
  return Array.from(event.dataTransfer?.types || []).includes(WS_DRAG_MIME)
}

function shortWorkspaceLabel(pathValue: string, folderName: string) {
  if (folderName.trim()) return folderName.trim()
  const parts = pathValue.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.at(-1) || ROOT_LABEL
}

function isImageFile(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)
}

function getFileIcon(entry: FileEntry) {
  if (entry.type === 'folder') return Folder01Icon
  if (isImageFile(entry.name)) return Image01Icon
  return File01Icon
}

function normalizePath(pathValue: string) {
  return pathValue.replace(/\\/g, '/')
}

function getParentPath(pathValue: string) {
  const normalized = normalizePath(pathValue)
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}

function buildReference(pathValue: string) {
  const normalized = normalizePath(pathValue)
  return `See file: workspace/${normalized}`
}

function findFileEntry(
  entries: Array<FileEntry>,
  pathValue: string,
): FileEntry | null {
  for (const entry of entries) {
    if (entry.path === pathValue) return entry
    if (entry.children?.length) {
      const nested = findFileEntry(entry.children, pathValue)
      if (nested) return nested
    }
  }
  return null
}

/** Depth-capped listings omit `children`. Keep those folders loadable on expand. */
function withLazyChildren(
  entries: Array<FileEntry>,
  lazyChildren: ReadonlyMap<string, Array<FileEntry>>,
): Array<FileEntry> {
  return entries.map((entry) => {
    if (entry.type !== 'folder') return entry
    const children =
      entry.children !== undefined
        ? entry.children
        : lazyChildren.get(entry.path)
    if (!children) return entry
    return { ...entry, children: withLazyChildren(children, lazyChildren) }
  })
}

function filterTree(entries: Array<FileEntry>, term: string): Array<FileEntry> {
  if (!term.trim()) return entries
  const lower = term.toLowerCase()
  const filterEntry = (entry: FileEntry): FileEntry | null => {
    if (entry.type === 'file') {
      return entry.name.toLowerCase().includes(lower) ? entry : null
    }
    const children = (entry.children || [])
      .map(filterEntry)
      .filter((child): child is FileEntry => child !== null)
    if (entry.name.toLowerCase().includes(lower) || children.length > 0) {
      return { ...entry, children }
    }
    return null
  }

  return entries
    .map(filterEntry)
    .filter((entry): entry is FileEntry => entry !== null)
}

export function FileExplorerSidebar({
  collapsed,
  onToggle,
  onInsertReference,
  onOpenFile,
  activePath = null,
  side = 'right',
  hidden = false,
  className,
}: FileExplorerSidebarProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [lazyChildren, setLazyChildren] = useState<
    Map<string, Array<FileEntry>>
  >(() => new Map())
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(
    () => new Set(),
  )
  const [search, setSearch] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [promptState, setPromptState] = useState<PromptState | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [panelWidth, setPanelWidth] = useState(readStoredPanelWidth)
  const [resizing, setResizing] = useState(false)
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [crudError, setCrudError] = useState<string | null>(null)
  const uploadTargetRef = useRef<string>('')
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const panelWidthRef = useRef(panelWidth)
  const nameClickTimerRef = useRef<number | null>(null)
  const renamingPathRef = useRef<string | null>(null)
  const skipRenameBlurRef = useRef(false)
  panelWidthRef.current = panelWidth
  renamingPathRef.current = renamingPath
  const workspaceQuery = useActiveWorkspace()
  const { workspaceProfileName } = useProfiles()
  const workspacePath = workspaceQuery.data?.path ?? ''
  const workspaceLabel = shortWorkspaceLabel(
    workspacePath,
    workspaceQuery.data?.folderName ?? '',
  )
  // Only treat as pending when we have nothing to show yet. Background
  // refetches (isFetching) used to keep the sidebar stuck on "Loading...".
  const workspacePending = !workspaceQuery.data && workspaceQuery.isPending
  const shallowQueryKey = useMemo(
    () => fileTreeQueryKey(workspaceProfileName, workspacePath, 0),
    [workspaceProfileName, workspacePath],
  )
  const deepQueryKey = useMemo(
    () => fileTreeQueryKey(workspaceProfileName, workspacePath, 3),
    [workspaceProfileName, workspacePath],
  )
  // Phase 1: top-level only — paint ASAP (own cache key, depth 0).
  const filesQuery = useQuery({
    queryKey: shallowQueryKey,
    queryFn: () =>
      fetchFileTree(workspaceProfileName, 0) as Promise<Array<FileEntry>>,
    enabled: Boolean(workspaceQuery.data) && Boolean(workspacePath),
    staleTime: 30_000,
    retry: false,
  })
  // Phase 2: deeper tree on a separate key so shallow prefetch/refetch cannot
  // clobber multi-level expand data.
  const deepQuery = useQuery({
    queryKey: deepQueryKey,
    queryFn: () =>
      fetchFileTree(workspaceProfileName, 3) as Promise<Array<FileEntry>>,
    enabled: Boolean(workspaceQuery.data) && Boolean(workspacePath),
    staleTime: 30_000,
    retry: false,
  })
  const entries = useMemo(() => {
    const base =
      ((deepQuery.data ?? filesQuery.data) as Array<FileEntry> | undefined) ??
      []
    return withLazyChildren(base, lazyChildren)
  }, [deepQuery.data, filesQuery.data, lazyChildren])
  const loading =
    workspacePending ||
    (Boolean(workspacePath) &&
      (filesQuery.isPending ||
        // Profile/workspace switch clears local entries before the new tree
        // lands; treat that gap as loading, not "empty".
        (entries.length === 0 &&
          (filesQuery.isFetching || deepQuery.isFetching)) ||
        (entries.length === 0 &&
          filesQuery.data === undefined &&
          deepQuery.data === undefined)))
  const error =
    filesQuery.error instanceof Error
      ? filesQuery.error.message
      : deepQuery.error instanceof Error && !filesQuery.data
        ? deepQuery.error.message
        : null
  const showEmpty =
    Boolean(workspacePath) &&
    !loading &&
    !error &&
    entries.length === 0 &&
    filesQuery.isFetched &&
    !filesQuery.isFetching

  const refresh = useCallback(async () => {
    await Promise.all([filesQuery.refetch(), deepQuery.refetch()])
  }, [filesQuery, deepQuery])

  useEffect(() => {
    setExpanded(new Set())
    setLazyChildren(new Map())
    setLoadingFolders(new Set())
    setPreviewPath(null)
    setContextMenu(null)
    setRenamingPath(null)
    setDropTargetPath(null)
    setCrudError(null)
  }, [workspacePath, workspaceProfileName])

  useEffect(() => {
    return () => {
      if (nameClickTimerRef.current != null) {
        window.clearTimeout(nameClickTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const handleClick = () => setContextMenu(null)
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    // Defer contextmenu closer so the opening right-click cannot immediately
    // clear the menu (same-event bubble used to race setState(null)).
    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleEscape)
    const timer = window.setTimeout(() => {
      window.addEventListener('contextmenu', handleClick)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('click', handleClick)
      window.removeEventListener('contextmenu', handleClick)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [contextMenu])

  const filteredEntries = useMemo(
    () => filterTree(entries, search),
    [entries, search],
  )

  const isSearchActive = search.trim().length > 0

  const loadFolderChildren = useCallback(
    (pathValue: string) => {
      const node = findFileEntry(entries, pathValue)
      if (!node || node.type !== 'folder' || node.children) return
      if (loadingFolders.has(pathValue)) return
      setLoadingFolders((prev) => {
        const next = new Set(prev)
        next.add(pathValue)
        return next
      })
      void fetchFileTree(workspaceProfileName, 0, pathValue)
        .then((children) => {
          setLazyChildren((prev) => {
            const next = new Map(prev)
            next.set(pathValue, children as Array<FileEntry>)
            return next
          })
        })
        .catch((err: unknown) => {
          setCrudError(
            err instanceof Error ? err.message : 'Failed to open folder',
          )
        })
        .finally(() => {
          setLoadingFolders((prev) => {
            const next = new Set(prev)
            next.delete(pathValue)
            return next
          })
        })
    },
    [entries, loadingFolders, workspaceProfileName],
  )

  const toggleFolder = useCallback(
    (pathValue: string) => {
      const opening = !expanded.has(pathValue)
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(pathValue)) next.delete(pathValue)
        else next.add(pathValue)
        return next
      })
      if (opening) loadFolderChildren(pathValue)
    },
    [expanded, loadFolderChildren],
  )

  const openPrompt = useCallback((state: PromptState) => {
    setPromptState(state)
    setPromptValue(state.defaultValue || '')
  }, [])

  const startInlineRename = useCallback((entry: FileEntry) => {
    skipRenameBlurRef.current = false
    renamingPathRef.current = entry.path
    setRenamingPath(entry.path)
    setRenameDraft(entry.name)
    setContextMenu(null)
  }, [])

  const handleRename = useCallback(
    (entry: FileEntry) => {
      startInlineRename(entry)
    },
    [startInlineRename],
  )

  const handleNewFile = useCallback(
    (targetDir: string) => {
      openPrompt({ mode: 'new-file', targetPath: targetDir })
    },
    [openPrompt],
  )

  const handleNewFolder = useCallback(
    (targetDir: string) => {
      openPrompt({ mode: 'new-folder', targetPath: targetDir })
    },
    [openPrompt],
  )

  const absoluteWorkspacePath = useCallback(
    (relPath: string) => {
      const root = workspacePath.replace(/[/\\]+$/, '')
      if (!relPath) return root || '.'
      if (!root) return relPath
      return `${root}/${relPath.replace(/^[/\\]+/, '')}`
    },
    [workspacePath],
  )

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* ignore */
      }
      ta.remove()
    }
  }, [])

  const handleDelete = useCallback(
    async (entry: FileEntry) => {
      if (!window.confirm(`Delete ${entry.name}?`)) return
      setCrudError(null)
      try {
        await postFilesJson(workspaceProfileName, {
          action: 'delete',
          path: entry.path,
        })
        if (
          previewPath === entry.path ||
          (entry.type === 'folder' && previewPath?.startsWith(`${entry.path}/`))
        ) {
          setPreviewPath(null)
        }
        await refresh()
      } catch (err) {
        setCrudError(err instanceof Error ? err.message : String(err))
      }
    },
    [previewPath, refresh, workspaceProfileName],
  )

  const handleDownload = useCallback(
    async (entry: FileEntry) => {
      const action = entry.type === 'folder' ? 'download-folder' : 'download'
      const res = await fetch(
        buildFilesApiUrl(action, entry.path, workspaceProfileName),
      )
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string
        } | null
        toast(data?.error || `Download failed (${res.status})`, {
          type: 'error',
        })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download =
        entry.type === 'folder'
          ? `${entry.name || 'workspace'}.zip`
          : entry.name
      anchor.click()
      URL.revokeObjectURL(url)
    },
    [workspaceProfileName],
  )

  const handleReveal = useCallback(
    async (entry: FileEntry) => {
      try {
        const data = await postFilesJson(workspaceProfileName, {
          action: 'reveal',
          path: entry.path || '.',
        })
        if (data?.mode === 'clipboard' && data.path) {
          await copyText(data.path)
          toast('Remote path copied (file manager unavailable over SSH)')
          return
        }
        toast('Revealed in file manager')
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), {
          type: 'error',
        })
      }
    },
    [copyText, workspaceProfileName],
  )

  const handleOpenInEditor = useCallback(
    async (entry: FileEntry) => {
      try {
        const data = await postFilesJson(workspaceProfileName, {
          action: 'open-vscode',
          path: entry.path || '.',
        })
        toast(
          data?.remote ? 'Opening remote path in editor' : 'Opened in editor',
        )
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), {
          type: 'error',
        })
      }
    },
    [workspaceProfileName],
  )

  const handleCopyAbsolutePath = useCallback(
    async (relPath: string) => {
      try {
        const res = await fetch(
          buildFilesApiUrl('abspath', relPath, workspaceProfileName),
        )
        const data = (await res.json().catch(() => null)) as {
          path?: string
          error?: string
        } | null
        if (!res.ok || !data?.path) {
          throw new Error(
            data?.error || `Failed to resolve path (${res.status})`,
          )
        }
        await copyText(data.path)
        toast('Path copied')
      } catch (err) {
        // Fallback to client join
        try {
          await copyText(absoluteWorkspacePath(relPath))
          toast('Path copied')
        } catch {
          toast(err instanceof Error ? err.message : String(err), {
            type: 'error',
          })
        }
      }
    },
    [absoluteWorkspacePath, copyText, workspaceProfileName],
  )

  const handleUploadClick = useCallback((targetPath: string) => {
    uploadTargetRef.current = targetPath
    uploadInputRef.current?.click()
  }, [])

  const handleUploadFiles = useCallback(
    async (
      targetPath: string,
      files: Array<File | { file: File; relativePath: string }>,
    ) => {
      if (files.length === 0) return
      setCrudError(null)
      try {
        await uploadFilesToPath(workspaceProfileName, targetPath, files)
        await refresh()
        toast(
          files.length === 1
            ? 'Uploaded 1 file'
            : `Uploaded ${files.length} files`,
        )
      } catch (err) {
        setCrudError(err instanceof Error ? err.message : String(err))
      }
    },
    [refresh, workspaceProfileName],
  )

  const handleUploadChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || [])
      event.target.value = ''
      await handleUploadFiles(uploadTargetRef.current || '', files)
    },
    [handleUploadFiles],
  )

  const cancelInlineRename = useCallback(() => {
    skipRenameBlurRef.current = true
    renamingPathRef.current = null
    setRenamingPath(null)
  }, [])

  const handleMoveEntry = useCallback(
    async (srcPath: string, destDir: string, srcType: FileEntry['type']) => {
      const srcParent = getParentPath(srcPath)
      if (srcPath === destDir) return
      if (destDir.startsWith(`${srcPath}/`)) return
      if (srcParent === destDir) return
      const name = srcPath.split('/').pop() || srcPath
      const nextPath = joinUnder(destDir, name)
      setCrudError(null)
      try {
        await postFilesJson(workspaceProfileName, {
          action: 'rename',
          from: srcPath,
          to: nextPath,
        })
        if (previewPath === srcPath) setPreviewPath(nextPath)
        else if (
          srcType === 'folder' &&
          previewPath?.startsWith(`${srcPath}/`)
        ) {
          setPreviewPath(previewPath.replace(srcPath, nextPath))
        }
        await refresh()
      } catch (err) {
        setCrudError(err instanceof Error ? err.message : String(err))
      }
    },
    [previewPath, refresh, workspaceProfileName],
  )

  // applyInlineRename placed after cancel helpers above was removed — redefine here
  const applyInlineRename = useCallback(
    async (entry: FileEntry, nextName: string) => {
      if (renamingPathRef.current !== entry.path) return
      renamingPathRef.current = null
      setRenamingPath(null)
      skipRenameBlurRef.current = true
      const value = nextName.trim()
      if (!value || value === entry.name) return
      const parent = getParentPath(entry.path)
      const nextPath = joinUnder(parent, value)
      setCrudError(null)
      try {
        await postFilesJson(workspaceProfileName, {
          action: 'rename',
          from: entry.path,
          to: nextPath,
        })
        if (previewPath === entry.path) setPreviewPath(nextPath)
        else if (
          entry.type === 'folder' &&
          previewPath?.startsWith(`${entry.path}/`)
        ) {
          setPreviewPath(previewPath.replace(entry.path, nextPath))
        }
        await refresh()
      } catch (err) {
        setCrudError(err instanceof Error ? err.message : String(err))
      }
    },
    [previewPath, refresh, workspaceProfileName],
  )

  const handlePromptSubmit = useCallback(async () => {
    if (!promptState) return
    const value = promptValue.trim()
    if (!value) return
    setCrudError(null)

    try {
      if (promptState.mode === 'rename') {
        const parent = getParentPath(promptState.targetPath)
        const nextPath = joinUnder(parent, value)
        await postFilesJson(workspaceProfileName, {
          action: 'rename',
          from: promptState.targetPath,
          to: nextPath,
        })
        if (previewPath === promptState.targetPath) setPreviewPath(nextPath)
      } else if (promptState.mode === 'new-folder') {
        const nextPath = joinUnder(promptState.targetPath, value)
        await postFilesJson(workspaceProfileName, {
          action: 'mkdir',
          path: nextPath,
        })
      } else {
        const nextPath = joinUnder(promptState.targetPath, value)
        await postFilesJson(workspaceProfileName, {
          action: 'write',
          path: nextPath,
          content: '',
        })
        setPromptState(null)
        setPromptValue('')
        await refresh()
        onInsertReference(buildReference(nextPath))
        if (onOpenFile) {
          onOpenFile({ name: value, path: nextPath, type: 'file' })
        } else if (classifyFilePreviewKind(nextPath) !== 'download') {
          setPreviewPath(nextPath)
        }
        return
      }

      setPromptState(null)
      setPromptValue('')
      await refresh()
    } catch (err) {
      setCrudError(err instanceof Error ? err.message : String(err))
    }
  }, [
    onInsertReference,
    onOpenFile,
    previewPath,
    promptState,
    promptValue,
    refresh,
    workspaceProfileName,
  ])

  const openEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.type === 'folder') {
        toggleFolder(entry.path)
        return
      }
      onInsertReference(buildReference(entry.path))
      if (onOpenFile) {
        onOpenFile(entry)
        return
      }
      if (classifyFilePreviewKind(entry.path) === 'download') {
        void handleDownload(entry)
        return
      }
      setPreviewPath(entry.path)
    },
    [handleDownload, onInsertReference, onOpenFile, toggleFolder],
  )

  const handleNameClick = useCallback(
    (entry: FileEntry) => {
      // Folders toggle immediately. Files use a short debounce so dblclick can
      // cancel open and rename — keep this << previous 280ms delay.
      if (entry.type === 'folder') {
        openEntry(entry)
        return
      }
      if (nameClickTimerRef.current != null) {
        window.clearTimeout(nameClickTimerRef.current)
      }
      nameClickTimerRef.current = window.setTimeout(() => {
        nameClickTimerRef.current = null
        openEntry(entry)
      }, 50)
    },
    [openEntry],
  )

  const handleNameDoubleClick = useCallback(
    (entry: FileEntry) => {
      if (nameClickTimerRef.current != null) {
        window.clearTimeout(nameClickTimerRef.current)
        nameClickTimerRef.current = null
      }
      if (entry.type === 'folder') return
      startInlineRename(entry)
    },
    [startInlineRename],
  )

  const renderEntry = useCallback(
    (entry: FileEntry, depth: number) => {
      const Icon = getFileIcon(entry)
      const isExpanded = isSearchActive ? true : expanded.has(entry.path)
      const padding = 12 + depth * 14
      const isActiveFile =
        (activePath === entry.path || previewPath === entry.path) &&
        entry.type === 'file'
      const isDropTarget =
        entry.type === 'folder' && dropTargetPath === entry.path
      const isRenaming = renamingPath === entry.path

      return (
        <div key={entry.path} data-file-row>
          <div
            draggable={!isRenaming}
            onDragStart={(event) => {
              event.dataTransfer.setData(
                WS_DRAG_MIME,
                JSON.stringify({
                  path: entry.path,
                  type: entry.type,
                  name: entry.name,
                }),
              )
              event.dataTransfer.effectAllowed = 'copyMove'
            }}
            onDragEnd={() => setDropTargetPath(null)}
            onDragEnter={(event) => {
              if (entry.type !== 'folder') return
              if (isWorkspaceMoveDrag(event) || isOsFilesDrag(event)) {
                event.preventDefault()
                event.stopPropagation()
                setDropTargetPath(entry.path)
              }
            }}
            onDragOver={(event) => {
              if (entry.type !== 'folder') return
              if (isWorkspaceMoveDrag(event)) {
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'move'
                setDropTargetPath(entry.path)
              } else if (isOsFilesDrag(event)) {
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'copy'
                setDropTargetPath(entry.path)
              }
            }}
            onDragLeave={(event) => {
              if (
                event.currentTarget.contains(event.relatedTarget as Node | null)
              ) {
                return
              }
              if (dropTargetPath === entry.path) setDropTargetPath(null)
            }}
            onDrop={(event) => {
              if (entry.type !== 'folder') return
              event.preventDefault()
              event.stopPropagation()
              setDropTargetPath(null)
              if (isOsFilesDrag(event)) {
                void collectOsDropFiles(event.dataTransfer).then((files) => {
                  void handleUploadFiles(entry.path, files)
                })
                return
              }
              if (!isWorkspaceMoveDrag(event)) return
              try {
                const raw = event.dataTransfer.getData(WS_DRAG_MIME)
                const payload = JSON.parse(raw) as {
                  path?: string
                  type?: FileEntry['type']
                }
                if (!payload.path || !payload.type) return
                void handleMoveEntry(payload.path, entry.path, payload.type)
              } catch {
                /* ignore */
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setContextMenu({
                x: event.clientX,
                y: event.clientY,
                entry,
              })
            }}
            className={cn(
              'group flex w-full items-center gap-2 rounded-md py-1.5 text-left text-sm text-primary-900',
              'hover:bg-primary-200',
              isActiveFile &&
                'bg-accent-100 font-medium text-accent-800 hover:bg-accent-100',
              isDropTarget &&
                'bg-accent-50 outline outline-1 outline-accent-400',
            )}
            style={{ paddingLeft: padding }}
          >
            <button
              type="button"
              className="inline-flex items-center justify-center"
              onClick={(event) => {
                event.stopPropagation()
                if (entry.type === 'folder') toggleFolder(entry.path)
              }}
            >
              {entry.type === 'folder' ? (
                <span
                  className={cn(
                    'transition-transform',
                    isExpanded ? 'rotate-90' : 'rotate-0',
                  )}
                >
                  <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
                </span>
              ) : (
                <span className="w-4" />
              )}
            </button>
            <HugeiconsIcon icon={Icon} size={18} strokeWidth={1.6} />
            {isRenaming ? (
              <input
                autoFocus
                value={renameDraft}
                className="min-w-0 flex-1 rounded border border-primary-300 bg-primary-50 px-1 py-0.5 text-sm text-primary-900 outline-none focus:ring-1 focus:ring-primary-400"
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={() => cancelInlineRename()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void applyInlineRename(entry, renameDraft)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelInlineRename()
                  }
                }}
              />
            ) : (
              <button
                type="button"
                title={
                  entry.type === 'file' ? 'Double-click to rename' : undefined
                }
                className="min-w-0 flex-1 truncate text-left"
                onClick={(event) => {
                  event.stopPropagation()
                  handleNameClick(entry)
                }}
                onDoubleClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  handleNameDoubleClick(entry)
                }}
              >
                {entry.name}
              </button>
            )}
          </div>
          {entry.type === 'folder' &&
          isExpanded &&
          !entry.children &&
          loadingFolders.has(entry.path) ? (
            <div
              className="py-1 text-xs text-primary-500"
              style={{ paddingLeft: padding + 14 }}
            >
              Loading…
            </div>
          ) : null}
          {entry.type === 'folder' && isExpanded && entry.children?.length ? (
            <div>
              {entry.children.map((child) => renderEntry(child, depth + 1))}
            </div>
          ) : null}
        </div>
      )
    },
    [
      activePath,
      applyInlineRename,
      cancelInlineRename,
      dropTargetPath,
      expanded,
      handleMoveEntry,
      handleNameClick,
      handleNameDoubleClick,
      handleUploadFiles,
      isSearchActive,
      loadingFolders,
      previewPath,
      renameDraft,
      renamingPath,
      toggleFolder,
    ],
  )

  const handleTreeDragOver = useCallback((event: React.DragEvent) => {
    if (isWorkspaceMoveDrag(event) || isOsFilesDrag(event)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = isWorkspaceMoveDrag(event)
        ? 'move'
        : 'copy'
      setDropTargetPath('')
    }
  }, [])

  const handleTreeDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDropTargetPath(null)
      if (isOsFilesDrag(event)) {
        void collectOsDropFiles(event.dataTransfer).then((files) => {
          void handleUploadFiles('', files)
        })
        return
      }
      if (!isWorkspaceMoveDrag(event)) return
      try {
        const raw = event.dataTransfer.getData(WS_DRAG_MIME)
        const payload = JSON.parse(raw) as {
          path?: string
          type?: FileEntry['type']
        }
        if (!payload.path || !payload.type) return
        void handleMoveEntry(payload.path, '', payload.type)
      } catch {
        /* ignore */
      }
    },
    [handleMoveEntry, handleUploadFiles],
  )

  const closePreview = useCallback(() => setPreviewPath(null), [])
  // webui model: same panel for browse + preview; only the body swaps.
  const previewActive = Boolean(previewPath) && !onOpenFile

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return
      event.preventDefault()
      const handle = event.currentTarget
      const startX = event.clientX
      const startWidth = panelWidthRef.current
      let currentWidth = startWidth
      handle.setPointerCapture(event.pointerId)
      setResizing(true)
      document.body.classList.add('select-none')
      document.body.style.cursor = 'col-resize'

      const onMove = (ev: PointerEvent) => {
        const delta =
          side === 'right' ? startX - ev.clientX : ev.clientX - startX
        currentWidth = Math.min(
          PANEL_MAX_WIDTH,
          Math.max(PANEL_MIN_WIDTH, Math.round(startWidth + delta)),
        )
        panelWidthRef.current = currentWidth
        setPanelWidth(currentWidth)
      }
      const onUp = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId)
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onUp)
        setResizing(false)
        document.body.classList.remove('select-none')
        document.body.style.cursor = ''
        try {
          localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(currentWidth))
        } catch {
          /* ignore */
        }
      }

      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
    },
    [collapsed, side],
  )

  if (hidden) return null

  if (collapsed) {
    return (
      <TooltipProvider>
        <TooltipRoot>
          <TooltipTrigger
            type="button"
            onClick={onToggle}
            aria-label="Show workspace panel"
            aria-expanded={false}
            className={cn(
              'fixed right-2.5 top-1/2 z-30 inline-flex h-11 w-[34px] -translate-y-1/2 items-center justify-center',
              'rounded-full border border-primary-300 bg-primary-50 text-primary-600 shadow-[0_10px_28px_rgba(0,0,0,0.22)]',
              'transition-[color,background-color,border-color] duration-150',
              'hover:border-accent-500 hover:bg-primary-100 hover:text-primary-900',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400',
              className,
            )}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} size={14} strokeWidth={2} />
          </TooltipTrigger>
          <TooltipContent
            side="left"
            className="px-2.5 py-1.5 text-[11.5px] font-semibold tracking-wide"
          >
            Show workspace panel
          </TooltipContent>
        </TooltipRoot>
      </TooltipProvider>
    )
  }

  return (
    <aside
      className={cn(
        'bg-primary-100 relative h-full flex flex-col opacity-100',
        resizing ? '' : 'transition-[width] duration-200 ease-out',
        side === 'right'
          ? 'border-l border-primary-200'
          : 'border-r border-primary-200',
        className,
      )}
      style={{ width: panelWidth }}
      data-panel-mode={previewActive ? 'preview' : 'browse'}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize files panel"
        title="Drag to resize"
        onPointerDown={handleResizePointerDown}
        className={cn(
          'absolute top-0 z-20 h-full w-1.5 cursor-col-resize touch-none',
          'hover:bg-accent-400/40 active:bg-accent-500/50',
          side === 'right'
            ? 'left-0 -translate-x-1/2'
            : 'right-0 translate-x-1/2',
          resizing && 'bg-accent-500/50',
        )}
      />

      <div className="flex items-center justify-between h-12 px-3 border-b border-primary-200">
        <div
          className="min-w-0 truncate text-sm font-semibold text-primary-900"
          title={
            previewActive && previewPath
              ? previewPath
              : workspacePath || undefined
          }
        >
          {previewActive && previewPath
            ? previewPath.split(/[\\/]/).pop() || previewPath
            : workspaceLabel}
        </div>
        <div className="flex items-center gap-1">
          {!previewActive ? (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={refresh}
                title="Refresh"
              >
                <HugeiconsIcon icon={RefreshIcon} size={18} />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => handleUploadClick('')}
                title="Upload"
              >
                <HugeiconsIcon icon={Upload01Icon} size={18} />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => handleNewFile('')}
                title="New file"
              >
                <HugeiconsIcon icon={PlusSignIcon} size={18} />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => handleNewFolder('')}
                title="New folder"
              >
                <HugeiconsIcon icon={Folder01Icon} size={18} />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={onToggle}
                title="Hide workspace panel"
                aria-label="Hide workspace panel"
              >
                <HugeiconsIcon icon={ArrowRight01Icon} size={18} />
              </Button>
            </>
          ) : (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={closePreview}
              title="Close preview"
              aria-label="Close preview"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={18} />
            </Button>
          )}
        </div>
      </div>

      {previewActive && previewPath ? (
        <FilePanelPreview
          path={previewPath}
          profileName={workspaceProfileName}
          onClose={closePreview}
          onSaved={refresh}
          className="min-h-0 flex-1"
        />
      ) : (
        <>
          <div className="px-3 py-2">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search files"
              className="w-full rounded-md border border-primary-200 bg-primary-50 px-2 py-1 text-sm text-primary-900 placeholder:text-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-300"
            />
            {crudError ? (
              <p className="mt-1.5 text-xs text-red-700 text-pretty">
                {crudError}
              </p>
            ) : null}
          </div>

          <ScrollAreaRoot className="flex-1 min-h-0">
            <ScrollAreaViewport
              className={cn(
                'px-1',
                dropTargetPath === '' &&
                  'bg-accent-50/60 outline outline-1 outline-accent-400 outline-offset-[-1px]',
              )}
              onDragOver={handleTreeDragOver}
              onDragLeave={(event) => {
                if (
                  event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  return
                }
                if (dropTargetPath === '') setDropTargetPath(null)
              }}
              onDrop={handleTreeDrop}
              onContextMenu={(event) => {
                if ((event.target as HTMLElement).closest('[data-file-row]')) {
                  return
                }
                event.preventDefault()
                event.stopPropagation()
                setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  entry: { name: workspaceLabel, path: '', type: 'folder' },
                })
              }}
            >
              {' '}
              {loading ? (
                <div className="px-3 py-2 text-xs text-primary-500">
                  Loading…
                </div>
              ) : !workspacePath ? (
                <div className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
                  <div className="flex size-10 items-center justify-center rounded-xl border border-primary-200 bg-primary-100/60">
                    <HugeiconsIcon
                      icon={Folder01Icon}
                      size={20}
                      strokeWidth={1.5}
                      className="text-primary-500"
                    />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-primary-800">
                      No workspace selected
                    </p>
                    <p className="mt-1 text-xs text-primary-500 text-pretty">
                      Select a folder to browse and edit files.
                    </p>
                  </div>
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
                  <div className="flex size-10 items-center justify-center rounded-xl border border-primary-200 bg-primary-100/60">
                    <HugeiconsIcon
                      icon={Folder01Icon}
                      size={20}
                      strokeWidth={1.5}
                      className="text-primary-500"
                    />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-primary-800">
                      Couldn't load workspace files
                    </p>
                    <p className="mt-1 text-xs text-primary-500 text-pretty">
                      {error}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={refresh}
                    className="mt-1"
                  >
                    <HugeiconsIcon icon={RefreshIcon} size={16} />
                    Retry
                  </Button>
                </div>
              ) : showEmpty ? (
                <div className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
                  <div className="flex size-10 items-center justify-center rounded-xl border border-primary-200 bg-primary-100/60">
                    <HugeiconsIcon
                      icon={Folder01Icon}
                      size={20}
                      strokeWidth={1.5}
                      className="text-primary-500"
                    />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-primary-800">
                      Workspace is empty
                    </p>
                    <p className="mt-1 text-xs text-primary-500 text-pretty">
                      Create files or upload content to get started.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleNewFile('')}
                    >
                      <HugeiconsIcon icon={PlusSignIcon} size={16} />
                      New file
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleUploadClick('')}
                    >
                      <HugeiconsIcon icon={Upload01Icon} size={16} />
                      Upload
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="pb-4">
                  {filteredEntries.map((entry) => renderEntry(entry, 0))}
                </div>
              )}
            </ScrollAreaViewport>
            <ScrollAreaScrollbar orientation="vertical">
              <ScrollAreaThumb />
            </ScrollAreaScrollbar>
            <ScrollAreaScrollbar orientation="horizontal">
              <ScrollAreaThumb />
            </ScrollAreaScrollbar>
            <ScrollAreaCorner />
          </ScrollAreaRoot>
        </>
      )}

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleUploadChange}
      />

      {contextMenu ? (
        <div
          className="fixed z-[80] min-w-[180px] rounded-lg bg-primary-50 p-1 text-sm text-primary-900 shadow-lg outline outline-primary-900/10"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <button
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
            onClick={() => {
              handleNewFile(createTargetDir(contextMenu.entry))
              setContextMenu(null)
            }}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={16} /> New file
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
            onClick={() => {
              handleNewFolder(createTargetDir(contextMenu.entry))
              setContextMenu(null)
            }}
          >
            <HugeiconsIcon icon={Folder01Icon} size={16} /> New folder
          </button>
          {contextMenu.entry.path ? (
            <>
              <div className="my-1 border-t border-primary-200" />
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
                onClick={() => {
                  handleRename(contextMenu.entry)
                  setContextMenu(null)
                }}
              >
                <HugeiconsIcon icon={Pen01Icon} size={16} /> Rename
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
                onClick={() => {
                  void handleReveal(contextMenu.entry)
                  setContextMenu(null)
                }}
              >
                Reveal in file manager
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
                onClick={() => {
                  void handleOpenInEditor(contextMenu.entry)
                  setContextMenu(null)
                }}
              >
                <HugeiconsIcon icon={SourceCodeIcon} size={16} /> Open in editor
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
                onClick={() => {
                  void handleCopyAbsolutePath(contextMenu.entry.path)
                  setContextMenu(null)
                }}
              >
                Copy path
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
                onClick={() => {
                  void copyText(contextMenu.entry.path || '.').then(() =>
                    toast('Relative path copied'),
                  )
                  setContextMenu(null)
                }}
              >
                Copy relative path
              </button>
            </>
          ) : (
            <>
              <div className="my-1 border-t border-primary-200" />
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
                onClick={() => {
                  void handleReveal(contextMenu.entry)
                  setContextMenu(null)
                }}
              >
                Reveal in file manager
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
                onClick={() => {
                  void handleOpenInEditor(contextMenu.entry)
                  setContextMenu(null)
                }}
              >
                <HugeiconsIcon icon={SourceCodeIcon} size={16} /> Open in editor
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
                onClick={() => {
                  void handleCopyAbsolutePath('')
                  setContextMenu(null)
                }}
              >
                Copy path
              </button>
            </>
          )}
          {contextMenu.entry.type === 'folder' ? (
            <>
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
                onClick={() => {
                  handleUploadClick(contextMenu.entry.path)
                  setContextMenu(null)
                }}
              >
                <HugeiconsIcon icon={Upload01Icon} size={16} /> Upload
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
                onClick={() => {
                  void handleDownload(contextMenu.entry)
                  setContextMenu(null)
                }}
              >
                <HugeiconsIcon icon={Download01Icon} size={16} /> Download
                folder
              </button>
            </>
          ) : (
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-100"
              onClick={() => {
                void handleDownload(contextMenu.entry)
                setContextMenu(null)
              }}
            >
              <HugeiconsIcon icon={Download01Icon} size={16} /> Download
            </button>
          )}
          {contextMenu.entry.path ? (
            <>
              <div className="my-1 border-t border-primary-200" />
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-red-700 hover:bg-red-50/80"
                onClick={() => {
                  void handleDelete(contextMenu.entry)
                  setContextMenu(null)
                }}
              >
                <HugeiconsIcon icon={Delete01Icon} size={16} /> Delete
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <DialogRoot
        open={Boolean(promptState)}
        onOpenChange={(open) => {
          if (!open) setPromptState(null)
        }}
      >
        <DialogContent>
          <div className="p-5 space-y-3">
            <DialogTitle>
              {promptState?.mode === 'rename'
                ? 'Rename'
                : promptState?.mode === 'new-folder'
                  ? 'New Folder'
                  : 'New File'}
            </DialogTitle>
            <DialogDescription>
              {promptState?.mode === 'rename'
                ? 'Enter a new name.'
                : 'Enter a name to create.'}
            </DialogDescription>
            <input
              value={promptValue}
              onChange={(event) => setPromptValue(event.target.value)}
              className="w-full rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900 focus:outline-none focus:ring-2 focus:ring-primary-300"
              autoFocus
            />
            <div className="flex justify-end gap-2 pt-2">
              <DialogClose render={<Button variant="outline">Cancel</Button>} />
              <Button onClick={handlePromptSubmit}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </DialogRoot>
    </aside>
  )
}
