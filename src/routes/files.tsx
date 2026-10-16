import { useCallback, useEffect, useMemo, useState } from 'react'
import { Editor } from '@monaco-editor/react'
import { createFileRoute } from '@tanstack/react-router'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Download01Icon,
  ExternalLink,
  File01Icon,
} from '@hugeicons/core-free-icons'
import { PageHeader } from '@/components/layout/page-header'
import { Markdown } from '@/components/prompt-kit/markdown'
import { Button } from '@/components/ui/button'
import {
  ScrollAreaCorner,
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '@/components/ui/scroll-area'
import { usePageTitle } from '@/hooks/use-page-title'
import { useActiveWorkspace } from '@/hooks/use-active-workspace'
import { FileExplorerSidebar } from '@/components/file-explorer'
import type { FileEntry } from '@/components/file-explorer/file-explorer-sidebar'
import { resolveTheme, useSettings } from '@/hooks/use-settings'

const PLACEHOLDER_VALUE = `// Files workspace
// Click a file in the tree to load it into this editor.
`

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  sql: 'sql',
  xml: 'xml',
  dockerfile: 'dockerfile',
  env: 'plaintext',
  log: 'plaintext',
  txt: 'plaintext',
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

function getExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function languageFor(name: string): string {
  if (/^Dockerfile$/i.test(name)) return 'dockerfile'
  return LANGUAGE_BY_EXT[getExt(name)] ?? 'plaintext'
}

type LoadedFile = {
  path: string
  name: string
  language: string
  content: string
  imageDataUrl: string | null
  loading: boolean
  error: string | null
  dirty: boolean
}

export const Route = createFileRoute('/files')({
  ssr: false,
  component: FilesRoute,
  errorComponent: function FilesError({ error }) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center bg-primary-50">
        <h2 className="text-xl font-semibold text-primary-900 mb-3">
          Failed to Load Files
        </h2>
        <p className="text-sm text-primary-600 mb-4 max-w-md">
          {error instanceof Error
            ? error.message
            : 'An unexpected error occurred'}
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-accent-500 text-white rounded-lg hover:bg-accent-600 transition-colors"
        >
          Reload Page
        </button>
      </div>
    )
  },
  pendingComponent: function FilesPending() {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-accent-500 border-r-transparent mb-3" />
          <p className="text-sm text-primary-500">Loading file explorer...</p>
        </div>
      </div>
    )
  },
})

