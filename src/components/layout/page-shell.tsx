import type * as React from 'react'
import { cn } from '@/lib/utils'

const WIDTH_CLASS = {
  default: 'max-w-[1200px]',
  wide: 'max-w-[1600px]',
  full: 'max-w-none',
} as const

export type PageShellWidth = keyof typeof WIDTH_CLASS

type PageShellProps = {
  width?: PageShellWidth
  className?: string
  contentClassName?: string
  style?: React.CSSProperties
  children: React.ReactNode
}

/** Scrollable page frame for list / overview screens (Skills, MCP, Jobs…). */
export function PageShell({
  width = 'default',
  className,
  contentClassName,
  style,
  children,
}: PageShellProps) {
  return (
    <div
      className={cn('min-h-full overflow-y-auto bg-surface text-fg', className)}
      style={style}
    >
      <div
        className={cn(
          'mx-auto flex w-full flex-col gap-5 px-4 py-6 pb-[calc(var(--tabbar-h,80px)+1.5rem)] sm:px-6 lg:px-8',
          WIDTH_CLASS[width],
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  )
}
