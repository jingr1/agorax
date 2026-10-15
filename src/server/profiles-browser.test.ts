import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  listProfiles,
  readProfile,
  updateProfileConfig,
  getMessagesForProfile,
  updateProfileModelProvider,
  updateAllProfilesModelProvider,
  readModelProviderFromConfig,
  setActiveProfile,
  getActiveProfileName,
} from './profiles-browser'

const nodeRequire = createRequire(import.meta.url)

describe('listProfiles', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hermes-workspace-profiles-'),
    )
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome)
    process.env.HERMES_HOME = path.join(tempHome, '.hermes')
    process.env.AGORAX_STATE_DIR = path.join(
      tempHome,
      '.hermes',
      'workspace',
    )
    delete process.env.HERMES_HOME
    delete process.env.AGORAX_STICKY_PROFILE
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.HERMES_HOME
    delete process.env.AGORAX_STATE_DIR
    delete process.env.AGORAX_STICKY_PROFILE
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  it('always includes the default profile even when a named profile is active', () => {
    const hermesRoot = path.join(tempHome, '.hermes')
    const profilesRoot = path.join(hermesRoot, 'profiles')
    const namedProfileRoot = path.join(profilesRoot, 'jarvis')

    fs.mkdirSync(namedProfileRoot, { recursive: true })
    fs.mkdirSync(path.join(hermesRoot, 'workspace'), { recursive: true })
    fs.writeFileSync(
      path.join(hermesRoot, 'workspace', 'selected_profile'),
      'jarvis\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(hermesRoot, 'config.yaml'),
      'model: default-model\ndescription: Default operator\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(namedProfileRoot, 'config.yaml'),
      'model: named-model\ndescription: Named operator\n',
      'utf-8',
    )

    const profiles = listProfiles()
    const names = profiles.map((profile) => profile.name)

    expect(names).toContain('default')
    expect(names).toContain('jarvis')
    expect(profiles.find((profile) => profile.name === 'default')?.active).toBe(
      false,
    )
    expect(profiles.find((profile) => profile.name === 'jarvis')?.active).toBe(
      true,
    )
    expect(
      profiles.find((profile) => profile.name === 'default')?.description,
    ).toBe('Default operator')
    expect(
      profiles.find((profile) => profile.name === 'jarvis')?.description,
    ).toBe('Named operator')
  })

  it('defaults to default when only Hermes sticky is set', () => {
    const hermesRoot = path.join(tempHome, '.hermes')
    const namedProfileRoot = path.join(hermesRoot, 'profiles', 'jarvis')
    fs.mkdirSync(namedProfileRoot, { recursive: true })
    fs.writeFileSync(path.join(namedProfileRoot, 'config.yaml'), 'model: x\n')
    fs.writeFileSync(path.join(hermesRoot, 'active_profile'), 'jarvis\n')

    expect(getActiveProfileName()).toBe('default')
    expect(listProfiles().find((p) => p.name === 'default')?.active).toBe(true)
    expect(listProfiles().find((p) => p.name === 'jarvis')?.active).toBe(false)
  })

  it('activates via selected_profile without rewriting Hermes sticky', () => {
    const hermesRoot = path.join(tempHome, '.hermes')
    const namedProfileRoot = path.join(hermesRoot, 'profiles', 'jarvis')
    fs.mkdirSync(namedProfileRoot, { recursive: true })
    fs.writeFileSync(path.join(namedProfileRoot, 'config.yaml'), 'model: x\n')
    fs.writeFileSync(path.join(hermesRoot, 'active_profile'), 'default\n')

    setActiveProfile('jarvis')

    expect(getActiveProfileName()).toBe('jarvis')
    expect(
      fs.readFileSync(
        path.join(hermesRoot, 'workspace', 'selected_profile'),
        'utf-8',
      ),
    ).toBe('jarvis\n')
    expect(
      fs.readFileSync(path.join(hermesRoot, 'active_profile'), 'utf-8'),
    ).toBe('default\n')
    expect(listProfiles().find((p) => p.name === 'jarvis')?.active).toBe(true)
  })

  it('skips profiles/default so only the root-backed default card renders', () => {
    const hermesRoot = path.join(tempHome, '.hermes')
    const defaultDirRoot = path.join(hermesRoot, 'profiles', 'default')
    const namedProfileRoot = path.join(hermesRoot, 'profiles', 'builder')

    fs.mkdirSync(defaultDirRoot, { recursive: true })
    fs.mkdirSync(namedProfileRoot, { recursive: true })
    fs.writeFileSync(
      path.join(hermesRoot, 'config.yaml'),
      'model: root-model\nprovider: openai\ndescription: Root default\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(namedProfileRoot, 'config.yaml'),
      'model: named-model\nprovider: anthropic\ndescription: Named operator\n',
      'utf-8',
    )

    const profiles = listProfiles()
    const defaultProfiles = profiles.filter(
      (profile) => profile.name === 'default',
    )

    expect(defaultProfiles).toHaveLength(1)
    expect(defaultProfiles[0]?.path).toBe(hermesRoot)
    expect(defaultProfiles[0]?.model).toBe('root-model')
    expect(defaultProfiles[0]?.provider).toBe('openai')
    expect(defaultProfiles[0]?.description).toBe('Root default')
    expect(
      profiles.find((profile) => profile.name === 'builder')?.provider,
    ).toBe('anthropic')
  })

  it('reads and updates profile descriptions from config.yaml', () => {
    const hermesRoot = path.join(tempHome, '.hermes')
    const profileRoot = path.join(hermesRoot, 'profiles', 'builder')

    fs.mkdirSync(profileRoot, { recursive: true })
    fs.writeFileSync(
      path.join(profileRoot, 'config.yaml'),
      'model: named-model\ndescription: Initial description\n',
      'utf-8',
    )

    expect(readProfile('builder').description).toBe('Initial description')

    updateProfileConfig('builder', { description: 'Updated description' })
    expect(readProfile('builder').description).toBe('Updated description')

    updateProfileConfig('builder', { description: null })
    expect(readProfile('builder').description).toBe('')
  })

  it('surfaces system prompt from config or SOUL.md in profile summaries', () => {
    const hermesRoot = path.join(tempHome, '.hermes')
    const profilesRoot = path.join(hermesRoot, 'profiles')
    const soulProfileRoot = path.join(profilesRoot, 'leelo')
    const configProfileRoot = path.join(profilesRoot, 'ops')

    fs.mkdirSync(soulProfileRoot, { recursive: true })
    fs.mkdirSync(configProfileRoot, { recursive: true })

    fs.writeFileSync(
      path.join(hermesRoot, 'config.yaml'),
      'model: root-model\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(soulProfileRoot, 'config.yaml'),
      'model: named-model\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(soulProfileRoot, 'SOUL.md'),
      'You are Leelo, executive assistant.',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(configProfileRoot, 'config.yaml'),
      'model: named-model\nsystem_prompt: Config prompt wins\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(configProfileRoot, 'SOUL.md'),
      'This should not override config',
      'utf-8',
    )

    const profiles = listProfiles()

    expect(
      profiles.find((profile) => profile.name === 'leelo')?.systemPrompt,
    ).toBe('You are Leelo, executive assistant.')
    expect(
      profiles.find((profile) => profile.name === 'ops')?.systemPrompt,
    ).toBe('Config prompt wins')
    expect(readProfile('leelo').systemPrompt).toBe(
      'You are Leelo, executive assistant.',
    )
    expect(readProfile('ops').systemPrompt).toBe('Config prompt wins')
  })
})

