import { cn } from '@/lib/utils'

type ClaudeCodeMarkProps = {
  size?: number
  className?: string
  title?: string
}

/** Inline Claude Code CLI mark — avoids broken <img> when static SVG fails to parse. */
export function ClaudeCodeMark({
  size = 80,
  className,
  title = 'Claude Code',
}: ClaudeCodeMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 80 80"
      width={size}
      height={size}
      fill="none"
      className={cn('shrink-0', className)}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <rect x="4" y="4" width="72" height="72" rx="14" fill="#1A1512" />
      <rect
        x="4"
        y="4"
        width="72"
        height="72"
        rx="14"
        stroke="#C4A484"
        strokeOpacity={0.35}
        strokeWidth={1.5}
      />
      <circle cx="18" cy="20" r="2.5" fill="#5C534A" />
      <circle cx="28" cy="20" r="2.5" fill="#5C534A" />
      <circle cx="38" cy="20" r="2.5" fill="#5C534A" />
      <path
        d="M22 38 L34 48 L22 58"
        stroke="#D97757"
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="42" y="44" width="18" height="3.5" rx="1.75" fill="#E8D5C4" />
    </svg>
  )
}
