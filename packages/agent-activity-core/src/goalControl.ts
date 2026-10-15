import type { AgentActivityInitialGoalControl } from "./goalControl.types.ts";

/**
 * Parses the provider-neutral text surface for a direct Goal command.
 * Structured-content callers must first prove that their submission contains
 * exactly one text block; presentation-only display text is not semantic input.
 */
export function parseAgentActivityGoalControlText(
  text: string
): AgentActivityInitialGoalControl | null {
  const prompt = text.trim();
  const match = /^\/goal(?:\s+([\s\S]+))?$/iu.exec(prompt);
  const args = match?.[1]?.trim() ?? "";
  if (!match || !args) return null;
  switch (args.toLowerCase()) {
    case "clear":
    case "reset":
      return { action: "clear" };
    case "pause":
      return { action: "pause" };
    case "resume":
    case "active":
      return { action: "resume" };
    default:
      return { action: "set", objective: args };
  }
}
