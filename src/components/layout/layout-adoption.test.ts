import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Screens migrated to PageShell / PageHeader; add new ones as they land. */
const MIGRATED_SCREENS = [
  'screens/agents/operations-screen.tsx',
  'screens/skills/platform-skills-screen.tsx',
  'screens/mcp/mcp-screen.tsx',
  'screens/jobs/jobs-screen.tsx',
  'screens/memory/memory-browser-screen.tsx',
  'screens/memory/knowledge-browser-screen.tsx',
  'routes/files.tsx',
  'routes/memory.tsx',
  'screens/mission-control/mission-control-layout.tsx',
  'screens/group-chat/rooms-screen.tsx',
  'screens/group-chat/group-chat-layout.tsx',
]

const HARDCODED_NEUTRAL =
  /\b(?:bg|text|border|divide|outline)-(?:neutral|zinc|gray|slate)-\d/
/** Literal widths only; `max-w-[var(--chat-content-max-width)]` is a theme token. */
const PAGE_MAX_WIDTH = /mx-auto[^"'`]*max-w-\[(?!var\()/

describe('layout adoption', () => {
  for (const file of MIGRATED_SCREENS) {
    const source = readFileSync(join(__dirname, '../..', file), 'utf8')

    it(`${file} uses theme tokens instead of hardcoded neutrals`, () => {
      expect(source).not.toMatch(HARDCODED_NEUTRAL)
    })

    it(`${file} leaves page width to PageShell`, () => {
      expect(source).not.toMatch(PAGE_MAX_WIDTH)
    })
  }
})
