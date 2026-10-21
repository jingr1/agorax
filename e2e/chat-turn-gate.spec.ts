/**
 * Architectural e2e for chat turn bugs that UI patches kept missing:
 * - follow-up while busy must not put a new user into the transcript
 * - prior assistant must not grow a streaming caret after a new turn face
 * - prior assistant body must not relocate under a new user
 *
 * SSE is kept open via page fetch patch (route.fulfill closes the stream).
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = `e2e-turn-gate-${Date.now()}`

async function dismissModals(page: Page) {
  const continueBtn = page.getByRole('button', { name: 'Continue' })
  if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await continueBtn.click()
  }
}

async function installChatMocks(page: Page) {
  // Keep send-stream open forever so the turn stays busy (fulfill closes SSE).
  await page.addInitScript((sessionId) => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url.includes('/api/send-stream')) {
        const runId = `run-e2e-${Date.now()}`
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const frame = (event: string, data: Record<string, unknown>) => {
              controller.enqueue(
                encoder.encode(
                  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                ),
              )
            }
            frame('started', {
              runId,
              sessionKey: sessionId,
              friendlyId: sessionId,
              messageId: `assistant:${runId}`,
            })
            frame('chunk', { runId, text: '正在生成……' })
            // Intentionally never close — prior turn remains unsettled.
          },
        })
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'x-session-key': sessionId,
            'x-friendly-id': sessionId,
          },
        })
      }
      return originalFetch(input, init)
    }
  }, SESSION_ID)

  await page.route('**/api/history**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionKey: SESSION_ID,
        messages: [
          {
            id: 'hist-u1',
            messageId: 'hist-u1',
            role: 'user',
            content: [{ type: 'text', text: '旧问题' }],
            timestamp: Date.now() - 60_000,
          },
          {
            id: 'hist-a1',
            messageId: 'assistant:run-old',
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: '旧回复：官方 Skill 是上游最小起点；perfetto-mcp 工具最具体。',
              },
            ],
            timestamp: Date.now() - 50_000,
          },
        ],
      }),
    })
  })

  await page.route('**/api/sessions**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: [
            {
              key: SESSION_ID,
              sessionKey: SESSION_ID,
              friendlyId: SESSION_ID,
              title: 'e2e turn gate',
            },
          ],
        }),
      })
      return
    }
    await route.continue()
  })
}

test.describe('Chat turn gate (busy follow-up)', () => {
  test('busy Enter queues — no new user row, no relocate of prior assistant', async ({
    page,
  }) => {
    await installChatMocks(page)
    await page.goto(`/chat/${SESSION_ID}`)
    await page.waitForLoadState('domcontentloaded')
    await dismissModals(page)

    await expect(
      page.locator('[data-chat-message-bubble="assistant"]').first(),
    ).toBeVisible({ timeout: 20_000 })

    const priorText = page.locator('[data-chat-message-bubble="assistant"]', {
      hasText: '旧回复',
    })
    await expect(priorText.first()).toBeVisible()

    const composer = page.locator('textarea, [contenteditable="true"]').last()
    await expect(composer).toBeVisible()

    await composer.fill('开始新一轮长回复')
    await composer.press('Enter')

    // Live turn chrome: Stop / Queue / streaming text.
    await expect(
      page
        .getByRole('button', { name: /Stop|Queue/i })
        .or(page.locator('text=/正在生成|Generating|queues a follow-up/i')),
    ).toBeVisible({ timeout: 15_000 })

    // Prior assistant must stay above the new user — not duplicated under it.
    const bubbles = page.locator(
      '[data-chat-message-bubble="user"], [data-chat-message-bubble="assistant"]',
    )
    await expect
      .poll(async () => {
        const texts = (await bubbles.allTextContents()).map((t) =>
          t.replace(/\s+/g, ' ').trim(),
        )
        return texts.findIndex((t) => t.includes('开始新一轮长回复'))
      })
      .toBeGreaterThanOrEqual(0)

    const texts = (await bubbles.allTextContents()).map((t) =>
      t.replace(/\s+/g, ' ').trim(),
    )
    const newUserIdx = texts.findIndex((t) => t.includes('开始新一轮长回复'))
    expect(newUserIdx).toBeGreaterThanOrEqual(0)
    const priorUnderNew = texts
      .slice(newUserIdx + 1)
      .some((t) => t.includes('旧回复：官方 Skill'))
    expect(priorUnderNew).toBe(false)

    const userBefore = await page
      .locator('[data-chat-message-bubble="user"]')
      .count()

    await composer.fill('setcap 跑完了')
    await expect(composer).toHaveValue('setcap 跑完了')
    await page.getByRole('button', { name: /Queue message/i }).click()

    // Queue banner (composer) or toast — either proves follow-up stayed out of list.
    await expect(
      page
        .locator('text=/message queued|messages queued|Queued \\(/i')
        .first(),
    ).toBeVisible({ timeout: 10_000 })

    const userAfter = await page
      .locator('[data-chat-message-bubble="user"]')
      .count()
    expect(userAfter).toBe(userBefore)

    await expect(
      page.locator('[data-chat-message-bubble="user"]', {
        hasText: 'setcap 跑完了',
      }),
    ).toHaveCount(0)

    const priorWithCaret = page.locator(
      '[data-chat-message-bubble="assistant"] .chat-streaming-content',
      { hasText: '旧回复' },
    )
    await expect(priorWithCaret).toHaveCount(0)
  })

  test('Enter does not flash prior reply away or duplicate the new user', async ({
    page,
  }) => {
    await installChatMocks(page)
    await page.goto(`/chat/${SESSION_ID}`)
    await page.waitForLoadState('domcontentloaded')
    await dismissModals(page)

    const prior = page.locator('[data-chat-message-bubble="assistant"]', {
      hasText: '旧回复：官方 Skill',
    })
    await expect(prior.first()).toBeVisible({ timeout: 20_000 })

    const composer = page.locator('textarea, [contenteditable="true"]').last()
    await composer.fill('不要刷没旧回复')
    await composer.press('Enter')

    // Prior reply must remain visible across the send→stream transition
    // (no empty frame where it vanished then reappeared).
    for (let i = 0; i < 8; i += 1) {
      await expect(prior.first()).toBeVisible({ timeout: 2_000 })
      await page.waitForTimeout(50)
    }

    await expect(
      page.locator('[data-chat-message-bubble="user"]', {
        hasText: '不要刷没旧回复',
      }),
    ).toHaveCount(1)

    // No duplicate user bubbles for the same prompt.
    const userTexts = await page
      .locator('[data-chat-message-bubble="user"]')
      .allTextContents()
    const matches = userTexts.filter((t) => t.includes('不要刷没旧回复'))
    expect(matches).toHaveLength(1)
  })
})
