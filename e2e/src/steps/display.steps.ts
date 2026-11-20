import { Given, Then, When } from '@cucumber/cucumber'
import { expect } from '@playwright/test'

import { ensureChatComposerReady } from '../../helpers/chat-page'
import {
  MULTI_TURN_PROMPTS,
  MULTI_TURN_REPLIES,
  installChatMocks,
} from '../mocks/chat'
import type { AgoraxWorld } from '../support/world'

Given(
  'a multi-turn equal-timestamp chat session is open',
  async function (this: AgoraxWorld) {
    this.chatMock = await installChatMocks(this.page, this.sessionId, {
      equalTimestampMultiTurn: true,
    })
    await this.page.goto(`/chat/${this.sessionId}`)
    await ensureChatComposerReady(this.page)
    await expect(
      this.page.locator('[data-chat-message-bubble="assistant"]', {
        hasText: MULTI_TURN_REPLIES[0]!,
      }),
    ).toBeVisible()
  },
)

Then(
  'the transcript keeps interleaved user and assistant turns',
  async function (this: AgoraxWorld) {
    const bubbles = this.page.locator('[data-chat-message-bubble]')
    await expect(bubbles).toHaveCount(MULTI_TURN_PROMPTS.length * 2)

    const roles = await bubbles.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-chat-message-bubble')),
    )
    expect(roles).toEqual(
      Array.from({ length: MULTI_TURN_PROMPTS.length }, () => [
        'user',
        'assistant',
      ]).flat(),
    )

    const texts = await bubbles.allTextContents()
    for (let index = 0; index < MULTI_TURN_PROMPTS.length; index += 1) {
      expect(texts[index * 2]).toContain(MULTI_TURN_PROMPTS[index]!)
      expect(texts[index * 2 + 1]).toContain(MULTI_TURN_REPLIES[index]!)
    }
  },
)

Then(
  'each assistant reply stays in its own bubble',
  async function (this: AgoraxWorld) {
    const assistants = this.page.locator(
      '[data-chat-message-bubble="assistant"]',
    )
    await expect(assistants).toHaveCount(MULTI_TURN_REPLIES.length)
    for (const reply of MULTI_TURN_REPLIES) {
      await expect(assistants.filter({ hasText: reply })).toHaveCount(1)
    }
    // Mashed fold would put every reply body into one host.
    await expect(
      assistants.filter({
        hasText: MULTI_TURN_REPLIES[0]!,
      }),
    ).not.toContainText(MULTI_TURN_REPLIES[1]!)
    await expect(
      assistants.filter({
        hasText: MULTI_TURN_REPLIES[1]!,
      }),
    ).not.toContainText(MULTI_TURN_REPLIES[2]!)
  },
)

When(
  'the next stream turn starts with thinking only',
  function (this: AgoraxWorld) {
    this.chatMock.holdThinkingFirst()
  },
)

When(
  'the user starts a thinking-first streaming turn',
  async function (this: AgoraxWorld) {
    this.prompt = `thinking-first-${this.sessionId}`
    this.previousUserCount = await this.page
      .locator('[data-chat-message-bubble="user"]')
      .count()
    await this.page.getByTestId('chat-composer-input').fill(this.prompt)
    await this.page.getByTestId('chat-composer-input').press('Enter')
    await expect(
      this.page.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toBeVisible()
    await expect(
      this.page
        .locator('[data-chat-message-bubble="user"]')
        .filter({ hasText: this.prompt }),
    ).toHaveCount(1)
    this.operations.push('start thinking-first streaming turn')
  },
)

Then(
  'the live Thinking label is visible',
  async function (this: AgoraxWorld) {
    await expect(this.page.locator('.thinking-live-label')).toBeVisible()
    await expect(this.page.locator('.thinking-live-label')).toHaveText(
      /Thinking/i,
    )
  },
)

Then('the live Thinking label is gone', async function (this: AgoraxWorld) {
  await expect(this.page.locator('.thinking-live-label')).toHaveCount(0)
})

When(
  'the stream releases the assistant reply text',
  async function (this: AgoraxWorld) {
    await this.chatMock.releaseText(
      this.sessionId,
      `E2E streaming response: ${this.prompt}`,
    )
    this.operations.push('release thinking-first text')
  },
)

Then(
  'the streaming assistant reply is visible once',
  async function (this: AgoraxWorld) {
    const reply = `E2E streaming response: ${this.prompt}`
    await expect(
      this.page.getByText(reply, {
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      this.page
        .locator('[data-chat-message-bubble="assistant"]')
        .filter({ hasText: reply }),
    ).toHaveCount(1)
  },
)
