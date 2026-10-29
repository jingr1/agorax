import { Given, Then, When } from '@cucumber/cucumber'
import { expect } from '@playwright/test'

import { ensureChatComposerReady } from '../../helpers/chat-page'
import { PRIOR_REPLY, installChatMocks } from '../mocks/chat'
import type { AgoraxWorld } from '../support/world'

Given('an isolated chat session is open', async function (this: AgoraxWorld) {
  this.chatMock = await installChatMocks(this.page, this.sessionId)
  await this.page.goto(`/chat/${this.sessionId}`)
  await ensureChatComposerReady(this.page)
  await expect(
    this.page.locator('[data-chat-message-bubble="assistant"]', {
      hasText: PRIOR_REPLY,
    }),
  ).toBeVisible()
})

When(
  'the user rapidly submits the same message twice',
  async function (this: AgoraxWorld) {
    this.prompt = `duplicate-${this.sessionId}`
    this.previousUserCount = await this.page
      .locator('[data-chat-message-bubble="user"]')
      .count()
    await this.page.getByTestId('chat-composer-input').fill(this.prompt)
    const send = this.page.getByTestId('chat-composer-send-button')
    await expect(send).toBeEnabled()
    await send.click()
    await send.click({ force: true })
    this.operations.push('double submit')
  },
)

Then(
  'exactly one new user message is displayed',
  async function (this: AgoraxWorld) {
    const users = this.page.locator('[data-chat-message-bubble="user"]')
    await expect(users.filter({ hasText: this.prompt })).toHaveCount(1)
    await expect(users).toHaveCount(this.previousUserCount + 1)
  },
)

When('the user starts a streaming turn', async function (this: AgoraxWorld) {
  this.prompt = `new-turn-${this.sessionId}-${this.chatMock.turns.length}`
  this.previousUserCount = await this.page
    .locator('[data-chat-message-bubble="user"]')
    .count()
  await this.page.getByTestId('chat-composer-input').fill(this.prompt)
  await this.page.getByTestId('chat-composer-input').press('Enter')
  await expect(
    this.page.getByRole('button', { name: 'Stop generation', exact: true }),
  ).toBeVisible()
  await expect(
    this.page.getByText(`E2E streaming response: ${this.prompt}`, {
      exact: true,
    }),
  ).toBeVisible()
  this.operations.push('start streaming turn')
})

Then(
  'the prior assistant reply stays above the new user message',
  async function (this: AgoraxWorld) {
    const bubbles = this.page.locator('[data-chat-message-bubble]')
    const texts = await bubbles.allTextContents()
    const priorIndex = texts.findIndex((text) => text.includes(PRIOR_REPLY))
    const userIndex = texts.findIndex((text) => text.includes(this.prompt))
    expect(priorIndex).toBeGreaterThanOrEqual(0)
    expect(userIndex).toBeGreaterThan(priorIndex)
    expect(texts.filter((text) => text.includes(PRIOR_REPLY))).toHaveLength(1)
  },
)

When(
  'the user queues a follow-up while streaming',
  async function (this: AgoraxWorld) {
    this.previousUserCount = await this.page
      .locator('[data-chat-message-bubble="user"]')
      .count()
    await this.page
      .getByTestId('chat-composer-input')
      .fill('E2E queued follow-up')
    await this.page.getByRole('button', { name: /Queue message/i }).click()
    await expect(
      this.page.getByText(/message queued|messages queued|Queued \(/i).first(),
    ).toBeVisible()
    this.operations.push('queue follow-up')
  },
)

Then(
  'the queued message is not appended to the transcript',
  async function (this: AgoraxWorld) {
    const users = this.page.locator('[data-chat-message-bubble="user"]')
    await expect(users).toHaveCount(this.previousUserCount)
    await expect(users.filter({ hasText: 'E2E queued follow-up' })).toHaveCount(
      0,
    )
  },
)

Then(
  'the prior assistant reply has no streaming caret',
  async function (this: AgoraxWorld) {
    await expect(
      this.page.locator(
        '[data-chat-message-bubble="assistant"] .chat-streaming-content',
        { hasText: PRIOR_REPLY },
      ),
    ).toHaveCount(0)
  },
)

Then(
  'the prior assistant reply remains visible during the transition',
  async function (this: AgoraxWorld) {
    const prior = this.page.locator('[data-chat-message-bubble="assistant"]', {
      hasText: PRIOR_REPLY,
    })
    for (let sample = 0; sample < 8; sample += 1) {
      await expect(prior).toBeVisible()
      await this.page.waitForTimeout(50)
    }
  },
)

Then(
  'the completed conversation has no duplicated messages',
  async function (this: AgoraxWorld) {
    await expect(
      this.page.locator('[data-chat-message-bubble="user"]'),
    ).toHaveText(['Previous question'])
    await expect(
      this.page.locator('[data-chat-message-bubble="assistant"]'),
    ).toContainText([PRIOR_REPLY])
  },
)

Then('the completed conversation is idle', async function (this: AgoraxWorld) {
  const composer = this.page.getByTestId('chat-composer-input')
  await expect(composer).toBeEnabled()
  await composer.fill('E2E readiness probe')
  await expect(
    this.page.getByTestId('chat-composer-send-button'),
  ).toHaveAttribute('data-action', 'send')
  await composer.fill('')
  await expect(
    this.page.locator(
      '[data-testid="thinking-indicator"], [aria-label="Assistant thinking"], .thinking-indicator, [data-thinking="true"]',
    ),
  ).toHaveCount(0)
  await expect(
    this.page.getByRole('button', { name: /Stop generation|Queue message/i }),
  ).toHaveCount(0)
})

When(
  'the user reloads with stale waiting state',
  async function (this: AgoraxWorld) {
    await this.page.evaluate((sessionId) => {
      sessionStorage.setItem(
        `claude_waiting_${sessionId}`,
        JSON.stringify({ since: Date.now() - 30_000, runId: 'stale-run' }),
      )
    }, this.sessionId)
    await this.page.reload()
    await ensureChatComposerReady(this.page)
    this.operations.push('reload with stale waiting state')
  },
)

Then('stale waiting state is removed', async function (this: AgoraxWorld) {
  await expect
    .poll(() =>
      this.page.evaluate(
        (sessionId) => sessionStorage.getItem(`claude_waiting_${sessionId}`),
        this.sessionId,
      ),
    )
    .toBeNull()
})
