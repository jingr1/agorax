/**
 * Per-request Hermes gateway target.
 *
 * Local pool: each 1:1 chat pins (profile, that profile's port, that
 * profile's API_SERVER_KEY). Switching the visible agent does not rewrite
 * the process-global HERMES_API, so an in-flight turn keeps the gateway it
 * started on.
 *
 * Pool off or remote pairing: every profile shares HERMES_API.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  HERMES_API,
  getGatewayBearerToken,
  readProfileApiServerKey,
} from './gateway-capabilities'
import { getProfileGatewayUrl, isGatewayPoolEnabled } from './gateway-ports'
import { getActiveProfileName } from './profiles-browser'
import {
  ensureActiveProfileGateway,
  ensureProfileGateway,
} from './gateway-pool'

export type ChatGatewayTarget = {
  profile: string
  url: string
  token: string
}

const chatGatewayStore = new AsyncLocalStorage<ChatGatewayTarget>()

function normalizeProfile(profileName?: string | null): string {
  const explicit = (profileName || '').trim()
  if (explicit) return explicit
  return (getActiveProfileName() || 'default').trim() || 'default'
}

export function resolveChatGateway(profileName?: string | null): ChatGatewayTarget {
  const pinned = chatGatewayStore.getStore()
  const explicit = (profileName || '').trim()
  if (pinned && (!explicit || explicit === pinned.profile)) return pinned

  const profile = explicit || pinned?.profile || normalizeProfile()
  if (!isGatewayPoolEnabled()) {
    return {
      profile,
      url: HERMES_API,
      token: getGatewayBearerToken(),
    }
  }
  return {
    profile,
    url: getProfileGatewayUrl(profile),
    token: readProfileApiServerKey(profile) || getGatewayBearerToken(),
  }
}

/**
 * Bind the rest of this request's async continuation to `target`.
 * Call it in the route handler itself, after `ensureChatGateway`.
 */
export function enterChatGateway(target: ChatGatewayTarget): void {
  chatGatewayStore.enterWith(target)
}

export async function ensureChatGateway(
  profileName?: string | null,
): Promise<ChatGatewayTarget> {
  const profile = normalizeProfile(profileName)
  if (!isGatewayPoolEnabled()) {
    await ensureActiveProfileGateway()
    return {
      profile,
      url: HERMES_API,
      token: getGatewayBearerToken(),
    }
  }

  const ensured = await ensureProfileGateway(profile)
  if (!ensured.ok) {
    throw new Error(ensured.error || `gateway for ${profile} is unavailable`)
  }
  return {
    profile,
    url: ensured.url,
    token: readProfileApiServerKey(profile) || getGatewayBearerToken(),
  }
}
