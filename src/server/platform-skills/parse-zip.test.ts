import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { extractZipTextFiles } from './parse-zip'

describe('skill archive bytes', () => {
  it('keeps binary assets and executable scripts', () => {
    const archive = spawnSync('python3', [
      '-c',
      `
import io, sys, zipfile
out = io.BytesIO()
with zipfile.ZipFile(out, 'w') as archive:
    archive.writestr('SKILL.md', '# Skill')
    archive.writestr('assets/example.png', bytes([0,255,128]))
    script = zipfile.ZipInfo('scripts/run.sh')
    script.external_attr = 0o100755 << 16
    archive.writestr(script, 'echo hello')
sys.stdout.buffer.write(out.getvalue())
`,
    ])
    expect(archive.status).toBe(0)
    const files = extractZipTextFiles(archive.stdout)
    expect(
      files.find((file) => file.path === 'assets/example.png'),
    ).toMatchObject({ encoding: 'base64', content: 'AP+A' })
    expect(
      files.find((file) => file.path === 'scripts/run.sh')?.executable,
    ).toBe(true)
  })
})
