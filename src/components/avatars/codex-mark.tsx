import { cn } from '@/lib/utils'

type CodexMarkProps = {
  size?: number
  className?: string
  title?: string
}

/** Inline Codex CLI mark — avoids broken <img> when static SVG fails to parse. */
export function CodexMark({
  size = 80,
  className,
  title = 'Codex',
}: CodexMarkProps) {
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
      style={{ display: 'block' }}
    >
      <title>{title}</title>
      <rect x="4" y="4" width="72" height="72" rx="14" fill="#F5F5F5" />
      <rect
        x="4"
        y="4"
        width="72"
        height="72"
        rx="14"
        stroke="#10A37F"
        strokeOpacity={0.45}
        strokeWidth={1.5}
      />
      <text
        x="50%"
        y="54%"
        dominantBaseline="middle"
        textAnchor="middle"
        fill="#10A37F"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
        fontSize={28}
        fontWeight={600}
      >
        &gt;_
      </text>
    </svg>
  )
}
