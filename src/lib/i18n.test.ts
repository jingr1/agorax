import { describe, expect, it } from 'vitest'
import { LOCALE_LABELS, t, type LocaleId } from './i18n'

function withLocale<T>(locale: LocaleId, fn: () => T): T {
  const originalWindow = globalThis.window
  const originalNavigator = globalThis.navigator
  const store = new Map<string, string>([['agorax-locale', locale]])
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { language: 'en-US' },
  })
  try {
    return fn()
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    })
  }
}

describe('i18n translations', () => {
  it('uses English labels by default', () => {
    withLocale('en', () => {
      expect(t('nav.dashboard')).toBe('Dashboard')
      expect(t('nav.missions')).toBe('Missions')
      expect(t('nav.agents')).toBe('Agents')
    })
  })

  it('uses Simplified Chinese labels for wired navigation keys', () => {
    withLocale('zh', () => {
      expect(t('nav.dashboard')).toBe('仪表板')
      expect(t('nav.missions')).toBe('任务')
      expect(t('nav.agents')).toBe('智能体')
      expect(t('nav.profiles')).toBe('配置文件')
    })
  })

  it('exposes only English and Simplified Chinese locale labels', () => {
    expect(Object.keys(LOCALE_LABELS).sort()).toEqual(['en', 'zh'])
    expect(LOCALE_LABELS.en).toBe('English')
    expect(LOCALE_LABELS.zh).toBe('中文（简体）')
  })
})
