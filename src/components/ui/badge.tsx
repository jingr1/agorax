'use client'

import { cn } from '@/lib/utils'

type BadgeProps = {
  children: React.ReactNode
  variant?:
    | 'default'
    | 'secondary'
    | 'outline'
    | 'destructive'
    | 'success'
    | 'warning'
  className?: string
}

const variants: Record<NonNullable<BadgeProps['variant']>, string> = {
  default: 'bg-primary-950 text-primary-50 hover:bg-primary-900',
  secondary: 'bg-primary-100 text-primary-900 hover:bg-primary-200',
  outline:
    'border border-primary-200 bg-transparent text-primary-900 hover:bg-primary-50',
  destructive: 'bg-red-600 text-primary-50 hover:bg-red-700',
  success: 'bg-emerald-600 text-primary-50 hover:bg-emerald-700',
  warning: 'bg-amber-500 text-primary-950 hover:bg-amber-600',
}

function Badge({ children, variant = 'default', className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium transition-colors',
        variants[variant],
        className,
      )}
    >
      {children}
    </span>
  )
}

export { Badge }
