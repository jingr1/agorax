import { describe, expect, it } from 'vitest'
import { classifyFilePreviewKind, isEditablePreviewKind } from './file-kind'

describe('classifyFilePreviewKind', () => {
  it('matches webui-style preview branching', () => {
    expect(classifyFilePreviewKind('docs/readme.md')).toBe('markdown')
    expect(classifyFilePreviewKind('shot.PNG')).toBe('image')
    expect(classifyFilePreviewKind('deck.pdf')).toBe('pdf')
    expect(classifyFilePreviewKind('index.html')).toBe('html')
    expect(classifyFilePreviewKind('clip.mp4')).toBe('video')
    expect(classifyFilePreviewKind('tone.mp3')).toBe('audio')
    expect(classifyFilePreviewKind('src/app.ts')).toBe('code')
    expect(classifyFilePreviewKind('data.csv')).toBe('csv')
    expect(classifyFilePreviewKind('bundle.zip')).toBe('download')
    expect(classifyFilePreviewKind('notes.docx')).toBe('download')
  })

  it('marks text-like kinds editable', () => {
    expect(isEditablePreviewKind('code')).toBe(true)
    expect(isEditablePreviewKind('markdown')).toBe(true)
    expect(isEditablePreviewKind('html')).toBe(true)
    expect(isEditablePreviewKind('csv')).toBe(true)
    expect(isEditablePreviewKind('pdf')).toBe(false)
    expect(isEditablePreviewKind('image')).toBe(false)
  })
})

describe('csv + markdown preview helpers', () => {
  it('builds a csv table preview', async () => {
    const { buildCsvTablePreview, shouldRenderMarkdownAsPlainText } =
      await import('./file-kind')
    const preview = buildCsvTablePreview('a,b\n1,2\n3,4')
    expect(preview.ok).toBe(true)
    if (preview.ok) {
      expect(preview.headers).toEqual(['a', 'b'])
      expect(preview.rows).toHaveLength(2)
    }
    expect(shouldRenderMarkdownAsPlainText('x'.repeat(300_000))).toBe(true)
  })
})
