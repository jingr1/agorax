/**
 * Personal / system skill roots for managed agent runtimes.
 * Mirrors managed-agent `composerSkillDiscoveryPlan` personal+system roots
 * (project-cwd ancestors are added by callers when a repoRoot is known).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import type { AgentRuntimeKind } from '../agent-runtime/types'

function existsDir(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function pushIfDir(out: Array<string>, seen: Set<string>, dir: string): void {
  if (!existsDir(dir)) return
  const key = path.resolve(dir)
  if (seen.has(key)) return
  seen.add(key)
  out.push(dir)
}

/** Resolve Codex home: honor CODEX_HOME only for the real user home. */
function resolveCodexHome(home: string): string {
  const envHome = process.env.CODEX_HOME?.trim()
  if (envHome && path.resolve(home) === path.resolve(homedir())) {
    return envHome
  }
  return path.join(home, '.codex')
}

/** Project-scoped skill dirs under a workspace/repo root. */
export function projectManagedSkillRoots(repoRoot: string): Array<string> {
  if (!repoRoot) return []
  const out: Array<string> = []
  const seen = new Set<string>()
  for (const rel of [
    path.join('.claude', 'skills'),
    path.join('.codex', 'skills'),
    path.join('.cursor', 'skills'),
    path.join('.opencode', 'skills'),
    path.join('.agents', 'skills'),
    path.join('.hermes', 'skills'),
    path.join('.gemini', 'skills'),
  ]) {
    pushIfDir(out, seen, path.join(repoRoot, rel))
  }
  return out
}

/**
 * User-home skill roots for a managed runtime.
 * Codex includes `.system` as its own root so recursive scanners that skip
 * other dotdirs still pick up bundled system skills when walking the parent.
 */
export function personalManagedSkillRoots(
  runtime: string,
  home = homedir(),
): Array<string> {
  const out: Array<string> = []
  const seen = new Set<string>()
  const codexHome = resolveCodexHome(home)

  switch (runtime) {
    case 'claude-code':
      pushIfDir(out, seen, path.join(home, '.claude', 'skills'))
      pushIfDir(out, seen, path.join(home, '.agents', 'skills'))
      break
    case 'codex':
      pushIfDir(out, seen, path.join(home, '.agents', 'skills'))
      pushIfDir(out, seen, path.join(codexHome, 'skills'))
      pushIfDir(out, seen, path.join(codexHome, 'skills', '.system'))
      break
    case 'cursor':
      pushIfDir(out, seen, path.join(home, '.cursor', 'skills'))
      pushIfDir(out, seen, path.join(home, '.cursor', 'skills-cursor'))
      pushIfDir(out, seen, path.join(home, '.agents', 'skills'))
      break
    case 'opencode':
      pushIfDir(out, seen, path.join(home, '.config', 'opencode', 'skills'))
      pushIfDir(out, seen, path.join(home, '.opencode', 'skills'))
      pushIfDir(out, seen, path.join(home, '.claude', 'skills'))
      pushIfDir(out, seen, path.join(home, '.agents', 'skills'))
      break
    case 'kimi':
      pushIfDir(out, seen, path.join(home, '.kimi', 'skills'))
      pushIfDir(out, seen, path.join(home, '.agents', 'skills'))
      break
    case 'deepseek-harness':
      pushIfDir(out, seen, path.join(home, '.agents', 'skills'))
      break
    default:
      break
  }
  return out
}

/** All personal managed roots across known runtimes (catalog sync). */
export function allPersonalManagedSkillRoots(
  home = homedir(),
): Array<string> {
  const runtimes: Array<AgentRuntimeKind | string> = [
    'claude-code',
    'codex',
    'cursor',
    'opencode',
    'kimi',
    'deepseek-harness',
  ]
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const runtime of runtimes) {
    for (const root of personalManagedSkillRoots(runtime, home)) {
      const key = path.resolve(root)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(root)
    }
  }
  return out
}
