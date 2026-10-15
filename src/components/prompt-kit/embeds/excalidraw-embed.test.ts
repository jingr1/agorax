import { describe, expect, it } from 'vitest'

import { parseExcalidrawScene } from './excalidraw-embed'

describe('parseExcalidrawScene', () => {
  it('accepts a standard .excalidraw envelope', () => {
    const scene = parseExcalidrawScene(
      JSON.stringify({
        type: 'excalidraw',
        version: 2,
        elements: [
          { type: 'rectangle', id: 'r1', x: 0, y: 0, width: 10, height: 10 },
        ],
        appState: { viewBackgroundColor: '#ffffff' },
      }),
    )
    expect(scene?.type).toBe('excalidraw')
    expect(scene?.elements).toHaveLength(1)
  })

  it('rejects non-object or missing elements', () => {
    expect(parseExcalidrawScene('not json')).toBeNull()
    expect(parseExcalidrawScene('{"type":"excalidraw"}')).toBeNull()
    expect(parseExcalidrawScene('[]')).toBeNull()
  })
})
