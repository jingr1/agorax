/**
 * Agent-scoped workspace resolution (Hermes + managed).
 *
 * Catalog / last-path state is keyed by agent registry id. Hermes agents keep
 * state under the profile home (`webui_state/`) so existing data stays put.
 * Managed agents store under `getStateDir()/agents/<id>/webui_state/`.
 *
 * APIs accept `?agent=` (preferred) or legacy `?profile=` (same scope key for
 * Hermes workers where id === profile).
 */
import path from 'node:path'
import { loadAgentsRegistry } from './agent-runtime/agents-config'
import { getActiveProfileName, readProfile } from './profiles-browser'
import { getStateDir } from './workspace-state-dir'
import { readRemoteTerminalCwd } from './workspace-remote'

const SCOPE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function resolveWorkspaceProfileName(explicit?: string | null): string {
  const trimmed = explicit?.trim()
  if (trimmed) return trimmed
  return getActiveProfileName()
}

export type WorkspaceProfileScope = {
  /** Registry agent id when known; otherwise the explicit scope key. */
  agentId: string
  /**
   * Hermes profile used for terminal/SSH config. For managed agents this is
   * the agent id (no Hermes profile FS).
   */
  profileName: string
  /** Hermes profile home when runtime is hermes; empty for managed. */
  profileHome: string
  /** Parent directory that contains `webui_state/`. */
  stateHome: string
  config: Record<string, unknown>
  runtime: 'hermes' | 'managed' | 'unknown'
}

function safeScopeId(raw: string): string {
  const trimmed = raw.trim()
  if (!SCOPE_ID_RE.test(trimmed)) {
    throw new Error(`Invalid workspace scope id: ${raw}`)
  }
  return trimmed
}

function hermesScopeFromProfile(
  agentId: string,
  profileName: string,
): WorkspaceProfileScope {
  const profile = readProfile(profileName)
  return {
    agentId,
    profileName,
    profileHome: profile.path,
    stateHome: profile.path,
    config: profile.config,
    runtime: 'hermes',
  }
}

function managedScope(agentId: string): WorkspaceProfileScope {
  const id = safeScopeId(agentId)
  return {
    agentId: id,
    profileName: id,
    profileHome: '',
    stateHome: path.join(getStateDir(), 'agents', id),
    config: {},
    runtime: 'managed',
  }
}

/**
 * Resolve workspace persistence + terminal config for an agent or Hermes
 * profile name. Prefer registry agent ids from the chat UI.
 */
export function workspaceProfileScope(
  scopeKey?: string | null,
): WorkspaceProfileScope {
  const key = resolveWorkspaceProfileName(scopeKey)

  try {
    const decl = loadAgentsRegistry().byId.get(key)
    if (decl) {
      if (decl.runtime === 'hermes') {
        const profileName = (decl.profile || decl.id).trim() || 'default'
        try {
          return hermesScopeFromProfile(decl.id, profileName)
        } catch {
          return {
            agentId: decl.id,
            profileName,
            profileHome: '',
            stateHome: path.join(getStateDir(), 'agents', safeScopeId(decl.id)),
            config: {},
            runtime: 'hermes',
          }
        }
      }
      return managedScope(decl.id)
    }
  } catch {
    // Registry load failure — fall through to profile / managed paths.
  }

  try {
    return hermesScopeFromProfile(key, key)
  } catch {
    // Unknown scope (e.g. typed agent id before registry load): isolate under
    // Agorax state so we never write into a random CWD `webui_state/`.
    try {
      return managedScope(key)
    } catch {
      return {
        agentId: key,
        profileName: key,
        profileHome: '',
        stateHome: '',
        config: {},
        runtime: 'unknown',
      }
    }
  }
}

export function remoteWorkspaceContextForScope(scope: WorkspaceProfileScope): {
  remoteCwd: string
  config: Record<string, unknown>
} | null {
  if (scope.runtime === 'managed') return null
  const remoteCwd = readRemoteTerminalCwd(scope.config)
  if (!remoteCwd) return null
  return { remoteCwd, config: scope.config }
}

/** @deprecated Prefer readWorkspaceScopeQueryParam (`agent` then `profile`). */
export function readProfileQueryParam(request: Request): string | undefined {
  return readWorkspaceScopeQueryParam(request)
}

export function readWorkspaceScopeQueryParam(
  request: Request,
): string | undefined {
  try {
    const url = new URL(request.url)
    const agent = url.searchParams.get('agent')?.trim()
    if (agent) return agent
    const profile = url.searchParams.get('profile')?.trim()
    return profile || undefined
  } catch {
    return undefined
  }
}
