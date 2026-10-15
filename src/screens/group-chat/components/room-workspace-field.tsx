'use client'

import { useEffect, useState } from 'react'
import {
  WorkspaceFolderPicker,
  preloadWorkspaceFolders,
} from '@/components/workspace-folder-picker'
import { cn } from '@/lib/utils'

type WorkspaceEntry = { name: string; path: string }

export function shortPathLabel(pathValue: string): string {
  const parts = pathValue.split(/[/\\]/).filter(Boolean)
  return parts.at(-1) || pathValue
}

async function fetchWorkspaceEntries(): Promise<Array<WorkspaceEntry>> {
  try {
    const res = await fetch('/api/workspace')
    if (!res.ok) return []
    const data = (await res.json()) as {
      workspaces?: Array<WorkspaceEntry>
      path?: string
    }
    const list = Array.isArray(data.workspaces) ? data.workspaces : []
    if (data.path && !list.some((w) => w.path === data.path)) {
      return [
        { name: shortPathLabel(data.path), path: data.path },
        ...list,
      ]
    }
    return list
  } catch {
    return []
  }
}

type RoomWorkspaceFieldProps = {
  value: string
  onChange: (path: string) => void
  className?: string
  /**
   * @deprecated Kept for call-site compatibility; picker always shows the
   * chat-style path input + folder tree.
   */
  compact?: boolean
}

/**
 * Room workspace picker — same layout as chat Workspace dialog:
 * Recent chips + shared WorkspaceFolderPicker (path input + home-rooted tree).
 * Empty value is allowed (no room cwd).
 */
export function RoomWorkspaceField({
  value,
  onChange,
  className,
}: RoomWorkspaceFieldProps) {
  const [entries, setEntries] = useState<Array<WorkspaceEntry>>([])

  useEffect(() => {
    void fetchWorkspaceEntries().then(setEntries)
    preloadWorkspaceFolders('')
  }, [])

  return (
    <div className={cn('space-y-3', className)}>
      {entries.length > 0 ? (
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--theme-muted)]">
            Recent
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => onChange('')}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs transition-colors',
                !value
                  ? 'border-[var(--theme-accent)] bg-[var(--theme-accent-soft)] text-[var(--theme-text)]'
                  : 'border-[var(--theme-border)] text-[var(--theme-muted)] hover:border-[var(--theme-accent)] hover:text-[var(--theme-text)]',
              )}
            >
              None
            </button>
            {entries.map((workspace) => {
              const selected = workspace.path === value
              return (
                <button
                  key={workspace.path}
                  type="button"
                  title={workspace.path}
                  onClick={() => onChange(workspace.path)}
                  className={cn(
                    'max-w-[10rem] truncate rounded-full border px-2.5 py-1 text-xs transition-colors',
                    selected
                      ? 'border-[var(--theme-accent)] bg-[var(--theme-accent-soft)] text-[var(--theme-text)]'
                      : 'border-[var(--theme-border)] text-[var(--theme-muted)] hover:border-[var(--theme-accent)] hover:text-[var(--theme-text)]',
                  )}
                >
                  {workspace.name || shortPathLabel(workspace.path)}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
      <WorkspaceFolderPicker value={value} onChange={onChange} />
    </div>
  )
}
