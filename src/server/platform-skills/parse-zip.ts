/**
 * Extract text files from a .zip / .skill archive via Python zipfile.
 * Avoids adding a JS zip dependency; Python 3 is required on the host.
 */
import { spawnSync } from 'node:child_process'
import type { PlatformSkillFile } from './types'

const EXTRACT_SCRIPT = `
import base64, io, json, stat, sys, zipfile
data = sys.stdin.buffer.read()
out = []
total = 0
with zipfile.ZipFile(io.BytesIO(data)) as zf:
  if len(zf.infolist()) > 512:
    raise ValueError("Skill archive has too many entries")
  for info in zf.infolist():
    if info.is_dir():
      continue
    name = info.filename.replace("\\\\", "/")
    if not name or name.startswith("/") or ".." in name.split("/"):
      raise ValueError("Invalid skill archive path")
    if stat.S_ISLNK(info.external_attr >> 16):
      raise ValueError("Skill archive contains a symbolic link")
    total += info.file_size
    if info.file_size > 1048576 or total > 8388608:
      raise ValueError("Skill archive exceeds extraction limits")
    raw = zf.read(info)
    encoding = "utf8"
    try:
      text = raw.decode("utf-8")
      if b"\\x00" in raw:
        raise UnicodeDecodeError("utf8", raw, 0, 1, "binary")
    except UnicodeDecodeError:
      text = base64.b64encode(raw).decode("ascii")
      encoding = "base64"
    out.append({"path": name, "content": text, "encoding": encoding, "executable": bool((info.external_attr >> 16) & 0o111)})
print(json.dumps(out, ensure_ascii=False))
`

export function extractZipTextFiles(archive: Buffer): Array<PlatformSkillFile> {
  const result = spawnSync('python3', ['-c', EXTRACT_SCRIPT], {
    input: archive,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'buffer',
    timeout: 30_000,
  })
  if (result.error) {
    throw new Error(
      `Failed to extract archive (python3 required): ${result.error.message}`,
    )
  }
  if (result.status !== 0) {
    const err = result.stderr.toString('utf-8').trim()
    throw new Error(err || 'Failed to extract skill archive')
  }
  const stdout = result.stdout.toString('utf-8') || '[]'
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('Failed to parse extracted archive listing')
  }
  if (!Array.isArray(parsed)) return []
  const files: Array<PlatformSkillFile> = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path.trim() : ''
    if (!path) continue
    files.push({
      path,
      content: typeof record.content === 'string' ? record.content : '',
      ...(record.encoding === 'base64' ? { encoding: 'base64' } : {}),
      ...(record.executable === true ? { executable: true } : {}),
    })
  }
  return files
}
