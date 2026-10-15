/**
 * Extract text files from a .zip / .skill archive via Python zipfile.
 * Avoids adding a JS zip dependency; Python 3 is required on the host.
 */
import { spawnSync } from 'node:child_process'
import type { PlatformSkillFile } from './types'

const EXTRACT_SCRIPT = `
import io, json, sys, zipfile
data = sys.stdin.buffer.read()
out = []
with zipfile.ZipFile(io.BytesIO(data)) as zf:
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename.replace("\\\\", "/")
        if not name or name.endswith("/") or ".." in name.split("/"):
            continue
        raw = zf.read(info)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        out.append({"path": name, "content": text})
print(json.dumps(out, ensure_ascii=False))
`

export function extractZipTextFiles(archive: Buffer): Array<PlatformSkillFile> {
  const result = spawnSync('python3', ['-c', EXTRACT_SCRIPT], {
    input: archive,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'buffer',
  })
  if (result.error) {
    throw new Error(
      `Failed to extract archive (python3 required): ${result.error.message}`,
    )
  }
  if (result.status !== 0) {
    const err = (result.stderr?.toString('utf-8') || '').trim()
    throw new Error(err || 'Failed to extract skill archive')
  }
  const stdout = result.stdout?.toString('utf-8') || '[]'
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
    })
  }
  return files
}
