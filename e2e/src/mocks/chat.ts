import { installStreamMock } from './stream'
import type { MockMessage } from './stream'
import type { Page } from '@playwright/test'

export const PRIOR_REPLY = 'Previous completed assistant response'

export const MULTI_TURN_REPLIES = [
  '你好！有什么我可以帮你的吗？',
  '我是 Architect Agent，一个系统架构与技术规格 Agent。',
  '我目前没在跑任何具体任务。',
] as const

export const MULTI_TURN_PROMPTS = ['你好', '你是谁？', '你在干什么？'] as const

/** Same wall-clock ms for every row — reproduces the UUUAAA sort trap. */
export function buildEqualTimestampMultiTurnHistory(
  sharedTimestampMs: number,
): Array<MockMessage> {
  const messages: Array<MockMessage> = []
  for (let index = 0; index < MULTI_TURN_PROMPTS.length; index += 1) {
    const runId = `run-equal-${index + 1}`
    messages.push({
      id: `hist-user-${index + 1}`,
      messageId: `hist-user-${index + 1}`,
      role: 'user',
      content: [{ type: 'text', text: MULTI_TURN_PROMPTS[index]! }],
      timestamp: sharedTimestampMs,
      turnId: `turn-${runId}`,
    })
    messages.push({
      id: `assistant:${runId}`,
      messageId: `assistant:${runId}`,
      role: 'assistant',
      content: [{ type: 'text', text: MULTI_TURN_REPLIES[index]! }],
      timestamp: sharedTimestampMs,
      turnId: `turn-${runId}`,
      runId,
    })
  }
  return messages
}

export async function installChatMocks(
  page: Page,
  sessionId: string,
  options?: { equalTimestampMultiTurn?: boolean },
) {
  const sharedTimestamp = Date.UTC(2026, 10, 2, 12, 0, 0)
  const primaryHistory = options?.equalTimestampMultiTurn
    ? buildEqualTimestampMultiTurnHistory(sharedTimestamp)
    : ([
        {
          id: 'hist-user',
          messageId: 'hist-user',
          role: 'user',
          content: [{ type: 'text', text: 'Previous question' }],
          timestamp: Date.now() - 60_000,
          turnId: 'turn-run-old',
        },
        {
          id: 'hist-assistant',
          messageId: 'assistant:run-old',
          role: 'assistant',
          content: [{ type: 'text', text: PRIOR_REPLY }],
          timestamp: Date.now() - 50_000,
          turnId: 'turn-run-old',
          runId: 'run-old',
        },
      ] satisfies Array<MockMessage>)
  const histories = new Map<string, Array<MockMessage>>([
    [sessionId, primaryHistory],
    [
      `${sessionId}-other`,
      [
        {
          id: 'other-user',
          messageId: 'other-user',
          role: 'user',
          content: [{ type: 'text', text: 'Other session question' }],
          timestamp: Date.now() - 60_000,
          turnId: 'turn-other',
        },
        {
          id: 'other-assistant',
          messageId: 'assistant:other',
          role: 'assistant',
          content: [{ type: 'text', text: 'Other session answer' }],
          timestamp: Date.now() - 50_000,
          turnId: 'turn-other',
          runId: 'other',
        },
      ],
    ],
  ])
  const stream = await installStreamMock(page, histories)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const method = request.method().toUpperCase()
    if (pathname === '/api/auth-check') {
      await route.fulfill({
        json: { authenticated: true, authRequired: false },
      })
    } else if (pathname === '/api/connection-status') {
      await route.fulfill({
        json: { ok: true, chatReady: true, modelConfigured: true },
      })
    } else if (pathname === '/api/sessions' && method === 'POST') {
      // activateSession create path — must return sessionKey / persisted.
      let body: Record<string, unknown> = {}
      try {
        body = request.postDataJSON() as Record<string, unknown>
      } catch {
        body = {}
      }
      const key =
        (typeof body.friendlyId === 'string' && body.friendlyId.trim()) ||
        (typeof body.id === 'string' && body.id.trim()) ||
        `e2e-created-${crypto.randomUUID()}`
      if (!histories.has(key)) histories.set(key, [])
      await route.fulfill({
        status: 200,
        json: {
          ok: true,
          sessionKey: key,
          friendlyId: key,
          persisted: true,
        },
      })
    } else if (pathname === '/api/sessions') {
      await route.fulfill({
        json: {
          sessions: [...histories.keys()].map((key) => ({
            key,
            sessionKey: key,
            friendlyId: key,
            title: key.endsWith('-other')
              ? 'E2E other chat'
              : options?.equalTimestampMultiTurn
                ? '你好 #2'
                : 'E2E chat',
          })),
        },
      })
    } else if (pathname === '/api/history') {
      const key =
        url.searchParams.get('sessionKey') ||
        url.searchParams.get('friendlyId') ||
        sessionId
      // Equal-timestamp multi-turn intentionally omits historyIndex so the
      // client must keep source order on ties (the UUUAAA / mash trap).
      const omitHistoryIndex = Boolean(options?.equalTimestampMultiTurn)
      await route.fulfill({
        json: {
          sessionKey: key,
          messages: (histories.get(key) ?? []).map((message, historyIndex) =>
            omitHistoryIndex ? message : { ...message, historyIndex },
          ),
        },
      })
    } else if (pathname === '/api/agorax-run-mapping') {
      if (method === 'PUT') {
        let mapping: Record<string, unknown> = {}
        try {
          mapping = request.postDataJSON() as Record<string, unknown>
        } catch {
          mapping = {}
        }
        await route.fulfill({ json: { mapping } })
      } else {
        await route.fulfill({ json: { mapping: null } })
      }
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
