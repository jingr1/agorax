'use client'

import { Select } from '@base-ui/react/select'
import { cn } from '@/lib/utils'

type SelectRootProps<T> = React.ComponentProps<typeof Select.Root<T>>

function SelectRoot<T>({ children, ...props }: SelectRootProps<T>) {
  return <Select.Root {...props}>{children}</Select.Root>
}

type SelectTriggerProps = React.ComponentProps<typeof Select.Trigger>

function SelectTrigger({ className, children, ...props }: SelectTriggerProps) {
  return (
    <Select.Trigger
      className={cn(
        'control-surface flex h-9 w-full items-center justify-between rounded-md px-3 py-2 text-sm transition-[background-color] duration-150 hover:bg-[var(--theme-card2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-accent)]/35',
        className,
      )}
      style={{
        color: 'var(--theme-text)',
      }}
      {...props}
    >
      {children}
      <Select.Icon className="ml-2 opacity-50">▼</Select.Icon>
    </Select.Trigger>
  )
}

type SelectValueProps = React.ComponentProps<typeof Select.Value>

function SelectValue({ placeholder, ...props }: SelectValueProps) {
  return <Select.Value placeholder={placeholder} {...props} />
}

type SelectContentProps = {
  className?: string
  children: React.ReactNode
}

function SelectContent({ className, children }: SelectContentProps) {
  return (
    <Select.Portal>
      <Select.Positioner>
        <Select.Popup
          className={cn(
            'z-50 max-h-[min(24rem,60vh)] min-w-[var(--select-trigger-width)] overflow-auto rounded-md border border-transparent p-1 text-sm shadow-lg',
            className,
          )}
          style={{
            background: 'var(--theme-card2, var(--theme-card))',
            color: 'var(--theme-text)',
            boxShadow: 'var(--theme-shadow-3)',
          }}
        >
          {children}
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  )
}

type SelectItemProps = React.ComponentProps<typeof Select.Item>

function SelectItem({ className, children, ...props }: SelectItemProps) {
  return (
    <Select.Item
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm select-none outline-none data-[highlighted]:bg-[var(--transparency-hover)] data-[selected]:bg-[var(--theme-accent-subtle)]',
        className,
      )}
      style={{
        color: 'var(--theme-text)',
      }}
      {...props}
    >
      <Select.ItemIndicator className="w-4 text-center">✓</Select.ItemIndicator>
      <Select.ItemText>{children}</Select.ItemText>
    </Select.Item>
  )
}

export {
  SelectRoot as Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
}
