#!/usr/bin/env node
/**
 * Sync ~/.hermes/profiles/<workerId>/ from agents.yaml roster fields.
 * Updates config.yaml (toolsets only) and SOUL.md (Hermes persona; no IDENTITY.md).
 * Prefer agents/<id>/SOUL.md over yaml-rendered stub when the file exists.
 *
 * Does NOT write model.provider/model.default — the profile config owns the
 * default model; an explicit runtime override may still be injected at dispatch.
 *
 * Agent SOUL: if `agents/<id>/SOUL.md` exists, copy it as-is; otherwise
 * synthesize from agents.yaml via renderSoul(). learning toolsets are merged
 * (union), not replaced.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import yaml from 'yaml'

const WS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PROFILES = path.join(os.homedir(), '.hermes', 'profiles')
const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin')

function loadAgentsDoc() {
  const agentsPath = path.join(WS, 'agents.yaml')
  const examplePath = path.join(WS, 'agents.yaml.example')
  if (!fs.existsSync(agentsPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, agentsPath)
  }
  if (!fs.existsSync(agentsPath)) {
    return { version: 1, agents: [] }
  }
  return yaml.parse(fs.readFileSync(agentsPath, 'utf8')) ?? {
    version: 1,
    agents: [],
  }
}

const swarm = loadAgentsDoc()
if (!Array.isArray(swarm.agents) && Array.isArray(swarm.workers)) {
  swarm.agents = swarm.workers
}

function isHermesRuntime(worker) {
  const runtime = String(worker?.runtime ?? 'hermes').trim().toLowerCase()
  return runtime === '' || runtime === 'hermes'
}

/** True when ~/.local/bin/<name> is an Agorax Hermes worker shim (not a real CLI). */
function looksLikeHermesWorkerWrapper(filePath) {
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile() || st.size > 8192) return false
    const text = fs.readFileSync(filePath, 'utf8')
    return (
      text.includes('HERMES_HOME=') &&
      (text.includes('HERMES_BIN=') || text.includes('hermes-agent/venv/bin/hermes')) &&
      /exec\s+"?\$HERMES_BIN"?\s+-p\s+/.test(text)
    )
  } catch {
    return false
  }
}

function installWorkerWrappers(workers) {
  fs.mkdirSync(LOCAL_BIN, { recursive: true })
  const installed = []
  const removed = []
  for (const w of workers) {
    const name = (w.wrapper || w.id || '').trim()
    if (!name) continue
    const target = path.join(LOCAL_BIN, name)

    // Managed runtimes (opencode / cursor / claude-code / …) must NOT get a
    // Hermes shim named after their real CLI — that shadows `opencode auth login`
    // etc. and surfaces "Profile 'opencode' does not exist".
    if (!isHermesRuntime(w)) {
      if (looksLikeHermesWorkerWrapper(target)) {
        fs.unlinkSync(target)
        removed.push(name)
      }
      continue
    }

    const profile = w.id
    const profileHomeExpr =
      profile === 'default'
        ? '$HOME/.hermes'
        : `$HOME/.hermes/profiles/${profile}`
    const script = `#!/usr/bin/env bash
set -euo pipefail
cd '${WS}'
export HERMES_HOME="\${HERMES_HOME:-${profileHomeExpr}}"
HERMES_BIN="\${HERMES_CLI_BIN:-\$HOME/.hermes/hermes-agent/venv/bin/hermes}"
if [ ! -x "\$HERMES_BIN" ]; then HERMES_BIN="\$(command -v hermes || true)"; fi
if [ -z "\$HERMES_BIN" ]; then
  echo "hermes CLI not found" >&2
  exit 127
fi
if [ "\$#" -gt 0 ]; then
  exec "\$HERMES_BIN" -p ${profile} "\$@"
fi
exec "\$HERMES_BIN" chat --tui
`
    fs.writeFileSync(target, script, { mode: 0o755 })
    installed.push(name)
  }
  return { installed, removed }
}

function mergeToolsets(existing, swarmTools) {
  return [...new Set([...(existing ?? []), ...(swarmTools ?? [])])]
}

