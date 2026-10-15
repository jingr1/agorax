import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function whichSync(cmd: string, fallbacks: Array<string> = []): string | null {
  const pathEnv = process.env.PATH || ''
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, cmd)
    if (fs.existsSync(candidate)) return candidate
  }
  for (const fb of fallbacks) {
    if (fb && fs.existsSync(fb)) return fb
  }
  return null
}

async function pathExists(target: string) {
  try {
    await fsPromises.access(target)
    return true
  } catch {
    return false
  }
}

export function resolveEditorCommand(): string {
  const localAppData = process.env.LOCALAPPDATA || ''
  const progFiles = process.env.PROGRAMFILES || 'C:\\Program Files'
  const progFilesX86 =
    process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
  const candidates = [
    whichSync('cursor'),
    whichSync('code', [
      '/usr/local/bin/code',
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/usr/bin/code',
      '/snap/bin/code',
      path.join(
        localAppData,
        'Programs',
        'Microsoft VS Code',
        'bin',
        'code.cmd',
      ),
      path.join(progFiles, 'Microsoft VS Code', 'bin', 'code.cmd'),
      path.join(progFilesX86, 'Microsoft VS Code', 'bin', 'code.cmd'),
      '/usr/local/bin/cursor',
      '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
    ]),
  ].filter(Boolean) as Array<string>

  const cmd = candidates[0]
  if (!cmd) {
    throw new Error(
      "Editor command not found. Install VS Code/Cursor CLI ('code' or 'cursor') on PATH.",
    )
  }
  return cmd
}

/** Build a vscode-remote URI for an SSH workspace path. */
export function buildSshRemoteEditorUri(input: {
  host: string
  user?: string
  remotePath: string
}): string {
  const host = input.host.trim()
  if (!host) throw new Error('SSH host is required')
  const user = (input.user || '').trim()
  // Prefer bare host when it is an SSH config Host alias (e.g. dev-wsl).
  // user@host still works for hosts without a config entry.
  const authority = user ? `${user}@${host}` : host
  const remotePath = input.remotePath.startsWith('/')
    ? input.remotePath
    : `/${input.remotePath}`
  return `vscode-remote://ssh-remote+${authority}${remotePath}`
}

export async function revealLocalPath(targetPath: string): Promise<void> {
  if (!(await pathExists(targetPath))) {
    throw new Error(`File not found: ${targetPath}`)
  }
  const platform = os.platform()
  if (platform === 'darwin') {
    spawn('open', ['-R', targetPath], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return
  }
  if (platform === 'win32') {
    spawn('explorer.exe', [`/select,${targetPath}`], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return
  }
  const parent = path.dirname(targetPath)
  spawn('xdg-open', [parent], { detached: true, stdio: 'ignore' }).unref()
}

export async function openLocalPathInEditor(targetPath: string): Promise<void> {
  if (!(await pathExists(targetPath))) {
    throw new Error(`File not found: ${targetPath}`)
  }
  const cmd = resolveEditorCommand()
  spawn(cmd, [targetPath], { detached: true, stdio: 'ignore' }).unref()
}

export async function openRemoteSshPathInEditor(input: {
  host: string
  user?: string
  remotePath: string
  isDirectory: boolean
}): Promise<{ uri: string }> {
  const uri = buildSshRemoteEditorUri(input)
  const cmd = resolveEditorCommand()
  const flag = input.isDirectory ? '--folder-uri' : '--file-uri'
  spawn(cmd, [flag, uri], { detached: true, stdio: 'ignore' }).unref()
  return { uri }
}
