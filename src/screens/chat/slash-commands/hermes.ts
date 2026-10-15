import type { SlashCommandDefinition } from './types'

/** Agorax slash catalog (gateway + UI commands). */
export const HERMES_SLASH_COMMANDS: Array<SlashCommandDefinition> = [
  // Session control
  { command: '/new', description: 'Start new session' },
  { command: '/clear', description: 'Clear screen and start fresh' },
  { command: '/retry', description: 'Resend the last user message' },
  { command: '/undo', description: 'Remove the last user turn' },
  {
    command: '/queue <text>',
    description: 'Queue a follow-up for after the current reply',
  },
  {
    command: '/interrupt <text>',
    description: 'Stop the current reply and send next',
  },
  {
    command: '/steer <text>',
    description: 'Inject guidance into the current reply',
  },
  { command: '/compress', description: 'Manually compress context' },
  {
    command: '/btw <question>',
    description: 'Ask a side question (does not change the chat)',
  },
  {
    command: '/bg <prompt>',
    description: 'Run a prompt in a background session',
  },
  { command: '/title', description: 'Name the current session' },

  // Persistent goals (Ralph loop)
  { command: '/goal <text>', description: 'Set standing goal across turns' },
  { command: '/goal status', description: 'Check active goal status' },
  { command: '/goal pause', description: 'Pause active goal' },
  { command: '/goal resume', description: 'Resume paused goal' },
  { command: '/goal clear', description: 'Clear active goal' },
  {
    command: '/subgoal <text>',
    description: 'Add extra success criteria to active goal',
  },

  // Model & config
  { command: '/model', description: 'Show or change the current model' },
  {
    command: '/reasoning',
    description: 'Set reasoning level (none/minimal/low/medium/high/xhigh)',
  },
  { command: '/skin', description: 'Change the display theme' },
  { command: '/config', description: 'Show session config' },
  { command: '/profile', description: 'Show active Hermes profile info' },

  // Tools & skills
  { command: '/skills', description: 'Browse and manage skills' },
  { command: '/skill <name>', description: 'Load a skill into session' },
  {
    command: '/plugins',
    description: 'List installed plugins and their status',
  },
  { command: '/mcp', description: 'Manage MCP servers' },
  { command: '/cron', description: 'Manage cron jobs' },
  { command: '/kanban', description: 'Kanban collaboration board' },

  // Session management
  { command: '/save', description: 'Save the current conversation' },
  { command: '/history', description: 'Show conversation history' },
  { command: '/agents', description: 'Show active agents and running tasks' },
  { command: '/resume', description: 'Resume a named session' },
  // Info
  { command: '/help', description: 'Show all available commands' },
  { command: '/usage', description: 'View token usage' },
  { command: '/status', description: 'Show session info' },
  { command: '/debug', description: 'Upload debug report' },
]
