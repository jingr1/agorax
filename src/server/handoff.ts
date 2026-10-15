/**
 * Structured agent handoffs.
 *
 * Builds a machine-readable handoff payload from a worker checkpoint and writes
 * it to the shared swarm handoff directory. The payload is richer than the raw
 * checkpoint text: it includes a git diff of changed files and recent terminal
 * output so the next agent can start warm instead of cold.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SWARM_MEMORY_HANDOFFS } from './swarm-environment'
import { getSwarmMission } from './swarm-missions'
import { getProject } from './task-pipeline/projects'
import { diffRange, localGitContext } from './git-ops'
import type { ParsedSwarmCheckpoint } from './swarm-checkpoints'

export type SwarmHandoff = {
  workerId: string
  missionId: string | null
  assignmentId: string | null
  generatedAt: string
  state: string
  result: string
  blocker: string
  nextAction: string
  filesChanged: Array<string>
  commandsRun: Array<string>
  gitDiff: string
  recentTerminalOutput: string
  sourceCheckpoint: ParsedSwarmCheckpoint
}

const HANDOFF_DIR = join(SWARM_MEMORY_HANDOFFS, 'handoffs', 'swarm')
const MAX_GIT_DIFF_CHARS = 20_000
const MAX_TERMINAL_CHARS = 10_000
const TMUX_CAPTURE_LINES = 50

function ensureHandoffDir(): void {
  mkdirSync(HANDOFF_DIR, { recursive: true })
}

function handoffJsonPath(workerId: string): string {
  return join(HANDOFF_DIR, `${workerId}-latest.json`)
}

function handoffMarkdownPath(workerId: string): string {
  return join(HANDOFF_DIR, `${workerId}-latest.md`)
}

/**
 * Extract absolute file paths from the free-text FILES_CHANGED checkpoint field.
 * Handles markdown bullet lines with backticks and trailing descriptions.
 */
function extractFilePaths(filesChangedText: string): Array<string> {
  const paths: Array<string> = []
  for (const line of filesChangedText.split('\n')) {
    // Match paths inside backticks, or any absolute path-like string.
    const matches = line.match(/`(\/[^`]+)`|(\/[^\s`,]+)/g)
    if (!matches) continue
    for (const match of matches) {
      const cleaned = match.replace(/^`|`$/g, '').trim()
      if (cleaned.startsWith('/') && !cleaned.includes('`')) {
        paths.push(cleaned)
      }
    }
  }
  return [...new Set(paths)]
}

async function runGitDiff(
  workerId: string,
  runtime: Record<string, unknown>,
): Promise<string> {
  const missionId =
    typeof runtime.currentMissionId === 'string'
      ? runtime.currentMissionId
      : null
  if (!missionId) return ''
  const mission = getSwarmMission(missionId)
  if (!mission || !mission.projectId) return ''
  const project = getProject(mission.projectId)
  if (!project) return ''

  const assignmentId =
    typeof runtime.currentAssignmentId === 'string'
      ? runtime.currentAssignmentId
      : null
  const assignment = assignmentId
    ? mission.assignments.find((a) => a.id === assignmentId)
    : mission.assignments.find(
        (a) => a.workerId === workerId && (a.baseRef || a.headSha),
      )
  const baseRef = assignment?.baseRef ?? null
  const headSha = assignment?.headSha ?? null
  if (!baseRef || !headSha) return ''

  try {
    const ctx = localGitContext(project, missionId)
    const diff = await diffRange(ctx, baseRef, headSha)
    if (diff.length > MAX_GIT_DIFF_CHARS) {
      return diff.slice(0, MAX_GIT_DIFF_CHARS) + '\n\n... (truncated)'
    }
    return diff
  } catch {
    return ''
  }
}

async function captureTerminalOutput(workerId: string): Promise<string> {
  const sessionName = `swarm-${workerId}`
  try {
    const output = await new Promise<string>((fulfill, reject) => {
      execFile(
        'tmux',
        [
          'capture-pane',
          '-t',
          sessionName,
          '-p',
          '-S',
          `-${TMUX_CAPTURE_LINES}`,
        ],
        { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 10_000 },
        (error, stdout) => {
          if (error) return reject(error)
          fulfill(stdout)
        },
      )
    })
    const trimmed = output.trim()
    if (trimmed.length > MAX_TERMINAL_CHARS) {
      return trimmed.slice(-MAX_TERMINAL_CHARS) + '\n\n... (truncated)'
    }
    return trimmed
  } catch {
    return ''
  }
}

