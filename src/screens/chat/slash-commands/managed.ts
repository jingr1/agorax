import type { AgentActivityComposerOptions, AgentActivitySessionCapabilities } from '@agorax/agent-activity-core'
import type { SlashCommandDefinition, SlashCommandRuntime } from './types'

type ManagedSlashHandlers = {
  onNew: () => void
  onClear: () => void
  onModel: () => void
  onHelp: (catalog: Array<SlashCommandDefinition>) => void
  onRuntimeCommand: (command: string) => void | Promise<void>
  onUnavailable: (command: string) => void
}

export function createManagedSlashRuntime(
  handlers: ManagedSlashHandlers,
  options: {
    capabilities: AgentActivitySessionCapabilities | null
    commands?: AgentActivityComposerOptions['commands']
  },
): SlashCommandRuntime {
  const supported = (name: string) => {
    const capabilities = options.capabilities
    if (name === '/model') return capabilities?.modelSwitch === true
    if (name === '/compact' || name === '/compress') return capabilities?.compact === true
    if (name === '/review') return capabilities?.review === true
    if (name === '/plan') return capabilities?.planMode === true
    return true
  }
  const catalog: Array<SlashCommandDefinition> = [
    { command: '/new', description: 'Start a new chat session' },
    { command: '/clear', description: 'Clear messages in this session' },
    { command: '/model', description: 'Open the model picker' },
    { command: '/help', description: 'List available slash commands' },
  ].filter((command) => supported(command.command))
  for (const command of options.commands ?? []) {
    const name = `/${command.name.trim().replace(/^\/+/, '')}`
    if (!supported(name) || catalog.some((item) => item.command === name)) continue
    catalog.push({ command: name, description: command.description || command.name })
  }
  return {
    catalog,
    sources: { gatewayCommands: false, skills: true },
    execute(command) {
      const trimmed = command.trim()
      const name = trimmed.split(/\s+/)[0]?.toLowerCase() ?? ''
      if (!supported(name)) {
        handlers.onUnavailable(name)
        return true
      }
      if (name === '/new') { handlers.onNew(); return true }
      if (name === '/clear') { handlers.onClear(); return true }
      if (name === '/model') { handlers.onModel(); return true }
      if (name === '/help') { handlers.onHelp(catalog); return true }
      if (!catalog.some((item) => item.command === name)) {
        if (['/compact', '/compress', '/review', '/plan'].includes(name)) {
          handlers.onUnavailable(name)
          return true
        }
        return false
      }
      return Promise.resolve(handlers.onRuntimeCommand(trimmed)).then(() => true)
    },
  }
}