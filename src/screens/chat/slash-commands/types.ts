export type SlashCommandDefinition = {
  command: string
  description: string
}

/**
 * Runtime-specific slash command catalog + executor.
 * ChatComposer UI stays shared; only the injected runtime differs.
 */
export type SlashCommandRuntime = {
  /** Menu list; do not merge another runtime's DEFAULT. */
  catalog: Array<SlashCommandDefinition>
  /** Optional: also pull gateway /api/commands and/or installed skills. */
  sources?: {
    gatewayCommands?: boolean
    skills?: boolean
  }
  /**
   * Called when the user submits a `/…` body.
   * Return true = handled locally (do not send to chat transport).
   */
  execute: (command: string) => boolean | Promise<boolean>
}
