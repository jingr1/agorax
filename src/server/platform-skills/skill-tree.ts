import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { PlatformSkillFile } from './types'

export const PLATFORM_MARKER = '.agorax-platform-skill'
export type SkillTree = { content: string; files?: Array<PlatformSkillFile> }
export type SkillTreeMarker = { version: 2; skillId: string; baseHash: string; executables?: Array<string> }

/** Mirrors Hermes / scan-skill-fs junk dirs — never part of a skill package. */
export const SKILL_TREE_EXCLUDED_DIR_NAMES = new Set([
  '.git',
  '.github',
  '.hub',
  '.archive',
  '.curator_backups',
  '.venv',
  'venv',
  'node_modules',
  'site-packages',
  '__pycache__',
  '.tox',
  '.nox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.cache',
  'dist',
  'build',
  '_org',
  '_wisdom',
])

export function isExcludedSkillPath(raw: string): boolean {
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .some((part) => SKILL_TREE_EXCLUDED_DIR_NAMES.has(part))
}

export function normalizeSkillFilePath(raw: string): string {
  const normalized = raw.replace(/\\/g, '/')
  const parts = normalized.split('/')
  if (
    !normalized ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[<>:"|?*]/.test(part) ||
        [...part].some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
        part === PLATFORM_MARKER ||
        part.startsWith('.agorax-') ||
        SKILL_TREE_EXCLUDED_DIR_NAMES.has(part),
    )
  )
    throw new Error(`Invalid skill file path: ${raw}`)
  return normalized
}

export function skillFileBytes(file: PlatformSkillFile): Buffer {
  const bytes = Buffer.from(
    file.content,
    file.encoding === 'base64' ? 'base64' : 'utf8',
  )
  if (file.encoding === 'base64' && bytes.toString('base64') !== file.content) throw new Error(`Invalid base64 skill file: ${file.path}`)
  return bytes
}

export function encodeSkillFile(
  relative: string,
  bytes: Buffer,
  executable = false,
): PlatformSkillFile {
  let content: string
  let encoding: 'utf8' | 'base64' = 'utf8'
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (bytes.includes(0)) throw new Error('binary')
  } catch {
    content = bytes.toString('base64')
    encoding = 'base64'
  }
  return {
    path: relative,
    content,
    ...(encoding === 'base64' ? { encoding } : {}),
    ...(executable ? { executable } : {}),
  }
}

export function skillTreeFiles(tree: SkillTree): Array<PlatformSkillFile> {
  const files: Array<PlatformSkillFile> = [
    { path: 'SKILL.md', content: tree.content },
    ...(tree.files ?? [])
      .filter((file) => !isExcludedSkillPath(file.path))
      .map((file) => ({ ...file })),
  ]
  const seen = new Set<string>()
  let total = 0
  for (const file of files) {
    file.path = normalizeSkillFilePath(file.path)
    const key = file.path.toLowerCase()
    if (seen.has(key))
      throw new Error(`Duplicate skill file path: ${file.path}`)
    seen.add(key)
    const size = skillFileBytes(file).length
    total += size
    if (size > 8 * 1024 * 1024)
      throw new Error(
        `Skill package exceeds file or size limits (file ${file.path} is ${size} bytes; max 8 MiB per file)`,
      )
    if (total > 32 * 1024 * 1024)
      throw new Error(
        `Skill package exceeds file or size limits (package total ${total} bytes; max 32 MiB)`,
      )
    if (files.length > 512)
      throw new Error(
        `Skill package exceeds file or size limits (${files.length} files; max 512)`,
      )
  }
  for (const file of files) {
    const segments = file.path.toLowerCase().split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      if (seen.has(segments.slice(0, depth).join('/'))) throw new Error(`Skill file conflicts with a directory: ${file.path}`)
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

export function hashSkillTree(tree: SkillTree): string {
  const hash = createHash('sha256')
  for (const file of skillTreeFiles(tree)) {
    const bytes = skillFileBytes(file)
    hash.update(
      JSON.stringify([file.path, bytes.length, Boolean(file.executable)]),
    )
    hash.update(bytes)
  }
  return hash.digest('hex')
}

export function readSkillTree(directory: string): SkillTree {
  if (!fs.lstatSync(directory).isDirectory())
    throw new Error('Skill root is not a real directory')
  // Fail fast for category folders / unmanaged trees before walking nested
  // packages (e.g. skills/github/github-pr-workflow/SKILL.md).
  const skillMdPath = path.join(directory, 'SKILL.md')
  if (!fs.existsSync(skillMdPath) || !fs.statSync(skillMdPath).isFile())
    throw new Error('Valid UTF-8 SKILL.md is required')
  const files: Array<PlatformSkillFile> = []
  const executablePaths = new Set(process.platform === 'win32' ? readSkillMarker(directory)?.executables ?? [] : [])
  let total = 0
  const walk = (current: string, prefix: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (
        entry.name === PLATFORM_MARKER ||
        entry.name.endsWith('.pyc') ||
        SKILL_TREE_EXCLUDED_DIR_NAMES.has(entry.name)
      )
        continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      normalizeSkillFilePath(relative)
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink())
        throw new Error(`Skill contains a symbolic link: ${relative}`)
      if (entry.isDirectory()) walk(full, relative)
      else if (entry.isFile()) {
        const stat = fs.lstatSync(full)
        total += stat.size
        if (stat.size > 8 * 1024 * 1024)
          throw new Error(
            `Skill package exceeds file or size limits (${relative} is ${stat.size} bytes; max 8 MiB per file): ${directory}`,
          )
        if (total > 32 * 1024 * 1024)
          throw new Error(
            `Skill package exceeds file or size limits (package total ${total} bytes; max 32 MiB): ${directory}`,
          )
        if (files.length >= 512)
          throw new Error(
            `Skill package exceeds file or size limits (${files.length + 1} files; max 512): ${directory}`,
          )
        files.push(
          encodeSkillFile(
            relative,
            fs.readFileSync(full),
            process.platform === 'win32' ? executablePaths.has(relative) : Boolean(stat.mode & 0o111),
          ),
        )
      } else throw new Error(`Unsupported skill file: ${relative}`)
    }
  }
  walk(directory, '')
  const index = files.find((file) => file.path === 'SKILL.md')
  if (!index || index.encoding === 'base64')
    throw new Error('Valid UTF-8 SKILL.md is required')
  return {
    content: index.content,
    files: files.filter((file) => file.path !== 'SKILL.md'),
  }
}