function renderSoul(w) {
  const name = w.name?.trim() || w.id
  const modes = w.modes?.length ? w.modes.join(', ') : 'none'
  const greenlight = w.greenlightRequiredFor?.length
    ? w.greenlightRequiredFor
        .map((g) => `- ${g}: Requires human approval`)
        .join('\n')
    : '- none declared'
  const skills = w.skills?.length ? w.skills.join(', ') : 'swarm-worker-core'
  const capabilities = w.capabilities?.length
    ? w.capabilities.join(', ')
    : 'not declared'
  const model = w.model?.trim() || 'Unspecified'

  const prohibitedById = {
    orchestrator: [
      'Implement code (developer)',
      'Collect primary research facts (researcher)',
      'Make technical architecture decisions (architect)',
    ],
    researcher: [
      'Strategy judgments, recommendations, or direction choices',
      'Architecture or implementation decisions',
      'Publishing externally without greenlight',
    ],
    architect: [
      'Primary fact gathering (researcher)',
      'Writing implementation code (developer)',
      'Business strategy beyond technical scope',
    ],
    developer: [
      'Changing architecture (architect)',
      'Making design decisions (architect)',
      'Skipping tests',
    ],
  }
  const prohibited = prohibitedById[w.id] ?? []
  const prohibBlock = prohibited.length
    ? `\n## Prohibited\n\n${prohibited.map((p) => `- ${p}`).join('\n')}\n`
    : ''

  return [
    `# ${name}`,
    '',
    `- Worker ID: ${w.id}`,
    `- Model: ${model}`,
    `- Skills: ${skills}`,
    `- Capabilities: ${capabilities}`,
    '',
    'The worker ID is a stable machine identifier only; user-facing surfaces should prefer Name — Role.',
    '',
    '## Role',
    w.role?.trim() || 'Worker',
    '',
    '## Mission',
    w.mission?.trim() || '',
    '',
    '## Specialty',
    w.specialty?.trim() || '',
    '',
    '## Modes',
    modes,
    prohibBlock,
    '## Greenlight Rules',
    greenlight,
    '',
    '## Communication Style',
    '- Structured checkpoints: STATE, FILES_CHANGED, COMMANDS_RUN, RESULT, BLOCKER, NEXT_ACTION',
    '- Stay within role boundaries defined in agents.yaml and profile skills',
    '',
  ].join('\n')
}

/** Return agents/<id>/SOUL.md contents, or '' when missing. */
function readAgentSoulFile(agentId) {
  const basePath = path.join(WS, 'agents', agentId, 'SOUL.md')
  if (!fs.existsSync(basePath)) return ''
  return `${fs.readFileSync(basePath, 'utf8').trimEnd()}\n`
}

