import { World, setWorldConstructor } from '@cucumber/cucumber'
import type { BrowserContext, Page } from '@playwright/test'
import type { installGroupChatMocks } from '../mocks/group-chat'
import type { installChatMocks } from '../mocks/chat'

export class AgoraxWorld extends World {
  context!: BrowserContext
  page!: Page
  sessionId = `e2e-${crypto.randomUUID()}`
  errors: Array<string> = []
  operations: Array<string> = []
  prompt = ''
  previousUserCount = 0
  groupMock?: Awaited<ReturnType<typeof installGroupChatMocks>>
  chatMock!: Awaited<ReturnType<typeof installChatMocks>>
  finalReply = ''
}

setWorldConstructor(AgoraxWorld)
