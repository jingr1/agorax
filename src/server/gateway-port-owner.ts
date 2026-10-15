/**
 * Who owns a TCP listen port.
 *
 * Keep this module a leaf: no imports from gateway-pool / lifecycle / ports.
 * Vite SSR rewrites `export function` into live `const` bindings; keep inode
 * helpers as non-exported function declarations so HMR cannot drop them.
 *
 * Linux uses `/proc` (fast). macOS/Windows fall back to `lsof` + `ps` because
 * `/proc/net/tcp` is unavailable — without that fallback every profile looks
 * `stopped` (gray) in the UI even when gateways are healthy.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveProfileHermesHome } from './profiles-browser'

function readAliveGatewayPid(hermesHome: string): number | null {
  try {
    const raw = fs
      .readFileSync(path.join(hermesHome, 'gateway.pid'), 'utf-8')
      .trim()
    if (!raw) return null
    let pid: number | null = null
    if (/^\d+$/.test(raw)) {
      pid = Number(raw)
    } else {
      const parsed = JSON.parse(raw) as { pid?: unknown }
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) {
        pid = parsed.pid
      }
    }
    if (!pid || pid <= 0) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

const LISTEN_CACHE_MS = 250
let listenCache: { at: number; inodesByPort: Map<number, Set<string>> } | null =
  null
let pidCache: { at: number; pidByPort: Map<number, number | null> } | null =
  null
let linuxProcAvailable: boolean | null = null

function hasLinuxProcNet(): boolean {
  if (linuxProcAvailable != null) return linuxProcAvailable
  try {
    fs.accessSync('/proc/net/tcp', fs.constants.R_OK)
    linuxProcAvailable = true
  } catch {
    linuxProcAvailable = false
  }
  return linuxProcAvailable
}

function listenInodesByPort(): Map<number, Set<string>> {
  const now = Date.now()
  if (listenCache && now - listenCache.at < LISTEN_CACHE_MS) {
    return listenCache.inodesByPort
  }
  const inodesByPort = new Map<number, Set<string>>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 10 || parts[3] !== '0A') continue
      const hex = parts[1]?.split(':')[1]
      if (!hex) continue
      const port = Number.parseInt(hex, 16)
      if (!Number.isInteger(port) || port <= 0) continue
      if (!parts[9] || parts[9] === '0') continue
      let inodes = inodesByPort.get(port)
      if (!inodes) {
        inodes = new Set<string>()
        inodesByPort.set(port, inodes)
      }
      inodes.add(parts[9])
    }
  }
  listenCache = { at: now, inodesByPort }
  return inodesByPort
}

function inodesForPort(port: number): Set<string> {
  return listenInodesByPort().get(port) ?? new Set()
}

function pidOwnsSocketInodes(pid: number, inodes: Set<string>): boolean {
  if (!inodes.size || !pid) return false
  let fds: Array<string> = []
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`)
  } catch {
    return false
  }
  for (const fd of fds) {
    try {
      const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`)
      const match = target.match(/^socket:\[(\d+)\]$/)
      if (match && inodes.has(match[1])) return true
    } catch {
      // fd vanished
    }
  }
  return false
}

function findPidBySocketInodes(inodes: Set<string>): number | null {
  let names: Array<string> = []
  try {
    names = fs.readdirSync('/proc')
  } catch {
    return null
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pidOwnsSocketInodes(pid, inodes)) return pid
  }
  return null
}

function rememberPid(port: number, pid: number | null): void {
  const now = Date.now()
  if (!pidCache || now - pidCache.at >= LISTEN_CACHE_MS) {
    pidCache = { at: now, pidByPort: new Map() }
  }
  pidCache.pidByPort.set(port, pid)
}

function lsofListeningPid(port: number): number | null {
  if (!Number.isInteger(port) || port <= 0) return null
  try {
    const out = execFileSync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      {
        encoding: 'utf8',
        timeout: 1500,
        maxBuffer: 64_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim()
    const first = out.split(/\s+/)[0]?.trim()
    if (first && /^\d+$/.test(first)) return Number(first)
  } catch {
    // not listening, or lsof unavailable
  }
  return null
}

export function isPortInUse(port: number): boolean {
  if (hasLinuxProcNet()) return inodesForPort(port).size > 0
  return lsofListeningPid(port) != null
}

export function pidListeningOnPort(port: number): number | null {
  const now = Date.now()
  if (
    pidCache &&
    now - pidCache.at < LISTEN_CACHE_MS &&
    pidCache.pidByPort.has(port)
  ) {
    return pidCache.pidByPort.get(port) ?? null
  }

  if (hasLinuxProcNet()) {
    const inodes = inodesForPort(port)
    if (!inodes.size) {
      rememberPid(port, null)
      return null
    }
    const scanned = findPidBySocketInodes(inodes)
    rememberPid(port, scanned)
    return scanned
  }

  const pid = lsofListeningPid(port)
  rememberPid(port, pid)
  return pid
}

export function profileOwnsPort(profileName: string, port: number): boolean {
  const home = resolveProfileHermesHome(profileName)
  const pidFromFile = readAliveGatewayPid(home)

  if (hasLinuxProcNet()) {
    const inodes = inodesForPort(port)
    if (!inodes.size) return false
    if (pidFromFile && pidOwnsSocketInodes(pidFromFile, inodes)) return true
    const pid = pidListeningOnPort(port)
    if (!pid) return false
    const occupantHome = readProcessHermesHome(pid)
    return Boolean(
      occupantHome && path.resolve(occupantHome) === path.resolve(home),
    )
  }

  const pid = pidListeningOnPort(port)
  if (!pid) return false
  if (pidFromFile && pidFromFile === pid) return true
  const occupantHome = readProcessHermesHome(pid)
  return Boolean(
    occupantHome && path.resolve(occupantHome) === path.resolve(home),
  )
}

export function readProcessHermesHome(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`)
    const env = raw.toString('utf8').split('\0')
    const line = env.find((entry) => entry.startsWith('HERMES_HOME='))
    if (!line) return null
    const value = line.slice('HERMES_HOME='.length).trim()
    return value || null
  } catch {
    // fall through to platform-specific probes
  }

  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('ps', ['eww', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1500,
        maxBuffer: 2_000_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const match = out.match(/\bHERMES_HOME=([^\s]+)/)
      return match?.[1] ? match[1].trim() : null
    } catch {
      return null
    }
  }

  return null
}
