import { afterEach, describe, expect, it } from 'vitest'
import {
  readLastAgent,
  readLastSession,
  resetLastSessionStorage,
  resolveSessionForProfile,
  writeLastAgent,
  writeLastSession,
} from './last-session'

function session(friendlyId: string) {
  return { friendlyId }
}

describe('last-session', () => {
  afterEach(() => {
    resetLastSessionStorage()
  })

  it('stores last session globally and per profile', () => {
    writeLastSession('dev-session', 'developer')
    writeLastSession('default-session', 'default')

    expect(readLastSession('developer')).toBe('dev-session')
    expect(readLastSession('default')).toBe('default-session')
    expect(readLastSession()).toBe('default-session')
  })

  it('stores last selected agent', () => {
    writeLastAgent('claude-code')
    expect(readLastAgent()).toBe('claude-code')
    writeLastAgent('')
    expect(readLastAgent()).toBe('claude-code')
  })

  it('does not restore another profile session on first load', () => {
    writeLastSession('developer-chat', 'developer')

    expect(
      resolveSessionForProfile(
        [session('default-one'), session('default-two')],
        'default',
      ),
    ).toBe('default-one')
  })

  it('restores the last session that belongs to the active profile', () => {
    writeLastSession('default-two', 'default')

    expect(
      resolveSessionForProfile(
        [session('default-one'), session('default-two')],
        'default',
      ),
    ).toBe('default-two')
  })

  it('falls back to a global last session only when it belongs to the profile', () => {
    writeLastSession('default-two')

    expect(
      resolveSessionForProfile(
        [session('default-one'), session('default-two')],
        'default',
      ),
    ).toBe('default-two')
    expect(
      resolveSessionForProfile([session('default-one')], 'developer'),
    ).toBe('default-one')
  })

  it('uses profile last session when the list is still empty', () => {
    writeLastSession('dev-chat', 'developer')

    expect(resolveSessionForProfile(undefined, 'developer')).toBe('dev-chat')
    expect(resolveSessionForProfile([], 'developer')).toBe('dev-chat')
    expect(
      resolveSessionForProfile([], 'developer', { sessionsLoaded: true }),
    ).toBe('new')
    expect(resolveSessionForProfile(undefined, 'default')).toBe('new')
  })
})
