'use client'

import { Switch as SwitchPrimitive } from '@base-ui/react/switch'

import { cn } from '@/lib/utils'

/**
 * Compact Tutti-style switch: 32×18 track, accent when on, no ON/OFF glyphs.
 */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent outline-none transition-[background-color,border-color,box-shadow] duration-150',
        'focus-visible:border-[var(--theme-focus)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--theme-focus)_30%,transparent)]',
        'data-checked:bg-[var(--theme-accent)] data-unchecked:bg-[color-mix(in_srgb,var(--theme-muted)_45%,var(--theme-panel))]',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-150',
          'data-checked:translate-x-[14px] data-unchecked:translate-x-px',
        )}
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
