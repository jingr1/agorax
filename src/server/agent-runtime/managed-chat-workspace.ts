import {
  isBlockedSystemPath,
  isHermesStatePath,
  normalizeCandidate,
} from '../workspace-path-policy'
import {
  remoteWorkspaceContextForScope,
  workspaceProfileScope,
} from '../workspace-profile'

/**
 * Resolves the UI-selected workspace to a local managed-agent process cwd.
 * Remote/SSH profile paths are deliberately excluded: managed runtimes launch
 * on this host and must never receive an unmounted remote path.
 *
 * Pass the managed agent id so catalog lookup uses that agent's persisted
 * workspace, not the last Hermes active profile.
 */
export function resolveManagedChatWorkspaceCwd(
  workspace: {
    path?: string
    isValid?: boolean
  } | null,
  agentId?: string | null,
): string | undefined {
  if (remoteWorkspaceContextForScope(workspaceProfileScope(agentId))) {
    return undefined
  }

  if (!workspace?.isValid || !workspace.path?.trim()) return undefined

  const normalized = normalizeCandidate(workspace.path.trim())
  if (
    !normalized ||
    isHermesStatePath(normalized) ||
    isBlockedSystemPath(normalized)
  ) {
    return undefined
  }
  return normalized
}
