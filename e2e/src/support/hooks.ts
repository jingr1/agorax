import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  After,
  AfterAll,
  Before,
  BeforeAll,
  Status,
  setDefaultTimeout,
} from '@cucumber/cucumber'
import {  chromium } from '@playwright/test'
import { installEventSourceMock } from '../mocks/events'
import type {Browser} from '@playwright/test';

import type { AgoraxWorld } from './world'

let browser: Browser | undefined
setDefaultTimeout(30_000)

BeforeAll(async () => {
  await mkdir('e2e/reports/artifacts', { recursive: true })
  browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
  })
})

Before(async function (this: AgoraxWorld) {
  if (!browser) throw new Error('E2E browser was not initialized')
  this.context = await browser.newContext({
    baseURL:
      process.env.BASE_URL ||
      process.env.PLAYWRIGHT_BASE_URL ||
      'http://127.0.0.1:6734',
    viewport: { width: 1280, height: 720 },
    serviceWorkers: 'block',
  })
  await this.context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  })
  await this.context.addInitScript(() => {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return
    localStorage.setItem('agorax-onboarding-complete', 'true')
    localStorage.setItem('hermes-update-v2-release-notes-seen', 'test-run')
    localStorage.setItem(
      'hermes-update-v2-release-notes',
      JSON.stringify({ id: 'test-run' }),
    )
  })
  this.page = await this.context.newPage()
  await installEventSourceMock(this.page)
  this.page.on('pageerror', (error) => this.errors.push(error.message))
})

After(async function (this: AgoraxWorld, { result }) {
  if (!Object.hasOwn(this, 'context')) return
  try {
    if (result?.status === Status.FAILED || this.errors.length > 0) {
      await this.attach(
        JSON.stringify({ errors: this.errors, operations: this.operations }),
        'application/json',
      )
      if (Object.hasOwn(this, 'page') && !this.page.isClosed()) {
        await this.attach(
          await this.page.screenshot({ fullPage: true }),
          'image/png',
        )
      }
      const tracePath = resolve(`e2e/reports/artifacts/${this.sessionId}.zip`)
      await this.context.tracing.stop({ path: tracePath })
      await this.attach(`Trace: ${tracePath}`, 'text/plain')
    } else {
      await this.context.tracing.stop()
    }
  } finally {
    this.groupMock?.releasePost()
    await this.context.close()
  }
  if (this.errors.length > 0)
    throw new Error(`Uncaught page errors: ${this.errors.join('\n')}`)
})

AfterAll(async () => {
  await browser?.close()
})
