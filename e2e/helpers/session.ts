import type { Page } from '@playwright/test'

export async function getOrCreateTestSession(page: Page): Promise<{ id: string }> {
  const resp = await page.request.post('/api/sessions', {
    data: {
      label: `e2e-send-duplicate-${Date.now()}`,
    },
    headers: { 'Content-Type': 'application/json' },
  })
  if (!resp.ok()) {
    throw new Error(`Failed to create test session: ${await resp.text()}`)
  }
  const json = (await resp.json()) as Record<string, unknown>
  const id = (json.sessionKey as string) || (json.friendlyId as string)
  if (!id) {
    throw new Error(`Unexpected session create response: ${JSON.stringify(json)}`)
  }
  return { id }
}
