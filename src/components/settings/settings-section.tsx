import type * as React from 'react'
import { HugeiconsIcon } from '@hugeicons/react'

/** Shared control chrome for settings selects/inputs (matches SettingsSection). */
export const SETTINGS_CONTROL_CLASS =
  'control-surface h-9 w-full rounded-lg px-3 text-sm text-primary-900 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--theme-accent)]/35'

type SectionProps = {
  title: string
  description?: string
  icon: React.ComponentProps<typeof HugeiconsIcon>['icon']
  children: React.ReactNode
  /** Optional trailing meta in the header (badge, path, etc.). */
  trailing?: React.ReactNode
}

export function SettingsSection({
  title,
  description,
  icon,
  children,
  trailing,
}: SectionProps) {
  return (
    <section className="rounded-2xl border border-primary-200 bg-primary-50/80 p-4 shadow-sm backdrop-blur-xl md:p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary-200 bg-primary-100/70">
          <HugeiconsIcon icon={icon} size={20} strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-medium text-primary-900 text-balance">
              {title}
            </h2>
            {trailing}
          </div>
          {description ? (
            <p className="text-sm text-primary-600 text-pretty">{description}</p>
          ) : null}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

type RowProps = {
  label: string
  description?: string
  children: React.ReactNode
  /** Stack controls under the label (useful for wide selects). */
  stacked?: boolean
}

export function SettingsRow({
  label,
  description,
  children,
  stacked = false,
}: RowProps) {
  return (
    <div
      className={
        stacked
          ? 'flex flex-col gap-2'
          : 'flex flex-col items-start gap-3 md:flex-row md:items-center md:justify-between'
      }
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-primary-900 text-balance">
          {label}
        </p>
        {description ? (
          <p className="text-xs text-primary-600 text-pretty">{description}</p>
        ) : null}
      </div>
      <div
        className={
          stacked
            ? 'w-full'
            : 'flex w-full items-center gap-2 md:w-auto md:justify-end'
        }
      >
        {children}
      </div>
    </div>
  )
}
