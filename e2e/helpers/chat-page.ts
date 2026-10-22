import type { Page } from '@playwright/test'

export async function ensureChatComposerReady(page: Page, timeoutMs = 10000) {
  // Wait for the root route chrome / app shell to render.
  await page.waitForSelector('body', { state: 'attached', timeout: timeoutMs })

  // Poll-dismiss any overlay-scrim modal that blocks composer interactions.
  for (let attempt = 0; attempt < 5; attempt++) {
    const anyModal = page.locator('.overlay-scrim:visible')
    const count = await anyModal.count()
    if (count === 0) break

    const closeBtn = anyModal.locator('button').filter({ hasText: /Continue|Close|Dismiss|Got it/i }).first()
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeBtn.click()
    } else {
      await page.keyboard.press('Escape')
    }
    await page.waitForTimeout(200)
  }

  // Ensure composer input is visible.
  const input = page.locator('[data-testid="chat-composer-input"]')
  await input.waitFor({ state: 'visible', timeout: timeoutMs })
  return input
}
