import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getHermesRoot } from './hermes-paths'

export type JobDeliveryTarget = {
  id: string
  label: string
  platform?: string
  kind: 'preset' | 'platform'
  requiresGateway?: boolean
}

const PRESET_TARGETS: Array<JobDeliveryTarget> = [
  { id: 'local', label: 'Local', kind: 'preset' },
  { id: 'origin', label: 'Origin', kind: 'preset' },
  {
    id: 'telegram',
    label: 'Telegram',
    kind: 'preset',
    platform: 'telegram',
    requiresGateway: true,
  },
  {
    id: 'discord',
    label: 'Discord',
    kind: 'preset',
    platform: 'discord',
    requiresGateway: true,
  },
  {
    id: 'signal',
    label: 'Signal',
    kind: 'preset',
    platform: 'signal',
    requiresGateway: true,
  },
]

const PLATFORM_LABELS: Record<string, string> = {
  feishu: 'Feishu',
  weixin: 'WeChat',
  telegram: 'Telegram',
  discord: 'Discord',
  signal: 'Signal',
}

function readGlobalChannelDirectory(): Record<
  string,
  Array<Record<string, unknown>>
> {
  const path = join(getHermesRoot(), 'channel_directory.json')
  if (!existsSync(path)) return {}

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      platforms?: Record<string, Array<Record<string, unknown>>>
    }
    if (!parsed.platforms || typeof parsed.platforms !== 'object') return {}
    return parsed.platforms
  } catch {
    return {}
  }
}

function readChannelLabel(
  platform: string,
  channel: Record<string, unknown>,
): string {
  const id =
    typeof channel.id === 'string' && channel.id.trim() ? channel.id.trim() : ''
  const name =
    typeof channel.name === 'string' && channel.name.trim()
      ? channel.name.trim()
      : id
  const type =
    typeof channel.type === 'string' && channel.type.trim()
      ? channel.type.trim()
      : 'channel'
  const platformLabel = PLATFORM_LABELS[platform] ?? platform

  if (name && name !== id) return `${platformLabel}: ${name}`
  if (id) return `${platformLabel}: ${type}`
  return platformLabel
}

function listPlatformTargets(
  platforms: Record<string, Array<Record<string, unknown>>>,
): Array<JobDeliveryTarget> {
  const targets: Array<JobDeliveryTarget> = []
  for (const [platform, channels] of Object.entries(platforms).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    if (!Array.isArray(channels)) continue
    for (const channel of channels) {
      if (!channel || typeof channel !== 'object') continue
      const id =
        typeof channel.id === 'string' && channel.id.trim()
          ? channel.id.trim()
          : null
      if (!id) continue
      targets.push({
        id: `${platform}:${id}`,
        label: readChannelLabel(platform, channel),
        platform,
        kind: 'platform',
        requiresGateway: true,
      })
    }
  }
  return targets
}

export function listJobDeliveryTargets(): Array<JobDeliveryTarget> {
  const platformTargets = listPlatformTargets(readGlobalChannelDirectory())
  const seen = new Set(PRESET_TARGETS.map((target) => target.id))
  const merged = [...PRESET_TARGETS]

  for (const target of platformTargets) {
    if (seen.has(target.id)) continue
    seen.add(target.id)
    merged.push(target)
  }

  return merged
}
