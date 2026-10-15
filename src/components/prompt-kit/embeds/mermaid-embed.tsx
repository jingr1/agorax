import { useEffect, useState } from 'react'
import { CodeBlock } from '../code-block'
import { useIsDark } from './use-is-dark'
import { cn } from '@/lib/utils'

let lastTheme: 'dark' | 'default' | null = null

function ensureInit(
  mermaid: { initialize: (config: Record<string, unknown>) => void },
  dark: boolean,
) {
  const theme = dark ? 'dark' : 'default'
  if (theme === lastTheme) return
  mermaid.initialize({
    fontFamily: 'inherit',
    securityLevel: 'strict',
    startOnLoad: false,
    theme,
  })
  lastTheme = theme
}

type MermaidEmbedProps = {
  code: string
  className?: string
}

/**
 * Lazy-loads `mermaid` and renders ```mermaid fences as SVG.
 * Debounces while content is still streaming; falls back to source on error.
 */
export function MermaidEmbed({ code, className }: MermaidEmbedProps) {
  const isDark = useIsDark()
  const [svg, setSvg] = useState('')
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(true)

  useEffect(() => {
    let cancelled = false
    setPending(true)
    setFailed(false)

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const mermaid = (await import('mermaid')).default
          ensureInit(mermaid, isDark)
          const id = `mmd-${Math.random().toString(36).slice(2)}`
          const result = await mermaid.render(id, code)
          if (!cancelled) {
            setSvg(result.svg)
            setFailed(false)
            setPending(false)
          }
        } catch {
          if (!cancelled) {
            setFailed(true)
            setSvg('')
            setPending(false)
          }
        }
      })()
    }, 220)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [code, isDark])

  if (failed || (!svg && !pending)) {
    return <CodeBlock content={code} language="mermaid" className={className} />
  }

  if (!svg) {
    return (
      <pre
        className={cn(
          'my-2 overflow-auto rounded-lg border border-primary-200 bg-primary-50/40 p-3 font-mono text-[0.7rem] leading-relaxed text-primary-700/80 whitespace-pre-wrap',
          className,
        )}
      >
        {code}
      </pre>
    )
  }

  return (
    <div
      className={cn(
        'my-2 overflow-x-auto rounded-lg border border-primary-200 bg-primary-50/30 p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-h-[min(60vh,520px)] [&_svg]:max-w-full',
        className,
      )}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
