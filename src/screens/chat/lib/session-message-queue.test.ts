import { describe, expect, it, beforeEach } from 'vitest'

import {
  clearSessionQueue,
  dequeueSessionMessage,
  enqueueSessionMessage,
  listQueuedMessages,
  queuedMessageCount,
} from './session-message-queue'

describe('session-message-queue', () => {
  beforeEach(() => {
    clearSessionQueue('session-a')
    clearSessionQueue('session-b')
  })

  it('enqueues and drains FIFO per session', () => {
    enqueueSessionMessage('session-a', { text: 'first' })
    enqueueSessionMessage('session-a', { text: 'second' })
    enqueueSessionMessage('session-b', { text: 'other' })

    expect(queuedMessageCount('session-a')).toBe(2)
    expect(dequeueSessionMessage('session-a')?.text).toBe('first')
    expect(dequeueSessionMessage('session-a')?.text).toBe('second')
    expect(dequeueSessionMessage('session-a')).toBeNull()
    expect(listQueuedMessages('session-b')[0]?.text).toBe('other')
  })
})
