import { useState } from 'react'
import { cn } from '@/lib/utils'

const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png/light'

// Provider IDs → lobehub CDN filenames (light variant; inverted in dark mode)
const CDN_FILE_MAP: Record<string, string> = {
  nous: 'nousresearch.png',
  'openai-codex': 'openai.png',
  openai: 'openai.png',
  anthropic: 'anthropic.png',
  'claude-oauth': 'anthropic.png',
  deepseek: 'deepseek.png',
  openrouter: 'openrouter.png',
  ollama: 'ollama.png',
  kimi: 'kimi.png',
  'kimi-coding': 'kimi.png',
  minimax: 'minimax.png',
  zai: 'zhipu.png',
  zhipu: 'zhipu.png',
  xiaomi: 'xiaomimimo.png',
}

// Local-only logos (no lobehub asset)
const LOCAL_FILE_MAP: Record<string, string> = {
  'atomic-chat': 'atomic-chat.png',
}

function LetterFallback({
  provider,
  size,
  className,
}: {
  provider: string
  size: number
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg bg-neutral-600 text-white text-xs font-bold',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {(provider || 'C')[0].toUpperCase()}
    </div>
  )
}

export function ProviderLogo({
  provider,
  size = 32,
  className,
}: {
  provider: string
  size?: number
  className?: string
}) {
  const [failed, setFailed] = useState(false)

  const cdnFile = CDN_FILE_MAP[provider]
  const localFile = LOCAL_FILE_MAP[provider]

  if (failed || (!cdnFile && !localFile)) {
    return (
      <LetterFallback provider={provider} size={size} className={className} />
    )
  }

  const src = cdnFile ? `${CDN_BASE}/${cdnFile}` : `/providers/${localFile}`

  return (
    <img
      src={src}
      alt={provider}
      className={cn(
        'shrink-0 rounded-lg object-contain',
        cdnFile && 'dark:invert',
        className,
      )}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  )
}
