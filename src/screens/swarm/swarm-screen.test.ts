import { describe, expect, it } from 'vitest'
import {
  SWARM_CARD_DENSITY_CONTRACT,
  SWARM_INFORMATION_HIERARCHY,
  SWARM_OPERATIONS_REUSE,
  SWARM_REAL_API_ENDPOINTS,
  SWARM_SURFACE_CONTRACT,
} from './swarm-screen'

describe('Swarm surface contract', () => {
  it('keeps Aurora as the primary hub above wired operational worker cards', () => {
    expect(SWARM_INFORMATION_HIERARCHY[0]).toContain('Status header')
    expect(SWARM_INFORMATION_HIERARCHY[1]).toContain('Orchestrator hub card')
    expect(SWARM_INFORMATION_HIERARCHY[2]).toContain('Visible routing wires')
    expect(SWARM_INFORMATION_HIERARCHY[3]).toContain(
      'Operations-style worker node cards',
    )
    expect(SWARM_INFORMATION_HIERARCHY[4]).toContain('Minimal attention rail')
    expect(SWARM_INFORMATION_HIERARCHY[5]).toContain(
      'Central bottom router chat',
    )
    expect(SWARM_INFORMATION_HIERARCHY).toContainEqual(
      expect.stringContaining('Kanban view'),
    )
    expect(SWARM_INFORMATION_HIERARCHY).toContainEqual(
      expect.stringContaining('Runtime view'),
    )
  })

  it('documents the operational surfaces on the canonical /swarm route', () => {
    expect(SWARM_SURFACE_CONTRACT.route).toBe('/swarm')
    expect(SWARM_SURFACE_CONTRACT.keepsLegacySwarmRoute).toBe(false)
    expect(SWARM_SURFACE_CONTRACT.primarySurface).toBe(
      'orchestrator-card-topology',
    )
    expect(SWARM_SURFACE_CONTRACT.workerSurface).toBe(
      'operations-card-patterns',
    )
    expect(SWARM_SURFACE_CONTRACT.connectionLayer).toBe(
      'visible-routing-wires',
    )
    expect(SWARM_SURFACE_CONTRACT.alternateSurface).toBe('runtime-tmux')
    expect(SWARM_SURFACE_CONTRACT.routerPlacement).toBe('bottom-center')
    expect(SWARM_SURFACE_CONTRACT.cardInlineChat).toBe(true)
    expect(SWARM_SURFACE_CONTRACT.routerDefaultOpen).toBe(false)
  })

  it('only depends on existing first-party APIs', () => {
    expect(SWARM_REAL_API_ENDPOINTS).toEqual([
      '/api/crew-status',
      '/api/swarm-environment',
      '/api/swarm-runtime',
      '/api/swarm-missions',
      '/api/swarm-roster',
      '/api/integrations',
      '/api/swarm-health',
      '/api/swarm-decompose',
      '/api/swarm-dispatch',
      '/api/swarm-tmux-start',
      '/api/swarm-tmux-stop',
      '/api/swarm-tmux-scroll',
      '/api/terminal-stream',
      '/api/terminal-input',
      '/api/terminal-resize',
      '/api/terminal-close',
    ])
  })

  it('documents Operations card primitives reused for Swarm worker nodes', () => {
    expect(SWARM_OPERATIONS_REUSE).toEqual([
      'centered-card-header-with-status-dot',
      'agent-progress-avatar-stack',
      'compact-operational-metadata-panel',
      'inline-direct-chat-panel',
      'bottom-card-action-row',
    ])
  })

  it('keeps the default control plane denser than a terminal wall on laptop screens', () => {
    expect(SWARM_CARD_DENSITY_CONTRACT.defaultView).toBe('cards')
    expect(SWARM_CARD_DENSITY_CONTRACT.runtimeView).toBe('separate-mode')
    expect(
      SWARM_CARD_DENSITY_CONTRACT.workerCardMinHeightRem,
    ).toBeLessThanOrEqual(30)
    expect(
      SWARM_CARD_DENSITY_CONTRACT.laptopGridColumns,
    ).toBeGreaterThanOrEqual(2)
    expect(SWARM_CARD_DENSITY_CONTRACT.duplicateEmptyStates).toBe(false)
  })
})

