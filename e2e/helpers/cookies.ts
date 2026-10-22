import type { BrowserContext, Page } from '@playwright/test'

export async function markUpdateNotesSeen(context: BrowserContext) {
  // Pre-seed localStorage so UpdateCenterNotifier doesn't pop the release-notes
  // modal during tests.
  const blank = await context.newPage()
  await blank.goto('http://127.0.0.1:6734/')
  await blank.evaluate(() => {
    try {
      localStorage.setItem('hermes-update-v2-release-notes-seen', 'test-run')
      localStorage.setItem(
        'hermes-update-v2-release-notes',
        JSON.stringify({ id: 'test-run' }),
      )
    } catch {}
  })
  await blank.close()
}

export async function markUpdateNotesSeenOnPage(page: Page) {
  await page.evaluate(() => {
    try {
      localStorage.setItem('hermes-update-v2-release-notes-seen', 'test-run')
      localStorage.setItem(
        'hermes-update-v2-release-notes',
        JSON.stringify({ id: 'test-run' }),
      )
    } catch {}
  })
}
