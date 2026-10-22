import { test, expect } from '@playwright/test'
import { getOrCreateTestSession } from './helpers/session'
import { ensureChatComposerReady } from './helpers/chat-page'

test.describe('Chat send duplicate root-cause reproduction', () => {
  test('rapid double submit must produce exactly one user message', async ({ page }) => {
    const session = await getOrCreateTestSession(page)
    await page.goto(`/chat/${session.id}`)

    const input = await ensureChatComposerReady(page, 10000)

    const prompt = `duplicate-repro-${Date.now()}`
    await input.fill(prompt)

    const previousUserMessages = await page.locator('[data-chat-message-bubble="user"]').count()

    const sendButton = page.locator('[data-testid="chat-composer-send-button"]')
    await expect(sendButton).toBeEnabled()

    // Double-click as fast as possible; force second click through any transient overlay.
    await sendButton.click()
    await sendButton.click({ force: true })

    // Wait for the optimistic row to appear and any duplicate to settle.
    await page.waitForTimeout(2000)

    const userMessages = page.locator('[data-chat-message-bubble="user"]')
    const texts = await userMessages.evaluateAll((els) => els.map((el) => el.textContent ?? ''))
    const matches = texts.filter((t) => t.includes(prompt))

    expect(matches.length).toBe(1)
    expect(await userMessages.count()).toBe(previousUserMessages + 1)
  })
})
