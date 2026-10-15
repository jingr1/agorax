import { describe, expect, it } from 'vitest'
import { managedPromptContentFromAttachments } from './agorax-managed-prompt-content'

describe('managedPromptContentFromAttachments', () => {
  it('converts an image data URL into a provider-readable canonical block', () => {
    expect(managedPromptContentFromAttachments({
      text: 'Describe this',
      attachments: [{ id: 'image-1', name: 'diagram.png', contentType: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' }],
    })).toEqual([
      { type: 'text', text: 'Describe this' },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=', attachmentId: 'image-1', name: 'diagram.png' },
    ])
  })

  it('rejects attachments without a provider-readable image payload', () => {
    expect(() => managedPromptContentFromAttachments({
      text: 'Read this',
      attachments: [{ id: 'file-1', name: 'notes.pdf', contentType: 'application/pdf' }],
    })).toThrow('Managed Agent supports only readable image attachments')
  })
})