import type { Page } from '@playwright/test'

export const GROUP_MESSAGE = 'hello bots'

export async function installGroupChatMocks(page: Page, roomId: string) {
  await page.route('**/api/available-agents**', (route) =>
    route.fulfill({ json: { ok: true, agents: [] } }),
  )
  const messageId = `message-${roomId}`
  const room = {
    id: roomId,
    title: 'E2E room',
    state: 'active',
    missionId: null,
    taskId: null,
    workspacePath: null,
    ownerParticipantId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const message = {
    id: messageId,
    roomId,
    senderKind: 'human',
    senderParticipantId: null,
    senderName: 'User',
    content: GROUP_MESSAGE,
    mentions: [],
    mentionDepth: 0,
    autoHandoff: false,
    taskRefs: [],
    answersPendingTurnId: null,
    runId: null,
    taskId: null,
    createdAt: Date.now(),
  }
  let visibleInList = false
  let releasePost!: () => void
  let markPostHeld!: () => void
  let markPostReturned!: () => void
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve
  })
  const postHeld = new Promise<void>((resolve) => {
    markPostHeld = resolve
  })
  const postReturned = new Promise<void>((resolve) => {
    markPostReturned = resolve
  })
  await page.route('**/api/rooms**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === `/api/rooms/${roomId}/messages`) {
      if (route.request().method() === 'POST') {
        markPostHeld()
        await postGate
        await route.fulfill({ json: { ok: true, room, message } })
        markPostReturned()
      } else {
        await route.fulfill({
          json: { ok: true, room, messages: visibleInList ? [message] : [] },
        })
      }
    } else if (pathname.endsWith('/participants')) {
      await route.fulfill({ json: { ok: true, room, participants: [] } })
    } else if (pathname.endsWith('/pending-turns')) {
      await route.fulfill({ json: { ok: true, room, pendingTurns: [] } })
    } else if (pathname === '/api/rooms') {
      await route.fulfill({ json: { ok: true, rooms: [room] } })
    } else {
      await route.fulfill({ json: { ok: true, room } })
    }
  })
  return {
    messageId,
    postHeld,
    postReturned,
    releasePost,
    showInList: () => {
      visibleInList = true
    },
  }
}