describe('getMessagesForProfile', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hermes-workspace-messages-'),
    )
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome)
    delete process.env.HERMES_HOME
    delete process.env.HERMES_HOME
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  it('reads messages from a named profile state.db without a gateway', () => {
    const profileRoot = path.join(tempHome, '.hermes', 'profiles', 'writer')
    fs.mkdirSync(profileRoot, { recursive: true })
    const Database = nodeRequire('better-sqlite3') as new (
      path: string,
    ) => {
      exec: (sql: string) => void
      close: () => void
    }
    const db = new Database(path.join(profileRoot, 'state.db'))
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT, started_at REAL, message_count INTEGER
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        timestamp REAL NOT NULL
      );
      INSERT INTO sessions (id, title, started_at, message_count)
        VALUES ('sess-1', 'hello', 1700000000, 2);
      INSERT INTO messages (session_id, role, content, timestamp)
        VALUES ('sess-1', 'user', 'hi', 1700000001);
      INSERT INTO messages (session_id, role, content, timestamp)
        VALUES ('sess-1', 'assistant', 'hello there', 1700000002);
      INSERT INTO messages (session_id, role, content, timestamp)
        VALUES (
          'sess-1',
          'assistant',
          '[{"type":"thinking","thinking":"Plan A"},{"type":"text","text":"Done"}]',
          1700000003
        );
    `)
    db.close()

    const messages = getMessagesForProfile('writer', 'sess-1')
    expect(messages).toHaveLength(3)
    expect(messages?.[0]?.role).toBe('user')
    expect(messages?.[0]?.content).toBe('hi')
    expect(messages?.[1]?.role).toBe('assistant')
    expect(messages?.[1]?.content).toBe('hello there')
    // Structured content keeps thinking for toChatMessage (same shape as managed).
    expect(messages?.[2]?.content).toEqual([
      { type: 'thinking', thinking: 'Plan A' },
      { type: 'text', text: 'Done' },
    ])
  })

  it('returns an empty array when the db exists but the session has no messages', () => {
    const profileRoot = path.join(tempHome, '.hermes', 'profiles', 'writer')
    fs.mkdirSync(profileRoot, { recursive: true })
    const Database = nodeRequire('better-sqlite3') as new (
      path: string,
    ) => {
      exec: (sql: string) => void
      close: () => void
    }
    const db = new Database(path.join(profileRoot, 'state.db'))
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        timestamp REAL NOT NULL
      );
    `)
    db.close()

    expect(getMessagesForProfile('writer', 'missing')).toEqual([])
  })

  it('returns null when the profile has no state.db', () => {
    expect(getMessagesForProfile('ghost', 'sess-1')).toBeNull()
  })
})

