'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Cancel01Icon,
  Download01Icon,
  ExternalLink,
  Pen01Icon,
} from '@hugeicons/core-free-icons'
import { Markdown } from '@/components/prompt-kit/markdown'
import { CodeBlock } from '@/components/prompt-kit/code-block'
import { Button } from '@/components/ui/button'
import { buildFilesApiUrl, withProfileQuery } from '@/lib/workspace-client'
import { cn } from '@/lib/utils'
import {
  buildCsvTablePreview,
  classifyFilePreviewKind,
  isEditablePreviewKind,
  languageFromPath,
  shouldRenderMarkdownAsPlainText,
  type FilePreviewKind,
} from './file-kind'

type FilePanelPreviewProps = {
  path: string
  profileName: string
  onClose: () => void
  onSaved?: () => void
  className?: string
}

export function FilePanelPreview({
  path,
  profileName,
  onClose,
  onSaved,
  className,
}: FilePanelPreviewProps) {
  const kind = useMemo(() => classifyFilePreviewKind(path), [path])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [forceRichMarkdown, setForceRichMarkdown] = useState(false)
  const loadAbortRef = useRef<AbortController | null>(null)

  const viewUrl = useMemo(
    () => buildFilesApiUrl('view', path, profileName),
    [path, profileName],
  )
  const downloadUrl = useMemo(
    () => buildFilesApiUrl('download', path, profileName),
    [path, profileName],
  )

  const fileName = path.split(/[\\/]/).pop() || path
  const codeLanguage = useMemo(() => languageFromPath(path), [path])

  const loadFile = useCallback(async () => {
    if (kind === 'download') return
    if (
      kind === 'pdf' ||
      kind === 'audio' ||
      kind === 'video' ||
      kind === 'image' ||
      kind === 'html'
    ) {
      setError(null)
      setLoading(false)
      setContent('')
      setDirty(false)
      setEditing(false)
      setForceRichMarkdown(false)
      return
    }

    const controller = new AbortController()
    loadAbortRef.current?.abort()
    loadAbortRef.current = controller

    setLoading(true)
    setError(null)
    setContent('')
    setDirty(false)
    setEditing(false)
    setForceRichMarkdown(false)
    try {
      const res = await fetch(buildFilesApiUrl('view', path, profileName), {
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`Failed to read file (${res.status})`)
      const text = await res.text()
      if (controller.signal.aborted) return
      setContent(text)
    } catch (err) {
      if (controller.signal.aborted) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [kind, path, profileName])

  const ensureTextContent = useCallback(async () => {
    if (content) return true
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(buildFilesApiUrl('view', path, profileName))
      if (!res.ok) throw new Error(`Failed to read file (${res.status})`)
      setContent(await res.text())
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setLoading(false)
    }
  }, [content, path, profileName])

  useEffect(() => {
    void loadFile()
    return () => {
      loadAbortRef.current?.abort()
    }
  }, [loadFile])

  useEffect(() => {
    if (kind !== 'download') return
    const anchor = document.createElement('a')
    anchor.href = downloadUrl
    anchor.download = fileName
    anchor.click()
    onClose()
  }, [downloadUrl, fileName, kind, onClose])

  const handleSave = useCallback(async () => {
    if (!isEditablePreviewKind(kind)) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(withProfileQuery('/api/files', profileName), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'write',
          path,
          content,
        }),
      })
      if (!res.ok) throw new Error(`Save failed (${res.status})`)
      setDirty(false)
      setEditing(false)
      onSaved?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [content, kind, onSaved, path, profileName])

  const handleEditToggle = useCallback(async () => {
    if (editing && dirty) {
      void handleSave()
      return
    }
    if (editing) {
      setEditing(false)
      return
    }
    if ((kind === 'html' || kind === 'csv') && !content) {
      const ok = await ensureTextContent()
      if (!ok) return
    }
    setEditing(true)
  }, [content, dirty, editing, ensureTextContent, handleSave, kind])

  const showEditToggle = isEditablePreviewKind(kind) && !loading && !error
  const markdownAsPlain =
    kind === 'markdown' &&
    !editing &&
    !forceRichMarkdown &&
    shouldRenderMarkdownAsPlainText(content)
  const csvPreview = useMemo(
    () => (kind === 'csv' && !editing ? buildCsvTablePreview(content) : null),
    [content, editing, kind],
  )

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-primary-50', className)}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-primary-200 px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[11px] font-medium text-primary-800"
            title={path}
          >
            {path}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-primary-400">
            {kindLabel(kind)}
          </div>
        </div>
        {markdownAsPlain ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={() => setForceRichMarkdown(true)}
            title="Render as markdown anyway"
          >
            Render MD
          </Button>
        ) : null}
        {showEditToggle ? (
          <Button
            size="sm"
            variant={editing ? 'default' : 'ghost'}
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => {
              void handleEditToggle()
            }}
            disabled={saving}
            title={editing ? (dirty ? 'Save' : 'Done') : 'Edit'}
          >
            <HugeiconsIcon icon={Pen01Icon} size={13} />
            {editing
              ? dirty
                ? saving
                  ? 'Saving…'
                  : 'Save'
                : 'Done'
              : 'Edit'}
          </Button>
        ) : null}
        {kind === 'html' || kind === 'pdf' || kind === 'image' ? (
          <Button
            size="icon-sm"
            variant="ghost"
            title="Open in browser"
            aria-label="Open in browser"
            onClick={() =>
              window.open(viewUrl, '_blank', 'noopener,noreferrer')
            }
          >
            <HugeiconsIcon icon={ExternalLink} size={14} />
          </Button>
        ) : null}
        {kind !== 'download' ? (
          <Button
            size="icon-sm"
            variant="ghost"
            title="Download"
            render={
              <a href={downloadUrl} download={fileName} aria-label="Download" />
            }
          >
            <HugeiconsIcon icon={Download01Icon} size={14} />
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
          title="Close preview"
          aria-label="Close preview"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={14} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {loading ? (
          <div className="px-2 py-4 text-xs text-primary-500">Loading…</div>
        ) : error ? (
          <div className="px-2 py-4 text-xs text-red-600">{error}</div>
        ) : kind === 'image' ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-primary-200 bg-primary-100/40 p-2">
            <img
              src={viewUrl}
              alt={path}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : kind === 'pdf' ? (
          <iframe
            title={`PDF preview: ${fileName}`}
            src={viewUrl}
            className="h-full min-h-[360px] w-full rounded-lg border border-primary-200 bg-white"
          />
        ) : kind === 'audio' ? (
          <div className="flex h-full items-center justify-center p-4">
            <audio controls preload="metadata" src={viewUrl} className="w-full">
              <track kind="captions" />
            </audio>
          </div>
        ) : kind === 'video' ? (
          <div className="flex h-full items-center justify-center">
            <video
              controls
              preload="metadata"
              src={viewUrl}
              className="max-h-full max-w-full rounded-lg border border-primary-200"
            >
              <track kind="captions" />
            </video>
          </div>
        ) : kind === 'html' && !editing ? (
          <iframe
            title={`HTML preview: ${fileName}`}
            src={viewUrl}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            className="h-full min-h-[360px] w-full rounded-lg border border-primary-200 bg-white"
          />
        ) : kind === 'csv' && !editing ? (
          csvPreview?.ok ? (
            <div className="overflow-auto rounded-lg border border-primary-200">
              <table className="min-w-full border-collapse text-left text-[11px]">
                <thead className="bg-primary-100 sticky top-0">
                  <tr>
                    {csvPreview.headers.map((header) => (
                      <th
                        key={header}
                        className="border-b border-primary-200 px-2 py-1.5 font-semibold text-primary-800"
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {csvPreview.rows.map((row, rowIdx) => (
                    <tr key={`r-${rowIdx}`} className="odd:bg-primary-50">
                      {row.map((cell, cellIdx) => (
                        <td
                          key={`c-${rowIdx}-${cellIdx}`}
                          className="border-b border-primary-100 px-2 py-1 text-primary-800 whitespace-pre"
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {csvPreview.truncated ? (
                <div className="px-2 py-1 text-[10px] text-primary-500">
                  Showing first 500 rows
                </div>
              ) : null}
            </div>
          ) : (
            <div className="px-2 py-4 text-xs text-primary-500">
              {csvPreview && !csvPreview.ok ? csvPreview.error : 'No CSV data'}
            </div>
          )
        ) : kind === 'markdown' && !editing && !markdownAsPlain ? (
          <div className="prose prose-sm dark:prose-invert max-w-none rounded-lg border border-primary-200 bg-primary-50 px-3 py-2">
            <Markdown className="text-sm">{content}</Markdown>
          </div>
        ) : kind === 'code' && !editing ? (
          <div className="overflow-auto rounded-lg border border-primary-200 bg-neutral-950">
            <CodeBlock content={content} language={codeLanguage} />
          </div>
        ) : (
          <textarea
            className="h-full min-h-[320px] w-full resize-none rounded-lg border border-primary-200 bg-neutral-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-300"
            value={content}
            readOnly={!editing}
            spellCheck={false}
            onChange={(event) => {
              setContent(event.target.value)
              setDirty(true)
            }}
          />
        )}
      </div>
    </div>
  )
}

function kindLabel(kind: FilePreviewKind): string {
  switch (kind) {
    case 'image':
      return 'Image'
    case 'audio':
      return 'Audio'
    case 'video':
      return 'Video'
    case 'pdf':
      return 'PDF'
    case 'markdown':
      return 'Markdown'
    case 'html':
      return 'HTML'
    case 'csv':
      return 'CSV'
    case 'download':
      return 'Download'
    default:
      return 'Code'
  }
}
