/**
 * Token estimator for local session files.
 *
 * cc-switch uses tiktoken when available and falls back to a heuristic.
 * Workspace keeps a lightweight approximation: ~4 characters per token
 * for Latin/script text, which is close enough for dashboard-level
 * spend tracking and avoids a heavy native dependency.
 */

const CJK_RANGES = [
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0xac00, 0xd7af], // Hangul Syllables
]

function isCjk(code: number): boolean {
  return CJK_RANGES.some(([start, end]) => code >= start && code <= end)
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjkCount = 0
  let otherCount = 0
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (isCjk(code)) {
      cjkCount += 1
    } else if (!/\s/.test(char)) {
      otherCount += 1
    }
  }
  // CJK: ~1 token per character; others: ~4 chars per token.
  return Math.ceil(cjkCount + otherCount / 4)
}
