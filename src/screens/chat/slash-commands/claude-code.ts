import type { SlashCommandDefinition, SlashCommandRuntime } from './types'

/** Session-level UI commands meaningful for Claude Code (not Hermes gateway). */
export const CLAUDE_CODE_SLASH_COMMANDS: Array<SlashCommandDefinition> = [
  { command: '/new', description: 'Start a new chat session' },
  { command: '/clear', description: 'Clear messages in this session' },
  { command: '/model', description: 'Open the model picker' },
  { command: '/help', description: 'List available slash commands' },
]

export type ClaudeCodeSlashHandlers = {
  onNew: () => void
  onClear: () => void
  onModel: () => void
  onHelp?: () => void
  /** Unknown commands: return false to send to CLI as a normal message. */
  onUnknown?: (command: string) => boolean
}

export function createClaudeCodeSlashRuntime(
  handlers: ClaudeCodeSlashHandlers,
): SlashCommandRuntime {
  return {
    catalog: CLAUDE_CODE_SLASH_COMMANDS,
    sources: { gatewayCommands: false, skills: true },
    execute: (command: string) => {
      const trimmed = command.trim()
      const name = trimmed.split(/\s+/)[0]?.toLowerCase() ?? ''

      if (name === '/new') {
        handlers.onNew()
        return true
      }
      if (name === '/clear') {
        handlers.onClear()
        return true
      }
      if (name === '/model') {
        handlers.onModel()
        return true
      }
      if (name === '/help') {
        if (handlers.onHelp) {
          handlers.onHelp()
          return true
        }
        return true
      }
      return handlers.onUnknown?.(trimmed) ?? false
    },
  }
}