function syncSwarmSkills(w, profileDir) {
  const wsSkills = path.join(WS, 'skills', 'swarm')
  const profileSkills = path.join(profileDir, 'skills')
  fs.mkdirSync(profileSkills, { recursive: true })

  for (const skill of w.skills ?? []) {
    const localCore = path.join(wsSkills, skill)
    const dest = path.join(profileSkills, skill)
    // Hub / bundled skills are not under skills/swarm/ — skip quietly.
    let st
    try {
      st = fs.statSync(localCore)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    try {
      if (fs.realpathSync(localCore) === fs.realpathSync(dest)) continue
    } catch {
      /* dest missing */
    }
    fs.rmSync(dest, { recursive: true, force: true })
    fs.cpSync(localCore, dest, { recursive: true })
  }
}

/** ~/.hermes/skills/swarm/ — canonical path for /slash-skill discovery (skill_view). */
function syncGlobalSwarmSkills(swarmWorkers) {
  const wsSkills = path.join(WS, 'skills', 'swarm')
  const globalSwarm = path.join(os.homedir(), '.hermes', 'skills', 'swarm')
  const globalRoot = path.join(os.homedir(), '.hermes', 'skills')
  // Dev setups often symlink ~/.hermes/skills/swarm → <repo>/skills/swarm.
  // Never rm/cp into that tree or we delete the git-tracked sources.
  try {
    if (fs.realpathSync(globalSwarm) === fs.realpathSync(wsSkills)) {
      return 0
    }
  } catch {
    /* global path missing — create a real directory below */
  }
  const names = new Set()
  for (const w of swarmWorkers) {
    for (const skill of w.skills ?? []) names.add(skill)
  }
  fs.mkdirSync(globalSwarm, { recursive: true })
  let synced = 0
  for (const skill of names) {
    const src = path.join(wsSkills, skill)
    let st
    try {
      st = fs.statSync(src)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const dest = path.join(globalSwarm, skill)
    try {
      if (fs.realpathSync(src) === fs.realpathSync(dest)) continue
    } catch {
      /* dest missing */
    }
    fs.rmSync(dest, { recursive: true, force: true })
    try {
      fs.cpSync(src, dest, { recursive: true })
    } catch (error) {
      console.warn(
        `global skill sync skip ${skill}: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
    synced++
    // Duplicate top-level copy breaks /slash load (skill name collision).
    // Only remove real directories — never unlink a symlink that points at the repo.
    const dup = path.join(globalRoot, skill)
    try {
      const dupStat = fs.lstatSync(dup)
      if (dupStat.isSymbolicLink()) continue
      if (dupStat.isDirectory()) {
        fs.rmSync(dup, { recursive: true, force: true })
      }
    } catch {
      /* no dup */
    }
  }
  return synced
}

const results = []
for (const w of swarm.agents) {
  const profileDir = path.join(PROFILES, w.id)
  if (!fs.existsSync(profileDir)) {
    results.push(`${w.id}: profile dir missing, skipped`)
    continue
  }

  const configPath = path.join(profileDir, 'config.yaml')
  if (fs.existsSync(configPath)) {
    const cfg = yaml.parse(fs.readFileSync(configPath, 'utf8')) ?? {}
    if (w.tools?.length) {
      const preserve =
        w.id === 'learning'
          ? ['hermes-cli', ...(cfg.toolsets ?? [])]
          : cfg.toolsets
      cfg.toolsets =
        w.id === 'learning' ? mergeToolsets(preserve, w.tools) : [...w.tools]
    }
    if (w.id === 'orchestrator' && cfg.kanban) {
      cfg.kanban.orchestrator_profile = 'orchestrator'
    }
    fs.writeFileSync(configPath, yaml.stringify(cfg))
    results.push(`${w.id}: config.yaml updated`)
  }

  const soulPath = path.join(profileDir, 'SOUL.md')
  const fileSoul = readAgentSoulFile(w.id)
  fs.writeFileSync(soulPath, fileSoul || renderSoul(w))

  // Hermes owns memories/; drop obsolete Agorax memory/ overlay when empty.
  const legacyMem = path.join(profileDir, 'memory')
  if (fs.existsSync(legacyMem)) {
    for (const name of ['IDENTITY.md', 'MEMORY.md', 'SOUL.md', 'USER.md']) {
      const p = path.join(legacyMem, name)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }
    try {
      if (fs.readdirSync(legacyMem).length === 0) {
        fs.rmSync(legacyMem, { recursive: true, force: true })
      }
    } catch {
      /* ignore */
    }
  }
  syncSwarmSkills(w, profileDir)
  const staleSwarmNest = path.join(profileDir, 'skills', 'swarm')
  if (fs.existsSync(staleSwarmNest)) {
    fs.rmSync(staleSwarmNest, { recursive: true, force: true })
    results.push(
      `${w.id}: removed skills/swarm/ nest (fixes /slash name collision)`,
    )
  }
  if (w.id === 'orchestrator') {
    const staleDispatch = path.join(profileDir, 'skills', 'workspace-dispatch')
    if (fs.existsSync(staleDispatch)) {
      fs.rmSync(staleDispatch, { recursive: true, force: true })
      results.push(
        `${w.id}: removed workspace-dispatch from profile (not for CLI orchestrator)`,
      )
    }
  }
  results.push(
    fileSoul
      ? `${w.id}: SOUL.md copied from agents/${w.id}/, swarm skills synced`
      : `${w.id}: SOUL.md rendered from agents.yaml, swarm skills synced`,
  )
}

const globalSynced = syncGlobalSwarmSkills(swarm.agents)
results.push(
  `global: ${globalSynced} swarm skills → ~/.hermes/skills/swarm/ (for /slash commands)`,
)

const { installed: wrappers, removed: removedWrappers } =
  installWorkerWrappers(swarm.agents)
results.push(
  `wrappers: ${wrappers.length} → ~/.local/bin/ (${wrappers.join(', ')})`,
)
if (removedWrappers.length > 0) {
  results.push(
    `removed managed Hermes shims (CLI name collision): ${removedWrappers.join(', ')}`,
  )
}

console.log(results.join('\n'))