function FilesRoute() {
  usePageTitle('Files')
  const { settings } = useSettings()
  const workspaceQuery = useActiveWorkspace()
  const workspacePath = workspaceQuery.data?.path ?? ''
  const [isMobile, setIsMobile] = useState(false)
  const [fileExplorerCollapsed, setFileExplorerCollapsed] = useState(false)
  const [loaded, setLoaded] = useState<LoadedFile | null>(null)
  const [renderMarkdown, setRenderMarkdown] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const resolvedTheme = resolveTheme(settings.theme)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!isMobile) return
    setFileExplorerCollapsed(true)
  }, [isMobile])

  useEffect(() => {
    if (!workspaceQuery.isFetched) return
    setLoaded(null)
  }, [workspacePath, workspaceQuery.isFetched])

  const handleInsertReference = useCallback(() => {
    // Reference insertion is only useful when there's a composer; on this
    // route we just want the click to open the file, so ignore.
  }, [])

  const handleOpenFile = useCallback(async (entry: FileEntry) => {
    const ext = getExt(entry.name)
    const isImage = IMAGE_EXTS.has(ext)
    setLoaded({
      path: entry.path,
      name: entry.name,
      language: languageFor(entry.name),
      content: '',
      imageDataUrl: null,
      loading: true,
      error: null,
      dirty: false,
    })
    try {
      const res = await fetch(
        `/api/files?action=read&path=${encodeURIComponent(entry.path)}`,
      )
      if (!res.ok) throw new Error(`Failed to read file (${res.status})`)
      const data = (await res.json()) as {
        type: 'text' | 'image'
        content: string
      }
      setLoaded({
        path: entry.path,
        name: entry.name,
        language: languageFor(entry.name),
        content: data.type === 'text' ? data.content : '',
        imageDataUrl:
          data.type === 'image' || isImage ? data.content || null : null,
        loading: false,
        error: null,
        dirty: false,
      })
    } catch (err) {
      setLoaded((prev) =>
        prev && prev.path === entry.path
          ? {
              ...prev,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : prev,
      )
    }
  }, [])

  const handleDownload = useCallback(() => {
    if (!loaded) return
    const url = `/api/files?action=download&path=${encodeURIComponent(loaded.path)}`
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = loaded.name
    anchor.click()
  }, [loaded])

  const handleOpenInTab = useCallback(() => {
    if (!loaded) return
    const url = `/api/files?action=view&path=${encodeURIComponent(loaded.path)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [loaded])

  const handleSave = useCallback(async () => {
    if (!loaded || !loaded.dirty || loaded.imageDataUrl) return
    setSaving(true)
    try {
      const res = await fetch('/api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'write',
          path: loaded.path,
          content: loaded.content,
        }),
      })
      if (!res.ok) throw new Error(`Save failed (${res.status})`)
      setLoaded((prev) => (prev ? { ...prev, dirty: false } : prev))
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 1500)
    } catch (err) {
      setLoaded((prev) =>
        prev
          ? {
              ...prev,
              error: err instanceof Error ? err.message : String(err),
            }
          : prev,
      )
    } finally {
      setSaving(false)
    }
  }, [loaded])

  const isMarkdown = loaded?.language === 'markdown'
  const isImage = Boolean(loaded?.imageDataUrl)
  const editorValue = loaded?.content ?? PLACEHOLDER_VALUE
  const editorLanguage = useMemo(
    () => (loaded ? loaded.language : 'plaintext'),
    [loaded],
  )

  return (
    <div className="h-full min-h-0 overflow-hidden bg-surface text-fg">
      <div className="flex h-full min-h-0 overflow-hidden">
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <PageHeader
            variant="bar"
            icon={File01Icon}
            title={
              loaded ? <span title={loaded.path}>{loaded.name}</span> : 'Files'
            }
            meta={
              loaded?.dirty ? (
                <span className="text-accent">unsaved changes</span>
              ) : savedFlash ? (
                <span className="text-success">saved</span>
              ) : undefined
            }
            description={
              loaded
                ? loaded.path
                : 'Click a file in the sidebar to load it into the editor.'
            }
            actions={
              loaded ? (
                <>
                  {isMarkdown && !isImage ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRenderMarkdown((v) => !v)}
                    >
                      {renderMarkdown ? 'Edit' : 'Preview'}
                    </Button>
                  ) : null}
                  {!isImage ? (
                    <Button
                      size="sm"
                      onClick={handleSave}
                      disabled={!loaded.dirty || saving}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleOpenInTab}
                    title="Open this file in a new browser tab"
                  >
                    <HugeiconsIcon
                      icon={ExternalLink}
                      size={14}
                      strokeWidth={1.6}
                    />
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleDownload}
                    title="Download this file to your computer"
                  >
                    <HugeiconsIcon
                      icon={Download01Icon}
                      size={14}
                      strokeWidth={1.6}
                    />
                    Download
                  </Button>
                </>
              ) : undefined
            }
          />
          <div className="min-h-0 flex-1 pb-24 md:pb-0">
            {loaded?.loading ? (
              <div className="flex h-full items-center justify-center text-sm text-fg-muted">
                Loading…
              </div>
            ) : loaded?.error ? (
              <div className="flex h-full items-center justify-center p-6 text-sm text-danger">
                {loaded.error}
              </div>
            ) : isImage && loaded?.imageDataUrl ? (
              <div className="flex h-full items-center justify-center overflow-auto p-6">
                <img
                  src={loaded.imageDataUrl}
                  alt={loaded.name}
                  className="max-h-full max-w-full rounded-lg border border-primary-200 shadow-sm object-contain"
                />
              </div>
            ) : isMarkdown && renderMarkdown && loaded ? (
              <ScrollAreaRoot className="h-full">
                <ScrollAreaViewport>
                  <div className="markdown-preview mx-auto max-w-4xl px-6 py-5 text-sm text-primary-900">
                    <Markdown className="gap-3">{loaded.content}</Markdown>
                  </div>
                </ScrollAreaViewport>
                <ScrollAreaScrollbar orientation="vertical">
                  <ScrollAreaThumb />
                </ScrollAreaScrollbar>
                <ScrollAreaCorner />
              </ScrollAreaRoot>
            ) : (
              <Editor
                height="100%"
                theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs-light'}
                language={editorLanguage}
                value={editorValue}
                onChange={(value) => {
                  if (!loaded) return
                  setLoaded({
                    ...loaded,
                    content: value ?? '',
                    dirty: (value ?? '') !== loaded.content,
                  })
                }}
                options={{
                  minimap: { enabled: settings.editorMinimap },
                  fontSize: settings.editorFontSize,
                  scrollBeyondLastLine: false,
                  wordWrap: settings.editorWordWrap ? 'on' : 'off',
                  readOnly: !loaded,
                }}
              />
            )}
          </div>
        </main>
        <FileExplorerSidebar
          collapsed={fileExplorerCollapsed}
          onToggle={() => setFileExplorerCollapsed((prev) => !prev)}
          onInsertReference={handleInsertReference}
          onOpenFile={handleOpenFile}
          activePath={loaded?.path ?? null}
          side="right"
        />
      </div>
    </div>
  )
}
