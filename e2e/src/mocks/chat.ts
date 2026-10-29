import { installStreamMock } from './stream'
import type { MockMessage } from './stream'
import type { Page } from '@playwright/test'

export const PRIOR_REPLY = 'Previous completed assistant response'

export async function installChatMocks(page: Page, sessionId: string) {
  const histories = new Map<string, Array<MockMessage>>([
    [
      sessionId,
      [
        {
          id: 'hist-user',
          messageId: 'hist-user',
          role: 'user',
          content: [{ type: 'text', text: 'Previous question' }],
          timestamp: Date.now() - 60_000,
        },
        {
          id: 'hist-assistant',
          messageId: 'assistant:run-old',
          role: 'assistant',
          content: [{ type: 'text', text: PRIOR_REPLY }],
          timestamp: Date.now() - 50_000,
        },
      ],
    ],
    [
      `${sessionId}-other`,
      [
        {
          id: 'other-user',
          messageId: 'other-user',
          role: 'user',
          content: [{ type: 'text', text: 'Other session question' }],
          timestamp: Date.now() - 60_000,
        },
        {
          id: 'other-assistant',
          messageId: 'assistant:other',
          role: 'assistant',
          content: [{ type: 'text', text: 'Other session answer' }],
          timestamp: Date.now() - 50_000,
        },
      ],
    ],
  ])
  const stream = await installStreamMock(page, histories)
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    if (pathname === '/api/auth-check') {
      await route.fulfill({
        json: { authenticated: true, authRequired: false },
      })
    } else if (pathname === '/api/connection-status') {
      await route.fulfill({
        json: { ok: true, chatReady: true, modelConfigured: true },
      })
    } else if (pathname === '/api/sessions') {
      await route.fulfill({
        json: {
          sessions: [...histories.keys()].map((key) => ({
            key,
            sessionKey: key,
            friendlyId: key,
            title: key.endsWith('-other') ? 'E2E other chat' : 'E2E chat',
          })),
        },
      })
    } else if (pathname === '/api/history') {
      const key =
        url.searchParams.get('sessionKey') ||
        url.searchParams.get('friendlyId') ||
        sessionId
      await route.fulfill({
        json: {
          sessionKey: key,
          messages: (histories.get(key) ?? []).map((message, historyIndex) => ({
            ...message,
            historyIndex,
          })),
        },
      })
    } else if (pathname.endsWith('/active-run')) {
      await route.fulfill({ json: { ok: true, active: false, run: null } })
    } else if (pathname === '/api/agents') {
      await route.fulfill({
        json: {
          agents: [
            {
              agentId: 'default',
              name: 'Hermes',
              runtime: 'hermes',
              runtimeConfig: { profile: 'default' },
              status: 'idle',
            },
          ],
        },
      })
    } else if (pathname.endsWith('/models')) {
      await route.fulfill({ json: { models: [], providers: [] } })
    } else if (pathname === '/api/profiles') {
      await route.fulfill({
        json: {
          profiles: [{ name: 'default', active: true }],
          activeProfile: 'default',
        },
      })
    } else if (pathname === '/api/ping') {
      await route.fulfill({ json: { ok: true } })
    } else if (pathname === '/api/workspace') {
      await route.fulfill({
        json: {
          path: '',
          folderName: 'E2E',
          source: 'test',
          isValid: true,
          workspaces: [],
          last: '',
        },
      })
    } else if (pathname === '/api/files') {
      await route.fulfill({ json: { entries: [] } })
    } else if (/^\/api\/runs\/[^/]+\/stop$/.test(pathname)) {
      await route.fulfill({ json: { ok: true } })
    } else {
      await route.fulfill({
        status: 404,
        json: { error: `No E2E fixture for ${pathname}` },
      })
    }
  })
  return stream
}
