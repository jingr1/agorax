import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as yaml from 'yaml'

export type ConfigSyncResult =
  | {
      ok: true
      changed: boolean
      previous?: { provider: string; default: string }
    }
  | { ok: false; error: string }

export type ProfileBootstrapResult = {
  ok: boolean
  configCreated: boolean
  /** True when a private `.env` was created/replaced (never a symlink to root). */
  envCopied: boolean
  authLinked: boolean
  mcpTokensLinked: number
  error?: string
}

export type SwarmWorkerIdentity = {
  id: string
  name?: string
  role?: string
  specialty?: string
  model?: string
  mission?: string
  skills?: Array<string>
  capabilities?: Array<string>
}

function linkSharedFile(source: string, target: string): boolean {
  if (!existsSync(source)) return false
  if (existsSync(target)) {
    try {
      const stat = lstatSync(target)
      if (stat.isSymbolicLink()) {
        unlinkSync(target)
      } else {
        renameSync(target, `${target}.profile-local.bak-${Date.now()}`)
      }
    } catch {
      return false
    }
  }
  symlinkSync(source, target)
  return true
}

/**
 * Copy root `.env` into a profile as a real file.
 *
 * Never symlink: Hermes loads `.env` with override=True, so a shared
 * `API_SERVER_PORT=8642` would make every worker fight for default's port.
 * Strip that key so the gateway pool can assign a unique port later.
 */
function copyPrivateEnv(sourceEnv: string, envPath: string): boolean {
  const raw = readFileSync(sourceEnv, 'utf8')
  const lines = raw.split('\n').filter((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return true
    const eq = trimmed.indexOf('=')
    if (eq <= 0) return true
    const key = trimmed.slice(0, eq).trim()
    return key !== 'API_SERVER_PORT'
  })
  const body = `${lines.join('\n').replace(/\n+$/, '')}\n`
  writeFileSync(envPath, body, { encoding: 'utf8', mode: 0o600 })
  return true
}

/**
 * Ensure a worker HERMES_HOME has enough runtime config to boot Hermes.
 *
 * Swarm dispatch runs workers with HERMES_HOME=~/.hermes/profiles/<workerId>.
 * A brand-new profile only has memory/runtime files, so `hermes chat -q` exits
 * with first-run setup before the worker can do any work. Bootstrap by copying
 * the operator's non-secret config.yaml and a private `.env` (keys shared,
 * ports not). The config is copied (not symlinked) because per-worker model
 * sync edits it. `auth.json` / mcp-tokens stay symlinked — they have no port.
 */
