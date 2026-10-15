import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('WorkspaceFolderPicker', () => {
  it('loads folders from the home-rooted workspace folders API', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/workspace-folder-picker.tsx'),
      'utf8',
    )
    expect(source).toContain('/api/workspace/folders')
    expect(source).toContain('preloadWorkspaceFolders')
    expect(source).toContain('Enter project path, e.g. /home/user/project')
    expect(source).toContain('No workspace folders')
    expect(source).toContain('controller.abort()')
  })
})
