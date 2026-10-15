import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getStateDir } from './workspace-state-dir'

describe('getStateDir', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // Clear workspace-specific override for clean tests
    delete process.env.AGORAX_STATE_DIR
    // Clear Hermes home override too
    delete process.env.HERMES_HOME
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns AGORAX_STATE_DIR when set', () => {
    process.env.AGORAX_STATE_DIR = '/custom/state/dir'
    const result = getStateDir()
    expect(result).toBe('/custom/state/dir')
  })

  it('uses HERMES_HOME/workspace when AGORAX_STATE_DIR is not set', () => {
    process.env.HERMES_HOME = '/custom/hermes'
    const result = getStateDir()
    expect(result).toBe('/custom/hermes/workspace')
  })

  it('uses HERMES_HOME/workspace when HERMES_HOME is set', () => {
    process.env.HERMES_HOME = '/hermes/home'
    const result = getStateDir()
    expect(result).toBe('/hermes/home/workspace')
  })

  it('prefers AGORAX_STATE_DIR over everything', () => {
    process.env.AGORAX_STATE_DIR = '/explicit/workspace'
    process.env.HERMES_HOME = '/hermes/home'
    const result = getStateDir()
    expect(result).toBe('/explicit/workspace')
  })

  it('trims whitespace from env values', () => {
    process.env.AGORAX_STATE_DIR = '  /trimmed/path  '
    const result = getStateDir()
    expect(result).toBe('/trimmed/path')
  })
})
