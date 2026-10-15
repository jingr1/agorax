import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = () =>
  readFileSync(
    resolve(process.cwd(), 'src/screens/chat/components/chat-composer.tsx'),
    'utf8',
  )

describe('ChatComposer context controls', () => {
  it('shows the active profile read-only via shared useProfiles hook', () => {
    const src = source()

    expect(src).toContain('useProfiles')
    // Runtime identity renders from the shared useProfiles result (read-only).
    expect(src).toContain('activeProfile')
    expect(src).not.toContain("queryKey: ['profiles', 'composer']")
    expect(src).not.toContain("fetch('/api/profiles/activate'")
  })

  it('surfaces workspace and reasoning controls next to the model picker', () => {
    const src = source()

    expect(src).toContain('/api/workspace')
    expect(src).toContain('agent=')
    expect(src).toContain('Workspace context')
    expect(src).toContain('workspaceSelectMutation')
    expect(src).toContain('WorkspaceFolderPicker')
    expect(src).toContain('DialogRoot')
    expect(src).toContain('SEARCH_MODAL_EVENTS.TOGGLE_FILE_EXPLORER')
    expect(src).toContain('Reasoning effort')
    expect(src).toContain('thinkingLabel')
  })
})
