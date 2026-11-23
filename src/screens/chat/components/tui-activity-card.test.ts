import { describe, expect, it } from 'vitest'

import {
  STREAMING_TOOL_WINDOW,
  buildTuiActivitySettledSummary,
  visibleStreamingToolSections,
} from './tui-activity-card'

describe('visibleStreamingToolSections', () => {
  it('shows every tool when not streaming', () => {
    const sections = Array.from({ length: 12 }, (_, i) => ({ id: i }))
    expect(visibleStreamingToolSections(sections, false)).toEqual({
      visible: sections,
      hiddenCount: 0,
    })
  })

  it('keeps a short live window so narration is not pushed off-screen', () => {
    const sections = Array.from({ length: 21 }, (_, i) => ({ id: i }))
    const result = visibleStreamingToolSections(sections, true)

    expect(result.hiddenCount).toBe(21 - STREAMING_TOOL_WINDOW)
    expect(result.visible).toEqual(sections.slice(-STREAMING_TOOL_WINDOW))
    expect(result.visible[0]).toEqual({ id: 13 })
  })
})

describe('buildTuiActivitySettledSummary', () => {
  it('summarizes thinking-only turns as a one-line Compact chip', () => {
    expect(
      buildTuiActivitySettledSummary({
        hasThinking: true,
        toolSections: [],
      }),
    ).toBe('Thinking')
  })

  it('joins thinking with settled tool counts', () => {
    expect(
      buildTuiActivitySettledSummary({
        hasThinking: true,
        toolSections: [
          { state: 'output-available' },
          { state: 'output-available' },
        ],
      }),
    ).toBe('Thinking · 2 tools')
  })

  it('returns null when the card has nothing to summarize', () => {
    expect(
      buildTuiActivitySettledSummary({
        hasThinking: false,
        toolSections: [],
      }),
    ).toBeNull()
  })
})
