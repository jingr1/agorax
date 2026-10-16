#!/usr/bin/env node
/**
 * Install-time ensure: create missing Hermes profiles marked
 * `ensureProfile: true` in agents.yaml (clone-from default via
 * `hermes profile create`), then sync-swarm-profiles.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import yaml from 'yaml'

const WS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HERMES_HOME =
  process.env.HERMES_HOME?.trim() || path.join(os.homedir(), '.hermes')

function loadEnsureIds() {
  const agentsPath = path.join(WS, 'agents.yaml')
  const examplePath = path.join(WS, 'agents.yaml.example')
  if (!fs.existsSync(agentsPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, agentsPath)
  }
  if (!fs.existsSync(agentsPath)) return []
  const doc = yaml.parse(fs.readFileSync(agentsPath, 'utf8')) ?? {}
  const agents = doc.agents ?? doc.workers ?? []
  return agents
    .filter(
      (a) =>
        a &&
        a.ensureProfile === true &&
        String(a.runtime ?? 'hermes') === 'hermes' &&
        a.id &&
        a.id !== 'default' &&
        a.enabled !== false,
    )
    .map((a) => String(a.id))
}

function hasDefault() {
  return fs.existsSync(path.join(HERMES_HOME, 'config.yaml'))
}

function profileDir(id) {
  return path.join(HERMES_HOME, 'profiles', id)
}

function hermesBin() {
  const fromEnv = process.env.HERMES_CLI_BIN?.trim()
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const venv = path.join(HERMES_HOME, 'hermes-agent', 'venv', 'bin', 'hermes')
  if (fs.existsSync(venv)) return venv
  return 'hermes'
}

const lines = []
const SEED_IDS = loadEnsureIds()

if (!hasDefault()) {
  console.error(
    'ensure-swarm-profiles: Hermes default (~/.hermes/config.yaml) missing; skip',
  )
  process.exit(0)
}

if (SEED_IDS.length === 0) {
  console.log(
    'ensure-swarm-profiles: no agents with ensureProfile: true in agents.yaml',
  )
  process.exit(0)
}

const bin = hermesBin()
let created = 0
for (const id of SEED_IDS) {
  if (fs.existsSync(profileDir(id))) {
    lines.push(`${id}: exists`)
    continue
  }
  const result = spawnSync(
    bin,
    ['profile', 'create', id, '--clone-from', 'default'],
    { encoding: 'utf8', cwd: WS },
  )
  if (result.status === 0) {
    lines.push(`${id}: created`)
    created++
  } else {
    const err = (result.stderr || result.stdout || '').trim()
    if (/already exists/i.test(err)) {
      lines.push(`${id}: exists`)
    } else {
      lines.push(`${id}: create failed — ${err || `exit ${result.status}`}`)
      console.log(lines.join('\n'))
      process.exit(result.status || 1)
    }
  }
}

const syncScript = path.join(WS, 'scripts', 'sync-swarm-profiles.mjs')
const sync = spawnSync(process.execPath, [syncScript], {
  encoding: 'utf8',
  cwd: WS,
})
if (sync.status !== 0) {
  lines.push(`sync failed: ${(sync.stderr || sync.stdout || '').trim()}`)
  console.log(lines.join('\n'))
  process.exit(sync.status || 1)
}
lines.push(`sync: ok (created ${created} profiles from agents.yaml ensureProfile)`)
if (sync.stdout?.trim()) lines.push(sync.stdout.trim())
console.log(lines.join('\n'))
