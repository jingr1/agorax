// Client-safe prompt-content assembly for Managed Agent submissions.
//
// Pure functions only: attachments + composer text -> canonical prompt
// content blocks. Both the chat hook (browser) and the server runtime
// (session activation / input forwarding) consume this module; keep it free
// of server-only imports.

export type AgoraxManagedImageMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'

export type AgoraxManagedPromptContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      mimeType: AgoraxManagedImageMimeType
      data: string
      attachmentId: string
      name: string
    }

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/

const IMAGE_MIME_TYPES: readonly AgoraxManagedImageMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

export function isAgoraxManagedImageMimeType(
  value: string,
): value is AgoraxManagedImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(value)
}

/**
 * Fail-closed narrowing of an untyped request body field into prompt content
 * blocks; throws on any malformed block instead of casting.
 */
export function managedPromptContentBlocksFromUnknown(
  value: unknown,
): Array<AgoraxManagedPromptContentBlock> {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error('Managed Agent promptContent must be an array of content blocks')
  }
  return value.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new Error('Managed Agent promptContent block must be an object')
    }
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      return { type: 'text', text: record.text }
    }
    if (
      record.type === 'image' &&
      typeof record.mimeType === 'string' &&
      isAgoraxManagedImageMimeType(record.mimeType) &&
      typeof record.data === 'string' &&
      typeof record.attachmentId === 'string' &&
      typeof record.name === 'string'
    ) {
      return {
        type: 'image',
        mimeType: record.mimeType,
        data: record.data,
        attachmentId: record.attachmentId,
        name: record.name,
      }
    }
    throw new Error('Managed Agent promptContent block is malformed')
  })
}

export function managedPromptContentFromAttachments(input: {
  text: string
  attachments: Array<{
    id?: unknown
    name?: unknown
    contentType?: unknown
    dataUrl?: unknown
  }>
}): Array<AgoraxManagedPromptContentBlock> {
  const content: Array<AgoraxManagedPromptContentBlock> = [
    { type: 'text', text: input.text },
  ]
  for (const attachment of input.attachments) {
    const dataUrl = typeof attachment.dataUrl === 'string' ? attachment.dataUrl : ''
    const match = IMAGE_DATA_URL.exec(dataUrl)
    const id = typeof attachment.id === 'string' ? attachment.id.trim() : ''
    const name = typeof attachment.name === 'string' ? attachment.name.trim() : ''
    const contentType = typeof attachment.contentType === 'string' ? attachment.contentType : ''
    if (!match || !id || !name || match[1] !== contentType) {
      throw new Error('Managed Agent supports only readable image attachments')
    }
    content.push({
      type: 'image',
      mimeType: match[1] as AgoraxManagedImageMimeType,
      data: match[2],
      attachmentId: id,
      name,
    })
  }
  return content
}