export function readSkillMarker(directory: string): SkillTreeMarker | null {
  try {
    const marker = JSON.parse(
      fs.readFileSync(path.join(directory, PLATFORM_MARKER), 'utf8'),
    ) as Partial<SkillTreeMarker>
    return marker.version === 2 &&
      typeof marker.skillId === 'string' &&
      typeof marker.baseHash === 'string'
      ? (marker as SkillTreeMarker)
      : null
  } catch {
    return null
  }
}

export function recoverSkillTree(directory: string, skillId: string): void {
  const backup = `${directory}.agorax-backup`
  if (!fs.existsSync(backup)) return
  const marker = readSkillMarker(backup)
  if (marker?.skillId !== skillId)
    throw new Error('Pending recovery has an unknown owner')
  if (!fs.existsSync(directory)) {
    fs.renameSync(backup, directory)
    return
  }
  const current = readSkillMarker(directory)
  if (
    current?.skillId !== skillId ||
    hashSkillTree(readSkillTree(directory)) !== current.baseHash
  )
    throw new Error('Pending recovery conflicts with local files')
  const backupHash = hashSkillTree(readSkillTree(backup))
  if (backupHash !== marker.baseHash && backupHash !== current.baseHash)
    throw new Error('Pending backup contains unpublished edits')
  fs.rmSync(backup, { recursive: true })
}

export function writeSkillTree(
  directory: string,
  skillId: string,
  tree: SkillTree,
  expectedHash?: string,
): void {
  const files = skillTreeFiles(tree)
  const staging = `${directory}.agorax-stage-${randomUUID()}`
  const backup = `${directory}.agorax-backup`
  if (fs.existsSync(backup))
    throw new Error(`Pending skill recovery: ${backup}`)
  fs.mkdirSync(staging, { recursive: true })
  try {
    for (const file of files) {
      const full = path.join(staging, file.path)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, skillFileBytes(file))
      if (process.platform !== 'win32')
        fs.chmodSync(full, file.executable ? 0o755 : 0o644)
    }
    fs.writeFileSync(
      path.join(staging, PLATFORM_MARKER),
      JSON.stringify({ version: 2, skillId, baseHash: hashSkillTree(tree), executables: files.filter((file) => file.executable).map((file) => file.path) }),
    )
    if (fs.existsSync(directory)) {
      if (
        expectedHash === undefined ||
        hashSkillTree(readSkillTree(directory)) !== expectedHash
      )
        throw new Error('Skill changed during synchronization')
      fs.renameSync(directory, backup)
    } else if (expectedHash !== undefined)
      throw new Error('Skill disappeared during synchronization')
    try {
      fs.renameSync(staging, directory)
    } catch (error) {
      if (fs.existsSync(backup) && !fs.existsSync(directory))
        fs.renameSync(backup, directory)
      throw error
    }
    fs.rmSync(backup, { recursive: true, force: true })
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
