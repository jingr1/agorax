'use client'

import { ArrowUp02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { memo, useRef } from 'react'
import { cn } from '@/lib/utils'
import {
  type ComposerPrimaryAction,
  composerPrimaryActionLabel,
} from '@/screens/chat/lib/composer-primary-action'

function QueueIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 5H3" />
      <path d="M16 12H3" />
      <path d="M9 19H3" />
      <path d="m16 16-3 3 3 3" />
      <path d="M21 5v12a2 2 0 0 1-2 2h-6" />
    </svg>
  )
}

function InterruptIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 4v16" />
      <path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z" />
    </svg>
  )
}

function SteerIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" />
    </svg>
  )
}

function StopIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  )
}

function ComposerPrimaryButtonComponent({
  action,
  onSend,
  onStop,
  compact = false,
}: {
  action: ComposerPrimaryAction
  onSend: () => void
  onStop: () => void
  compact?: boolean
}) {
  const isStop = action === 'stop'
  const isQueue = action === 'queue'
  const isInterrupt = action === 'interrupt'
  const isSteer = action === 'steer'
  const isDisabled = action === 'disabled'
  const label = composerPrimaryActionLabel(action)
  const sizeClass = compact ? 'size-9' : 'size-[34px]'
  const iconSize = compact ? 18 : 16
  const touchHandledRef = useRef(false)

  const activate = () => {
    if (isDisabled) return
    if (isStop) {
      onStop()
      return
    }
    onSend()
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (isDisabled || event.pointerType !== 'touch') return
    event.preventDefault()
    event.stopPropagation()
    touchHandledRef.current = true
    activate()
  }

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (touchHandledRef.current) {
      touchHandledRef.current = false
      return
    }
    activate()
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      disabled={isDisabled}
      aria-label={label}
      title={label}
      data-action={action}
      className={cn(
        'relative z-[1] inline-flex shrink-0 touch-manipulation items-center justify-center rounded-full border-0 text-white transition-all duration-150',
        sizeClass,
        isStop
          ? 'bg-red-500 shadow-[0_2px_10px_rgba(0,0,0,0.18)] hover:brightness-110 active:scale-95'
          : isQueue
            ? 'bg-amber-500 shadow-[0_2px_10px_rgba(0,0,0,0.16)] hover:brightness-110 active:scale-95'
            : isInterrupt
              ? 'bg-orange-500 shadow-[0_2px_10px_rgba(0,0,0,0.16)] hover:brightness-110 active:scale-95'
              : isSteer
                ? 'bg-sky-500 shadow-[0_2px_10px_rgba(0,0,0,0.16)] hover:brightness-110 active:scale-95'
                : 'bg-accent-500 shadow-[0_2px_8px_rgba(0,0,0,0.12)] hover:scale-[1.04] hover:shadow-[0_4px_14px_rgba(0,0,0,0.16)] active:scale-95',
        isDisabled &&
          'cursor-not-allowed opacity-35 shadow-none hover:scale-100',
      )}
    >
      {isStop ? (
        <StopIcon size={iconSize} />
      ) : isQueue ? (
        <QueueIcon size={iconSize} />
      ) : isInterrupt ? (
        <InterruptIcon size={iconSize} />
      ) : isSteer ? (
        <SteerIcon size={iconSize} />
      ) : (
        <HugeiconsIcon icon={ArrowUp02Icon} size={iconSize} strokeWidth={2.5} />
      )}
    </button>
  )
}

export const ComposerPrimaryButton = memo(ComposerPrimaryButtonComponent)
