import type { OpenAICompatContentPart } from '../openai-compat-api'

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

export function stripDataUrlPrefix(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const commaIndex = trimmed.indexOf(',')
  if (trimmed.toLowerCase().startsWith('data:') && commaIndex >= 0) {
    return trimmed.slice(commaIndex + 1).trim()
  }
  return trimmed
}

export function normalizeAttachments(
  attachments: unknown,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return undefined
  }

  const normalized: Array<Record<string, unknown>> = []
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') continue
    const source = attachment as Record<string, unknown>

    const id = readString(source.id)
    const name = readString(source.name) || readString(source.fileName)
    const mimeType =
      readString(source.contentType) ||
      readString(source.mimeType) ||
      readString(source.mediaType)
    const size = readNumber(source.size)

    const base64Raw =
      readString(source.content) ||
      readString(source.data) ||
      readString(source.base64) ||
      readString(source.dataUrl)
    const content = stripDataUrlPrefix(base64Raw)
    if (!content) continue

    const type =
      readString(source.type) ||
      (mimeType.toLowerCase().startsWith('image/') ? 'image' : 'file')

    const dataUrl =
      readString(source.dataUrl) ||
      (mimeType ? `data:${mimeType};base64,${content}` : '')

    normalized.push({
      id: id || undefined,
      name: name || undefined,
      fileName: name || undefined,
      type,
      contentType: mimeType || undefined,
      mimeType: mimeType || undefined,
      mediaType: mimeType || undefined,
      content,
      data: content,
      base64: content,
      dataUrl: dataUrl || undefined,
      size,
    })
  }

  return normalized.length > 0 ? normalized : undefined
}

export function getChatMessage(
  message: string,
  attachments?: Array<Record<string, unknown>>,
): string {
  if (message.trim().length > 0) return message
  if (attachments && attachments.length > 0) {
    return 'Please review the attached content.'
  }
  return message
}

export function buildMultimodalContent(
  message: string,
  attachments?: Array<Record<string, unknown>>,
): string | Array<OpenAICompatContentPart> {
  const imageParts: Array<OpenAICompatContentPart> = []

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      const mime = (att.contentType ||
        att.mimeType ||
        att.mediaType ||
        '') as string
      if (!mime.toLowerCase().startsWith('image/')) continue

      let b64 = (att.base64 || att.content || att.data || '') as string
      if (!b64) {
        const dataUrl = (att.dataUrl || '') as string
        if (dataUrl.startsWith('data:') && dataUrl.includes(',')) {
          b64 = dataUrl.split(',')[1]
        }
      }
      if (!b64) continue

      imageParts.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${b64}` },
      })
    }
  }

  if (imageParts.length === 0) {
    return getChatMessage(message, attachments)
  }

  const parts: Array<OpenAICompatContentPart> = []
  const text = message.trim() || 'Please review the attached content.'
  parts.push({ type: 'text', text })
  parts.push(...imageParts)
  return parts
}

export type PortableHistoryMessage = {
  role: string
  content: string
}

export function normalizePortableHistory(
  value: unknown,
): Array<PortableHistoryMessage> {
  if (!Array.isArray(value) || value.length === 0) return []

  const normalized: Array<PortableHistoryMessage> = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const role = readString(record.role)
    const content = readString(record.content)
    if (!role || !content) continue
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue
    normalized.push({ role, content })
  }

  return normalized
}

export function normalizeClaudeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.trim()
  if (!message) return 'Claude request failed'
  return message.replace(/\bserver\b/gi, 'Claude')
}