describe('profile model/provider updates', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hermes-workspace-profiles-mp-'),
    )
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome)
    delete process.env.HERMES_HOME
    delete process.env.HERMES_HOME
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  it('updates a single nested profile model/provider without flattening extra fields', () => {
    const hermesRoot = path.join(tempHome, '.hermes')
    const profileRoot = path.join(hermesRoot, 'profiles', 'developer')
    fs.mkdirSync(profileRoot, { recursive: true })
    fs.writeFileSync(
      path.join(profileRoot, 'config.yaml'),
      'model:\n  default: old-model\n  provider: tokenx\n  temperature: 0.2\nprovider: tokenx\n',
      'utf-8',
    )

    updateProfileModelProvider('developer', 'custom:tokenx', 'Kimi-K2.7-Code')
    const profile = readProfile('developer')
    expect(readModelProviderFromConfig(profile.config)).toEqual({
      model: 'Kimi-K2.7-Code',
      provider: 'custom:tokenx',
    })
    const nested = profile.config.model as Record<string, unknown>
    expect(nested.temperature).toBe(0.2)
  })

  it('writes the same model/provider to every profile including default', () => {
    const hermesRoot = path.join(tempHome, '.hermes')
    const developerRoot = path.join(hermesRoot, 'profiles', 'developer')
    const writerRoot = path.join(hermesRoot, 'profiles', 'writer')
    fs.mkdirSync(developerRoot, { recursive: true })
    fs.mkdirSync(writerRoot, { recursive: true })
    fs.writeFileSync(
      path.join(hermesRoot, 'config.yaml'),
      'model: root-model\nprovider: openai\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(developerRoot, 'config.yaml'),
      'model:\n  default: old-dev\n  provider: tokenx\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(writerRoot, 'config.yaml'),
      'model: old-writer\nprovider: anthropic\n',
      'utf-8',
    )

    const result = updateAllProfilesModelProvider('tokenx', 'Kimi-K2.7-Code')
    expect(result.updated.every((entry) => entry.ok)).toBe(true)
    expect(result.updated.map((entry) => entry.name).sort()).toEqual([
      'default',
      'developer',
      'writer',
    ])
    expect(readModelProviderFromConfig(readProfile('default').config)).toEqual({
      model: 'Kimi-K2.7-Code',
      provider: 'tokenx',
    })
    expect(
      readModelProviderFromConfig(readProfile('developer').config),
    ).toEqual({
      model: 'Kimi-K2.7-Code',
      provider: 'tokenx',
    })
    expect(readModelProviderFromConfig(readProfile('writer').config)).toEqual({
      model: 'Kimi-K2.7-Code',
      provider: 'tokenx',
    })
  })

  it('listProfiles reports the same default model/provider as each profile config', () => {
    const hermesRoot = path.join(tempHome, '.hermes')
    const developerRoot = path.join(hermesRoot, 'profiles', 'developer')
    fs.mkdirSync(developerRoot, { recursive: true })
    fs.writeFileSync(
      path.join(hermesRoot, 'config.yaml'),
      'model: root-model\nprovider: openai\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(developerRoot, 'config.yaml'),
      'model:\n  default: Kimi-K2.7-Code\n  provider: custom:tokenx\n',
      'utf-8',
    )

    const listed = Object.fromEntries(
      listProfiles().map((profile) => [profile.name, profile]),
    )
    expect(listed.default).toMatchObject({
      model: 'root-model',
      provider: 'openai',
    })
    expect(listed.developer).toMatchObject({
      model: 'Kimi-K2.7-Code',
      provider: 'custom:tokenx',
    })
  })
})
