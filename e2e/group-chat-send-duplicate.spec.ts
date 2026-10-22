/**
 * Reproduce: one Enter → two user bubbles → refresh shows one.
 *
 * Root cause (frontend): POST append and SSE refetch both write `messages`.
 * Server publishes `group_chat_message` before the POST response returns. If
 * the SSE-driven `setMessages(list)` commits first, the later
 * `setMessages(prev => [...prev, msg])` appends the same id again. A later
 * refetch replaces the list with one row.
 *
 * This test forces that ordering: hold the POST response, emit SSE so the
 * list refetch lands with the message, then release POST.
 */
import { test, expect, type Page } from '@playwright/test'

const ROOM_ID = `e2e-send-dup-${Date.now()}`
const MESSAGE_ID = `msg-send-dup-${Date.now()}`
const CONTENT = 'hello bots'

type RoomMessage = {
  id: string
  roomId: string
  senderKind: string
  senderParticipantId: null
  senderName: string
  content: string
  mentions: []
  mentionDepth: number
  autoHandoff: boolean
  taskRefs: []
  answersPendingTurnId: null
  runId: null
  taskId: null
  createdAt: number
}

function roomFixture() {
  return {
    id: ROOM_ID,
    title: 'e2e send dup',
    state: 'active',
    missionId: null,
    taskId: null,
    workspacePath: null,
    ownerParticipantId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function messageFixture(content: string): RoomMessage {
  return {
    id: MESSAGE_ID,
    roomId: ROOM_ID,
    senderKind: 'human',
    senderParticipantId: null,
    senderName: 'User',
    content,
    mentions: [],
    mentionDepth: 0,
    autoHandoff: false,
    taskRefs: [],
    answersPendingTurnId: null,
    runId: null,
    taskId: null,
    createdAt: Date.now(),
  }
}

async function dismissModals(page: Page) {
  const continueBtn = page.getByRole('button', { name: 'Continue' })
  if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await continueBtn.click()
  }
}

/** Controllable EventSource so tests can emit SSE after POST is in-flight. */
async function installMockEventSource(page: Page) {
  await page.addInitScript(() => {
    type Handler = (event: { data?: string }) => void
    const registry: Array<{
      handlers: Map<string, Set<Handler>>
      close: () => void
    }> = []

    ;(
      window as unknown as {
        __agoraxEmitSse: (event: string, data: Record<string, unknown>) => void
      }
    ).__agoraxEmitSse = (event, data) => {
      const payload = { data: JSON.stringify(data) }
      for (const es of registry) {
        const set = es.handlers.get(event)
        if (!set) continue
        for (const handler of set) handler(payload)
      }
    }

    class MockEventSource {
      handlers = new Map<string, Set<Handler>>()
      constructor(public url: string) {
        registry.push(this)
        queueMicrotask(() => {
          const connected = this.handlers.get('connected')
          if (!connected) return
          for (const handler of connected) handler({})
        })
      }
      addEventListener(type: string, fn: Handler) {
        if (!this.handlers.has(type)) this.handlers.set(type, new Set())
        this.handlers.get(type)!.add(fn)
      }
      removeEventListener(type: string, fn: Handler) {
        this.handlers.get(type)?.delete(fn)
      }
      close() {
        const idx = registry.indexOf(this)
        if (idx >= 0) registry.splice(idx, 1)
      }
    }

    ;(window as unknown as { EventSource: typeof MockEventSource }).EventSource =
      MockEventSource
  })
}

async function installGroupChatMocks(page: Page): Promise<{
  /** Resolves when the send POST is waiting on the gate. */
  waitForPostHeld: () => Promise<void>
  /** Release the held POST response. */
  releasePost: () => void
  /** After SSE: listMessages returns the sent message. */
  markMessageVisibleInList: () => void
}> {
  const room = roomFixture()
  let listIncludesMessage = false
  let releasePost!: () => void
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve
  })
  let postHeld!: () => void
  const postHeldGate = new Promise<void>((resolve) => {
    postHeld = resolve
  })

  await page.route('**/api/auth-check', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, authRequired: false }),
    })
  })

  await page.route('**/api/connection-status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        chatReady: true,
        modelConfigured: true,
      }),
    })
  })

  await page.route('**/api/rooms', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, rooms: [room] }),
      })
      return
    }
    await route.continue()
  })

  await page.route(`**/api/rooms/${ROOM_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, room }),
    })
  })

  await page.route(`**/api/rooms/${ROOM_ID}/participants`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, room, participants: [] }),
    })
  })

  await page.route(`**/api/rooms/${ROOM_ID}/pending-turns`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, room, pendingTurns: [] }),
    })
  })

  // Real EventSource is mocked; keep a harmless stub if anything still hits it.
  await page.route('**/api/chat-events**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: connected\ndata: {}\n\n',
    })
  })

  await page.route(`**/api/rooms/${ROOM_ID}/messages`, async (route) => {
    if (route.request().method() === 'POST') {
      const body = (await route.request().postDataJSON()) as { content: string }
      postHeld()
      await postGate
      // Let the SSE-driven setMessages([msg]) flush before POST append runs.
      await new Promise((r) => setTimeout(r, 50))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          room,
          message: messageFixture(body.content),
        }),
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        room,
        messages: listIncludesMessage ? [messageFixture(CONTENT)] : [],
      }),
    })
  })

  return {
    waitForPostHeld: () => postHeldGate,
    releasePost,
    markMessageVisibleInList: () => {
      listIncludesMessage = true
    },
  }
}

test.describe('Group chat send duplicates', () => {
  test('one Enter must not leave two bubbles when SSE refetch beats POST append', async ({
    page,
  }) => {
    await installMockEventSource(page)
    const mocks = await installGroupChatMocks(page)

    await page.goto(`/group-chat/${ROOM_ID}`)
    await page.waitForLoadState('domcontentloaded')
    await dismissModals(page)

    const composer = page.locator('textarea[aria-label="Group chat message"]')
    await expect(composer).toBeVisible({ timeout: 10_000 })
    await composer.fill(CONTENT)
    await composer.press('Enter')

    // POST is in-flight; composer already cleared by handleSend.
    await mocks.waitForPostHeld()
    await expect(composer).toHaveValue('')

    // Server would publish group_chat_message before the HTTP response.
    // Land the refetch replace first (list already contains the same id).
    mocks.markMessageVisibleInList()
    await page.evaluate(
      ({ roomId, messageId }) => {
        ;(
          window as unknown as {
            __agoraxEmitSse: (
              event: string,
              data: Record<string, unknown>,
            ) => void
          }
        ).__agoraxEmitSse('group_chat_message', { roomId, messageId })
      },
      { roomId: ROOM_ID, messageId: MESSAGE_ID },
    )

    const userBubbles = page.locator('[data-chat-message-bubble="user"]')
    // SSE replace committed: one bubble before POST append.
    await expect(userBubbles).toHaveCount(1)

    mocks.releasePost()

    // Give the POST append path time to race. Bug → 2; fix → stays 1.
    await page.waitForTimeout(400)
    await expect(userBubbles).toHaveCount(1)
    await expect(userBubbles).toHaveText([CONTENT])

    // Simulate "refresh": list endpoint is the durable source (still one row).
    await page.reload()
    await dismissModals(page)
    await expect(
      page.locator('[data-chat-message-bubble="user"]'),
    ).toHaveCount(1)
  })
})
