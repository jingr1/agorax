import { HugeiconsIcon } from '@hugeicons/react'
import type { IconSvgElement } from '@hugeicons/react'
import type * as React from 'react'
import { cn } from '@/lib/utils'

type PageHeaderProps = {
  icon?: IconSvgElement
  eyebrow?: React.ReactNode
  title: React.ReactNode
  /** Inline after the title, e.g. a count badge. */
  meta?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  /** Rendered under the title row (banners, notices). */
  children?: React.ReactNode
  /**
   * `card` — bordered block inside PageShell.
   * `bar` — compact top bar for full-height workspace screens.
   */
  variant?: 'card' | 'bar'
  className?: string
}

export function PageHeader({
  icon,
  eyebrow,
  title,
  meta,
  description,
  actions,
  children,
  variant = 'card',
  className,
}: PageHeaderProps) {
  const isBar = variant === 'bar'
  return (
    <header
      className={cn(
        isBar
          ? 'shrink-0 border-b border-border bg-surface px-3 py-2.5 md:px-4'
          : 'rounded-xl border border-border bg-panel px-5 py-4',
        className,
      )}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {icon ? (
            <div
              className={cn(
                'flex shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent',
                isBar ? 'size-8' : 'size-10',
              )}
            >
              <HugeiconsIcon
                icon={icon}
                size={isBar ? 16 : 20}
                strokeWidth={1.6}
              />
            </div>
          ) : null}
          <div className="min-w-0">
            {eyebrow ? (
              <p className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">
                {eyebrow}
              </p>
            ) : null}
            <div className="flex min-w-0 items-baseline gap-2">
              <h1
                className={cn(
                  'truncate font-semibold text-fg',
                  isBar ? 'text-sm' : 'text-lg',
                )}
              >
                {title}
              </h1>
              {meta ? (
                <span className="shrink-0 text-xs text-fg-muted tabular-nums">
                  {meta}
                </span>
              ) : null}
            </div>
            {description ? (
              <p
                className={cn(
                  'text-fg-muted',
                  isBar
                    ? 'hidden truncate text-xs sm:block'
                    : 'mt-0.5 text-sm text-pretty',
                )}
              >
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </header>
  )
}