export function ensureSwarmProfileConfig(
  profilePath: string,
  options: { hermesRoot?: string } = {},
): ProfileBootstrapResult {
  const result: ProfileBootstrapResult = {
    ok: true,
    configCreated: false,
    envCopied: false,
    authLinked: false,
    mcpTokensLinked: 0,
  }
  try {
    // Never materialize a tombstoned named profile via bootstrap mkdir.
    const base = profilePath.replace(/\/+$/, '')
    const marker = base.match(/^(.*)\/profiles\/([^/]+)$/)
    if (marker) {
      const [, hermesRootGuess, profileName] = marker
      const tombstone = join(
        hermesRootGuess,
        'profiles',
        '.deleted',
        profileName,
      )
      if (existsSync(tombstone)) {
        return {
          ...result,
          ok: false,
          error: `profile "${profileName}" was deleted`,
        }
      }
    }
    mkdirSync(profilePath, { recursive: true })
    const hermesRoot = options.hermesRoot ?? join(homedir(), '.hermes')

    const configPath = join(profilePath, 'config.yaml')
    const sourceConfig = join(hermesRoot, 'config.yaml')
    if (!existsSync(configPath) && existsSync(sourceConfig)) {
      copyFileSync(sourceConfig, configPath)
      result.configCreated = true
    }

    const envPath = join(profilePath, '.env')
    const sourceEnv = join(hermesRoot, '.env')
    if (existsSync(sourceEnv)) {
      let shouldCopy = !existsSync(envPath)
      if (!shouldCopy) {
        try {
          // Break legacy symlinks that shared default's API_SERVER_PORT.
          shouldCopy = lstatSync(envPath).isSymbolicLink()
          if (shouldCopy) unlinkSync(envPath)
        } catch {
          shouldCopy = false
        }
      }
      if (shouldCopy) {
        copyPrivateEnv(sourceEnv, envPath)
        result.envCopied = true
      }
    }

    const authPath = join(profilePath, 'auth.json')
    const sourceAuth = join(hermesRoot, 'auth.json')
    if (existsSync(sourceAuth)) {
      let shouldLink = !existsSync(authPath)
      if (!shouldLink) {
        try {
          const stat = lstatSync(authPath)
          shouldLink = stat.isSymbolicLink()
          if (shouldLink) unlinkSync(authPath)
        } catch {
          shouldLink = false
        }
      }
      if (shouldLink) {
        symlinkSync(sourceAuth, authPath)
        result.authLinked = true
      }
    }

    const mcpTokensDir = join(profilePath, 'mcp-tokens')
    const sourceMcpTokensDir = join(hermesRoot, 'mcp-tokens')
    if (existsSync(sourceMcpTokensDir)) {
      mkdirSync(mcpTokensDir, { recursive: true })
      for (const name of readdirSync(sourceMcpTokensDir)) {
        if (!name.endsWith('.json')) continue
        if (
          linkSharedFile(
            join(sourceMcpTokensDir, name),
            join(mcpTokensDir, name),
          )
        ) {
          result.mcpTokensLinked += 1
        }
      }
    }

    if (!existsSync(configPath)) {
      return {
        ...result,
        ok: false,
        error: `config.yaml missing at ${configPath}`,
      }
    }
    return result
  } catch (err) {
    return {
      ...result,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function renderSwarmWorkerIdentity(worker: SwarmWorkerIdentity): string {
  const name = worker.name?.trim() || worker.id
  const role = worker.role?.trim() || 'Worker'
  const specialty = worker.specialty?.trim() || 'General execution'
  const model = worker.model?.trim() || 'Unspecified'
  const mission =
    worker.mission?.trim() ||
    'Execute assigned swarm work and checkpoint progress.'
  const skills =
    worker.skills && worker.skills.length > 0
      ? worker.skills.join(', ')
      : 'swarm-worker-core'
  const capabilities =
    worker.capabilities && worker.capabilities.length > 0
      ? worker.capabilities.join(', ')
      : 'not declared'

  return [
    `# IDENTITY.md — ${name}`,
    '',
    `- Name: ${name}`,
    `- Worker ID: ${worker.id}`,
    `- Role: ${role}`,
    `- Specialty: ${specialty}`,
    `- Mission: ${mission}`,
    `- Skills: ${skills}`,
    `- Capabilities: ${capabilities}`,
    `- Model: ${model}`,
    '',
    '## Job description',
    `${name} is the ${role} lane. ${mission}`,
    '',
    'The worker ID is a stable machine identifier only; user-facing surfaces should prefer `Name — Role`.',
    '',
  ].join('\n')
}

export function syncSwarmProfileIdentity(
  profilePath: string,
  worker: SwarmWorkerIdentity,
): ConfigSyncResult {
  if (!existsSync(profilePath)) {
    return { ok: false, error: `profile path missing: ${profilePath}` }
  }
  const identityDir = join(profilePath, 'memory')
  const identityPath = join(identityDir, 'IDENTITY.md')
  const next = renderSwarmWorkerIdentity(worker)
  try {
    mkdirSync(identityDir, { recursive: true })
    const current = existsSync(identityPath)
      ? readFileSync(identityPath, 'utf8')
      : ''
    if (current === next) return { ok: true, changed: false }
    const tmpPath = `${identityPath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmpPath, next, 'utf8')
    renameSync(tmpPath, identityPath)
    return { ok: true, changed: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
