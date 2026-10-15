export type QueuedChatAttachment = {
  id?: string
  name?: string
  contentType?: string
  size?: number
  dataUrl?: string
  previewUrl?: string
  kind?: 'image' | 'file' | 'audio'
}

export type QueuedChatMessage = {
  id: string
  text: string
  attachments: Array<QueuedChatAttachment>
  createdAt: number
}

const STORAGE_PREFIX = 'hermes-workspace-queue:'

function storageKey(sessionKey: string): string {
  return `${STORAGE_PREFIX}${sessionKey}`
}

function readPersisted(sessionKey: string): Array<QueuedChatMessage> {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.sessionStorage.getItem(storageKey(sessionKey))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is QueuedChatMessage =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as QueuedChatMessage).id === 'string' &&
        typeof (item as QueuedChatMessage).text === 'string',
    )
  } catch {
    return []
  }
}

function writePersisted(
  sessionKey: string,
  queue: Array<QueuedChatMessage>,
): void {
  if (typeof window === 'undefined') return
  try {
    if (queue.length === 0) {
      window.sessionStorage.removeItem(storageKey(sessionKey))
      return
    }
    window.sessionStorage.setItem(storageKey(sessionKey), JSON.stringify(queue))
  } catch {
    // ignore quota / private mode
  }
}

const memoryQueues = new Map<string, Array<QueuedChatMessage>>()

function ensureQueue(sessionKey: string): Array<QueuedChatMessage> {
  const key = sessionKey.trim()
  if (!key || key === 'new') return []
  let queue = memoryQueues.get(key)
  if (!queue) {
    queue = readPersisted(key)
    memoryQueues.set(key, queue)
  }
  return queue
}

export function listQueuedMessages(
  sessionKey: string,
): Array<QueuedChatMessage> {
  return [...ensureQueue(sessionKey)]
}

export function enqueueSessionMessage(
  sessionKey: string,
  input: { text: string; attachments?: Array<QueuedChatAttachment> },
): QueuedChatMessage | null {
  const key = sessionKey.trim()
  if (!key || key === 'new') return null
  const text = input.text.trim()
  const attachments = input.attachments ?? []
  if (!text && attachments.length === 0) return null

  const entry: QueuedChatMessage = {
    id: crypto.randomUUID(),
    text,
    attachments,
    createdAt: Date.now(),
  }
  const queue = ensureQueue(key)
  const next = [...queue, entry]
  memoryQueues.set(key, next)
  writePersisted(key, next)
  return entry
}

export function dequeueSessionMessage(
  sessionKey: string,
): QueuedChatMessage | null {
  const key = sessionKey.trim()
  if (!key || key === 'new') return null
  const queue = ensureQueue(key)
  if (queue.length === 0) return null
  const [head, ...rest] = queue
  memoryQueues.set(key, rest)
  writePersisted(key, rest)
  return head ?? null
}

export function clearSessionQueue(sessionKey: string): void {
  const key = sessionKey.trim()
  if (!key || key === 'new') return
  memoryQueues.set(key, [])
  writePersisted(key, [])
}

export function queuedMessageCount(sessionKey: string): number {
  return ensureQueue(sessionKey).length
}
