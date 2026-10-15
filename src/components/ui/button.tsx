'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-normal transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-[var(--theme-accent)]/35 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 select-none',
  {
    defaultVariants: {
      size: 'default',
      variant: 'default',
    },
    variants: {
      size: {
        default: 'h-9 px-3',
        sm: 'h-8 px-2.5',
        lg: 'h-10 px-4',
        icon: 'size-9',
        'icon-sm': 'size-8',
        'icon-md': 'size-9',
        'icon-xl': 'size-10 [&_svg]:size-5',
      },
      variant: {
        /* Primary CTA — filled */
        default:
          'border border-transparent bg-[var(--theme-accent)] text-white hover:bg-[var(--theme-accent-secondary)]',
        /* Quiet fill chip — color lift only, no outline border */
        secondary:
          'border border-transparent bg-[var(--theme-input)] text-[var(--theme-text)] hover:bg-[var(--theme-card2)]',
        outline:
          'border border-transparent bg-[var(--theme-input)] text-[var(--theme-text)] hover:bg-[var(--theme-card2)]',
        ghost:
          'border border-transparent text-[var(--theme-text)] hover:bg-[var(--transparency-hover)]',
        /* Soft danger: red ink on tinted panel */
        destructive:
          'border border-transparent bg-[color-mix(in_srgb,var(--theme-danger)_12%,var(--theme-input))] text-[var(--theme-danger)] hover:bg-[color-mix(in_srgb,var(--theme-danger)_18%,var(--theme-input))]',
      },
    },
  },
)

interface ButtonProps extends useRender.ComponentProps<'button'> {
  variant?: VariantProps<typeof buttonVariants>['variant']
  size?: VariantProps<typeof buttonVariants>['size']
}

function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>['type'] =
    render ? undefined : 'button'

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    'data-slot': 'button',
    type: typeValue,
  }

  return useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(defaultProps, props),
    render,
  })
}

export { Button, buttonVariants }
