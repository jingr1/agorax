import { describe, expect, it, vi } from 'vitest'
import { createManagedSlashRuntime } from './managed'
import type { AgentActivitySessionCapabilities } from '@agorax/agent-activity-core'

function handlers() {
  return { onNew: vi.fn(), onClear: vi.fn(), onModel: vi.fn(), onHelp: vi.fn(), onRuntimeCommand: vi.fn(), onUnavailable: vi.fn() }
}

describe('capability-scoped managed commands', () => {
  it('does not advertise unknown optional capabilities', () => {
    const callbacks = handlers()
    const runtime = createManagedSlashRuntime(callbacks, { capabilities: null })
    expect(runtime.catalog.map((command) => command.command)).toEqual(['/new', '/clear', '/help'])
    expect(runtime.execute('/model')).toBe(true)
    expect(callbacks.onModel).not.toHaveBeenCalled()
    expect(callbacks.onUnavailable).toHaveBeenCalledWith('/model')
    expect(runtime.sources).toEqual({ gatewayCommands: false, skills: true })
  })

  it('uses the provider catalog and filters unsupported operations', async () => {
    const callbacks = handlers()
    const runtime = createManagedSlashRuntime(callbacks, {
      capabilities: { modelSwitch: true, compact: true, review: false, planMode: false, skills: true } as AgentActivitySessionCapabilities,
      commands: [{ name: 'compact', description: 'Compact context' }, { name: 'review', description: 'Review changes' }, { name: 'provider-action', description: 'Provider action' }],
    })
    expect(runtime.catalog.map((command) => command.command)).toEqual(['/new', '/clear', '/model', '/help', '/compact', '/provider-action'])
    await expect(runtime.execute('/compact keep decisions')).resolves.toBe(true)
    expect(callbacks.onRuntimeCommand).toHaveBeenCalledWith('/compact keep decisions')
    expect(runtime.execute('/help')).toBe(true)
    expect(callbacks.onHelp).toHaveBeenCalledWith(runtime.catalog)
    expect(runtime.execute('/skill-from-library')).toBe(false)
  })

  it('does not mix one provider catalog into another', () => {
    const first = createManagedSlashRuntime(handlers(), { capabilities: null, commands: [{ name: 'first-only' }] })
    const second = createManagedSlashRuntime(handlers(), { capabilities: null, commands: [{ name: 'second-only' }] })
    expect(first.catalog.some((command) => command.command === '/second-only')).toBe(false)
    expect(second.catalog.some((command) => command.command === '/first-only')).toBe(false)
  })
})