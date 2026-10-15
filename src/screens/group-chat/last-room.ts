const LAST_ROOM_KEY = 'hermes-group-chat-last-room'
const memoryStore = new Map<string, string>()

function canUseLocalStorage(): boolean {
  return (
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  )
}

function readStorage(key: string): string | null {
  try {
    const value = canUseLocalStorage()
      ? window.localStorage.getItem(key)
      : (memoryStore.get(key) ?? null)
    const trimmed = typeof value === 'string' ? value.trim() : ''
    return trimmed || null
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (canUseLocalStorage()) {
      window.localStorage.setItem(key, value)
      return
    }
    memoryStore.set(key, value)
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function removeStorage(key: string): void {
  try {
    if (canUseLocalStorage()) {
      window.localStorage.removeItem(key)
      return
    }
    memoryStore.delete(key)
  } catch {
    // ignore
  }
}

export function writeLastRoom(roomId: string): void {
  const trimmed = roomId.trim()
  if (!trimmed) return
  writeStorage(LAST_ROOM_KEY, trimmed)
}

export function readLastRoom(): string | null {
  return readStorage(LAST_ROOM_KEY)
}

export function clearLastRoom(roomId?: string): void {
  if (roomId) {
    const current = readLastRoom()
    if (current && current !== roomId) return
  }
  removeStorage(LAST_ROOM_KEY)
}

/** Pick a room to reopen: last remembered if still present, else newest. */
export function resolveRoomToOpen(rooms: Array<{ id: string }>): string | null {
  if (rooms.length === 0) return null
  const last = readLastRoom()
  if (last && rooms.some((room) => room.id === last)) return last
  return rooms[0]?.id ?? null
}
