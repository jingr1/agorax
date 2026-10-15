import { describe, expect, it } from 'vitest'

import { rewriteLocalMediaSources } from './markdown'

describe('rewriteLocalMediaSources', () => {
  it('rewrites markdown image MEDIA tokens that point to local files', () => {
    expect(
      rewriteLocalMediaSources('![cat](MEDIA:/Users/test/.hermes/tmp/cat.png)'),
    ).toBe('![cat](/api/media?path=%2FUsers%2Ftest%2F.hermes%2Ftmp%2Fcat.png)')
  })

  it('rewrites html image MEDIA tokens that point to local files without corrupting quotes', () => {
    expect(
      rewriteLocalMediaSources('<img src="MEDIA:/tmp/cat.png" alt="cat" />'),
    ).toBe('<img src="/api/media?path=%2Ftmp%2Fcat.png" alt="cat" />')
  })

  it('unwraps remote MEDIA URLs in markdown/html image forms', () => {
    expect(
      rewriteLocalMediaSources('![cat](MEDIA:https://example.com/cat.png)'),
    ).toBe('![cat](https://example.com/cat.png)')
    expect(
      rewriteLocalMediaSources(
        '<img src="MEDIA:https://example.com/cat.png" />',
      ),
    ).toBe('<img src="https://example.com/cat.png" />')
  })

  it('handles multiple local MEDIA tokens in one message', () => {
    const input =
      'Here is one: ![a](MEDIA:/tmp/a.png) and two: <img src="MEDIA:/tmp/b.png" />'
    const result = rewriteLocalMediaSources(input)
    expect(result).toContain('/api/media?path=%2Ftmp%2Fa.png')
    expect(result).toContain('/api/media?path=%2Ftmp%2Fb.png')
  })

  it('expands bare local MEDIA image tokens', () => {
    expect(rewriteLocalMediaSources('See MEDIA:/tmp/shot.png please')).toBe(
      'See ![shot.png](/api/media?path=%2Ftmp%2Fshot.png) please',
    )
  })

  it('expands bare MEDIA audio/video tokens into players', () => {
    expect(rewriteLocalMediaSources('MEDIA:/tmp/note.mp3')).toContain(
      '<audio controls',
    )
    expect(rewriteLocalMediaSources('MEDIA:/tmp/clip.mp4')).toContain(
      '<video controls',
    )
  })

  it('expands bare MEDIA .excalidraw tokens into host nodes', () => {
    const result = rewriteLocalMediaSources('MEDIA:/tmp/arch.excalidraw')
    expect(result).toContain('class="hermes-excalidraw"')
    expect(result).toContain('/api/media?path=%2Ftmp%2Farch.excalidraw')
    expect(result).toContain('data-title="arch.excalidraw"')
  })

  it('passes through content without MEDIA tokens unchanged', () => {
    const plain = 'Hello world, no images here.'
    expect(rewriteLocalMediaSources(plain)).toBe(plain)
  })
})
