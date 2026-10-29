import type { Page } from '@playwright/test'

export async function installEventSourceMock(page: Page) {
  await page.addInitScript({
    content: `(() => {
    const sources = new Set()
    class MockEventSource {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 2
      readyState = 1
      handlers = new Map()
      constructor(url) {
        this.url = url
        sources.add(this)
        queueMicrotask(() => this.emit('connected', {}))
      }
      addEventListener(type, handler) {
        if (!this.handlers.has(type)) this.handlers.set(type, new Set())
        this.handlers.get(type).add(handler)
      }
      removeEventListener(type, handler) {
        this.handlers.get(type)?.delete(handler)
      }
      emit(type, data) {
        for (const handler of this.handlers.get(type) ?? []) handler({ data: JSON.stringify(data) })
      }
      close() {
        this.readyState = 2
        sources.delete(this)
      }
    }
    Object.assign(window, {
      EventSource: MockEventSource,
      __agoraxEmitSse: (type, data) => {
        for (const source of sources) source.emit(type, data)
      },
    })
  })()`,
  })
}

export async function emitRoomMessage(
  page: Page,
  targetRoomId: string,
  targetMessageId: string,
) {
  await page.evaluate(
    ({ roomId, messageId }) => {
      const emit = Reflect.get(window, '__agoraxEmitSse') as (
        type: string,
        data: Record<string, unknown>,
      ) => void
      emit('group_chat_message', { roomId, messageId })
    },
    { roomId: targetRoomId, messageId: targetMessageId },
  )
}
