import type { Page } from '@playwright/test'

export async function ensureChatComposerReady(page: Page, timeoutMs = 10000) {
  const input = page.getByTestId('chat-composer-input')
  await input.waitFor({ state: 'visible', timeout: timeoutMs })
  return input
}
