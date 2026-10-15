/**
 * Agorax-parity update row presentation for the Runtimes table: current → latest,
 * check-failed, and up-to-date summaries under the agent name.
 */

import type { AgentProviderStatusDto } from './provider-status'

export type AgentProviderUpdateRowPresentation = {
  checkFailed: boolean
  currentVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
}

export function resolveAgentProviderUpdateRowPresentation(
  entry: AgentProviderStatusDto | null | undefined,
): AgentProviderUpdateRowPresentation {
  const currentVersion =
    entry?.update?.currentVersion?.trim() || entry?.version?.trim() || null
  const latestVersion =
    entry?.update?.latestVersion?.trim() ||
    entry?.latestVersion?.trim() ||
    null
  const updateAvailable = entry?.updateAvailable === true
  // Discovery ran (lastCheckedAt) but failed with a reason — same contract as
  // Agorax's workspaceAgentsSettingsUpdateModel.
  const checkFailed = Boolean(
    entry?.update?.capability === 'supported' &&
      entry.update.lastCheckedAt &&
      entry.update.reasonCode,
  )

  return {
    checkFailed,
    currentVersion,
    latestVersion,
    updateAvailable,
  }
}

export function formatAgentProviderUpdateSummary(
  presentation: AgentProviderUpdateRowPresentation,
): string | null {
  const { checkFailed, currentVersion, latestVersion, updateAvailable } =
    presentation
  if (checkFailed && currentVersion) {
    return `${currentVersion} · 暂时无法检查`
  }
  if (checkFailed) {
    return '暂时无法检查更新'
  }
  if (updateAvailable && currentVersion && latestVersion) {
    return `${currentVersion} → ${latestVersion}`
  }
  if (updateAvailable && latestVersion) {
    return `可升级至 ${latestVersion}`
  }
  if (currentVersion && latestVersion && !updateAvailable) {
    return `${currentVersion}（已是最新）`
  }
  if (currentVersion) {
    return currentVersion
  }
  return null
}
