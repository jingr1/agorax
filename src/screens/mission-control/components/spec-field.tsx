'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Folder01Icon,
  File01Icon,
  ArrowLeft01Icon,
} from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  fetchFileTree,
  type FileTreeEntry,
} from '@/lib/workspace-client'

/** Matches file-explorer-sidebar drag payload. */
const WS_DRAG_MIME = 'application/x-hermes-workspace-file'

function formatPathRef(path: string): string {
  return `\`${path}\``
}

function insertAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  insert: string,
): { next: string; caret: number } {
  const before = value.slice(0, selectionStart)
  const after = value.slice(selectionEnd)
  const needsLeadingNewline =
    before.length > 0 && !before.endsWith('\n') && !before.endsWith(' ')
  const chunk = `${needsLeadingNewline ? '\n' : ''}${insert}`
  const next = `${before}${chunk}${after}`
  return { next, caret: before.length + chunk.length }
}

type SpecFieldProps = {
  value: string
  onChange: (value: string) => void
  rows?: number
  placeholder?: string
  disabled?: boolean
  className?: string
  /** Optional profile for /api/files listing. Empty = active workspace. */
  profileName?: string
}

export function SpecField({
  value,
  onChange,
  rows = 4,
  placeholder,
  disabled,
  className,
  profileName = '',
}: SpecFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dirPath, setDirPath] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const insertPath = useCallback(
    (path: string) => {
      const el = textareaRef.current
      const start = el?.selectionStart ?? value.length
      const end = el?.selectionEnd ?? value.length
      const { next, caret } = insertAtSelection(
        value,
        start,
        end,
        formatPathRef(path),
      )
      onChange(next)
      requestAnimationFrame(() => {
        el?.focus()
        try {
          el?.setSelectionRange(caret, caret)
        } catch {
          /* ignore */
        }
      })
    },
    [onChange, value],
  )

  const filesQuery = useQuery({
    queryKey: ['mission-control', 'spec-files', profileName, dirPath],
    queryFn: () => fetchFileTree(profileName, 0, dirPath),
    enabled: pickerOpen,
  })

  useEffect(() => {
    if (!pickerOpen) setDirPath('')
  }, [pickerOpen])

  const onDrop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    if (disabled) return
    const types = Array.from(event.dataTransfer.types || [])
    if (!types.includes(WS_DRAG_MIME)) return
    event.preventDefault()
    setDragOver(false)
    try {
      const raw = event.dataTransfer.getData(WS_DRAG_MIME)
      const payload = JSON.parse(raw) as {
        path?: string
        type?: string
        name?: string
      }
      if (!payload.path || payload.type === 'folder') return
      insertPath(payload.path)
    } catch {
      /* ignore */
    }
  }

  const parentDir = dirPath.includes('/')
    ? dirPath.slice(0, dirPath.lastIndexOf('/'))
    : ''

  return (
    <div className={cn('relative', className)}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] text-[var(--theme-muted)]">
          Tip: Attach path… or drop a workspace file
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => setPickerOpen(true)}
          className="h-6 px-2 text-[10px]"
        >
          Attach path…
        </Button>
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onDragEnter={(e) => {
          if (Array.from(e.dataTransfer.types || []).includes(WS_DRAG_MIME)) {
            e.preventDefault()
            setDragOver(true)
          }
        }}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types || []).includes(WS_DRAG_MIME)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setDragOver(true)
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          'mt-0 w-full rounded-md field-surface px-2 py-1.5 text-sm',
          dragOver
            ? 'border-[var(--theme-accent)] ring-1 ring-[var(--theme-accent)]'
            : '',
        )}
      />

      {pickerOpen ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[70vh] w-full max-w-md flex-col rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] shadow-xl">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--theme-border)] px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                {dirPath ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDirPath(parentDir)}
                    aria-label="Up"
                  >
                    <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
                  </Button>
                ) : null}
                <h3 className="truncate text-xs font-semibold">
                  {dirPath || 'Workspace'}
                </h3>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setPickerOpen(false)}
                className="h-6 px-2 text-[10px]"
              >
                Close
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {filesQuery.isLoading ? (
                <p className="px-2 py-3 text-xs text-[var(--theme-muted)]">
                  Loading…
                </p>
              ) : filesQuery.isError ? (
                <p className="px-2 py-3 text-xs text-red-600">
                  {(filesQuery.error as Error).message || 'Failed to list files'}
                </p>
              ) : (filesQuery.data ?? []).length === 0 ? (
                <p className="px-2 py-3 text-xs text-[var(--theme-muted)]">
                  Empty folder
                </p>
              ) : (
                (filesQuery.data ?? []).map((entry: FileTreeEntry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-[var(--theme-hover)]"
                    onClick={() => {
                      if (entry.type === 'folder') {
                        setDirPath(entry.path)
                        return
                      }
                      insertPath(entry.path)
                      setPickerOpen(false)
                    }}
                  >
                    <HugeiconsIcon
                      icon={
                        entry.type === 'folder' ? Folder01Icon : File01Icon
                      }
                      size={14}
                    />
                    <span className="truncate">{entry.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
