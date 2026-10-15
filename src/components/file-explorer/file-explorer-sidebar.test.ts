import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sidebarSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'file-explorer-sidebar.tsx'),
  'utf8',
)

describe('file explorer workspace refresh', () => {
  it('reloads the tree when the active workspace path changes', () => {
    expect(sidebarSource).toContain('useActiveWorkspace')
    expect(sidebarSource).toContain('workspacePath')
    expect(sidebarSource).toContain('filesQuery.refetch')
  })

  it('paints top-level then prefetches depth 3 in the background', () => {
    expect(sidebarSource).toContain('fetchFileTree(workspaceProfileName, 0)')
    expect(sidebarSource).toContain('fetchFileTree(workspaceProfileName, 3)')
    expect(sidebarSource).toContain(
      'fileTreeQueryKey(workspaceProfileName, workspacePath, 0)',
    )
    expect(sidebarSource).toContain(
      'fileTreeQueryKey(workspaceProfileName, workspacePath, 3)',
    )
    expect(sidebarSource).toContain('deepQuery.data ?? filesQuery.data')
    expect(sidebarSource).toContain('loadFolderChildren')
    expect(sidebarSource).toContain(
      'fetchFileTree(workspaceProfileName, 0, pathValue)',
    )
  })

  it('shows loading instead of empty while the tree is fetching', () => {
    expect(sidebarSource).toContain('showEmpty')
    expect(sidebarSource).toContain(
      'filesQuery.isFetching || deepQuery.isFetching',
    )
  })

  it('docks on the right by default with a left border', () => {
    expect(sidebarSource).toContain("side = 'right'")
    expect(sidebarSource).toContain("side === 'right'")
    expect(sidebarSource).toContain("'border-l border-primary-200'")
  })

  it('opens files in an in-panel webui-style preview instead of a modal', () => {
    expect(sidebarSource).toContain('FilePanelPreview')
    expect(sidebarSource).toContain('previewActive')
    expect(sidebarSource).toContain(
      "data-panel-mode={previewActive ? 'preview' : 'browse'}",
    )
    expect(sidebarSource).toContain(
      "classifyFilePreviewKind(entry.path) === 'download'",
    )
    expect(sidebarSource).not.toContain('FilePreviewDialog')
    expect(sidebarSource).not.toContain('w-[min(480px,46vw)]')
  })

  it('supports dragging to resize the files panel like webui', () => {
    expect(sidebarSource).toContain('hermes-workspace-files-panel-w')
    expect(sidebarSource).toContain('handleResizePointerDown')
    expect(sidebarSource).toContain('cursor-col-resize')
    expect(sidebarSource).toContain('PANEL_MIN_WIDTH')
    expect(sidebarSource).toContain('PANEL_MAX_WIDTH')
  })

  it('aligns CRUD with webui: move, upload drop, rename, menu, profile', () => {
    expect(sidebarSource).toContain('application/x-hermes-workspace-file')
    expect(sidebarSource).toContain('handleMoveEntry')
    expect(sidebarSource).toContain('handleUploadFiles')
    expect(sidebarSource).toContain('isOsFilesDrag')
    expect(sidebarSource).toContain('startInlineRename')
    expect(sidebarSource).toContain('handleNameDoubleClick')
    expect(sidebarSource).toContain('Copy relative path')
    expect(sidebarSource).toContain('withProfileQuery')
    expect(sidebarSource).toContain("action: 'rename'")
    expect(sidebarSource).toContain('createTargetDir')
    expect(sidebarSource).toContain('setPreviewPath(null)')
    expect(sidebarSource).toContain(
      "classifyFilePreviewKind(nextPath) !== 'download'",
    )
  })

  it('shows a webui-style edge toggle with left tooltip when collapsed', () => {
    expect(sidebarSource).toContain('Show workspace panel')
    expect(sidebarSource).toContain('Hide workspace panel')
    expect(sidebarSource).toContain('ArrowLeft01Icon')
    expect(sidebarSource).toContain('side="left"')
    expect(sidebarSource).toContain('fixed right-2.5 top-1/2')
    expect(sidebarSource).toContain('if (collapsed)')
  })

  it('opens files quickly without a long click debounce', () => {
    expect(sidebarSource).toContain('}, 50)')
    expect(sidebarSource).not.toContain('}, 280)')
  })

  it('extends context menu and preview-facing CRUD gaps', () => {
    expect(sidebarSource).toContain('Reveal in file manager')
    expect(sidebarSource).toContain('Open in editor')
    expect(sidebarSource).toContain('Download')
    expect(sidebarSource).toContain('folder')
    expect(sidebarSource).toContain('download-folder')
    expect(sidebarSource).toContain('collectOsDropFiles')
    expect(sidebarSource).toContain('handleCopyAbsolutePath')
    expect(sidebarSource).toContain('applyInlineRename')
    expect(sidebarSource).toContain('cancelInlineRename')
    expect(sidebarSource).toContain('event.stopPropagation()')
    expect(sidebarSource).toContain("mode === 'clipboard'")
    expect(sidebarSource).toContain('Remote path copied')
  })
})
