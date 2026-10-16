import type * as React from 'react'
import { cn } from '@/lib/utils'

type SectionProps = {
  title?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
  children?: React.ReactNode
}

/** Standard content block inside PageShell. */
export function Section({
  title,
  description,
  actions,
  className,
  children,
}: SectionProps) {
  const hasHeader = Boolean(title || description || actions)
  return (
    <section
      className={cn('rounded-xl border border-border bg-panel p-4', className)}
    >
      {hasHeader ? (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? (
              <h2 className="text-sm font-semibold text-fg">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-xs text-fg-muted text-pretty">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}
