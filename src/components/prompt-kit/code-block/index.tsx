import { useMemo, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import {
  formatLanguageName,
  resolveCodeBlockLanguage,
  resolveLanguage,
} from './utils'
import { highlightWithPrism } from './prism-highlight'
import { writeTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type CodeBlockProps = {
  content: string
  ariaLabel?: string
  language?: string
  className?: string
}

export function CodeBlock({
  content,
  ariaLabel,
  language = 'text',
  className,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const [showLineNumbers, setShowLineNumbers] = useState(false)

  const normalizedLanguage = useMemo(
    () => resolveCodeBlockLanguage(language, content),
    [language, content],
  )
  const labelLanguage = resolveLanguage(normalizedLanguage)
  const lineCount = useMemo(
    () => Math.max(1, content.split('\n').length),
    [content],
  )
  const canShowLineNumbers = lineCount > 1
  const displayLanguage = formatLanguageName(labelLanguage)

  const highlightedHtml = useMemo(
    () => highlightWithPrism(content, labelLanguage),
    [content, labelLanguage],
  )

  async function handleCopy() {
    try {
      await writeTextToClipboard(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  const isSingleLine = content.split('\n').length === 1
  const codeClassName =
    labelLanguage === 'text'
      ? undefined
      : `language-${labelLanguage === 'shell' ? 'bash' : labelLanguage}`

  return (
    <div className={cn('code-block', className)}>
      <div className="code-block-header">
        <span className="code-block-lang">{displayLanguage}</span>
        <div className="code-block-actions">
          {canShowLineNumbers ? (
            <Button
              variant="ghost"
              className="code-block-action h-auto px-0 hover:bg-transparent"
              onClick={() => {
                setShowLineNumbers((current) => !current)
              }}
            >
              {showLineNumbers ? 'Hide lines' : 'Show lines'}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            aria-label={ariaLabel ?? 'Copy code'}
            className="code-block-action h-auto px-0 hover:bg-transparent"
            onClick={() => {
              handleCopy().catch(() => {})
            }}
          >
            <HugeiconsIcon
              icon={copied ? Tick02Icon : Copy01Icon}
              size={20}
              strokeWidth={1.5}
            />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
      <div className="code-block-body">
        {showLineNumbers ? (
          <ol className="code-block-lines">
            {Array.from({ length: lineCount }, (_, index) => (
              <li key={`line-${index + 1}`}>{index + 1}</li>
            ))}
          </ol>
        ) : null}
        <pre
          className={cn(
            'code-block-pre',
            isSingleLine ? 'code-block-pre--single' : undefined,
            codeClassName,
          )}
        >
          <code
            className={cn(codeClassName)}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        </pre>
      </div>
    </div>
  )
}
