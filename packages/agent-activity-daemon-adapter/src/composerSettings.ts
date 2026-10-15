import type { AgentActivitySessionSettings } from "@agorax/agent-activity-core";
import type { DaemonAgentSessionComposerSettings } from "./daemonDtos.ts";

/**
 * Reverse request projection shared by hosts. Forwards only fields declared
 * by the composer-settings contract; broader Engine or presentation settings
 * such as `computerUse` remain local unless the daemon first adds a matching
 * request field.
 *
 * @deprecated TODO(daemon-endpoint): the Agorax agent daemon has no
 * composer-settings REST route yet. Kept from the daemon adapter so the
 * reverse projection survives the port; the request contract lives in
 * daemonDtos.ts (DaemonAgentSessionComposerSettings).
 */
export function daemonAgentSessionComposerSettingsFromActivity(
  settings: AgentActivitySessionSettings | null | undefined
): DaemonAgentSessionComposerSettings {
  return {
    ...(settings?.model !== undefined ? { model: settings.model } : {}),
    ...(settings?.permissionModeId !== undefined
      ? { permissionModeId: settings.permissionModeId }
      : {}),
    ...(settings?.planMode !== undefined
      ? { planMode: settings.planMode }
      : {}),
    ...(settings?.browserUse !== undefined
      ? { browserUse: settings.browserUse }
      : {}),
    ...(settings?.reasoningEffort !== undefined
      ? { reasoningEffort: settings.reasoningEffort }
      : {}),
    ...(settings?.speed !== undefined ? { speed: settings.speed } : {})
  };
}
