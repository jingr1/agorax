import { Given, Then, When } from '@cucumber/cucumber'
import { expect } from '@playwright/test'

import { installChatMocks } from '../mocks/chat'
import { emitRoomMessage } from '../mocks/events'
import { GROUP_MESSAGE, installGroupChatMocks } from '../mocks/group-chat'
import type { AgoraxWorld } from '../support/world'

Given(
  'an isolated group chat room is open',
  async function (this: AgoraxWorld) {
    await installChatMocks(this.page, this.sessionId)
    this.groupMock = await installGroupChatMocks(this.page, this.sessionId)
    await this.page.goto(`/group-chat/${this.sessionId}`)
    await expect(
      this.page.getByRole('textbox', { name: 'Group chat message' }),
    ).toBeVisible({ timeout: 15_000 })
  },
)

When(
  'the user sends a group message with its POST response held',
  async function (this: AgoraxWorld) {
    const composer = this.page.getByRole('textbox', {
      name: 'Group chat message',
    })
    await composer.fill(GROUP_MESSAGE)
    await composer.press('Enter')
    await this.groupMock!.postHeld
    await expect(composer).toHaveValue('')
    this.operations.push('hold send POST')
  },
)

When(
  'the server publishes the message before the POST response',
  async function (this: AgoraxWorld) {
    this.groupMock!.showInList()
    await emitRoomMessage(this.page, this.sessionId, this.groupMock!.messageId)
    this.operations.push('emit group_chat_message before releasing POST')
  },
)

Then(
  'the group transcript contains exactly one sent message',
  async function (this: AgoraxWorld) {
    await expect(
      this.page.locator('[data-chat-message-bubble="user"]'),
    ).toHaveText([GROUP_MESSAGE])
  },
)

When('the POST response is released', async function (this: AgoraxWorld) {
  const pendingResponse = this.page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/rooms/${this.sessionId}/messages`) &&
      response.request().method() === 'POST',
  )
  this.groupMock!.releasePost()
  await pendingResponse
  await this.groupMock!.postReturned
  await this.page.waitForTimeout(400)
  this.operations.push('release send POST')
})

When('the group chat is reloaded', async function (this: AgoraxWorld) {
  await this.page.reload()
  await expect(
    this.page.getByRole('textbox', { name: 'Group chat message' }),
  ).toBeVisible({ timeout: 15_000 })
})
