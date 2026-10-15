import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildHermesChatQueryArgs,
  buildHermesTmuxExecCommand,
  buildHermesTmuxLaunchCommand,
  buildWorkerPrompt,
  checkpointFromRuntimeSnapshot,
  dispatchBlockReason,
  resolveDeliveryMode,
  resolveWaitForCheckpoint,
  runtimeCheckpointSignature,
  runtimeSnapshotIsFresh,
  tmuxPaneLooksLikeHermesTui,
  tmuxPaneLooksLikeShellReady,
} from './swarm-dispatch'

describe('resolveWaitForCheckpoint', () => {
  it('waits by default for curl-style callers', () => {
    expect(resolveWaitForCheckpoint({})).toBe(true)
    expect(resolveWaitForCheckpoint({ waitForCheckpoint: true })).toBe(true)
  })

  it('does not wait when explicitly async', () => {
    expect(resolveWaitForCheckpoint({ waitForCheckpoint: false })).toBe(false)
    expect(resolveWaitForCheckpoint({ allowAsync: true })).toBe(false)
    expect(
      resolveWaitForCheckpoint({ waitForCheckpoint: false, allowAsync: true }),
    ).toBe(false)
  })
})

describe('resolveDeliveryMode', () => {
  const originalForceOneshot = process.env.HERMES_SWARM_FORCE_ONESHOT
  const originalTmuxBin = process.env.TMUX_BIN
  const originalTmuxMode = process.env.HERMES_SWARM_TMUX_MODE

  afterEach(() => {
    if (originalForceOneshot === undefined)
      delete process.env.HERMES_SWARM_FORCE_ONESHOT
    else process.env.HERMES_SWARM_FORCE_ONESHOT = originalForceOneshot
    if (originalTmuxBin === undefined) delete process.env.TMUX_BIN
    else process.env.TMUX_BIN = originalTmuxBin
    if (originalTmuxMode === undefined)
      delete process.env.HERMES_SWARM_TMUX_MODE
    else process.env.HERMES_SWARM_TMUX_MODE = originalTmuxMode
  })

  it('defaults to tmux-tui when tmux is available', () => {
    process.env.TMUX_BIN = '/usr/bin/tmux'
    delete process.env.HERMES_SWARM_FORCE_ONESHOT
    delete process.env.HERMES_SWARM_TMUX_MODE
    expect(resolveDeliveryMode()).toEqual({ mode: 'tmux-tui', fallback: null })
  })

  it('defaults to tmux-cli when HERMES_SWARM_TMUX_MODE=cli', () => {
    process.env.TMUX_BIN = '/usr/bin/tmux'
    process.env.HERMES_SWARM_TMUX_MODE = 'cli'
    delete process.env.HERMES_SWARM_FORCE_ONESHOT
    expect(resolveDeliveryMode()).toEqual({ mode: 'tmux-cli', fallback: null })
  })

  it('falls back to oneshot when tmux is unavailable', () => {
    delete process.env.HERMES_SWARM_FORCE_ONESHOT
    expect(resolveDeliveryMode('auto', { tmuxAvailable: false })).toEqual({
      mode: 'oneshot',
      fallback: 'tmux_unavailable',
    })
  })

  it('forces oneshot when HERMES_SWARM_FORCE_ONESHOT is set', () => {
    process.env.TMUX_BIN = '/usr/bin/tmux'
    process.env.HERMES_SWARM_FORCE_ONESHOT = '1'
    expect(resolveDeliveryMode()).toEqual({ mode: 'oneshot', fallback: null })
  })

  it('honors explicit request overrides', () => {
    process.env.TMUX_BIN = '/usr/bin/tmux'
    expect(resolveDeliveryMode('oneshot')).toEqual({
      mode: 'oneshot',
      fallback: null,
    })
    expect(resolveDeliveryMode('tmux-tui')).toEqual({
      mode: 'tmux-tui',
      fallback: null,
    })
    expect(resolveDeliveryMode('tmux-cli')).toEqual({
      mode: 'tmux-cli',
      fallback: null,
    })
    expect(resolveDeliveryMode('tmux')).toEqual({
      mode: 'tmux-tui',
      fallback: null,
    })
  })

  it('warns once when deprecated HERMES_SWARM_USE_LIVE is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.HERMES_SWARM_USE_LIVE = '1'
    process.env.TMUX_BIN = '/usr/bin/tmux'
    resolveDeliveryMode()
    resolveDeliveryMode()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    delete process.env.HERMES_SWARM_USE_LIVE
  })
})

