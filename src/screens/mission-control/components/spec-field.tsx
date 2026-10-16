'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog'
import { RoomWorkspaceField } from '@/screens/group-chat/components/room-workspace-field'

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
  /** Hide the built-in tip row so the parent can place the button. */
  hideToolbar?: boolean
  /** Receives the opener, then null on unmount. */
  onAttachReady?: (open: (() => void) | null) => void
}

export function SpecField({
  value,
  onChange,
  rows = 4,
  placeholder,
  disabled,
  className,
  hideToolbar = false,
  onAttachReady,
}: SpecFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [fieldMounted, setFieldMounted] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const openPicker = useCallback(() => {
    setPathDraft('')
    setFieldMounted(true)
    setPickerOpen(true)
  }, [])

  useEffect(() => {
    onAttachReady?.(openPicker)
    return () => onAttachReady?.(null)
  }, [onAttachReady, openPicker])

  const insertPath = useCallback(
    (path: string) => {
      const trimmed = path.trim()
      if (!trimmed) return
      const el = textareaRef.current
      const start = el?.selectionStart ?? value.length
      const end = el?.selectionEnd ?? value.length
      const { next, caret } = insertAtSelection(
        value,
        start,
        end,
        formatPathRef(trimmed),
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

  return (
    <div className={cn('relative', className)}>
      {hideToolbar ? null : (
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[10px] text-[var(--theme-muted)]">
            Tip: Attach path… or drop a workspace file
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={openPicker}
            className="h-6 px-2 text-[10px]"
          >
            Attach path…
          </Button>
        </div>
      )}
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

      <DialogRoot
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open)
          if (!open) setPathDraft('')
        }}
        onOpenChangeComplete={(open) => {
          if (!open) setFieldMounted(false)
        }}
      >
        <DialogContent className="w-[min(520px,92vw)]">
          <div className="p-4">
            <DialogTitle className="mb-1">Attach path</DialogTitle>
            <DialogDescription className="mb-3">
              Enter a path or pick a file. The path is inserted into the spec.
            </DialogDescription>
            {fieldMounted ? (
              <RoomWorkspaceField
                includeFiles
                value={pathDraft}
                onChange={setPathDraft}
              />
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <DialogClose
                render={
                  <Button variant="ghost" type="button">
                    Cancel
                  </Button>
                }
              />
              <Button
                type="button"
                disabled={!pathDraft.trim()}
                onClick={() => {
                  insertPath(pathDraft)
                  setPickerOpen(false)
                  setPathDraft('')
                }}
              >
                Attach
              </Button>
            </div>
          </div>
        </DialogContent>
      </DialogRoot>
    </div>
  )
}
