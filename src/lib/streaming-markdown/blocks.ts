/**
 * Tutti-aligned streaming markdown block split: blank-line boundaries that
 * never cut through an open fence, so settled blocks stay memo-stable.
 */

export interface StreamingMarkdownBlock {
  content: string
  /** First content snapshot for this block — used as a stable React key seed. */
  initialKeyContent: string
}

export function splitStreamingMarkdownBlocks(
  content: string,
): StreamingMarkdownBlock[] {
  const normalized = content.replace(/\r\n?/g, '\n')
  if (!normalized) {
    return [{ content: '', initialKeyContent: '' }]
  }

  const lines = normalized.split('\n')
  const blocks: StreamingMarkdownBlock[] = []
  const current: string[] = []
  let fence: { marker: string; length: number } | null = null

  for (const line of lines) {
    current.push(line)
    const lineFence = parseStreamingFence(line)
    if (lineFence) {
      if (!fence) {
        fence = lineFence
      } else if (
        lineFence.marker === fence.marker &&
        lineFence.length >= fence.length
      ) {
        fence = null
      }
      continue
    }
    if (!fence && line.trim() === '') {
      pushStreamingMarkdownBlock(blocks, current)
    }
  }
  pushStreamingMarkdownBlock(blocks, current)
  return blocks.length > 0
    ? blocks
    : [{ content: normalized, initialKeyContent: normalized }]
}

export function pushStreamingMarkdownBlock(
  blocks: StreamingMarkdownBlock[],
  lines: string[],
): void {
  if (lines.length === 0) return
  const content = lines.join('\n')
  if (!content) {
    lines.length = 0
    return
  }
  blocks.push({
    content,
    initialKeyContent: content,
  })
  lines.length = 0
}

export function parseStreamingFence(
  line: string,
): { marker: string; length: number } | null {
  const trimmed = line.trimStart()
  const marker = trimmed[0]
  if (marker !== '`' && marker !== '~') return null
  let length = 0
  while (trimmed[length] === marker) length += 1
  return length >= 3 ? { marker, length } : null
}

export function hashMarkdownBlockContent(content: string): string {
  let hash = 0
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) | 0
  }
  return `${content.length}:${Math.abs(hash)}`
}

export function hasOpenPotentialMermaidFence(content: string): boolean {
  let openFence: {
    marker: string
    length: number
    isPotentialMermaid: boolean
  } | null = null

  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const lineFence = parseStreamingFence(line)
    if (!lineFence) continue
    const trimmed = line.trimStart()
    const suffix = trimmed.slice(lineFence.length).trim()
    if (!openFence) {
      const language = suffix.split(/\s+/, 1)[0]?.toLowerCase() ?? ''
      openFence = {
        ...lineFence,
        isPotentialMermaid:
          language.length > 0 && 'mermaid'.startsWith(language),
      }
      continue
    }
    if (
      suffix === '' &&
      lineFence.marker === openFence.marker &&
      lineFence.length >= openFence.length
    ) {
      openFence = null
    }
  }

  return openFence?.isPotentialMermaid ?? false
}
