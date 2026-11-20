import { Then, When } from '@cucumber/cucumber'
import { expect } from '@playwright/test'

import { ensureChatComposerReady } from '../../helpers/chat-page'
import { PRIOR_REPLY } from '../mocks/chat'
import type { AgoraxWorld } from '../support/world'

When('服务端完成本轮回复', async function (this: AgoraxWorld) {
  this.finalReply = `Final response for ${this.prompt}`
  await this.chatMock.complete(this.sessionId, this.finalReply)
  this.operations.push(`complete: ${this.prompt}`)
})

Then('最终回复只显示一次且退出生成状态', async function (this: AgoraxWorld) {
  const assistants = this.page.locator('[data-chat-message-bubble="assistant"]')
  await expect(assistants.filter({ hasText: this.finalReply })).toHaveCount(1)
  await expect(
    this.page.getByRole('button', { name: 'Stop generation', exact: true }),
  ).toHaveCount(0)
  await expect(
    this.page
      .locator('[data-chat-message-bubble="user"]')
      .filter({ hasText: this.prompt }),
  ).toHaveCount(1)
})

When('刷新当前聊天', async function (this: AgoraxWorld) {
  await this.page.reload()
  await ensureChatComposerReady(this.page)
})

When('下一次发送返回临时服务错误', function (this: AgoraxWorld) {
  this.chatMock.failNext()
})

When('用户发送触发失败的消息', async function (this: AgoraxWorld) {
  await this.page.getByTestId('chat-composer-input').fill('E2E failing message')
  await this.page.getByTestId('chat-composer-input').press('Enter')
  this.operations.push('send: HTTP 503')
})

Then('页面显示发送错误且允许再次发送', async function (this: AgoraxWorld) {
  await expect(
    this.page
      .getByText('E2E temporary service failure', { exact: false })
      .first(),
  ).toBeVisible()
  await this.page.getByTestId('chat-composer-input').fill('E2E recovery probe')
  await expect(
    this.page.getByTestId('chat-composer-send-button'),
  ).toHaveAttribute('data-action', 'send')
  await this.page.getByTestId('chat-composer-input').fill('')
})

When('用户切换到另一个会话', async function (this: AgoraxWorld) {
  await this.page.getByText('E2E other chat', { exact: true }).click()
  await expect(this.page).toHaveURL(new RegExp(`${this.sessionId}-other`))
  this.operations.push('switch to other session while streaming')
})

Then('另一个会话只显示自己的历史', async function (this: AgoraxWorld) {
  await expect(
    this.page.locator('[data-chat-message-bubble="user"]'),
  ).toHaveText(['Other session question'])
  await expect(
    this.page.locator('[data-chat-message-bubble="assistant"]'),
  ).toContainText(['Other session answer'])
  await expect(
    this.page
      .locator('[data-chat-message-bubble]')
      .filter({ hasText: this.prompt }),
  ).toHaveCount(0)
})

When('用户停止生成', async function (this: AgoraxWorld) {
  await this.page
    .getByRole('button', { name: 'Stop generation', exact: true })
    .click()
  await expect(
    this.page.getByRole('button', { name: 'Stop generation', exact: true }),
  ).toHaveCount(0)
  this.operations.push('stop generation')
})

When(
  '在同一页面执行可重放的多轮聊天',
  { timeout: 3_600_000 },
  async function (this: AgoraxWorld) {
    const rounds = Number(process.env.E2E_SOAK_ROUNDS || 20)
    const seed = Number(process.env.E2E_SEED || 12345)
    if (
      !Number.isInteger(rounds) ||
      rounds < 1 ||
      rounds > 10000 ||
      !Number.isInteger(seed)
    ) {
      throw new Error(
        'E2E_SOAK_ROUNDS must be 1..10000 and E2E_SEED must be an integer',
      )
    }
    let randomState = seed >>> 0
    const documentId = await this.page.evaluate(() => performance.timeOrigin)
    this.operations.push(`seed=${seed}; rounds=${rounds}`)
    console.log(`Soak seed=${seed}; rounds=${rounds}`)
    const expectedTranscript = ['Previous question', PRIOR_REPLY]
    for (let round = 0; round < rounds; round += 1) {
      if (round > 0 && round % 25 === 0) {
        await this.context.tracing.stopChunk()
        await this.context.tracing.startChunk({
          title: `soak seed=${seed}; round=${round}`,
        })
      }
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
      const prompt = `soak-${round}-${randomState}`
      await this.page.getByTestId('chat-composer-input').fill(prompt)
      await this.page.getByTestId('chat-composer-input').press('Enter')
      await expect(
        this.page.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toBeVisible()
      await expect(
        this.page
          .locator('[data-chat-message-bubble="assistant"]')
          .filter({ hasText: 'E2E streaming response' }),
      ).toHaveCount(1)
      if (randomState % 2 === 0)
        await this.page
          .getByTestId('chat-composer-input')
          .fill(`draft-${round}`)
      const reply = `soak-response-${round}`
      this.operations.push(`round=${round}; prompt=${prompt}`)
      await this.chatMock.complete(this.sessionId, reply)
      await expect(
        this.page.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(0)
      const earlierMessages = this.page.getByRole('button', {
        name: /^Show \d+ earlier messages/,
      })
      while (await earlierMessages.count()) {
        await earlierMessages.click()
      }
      await expect(
        this.page.locator('[data-chat-message-bubble="user"]'),
      ).toHaveCount(round + 2)
      await expect(
        this.page.locator('[data-chat-message-bubble="assistant"]'),
      ).toHaveCount(round + 2)
      await expect(
        this.page
          .locator('[data-chat-message-bubble="assistant"]')
          .filter({ hasText: reply }),
      ).toHaveCount(1)
      expectedTranscript.push(prompt, reply)
      await expect(
        this.page.locator('[data-chat-message-bubble]'),
      ).toContainText(expectedTranscript)
      await expect(this.page.getByTestId('chat-composer-input')).toHaveValue(
        randomState % 2 === 0 ? `draft-${round}` : '',
      )
      expect(await this.page.evaluate(() => performance.timeOrigin)).toBe(
        documentId,
      )
      expect(this.chatMock.turns).toHaveLength(round + 1)
      await this.page.getByTestId('chat-composer-input').fill('')
    }
  },
)

Then('耐久测试期间没有未捕获页面异常', function (this: AgoraxWorld) {
  expect(this.errors).toEqual([])
})
