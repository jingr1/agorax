'use client'

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react'
import type { Ref } from 'react'

import { useAutocompleteFilter } from '@/components/ui/autocomplete'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { HERMES_SLASH_COMMANDS } from '@/screens/chat/slash-commands/hermes'
import type { SlashCommandDefinition } from '@/screens/chat/slash-commands/types'

export type { SlashCommandDefinition }

export type SlashCommandMenuProps = {
  open: boolean
  query: string
  onSelect: (command: SlashCommandDefinition) => void
  commands?: Array<SlashCommandDefinition>
}

export type SlashCommandMenuHandle = {
  moveSelection: (step: number) => void
  selectActive: () => boolean
}

/** @deprecated Prefer HERMES_SLASH_COMMANDS from slash-commands/hermes */
export const DEFAULT_SLASH_COMMANDS = HERMES_SLASH_COMMANDS

export function mergeSlashCommands(
  base: Array<SlashCommandDefinition>,
  additions: Array<SlashCommandDefinition>,
): Array<SlashCommandDefinition> {
  const merged: Array<SlashCommandDefinition> = []
  const seen = new Set<string>()

  for (const entry of [...base, ...additions]) {
    const command = entry.command.trim()
    if (!command || seen.has(command)) continue
    seen.add(command)
    merged.push({
      command,
      description: entry.description.trim() || 'Run command',
    })
  }

  return merged
}

const SlashCommandMenu = forwardRef(function SlashCommandMenu(
  {
    open,
    query,
    onSelect,
    commands = DEFAULT_SLASH_COMMANDS,
  }: SlashCommandMenuProps,
  ref: Ref<SlashCommandMenuHandle>,
) {
  const [activeIndex, setActiveIndex] = useState(0)
  const filter = useAutocompleteFilter({ sensitivity: 'base' })

  const filteredCommands = useMemo(() => {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) return commands

    return commands.filter((item) =>
      filter.contains(
        item,
        normalizedQuery,
        (target) => `${target.command} ${target.description}`,
      ),
    )
  }, [commands, filter, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [open, query])

  useEffect(() => {
    if (filteredCommands.length === 0) {
      setActiveIndex(0)
      return
    }
    setActiveIndex((previous) =>
      Math.max(0, Math.min(previous, filteredCommands.length - 1)),
    )
  }, [filteredCommands.length])

  useImperativeHandle(
    ref,
    () => ({
      moveSelection(step: number) {
        if (!open || filteredCommands.length === 0) return
        const direction = step >= 0 ? 1 : -1
        setActiveIndex((previous) => {
          const next = previous + direction
          if (next < 0) return filteredCommands.length - 1
          if (next >= filteredCommands.length) return 0
          return next
        })
      },
      selectActive() {
        if (!open || filteredCommands.length === 0) return false
        const selected = filteredCommands[activeIndex]
        if (!selected) return false
        onSelect(selected)
        return true
      },
    }),
    [activeIndex, filteredCommands, onSelect, open],
  )

  if (!open) return null

  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-[calc(100%+0.5rem)] z-[70]">
      <div
        className="pointer-events-auto overflow-hidden rounded-xl border border-primary-200 shadow-lg"
        style={{
          background: 'var(--color-surface, var(--theme-card, #1a1f2e))',
        }}
      >
        <Command
          items={filteredCommands}
          value={query}
          onValueChange={() => {}}
          mode="none"
          autoHighlight={false}
          keepHighlight={false}
        >
          {filteredCommands.length === 0 ? (
            <div className="px-3 py-2 text-sm text-primary-600">
              No commands found
            </div>
          ) : (
            <CommandList className="max-h-60 min-h-0">
              {filteredCommands.map((item, index) => (
                <CommandItem
                  key={item.command}
                  value={item.command}
                  onSelect={() => onSelect(item)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onSelect(item)
                  }}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 text-sm transition-colors',
                    index === activeIndex &&
                      'bg-neutral-100 dark:bg-neutral-800',
                  )}
                >
                  <span className="font-mono text-[var(--color-accent,#6366f1)]">
                    {item.command}
                  </span>
                  <span className="text-primary-600">{item.description}</span>
                </CommandItem>
              ))}
            </CommandList>
          )}
        </Command>
      </div>
    </div>
  )
})

export { SlashCommandMenu }
export default SlashCommandMenu
