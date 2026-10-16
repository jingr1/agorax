import { Search01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import type * as React from 'react'
import { cn } from '@/lib/utils'

/** Filter / search row; pair with `<Section className="p-3">`. */
export function Toolbar({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {children}
    </div>
  )
}

type ToolbarSearchProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type'
>

export function ToolbarSearch({ className, ...props }: ToolbarSearchProps) {
  return (
    <div className={cn('relative min-w-0 flex-1 sm:min-w-[220px]', className)}>
      <HugeiconsIcon
        icon={Search01Icon}
        size={14}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted"
      />
      <input
        type="text"
        className="h-9 w-full rounded-lg border border-border bg-input pl-8 pr-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-accent"
        {...props}
      />
    </div>
  )
}

type ToolbarSelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label: string
}

export function ToolbarSelect({
  label,
  className,
  children,
  ...props
}: ToolbarSelectProps) {
  return (
    <label className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border bg-input px-3 text-xs text-fg-muted">
      <span className="text-[10px] font-medium uppercase tracking-wider">
        {label}
      </span>
      <select
        className={cn(
          'h-7 max-w-[180px] rounded-md bg-input text-xs text-fg outline-none',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    </label>
  )
}