function splitCommands(commandsText: string): Array<string> {
  return commandsText
    .split('\n')
    .map((line) =>
      line
        .replace(/^[-*]\s+/, '')
        .replace(/^`|`$/g, '')
        .trim(),
    )
    .filter(Boolean)
}

function sanitize(text: string | null | undefined): string {
  return (text ?? '').trim()
}

/**
 * Build a structured handoff from a worker checkpoint.
 */
export async function buildHandoff(
  workerId: string,
  checkpoint: ParsedSwarmCheckpoint,
  runtime: Record<string, unknown> = {},
): Promise<SwarmHandoff> {
  const filePaths = extractFilePaths(checkpoint.filesChanged ?? '')
  const [gitDiff, recentTerminalOutput] = await Promise.all([
    runGitDiff(workerId, runtime),
    captureTerminalOutput(workerId),
  ])

  return {
    workerId,
    missionId:
      typeof runtime.currentMissionId === 'string'
        ? runtime.currentMissionId
        : null,
    assignmentId:
      typeof runtime.currentAssignmentId === 'string'
        ? runtime.currentAssignmentId
        : null,
    generatedAt: new Date().toISOString(),
    state: checkpoint.stateLabel,
    result: sanitize(checkpoint.result),
    blocker: sanitize(checkpoint.blocker),
    nextAction: sanitize(checkpoint.nextAction),
    filesChanged: filePaths,
    commandsRun: splitCommands(checkpoint.commandsRun ?? ''),
    gitDiff,
    recentTerminalOutput,
    sourceCheckpoint: checkpoint,
  }
}

function handoffToMarkdown(handoff: SwarmHandoff): string {
  const lines = [
    `# Handoff — ${handoff.workerId}`,
    '',
    `Generated: ${handoff.generatedAt}`,
    `Mission: ${handoff.missionId ?? 'unknown'}`,
    `Assignment: ${handoff.assignmentId ?? 'unknown'}`,
    `State: ${handoff.state}`,
    '',
    '## Result',
    handoff.result || '_no result_',
    '',
    '## Files changed',
    handoff.filesChanged.length
      ? handoff.filesChanged.map((p) => `- \`${p}\``).join('\n')
      : '- none',
    '',
    '## Commands run',
    handoff.commandsRun.length
      ? handoff.commandsRun.map((c) => `- \`${c}\``).join('\n')
      : '- none',
    '',
    '## Git diff',
    handoff.gitDiff
      ? ['```diff', handoff.gitDiff, '```'].join('\n')
      : '- no git diff available',
    '',
    '## Recent terminal output',
    handoff.recentTerminalOutput
      ? ['```', handoff.recentTerminalOutput, '```'].join('\n')
      : '- no terminal output captured',
    '',
    '## Blockers',
    handoff.blocker || 'none',
    '',
    '## Next action',
    handoff.nextAction || 'Awaiting next mission.',
    '',
  ]
  return lines.join('\n')
}

/**
 * Persist a handoff to the shared swarm handoff directory.
 */
export async function writeHandoff(
  handoff: SwarmHandoff,
): Promise<{ jsonPath: string; markdownPath: string }> {
  ensureHandoffDir()
  const jsonPath = handoffJsonPath(handoff.workerId)
  const markdownPath = handoffMarkdownPath(handoff.workerId)

  const fs = await import('node:fs/promises')
  await Promise.all([
    fs.writeFile(jsonPath, JSON.stringify(handoff, null, 2) + '\n', 'utf8'),
    fs.writeFile(markdownPath, handoffToMarkdown(handoff), 'utf8'),
  ])

  console.log(`[handoff] wrote ${jsonPath} and ${markdownPath}`)
  return { jsonPath, markdownPath }
}

/**
 * Read a previously written handoff.
 */
export function readHandoff(workerId: string): SwarmHandoff | null {
  const path = handoffJsonPath(workerId)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SwarmHandoff
  } catch {
    return null
  }
}

/**
 * Return the absolute path to a worker's latest handoff JSON file.
 */
export function handoffPath(workerId: string): string {
  return handoffJsonPath(workerId)
}

export function handoffDirectory(): string {
  return HANDOFF_DIR
}