import { buildTmuxAttachCommand } from '@/lib/tmux-attach'
import { __runtimeTabInternals } from './swarm-screen'

describe('Swarm runtime tab command resolution', () => {
  const { commandForRuntime } = __runtimeTabInternals

  it('prefers tmux attach when an attachable session exists', () => {
    const result = commandForRuntime({
      workerId: 'swarm4',
      currentTask: null,
      recentLogTail: null,
      pid: null,
      startedAt: null,
      lastOutputAt: null,
      cwd: '/tmp',
      tmuxSession: 'swarm-swarm4',
      tmuxAttachable: true,
      logPath: '/tmp/agent.log',
      terminalKind: 'tmux',
    })
    expect(result.kind).toBe('tmux')
    expect(result.command).toEqual(buildTmuxAttachCommand('swarm-swarm4'))
    expect(result.label).toContain('tmux:swarm-swarm4')
  })

  it('prefers a chat-able shell over read-only log tail when no tmux is available', () => {
    const result = commandForRuntime({
      workerId: 'swarm4',
      currentTask: null,
      recentLogTail: null,
      pid: null,
      startedAt: null,
      lastOutputAt: null,
      cwd: '/tmp/work',
      tmuxSession: null,
      tmuxAttachable: false,
      logPath: '/tmp/agent.log',
      terminalKind: 'shell',
    })
    expect(result.kind).toBe('shell')
    expect(result.command[0]).toBe('zsh')
    expect(result.command.join(' ')).toContain('cd "/tmp/work"')
  })

  it('falls back to tail -F when no tmux and no cwd are available', () => {
    const result = commandForRuntime({
      workerId: 'swarm4',
      currentTask: null,
      recentLogTail: null,
      pid: null,
      startedAt: null,
      lastOutputAt: null,
      cwd: null,
      tmuxSession: null,
      tmuxAttachable: false,
      logPath: '/tmp/agent.log',
      terminalKind: 'log-tail',
    })
    expect(result.kind).toBe('log-tail')
    expect(result.command).toEqual([
      'tail',
      '-n',
      '200',
      '-F',
      '/tmp/agent.log',
    ])
  })

  it('falls back to a workspace shell when no tmux and no log file exist', () => {
    const result = commandForRuntime({
      workerId: 'swarm4',
      currentTask: null,
      recentLogTail: null,
      pid: null,
      startedAt: null,
      lastOutputAt: null,
      cwd: '/tmp/work',
      tmuxSession: null,
      tmuxAttachable: false,
      logPath: null,
      terminalKind: 'shell',
    })
    expect(result.kind).toBe('shell')
    expect(result.command[0]).toBe('zsh')
    expect(result.command.join(' ')).toContain('cd "/tmp/work"')
  })

  it('handles entirely missing runtime metadata gracefully', () => {
    const result = commandForRuntime(undefined)
    expect(result.kind).toBe('shell')
    expect(result.command[0]).toBe('zsh')
  })

  it('mode=logs forces tail -F even when a cwd would normally win', () => {
    const result = commandForRuntime(
      {
        workerId: 'swarm4',
        currentTask: null,
        recentLogTail: null,
        pid: null,
        startedAt: null,
        lastOutputAt: null,
        cwd: '/tmp/work',
        tmuxSession: null,
        tmuxAttachable: false,
        logPath: '/tmp/agent.log',
        terminalKind: 'shell',
      },
      'logs',
    )
    expect(result.kind).toBe('log-tail')
    expect(result.command).toContain('-F')
  })

  it('mode=shell skips tmux attach in favor of a workspace shell', () => {
    const result = commandForRuntime(
      {
        workerId: 'swarm4',
        currentTask: null,
        recentLogTail: null,
        pid: null,
        startedAt: null,
        lastOutputAt: null,
        cwd: '/tmp/work',
        tmuxSession: 'swarm-swarm4',
        tmuxAttachable: true,
        logPath: '/tmp/agent.log',
        terminalKind: 'tmux',
      },
      'shell',
    )
    expect(result.kind).toBe('shell')
    expect(result.command[0]).toBe('zsh')
  })
})
