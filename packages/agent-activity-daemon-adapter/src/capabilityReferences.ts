import type { AgentActivityCapabilityReference } from "@agorax/agent-activity-core";
import type { DaemonCapabilityReference } from "./daemonDtos.ts";

const AGORAX_CAPABILITY = "agorax";
const SLASH_COMMAND_SOURCE = "slash_command";

export function daemonCapabilityReferencesFromActivity(
  references: readonly AgentActivityCapabilityReference[] | null | undefined
): DaemonCapabilityReference[] {
  return (
    references?.map((reference) => {
      if (
        reference.capability !== AGORAX_CAPABILITY ||
        reference.source !== SLASH_COMMAND_SOURCE
      ) {
        throw new Error(
          "Unsupported workspace agent capability reference contract"
        );
      }
      return {
        capability: reference.capability,
        source: reference.source
      };
    }) ?? []
  );
}

export function agentActivityCapabilityReferencesFromDaemon(
  references: DaemonCapabilityReference[] | null | undefined
): AgentActivityCapabilityReference[] {
  if (references === undefined || references === null) {
    return [];
  }
  if (!Array.isArray(references)) {
    throw new Error(
      "Protocol contract error: workspace agent capabilityRefs must be an array"
    );
  }
  return references.map((reference) => {
    if (
      reference?.capability !== AGORAX_CAPABILITY ||
      reference.source !== SLASH_COMMAND_SOURCE
    ) {
      throw new Error(
        "Protocol contract error: unsupported workspace agent capability reference"
      );
    }
    return {
      capability: reference.capability,
      source: reference.source
    };
  });
}