describe('checkpointFromRuntimeSnapshot', () => {
  it('maps runtime lifecycle fields into a structured checkpoint', () => {
    const checkpoint = checkpointFromRuntimeSnapshot({
      checkpointStatus: 'done',
      state: 'idle',
      lastSummary: 'Patched dispatch polling',
      lastResult: 'Structured checkpoint returned to RouterChat',
      nextAction: 'Verify in UI flow',
      blockedReason: null,
      lastCheckIn: '2026-04-28T20:00:00.000Z',
      lastOutputAt: 1_746_000_000_000,
      checkpointRaw: null,
      checkpointTimestamp: 1_000_000,
    })

    expect(checkpoint).not.toBeNull()
    expect(checkpoint?.stateLabel).toBe('DONE')
    expect(checkpoint?.checkpointStatus).toBe('done')
    expect(checkpoint?.result).toBe(
      'Structured checkpoint returned to RouterChat',
    )
    expect(checkpoint?.nextAction).toBe('Verify in UI flow')
    expect(checkpoint?.raw).toContain('STATE: DONE')
  })

  it('returns null when runtime has no meaningful checkpoint fields yet', () => {
    const checkpoint = checkpointFromRuntimeSnapshot({
      checkpointStatus: 'in_progress',
      state: 'executing',
      lastSummary: null,
      lastResult: null,
      nextAction: null,
      blockedReason: null,
      lastCheckIn: '2026-04-28T20:00:00.000Z',
      lastOutputAt: 1_746_000_000_000,
      checkpointRaw: null,
      checkpointTimestamp: 1_000_000,
    })

    expect(checkpoint).toBeNull()
  })
})

describe('dispatchBlockReason', () => {
  it('turns failed or timed-out dispatch results into mission blocker text', () => {
    expect(
      dispatchBlockReason({
        ok: false,
        error: 'Command failed: worker exited',
        output: '',
        checkpointStatus: undefined,
      }),
    ).toBe('Command failed: worker exited')
    expect(
      dispatchBlockReason({
        ok: true,
        error: null,
        output: 'Delivered',
        checkpointStatus: 'timeout',
      }),
    ).toBe('No fresh checkpoint before poll timeout.')
    expect(
      dispatchBlockReason({
        ok: true,
        error: null,
        output: 'Checkpoint DONE',
        checkpointStatus: 'checkpointed',
      }),
    ).toBeNull()
  })
})

describe('runtimeSnapshotIsFresh', () => {
  it('requires a changed snapshot with post-dispatch activity', () => {
    const baseline = {
      checkpointStatus: 'in_progress' as const,
      state: 'executing',
      lastSummary: 'Dispatched task',
      lastResult: null,
      nextAction: 'Wait for worker',
      blockedReason: null,
      lastCheckIn: '2026-04-28T19:59:00.000Z',
      lastOutputAt: 1_745_999_900_000,
      checkpointRaw: null,
      checkpointTimestamp: 1_745_999_900_000,
    }
    const dispatchedAt = 1_746_000_000_000

    expect(
      runtimeSnapshotIsFresh(
        baseline,
        runtimeCheckpointSignature(baseline),
        dispatchedAt,
      ),
    ).toBe(false)

    const updated = {
      ...baseline,
      checkpointStatus: 'done' as const,
      lastResult: 'Completed backend patch',
      nextAction: 'Hand off to UI',
      lastCheckIn: '2026-04-28T20:00:01.000Z',
      lastOutputAt: 1_746_000_001_000,
      checkpointTimestamp: 1_746_000_001_000,
    }

    expect(
      runtimeSnapshotIsFresh(
        updated,
        runtimeCheckpointSignature(baseline),
        dispatchedAt,
      ),
    ).toBe(true)
  })
})

describe('checkpoint filtering', () => {
  it('still parses IN_PROGRESS runtime snapshots but leaves terminal filtering to the poller', () => {
    const checkpoint = checkpointFromRuntimeSnapshot({
      checkpointStatus: 'in_progress',
      state: 'executing',
      lastSummary: 'Task is running',
      lastResult: null,
      nextAction: 'Wait for worker output',
      blockedReason: null,
      lastCheckIn: '2026-04-28T20:00:01.000Z',
      lastOutputAt: 1_746_000_001_000,
      checkpointRaw: null,
      checkpointTimestamp: 1_000_000,
    })

    expect(checkpoint?.stateLabel).toBe('IN_PROGRESS')
  })
})

describe('buildHermesTmuxLaunchCommand', () => {
  it('delegates to buildHermesTmuxTuiCommand (exec hermes chat --tui)', () => {
    const command = buildHermesTmuxLaunchCommand({
      profilePath: '/tmp/hermes profiles/swarm1',
      hermesBin: '/opt/homebrew/bin/hermes',
      ghToken: 'ghp_te...3456',
    })

    expect(command).toContain("HERMES_HOME='/tmp/hermes profiles/swarm1'")
    expect(command).toContain("exec '/opt/homebrew/bin/hermes' chat --tui")
    expect(command).toContain("GH_TOKEN='ghp_te...3456'")
  })
})

