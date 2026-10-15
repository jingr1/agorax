'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

export type ConversationOutlineEntry = {
  id: string
  excerpt: string
}

export function ConversationOutline({
  entries,
  onJump,
  className,
}: {
  entries: Array<ConversationOutlineEntry>
  onJump: (messageId: string) => void
  className?: string
}) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <aside
      className={cn(
        'pointer-events-auto hidden w-[220px] shrink-0 flex-col border-l border-primary-200/70 bg-surface/95 backdrop-blur-md lg:flex',
        className,
      )}
      aria-label="Conversation outline"
    >
      <div className="flex items-center justify-between gap-2 border-b border-primary-200/60 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold tracking-wide text-primary-800">
            Outline
          </div>
          <div className="truncate text-[11px] text-primary-500">
            {entries.length === 0
              ? 'No questions yet'
              : `${entries.length} question${entries.length === 1 ? '' : 's'}`}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md px-1.5 py-0.5 text-[11px] text-primary-600 hover:bg-primary-100"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>
      {collapsed ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {entries.length === 0 ? (
            <p className="px-1 py-2 text-[11px] text-primary-500">
              User questions will appear here for quick jumps.
            </p>
          ) : (
            <ul className="space-y-1">
              {entries.map((entry, index) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1.5 text-left text-[12px] leading-snug text-primary-800 hover:bg-primary-100/80"
                    onClick={() => onJump(entry.id)}
                    title={entry.excerpt}
                  >
                    <span className="mr-1.5 inline-block w-4 text-[10px] text-primary-400">
                      {index + 1}.
                    </span>
                    {entry.excerpt}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  )
}
