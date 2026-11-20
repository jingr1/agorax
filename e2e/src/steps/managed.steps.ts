import { Given, Then, When } from '@cucumber/cucumber'
import { expect } from '@playwright/test'
import { installChatMocks } from '../mocks/chat'
import { installPageMocks } from '../mocks/pages'
import { installManagedMock } from '../mocks/managed'
import type { AgoraxWorld } from '../support/world'

Given(
  'managed 聊天使用隔离会话',
  { timeout: 60_000 },
  async function (this: AgoraxWorld) {
    this.chatMock = await installChatMocks(this.page, this.sessionId)
    await installPageMocks(this.page)
    await installManagedMock(this.page, this.sessionId)
    await this.page.goto(`/chat/agent/cc-impl?session=${this.sessionId}`)
    await expect(this.page.getByTestId('chat-composer-input')).toBeVisible({
      timeout: 30_000,
    })
    const detail = this.page.waitForResponse(
      (response) =>
        response.url().includes('/engine/session/') &&
        response.url().endsWith('/detail') &&
        response.ok(),
    )
    await this.page.evaluate(() =>
      Reflect.get(window, '__agoraxEmitSse')('connected', {
        workspaceId: 'e2e-workspace',
      }),
    )
    await detail
  },
)

Given(
  'managed 聊天使用空会话列表',
  { timeout: 60_000 },
  async function (this: AgoraxWorld) {
    this.chatMock = await installChatMocks(this.page, this.sessionId)
    await installPageMocks(this.page)
    await installManagedMock(this.page, this.sessionId, { empty: true })
    await this.page.goto('/chat/agent/cc-impl')
    await expect(this.page.getByTestId('chat-composer-input')).toBeVisible({
      timeout: 30_000,
    })
  },
)

When(
  '用户发送 managed 消息 {string}',
  async function (this: AgoraxWorld, text: string) {
    await this.page.getByTestId('chat-composer-input').fill(text)
    await this.page.getByTestId('chat-composer-input').press('Enter')
    this.operations.push(
      JSON.stringify(
        await this.page.evaluate(() =>
          Reflect.get(window, '__agoraxInspectSse')(),
        ),
      ),
    )
  },
)

Then(
  'managed 回复 {string} 只显示一次',
  async function (this: AgoraxWorld, text: string) {
    await expect(
      this.page
        .locator('[data-chat-message-bubble="assistant"]')
        .filter({ hasText: text }),
    ).toHaveCount(1, { timeout: 15_000 })
  },
)

Then(
  '会话列表包含 {string}',
  async function (this: AgoraxWorld, title: string) {
    await expect(this.page.getByText(title, { exact: true })).toBeVisible({
      timeout: 15_000,
    })
  },
)

Then(
  '会话列表不包含 {string}',
  async function (this: AgoraxWorld, title: string) {
    await expect(this.page.getByText(title, { exact: true })).toHaveCount(0)
  },
)

When(
  '用户将唯一会话重命名为 {string}',
  async function (this: AgoraxWorld, title: string) {
    await this.page
      .getByRole('button', { name: 'Session options', exact: true })
      .click()
    await this.page
      .getByRole('menuitem', { name: 'Rename', exact: true })
      .click()
    await this.page
      .getByRole('textbox', { name: 'Rename session', exact: true })
      .fill(title)
    await this.page
      .getByRole('textbox', { name: 'Rename session', exact: true })
      .press('Enter')
  },
)

When('用户删除唯一会话', async function (this: AgoraxWorld) {
  await this.page
    .getByRole('button', { name: 'Session options', exact: true })
    .click()
  await this.page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await this.page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
})