describe('buildHermesTmuxExecCommand', () => {
  it('exec-replaces the pane with Hermes TUI for tmux-first dispatch', () => {
    const command = buildHermesTmuxExecCommand({
      profilePath: '/home/user/.hermes/profiles/researcher',
      hermesBin: '/usr/bin/hermes',
    })
    expect(command).toContain("exec '/usr/bin/hermes' chat --tui")
    expect(command).toContain(
      "HERMES_HOME='/home/user/.hermes/profiles/researcher'",
    )
  })
})

describe('tmuxPaneLooksLikeHermesTui', () => {
  it('accepts an active Hermes prompt', () => {
    const pane = [
      'Hermes Agent',
      'Available Tools',
      '─ ready │ DeepSeek V4 Pro Seed │ 1 session ─',
      'researcher ❯',
    ].join('\n')
    expect(tmuxPaneLooksLikeHermesTui(pane)).toBe(true)
  })

  it('rejects a bare bash shell where paste would run Execute as a command', () => {
    const pane = [
      '(base) user@host:~$ Execute the task in /tmp/swarm-task.md and return the required checkpoint format.',
      'Execute: command not found',
      '(base) user@host:~$',
    ].join('\n')
    expect(tmuxPaneLooksLikeHermesTui(pane)).toBe(false)
  })
})

describe('tmuxPaneLooksLikeShellReady', () => {
  it('accepts an idle bash prompt for CLI dispatch', () => {
    const pane = '(base) user@host:~/proj$'
    expect(tmuxPaneLooksLikeShellReady(pane, 'bash')).toBe(true)
  })

  it('rejects a pane that is still running hermes', () => {
    const pane = 'running tools...'
    expect(tmuxPaneLooksLikeShellReady(pane, 'python3')).toBe(false)
  })
})

describe('buildHermesChatQueryArgs', () => {
  it('passes the prompt immediately after -q so flags are not parsed as the query', () => {
    const prompt = 'STATE: DONE\nRESULT: ok'
    const args = buildHermesChatQueryArgs(prompt)

    expect(args.slice(0, 3)).toEqual(['chat', '-q', prompt])
    expect(args).toContain('-Q')
    expect(args).toContain('--source')
    expect(args[1]).toBe('-q')
    expect(args[2]).toBe(prompt)
    expect(args[3]).toBe('-Q')
  })

  it('does not inject model flags because the profile owns model defaults', () => {
    const args = buildHermesChatQueryArgs('Execute swarm task')
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--provider')
  })
})

describe('buildWorkerPrompt', () => {
  const roster = {
    id: 'swarm5',
    name: 'Builder',
    role: 'Primary Builder',
    specialty: 'full-stack implementation across Agorax and Swarm2',
    model: 'GPT-5.5',
    mission: 'Ship focused product slices with tests and clean diffs.',
    modes: [],
    tools: [],
    skills: ['swarm-ui-worker', 'swarm-worker-core'],
    plugins: [],
    pluginToolsets: [],
    mcpServers: [],
    capabilities: ['code-editing', 'ui-implementation', 'build-verification'],
    preferredTaskTypes: ['implementation'],
    greenlightRequiredFor: [],
    maxConcurrentTasks: 1,
    acceptsBroadcast: true,
    reviewRequired: false,
  }

  it('uses Name — Role as the human-facing label while preserving swarmN as machine ID', () => {
    const prompt = buildWorkerPrompt({
      workerId: 'swarm5',
      task: 'Patch the conductor card copy.',
      rationale: 'Builder executes implementation work.',
      roster,
    })

    expect(prompt).toContain('Worker: Builder — Primary Builder')
    expect(prompt).toContain('Machine ID: swarm5')
    expect(prompt).toContain(
      'Mission: Ship focused product slices with tests and clean diffs.',
    )
    expect(prompt).toContain(
      'Capabilities: code-editing, ui-implementation, build-verification',
    )
    expect(prompt).toContain('Skills: swarm-ui-worker, swarm-worker-core')
  })

  it('still injects role context for direct one-shot dispatch unless raw mode is explicit', () => {
    const prompt = buildWorkerPrompt({
      workerId: 'swarm5',
      task: 'Reply with exactly: BUILDER_OK',
      roster,
      direct: true,
    })

    expect(prompt).toContain('Worker: Builder — Primary Builder')
    expect(prompt).toContain('## Assigned Task')
    expect(prompt).toContain('Reply with exactly: BUILDER_OK')
  })

  it('keeps explicit raw/smoke dispatch unwrapped for minimal probes', () => {
    const prompt = buildWorkerPrompt({
      workerId: 'swarm5',
      task: 'RAW_PING_ONLY',
      roster,
      direct: true,
      raw: true,
    })

    expect(prompt).toBe('RAW_PING_ONLY')
  })
})
