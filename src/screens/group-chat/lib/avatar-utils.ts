import { PERSONA_COLORS } from '@/components/agent-swarm/pixel-avatar'
import { normalizeAgentAvatarProvider } from '@/lib/agent-avatar'
import type { RoomParticipant } from '@/lib/group-chat-types'

/** Count agents in a room that share the same avatar provider as `runtime`. */
export function countRoomAgentProviderSiblings(
  participants: ReadonlyArray<Pick<RoomParticipant, 'kind' | 'runtime'>>,
  runtime: string | null | undefined,
): number {
  const key = normalizeAgentAvatarProvider(runtime)
  return participants.filter(
    (p) =>
      p.kind === 'agent' &&
      normalizeAgentAvatarProvider(p.runtime) === key,
  ).length
}

const PRESET_COLORS = [
  '#3b82f6',
  '#a855f7',
  '#f97316',
  '#10b981',
  '#f59e0b',
  '#06b6d4',
  '#eab308',
  '#ef4444',
  '#ec4899',
  '#6366f1',
  '#14b8a6',
  '#8b5cf6',
]

export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase()
  }
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase()
}

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0
  }
  return Math.abs(hash)
}

export function getMemberColor(id: string, name: string): string {
  const persona = PERSONA_COLORS[name]
  if (persona) return persona.body
  return PRESET_COLORS[hashString(id) % PRESET_COLORS.length]!
}

export function getMemberAccent(id: string, name: string): string {
  const persona = PERSONA_COLORS[name]
  if (persona) return persona.accent
  const body = getMemberColor(id, name)
  return lighten(body, 40)
}

function lighten(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16)
  const r = Math.min(255, ((num >> 16) & 0xff) + amount)
  const g = Math.min(255, ((num >> 8) & 0xff) + amount)
  const b = Math.min(255, (num & 0xff) + amount)
  return `rgb(${r}, ${g}, ${b})`
}
