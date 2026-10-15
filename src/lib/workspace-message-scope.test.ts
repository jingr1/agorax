import { describe, expect, it } from 'vitest'

import {
  buildWorkspaceScopedTextMessage,
  isWorkspaceMetadataTitle,
  stripWorkspaceDirective,
} from './workspace-message-scope'

describe('buildWorkspaceScopedTextMessage', () => {
  it('prepends a WebUI-compatible Workspace::v1 prefix to plain text', () => {
    expect(
      buildWorkspaceScopedTextMessage('Run the tests', {
        path: '/Users/eric/projects/hermes-workspace',
        folderName: 'hermes-workspace',
        isValid: true,
      }),
    ).toBe(
      '[Workspace::v1: /Users/eric/projects/hermes-workspace]\nRun the tests',
    )
  })

  it('escapes backslashes and closing brackets in the path', () => {
    expect(
      buildWorkspaceScopedTextMessage('hi', {
        path: 'C:\\work\\proj[wip]',
        isValid: true,
      }),
    ).toBe('[Workspace::v1: C:\\\\work\\\\proj[wip\\]]\nhi')
  })

  it('does not duplicate the directive if the message is retried', () => {
    const scoped = buildWorkspaceScopedTextMessage('Run the tests', {
      path: '/Users/eric/work',
      folderName: 'work',
      isValid: true,
    })
    expect(
      buildWorkspaceScopedTextMessage(scoped, {
        path: '/Users/eric/other',
        folderName: 'other',
        isValid: true,
      }),
    ).toBe(scoped)
  })

  it('leaves messages unchanged when no valid workspace exists', () => {
    expect(
      buildWorkspaceScopedTextMessage('hello', {
        path: '',
        folderName: '',
        isValid: false,
      }),
    ).toBe('hello')
  })

  it('strips Workspace::v1 prefixes for user-visible rendering', () => {
    expect(
      stripWorkspaceDirective(
        '[Workspace::v1: /Users/aurora/workspace]\nRun the tests',
      ),
    ).toBe('Run the tests')
  })

  it('strips legacy Agorax XML directives', () => {
    expect(
      stripWorkspaceDirective(
        '<workspace_context active="true" name="Home" path="/Users/aurora/workspace" />\n\nRun the tests',
      ),
    ).toBe('Run the tests')
  })

  it('clears truncated gateway metadata-only titles', () => {
    expect(
      stripWorkspaceDirective('<workspace_context active="true"… #6'),
    ).toBe('')
    expect(stripWorkspaceDirective('[Workspace::v1: /tmp/proj… #2')).toBe('')
  })
})

describe('isWorkspaceMetadataTitle', () => {
  it('detects WebUI and legacy Agorax title pollution', () => {
    expect(isWorkspaceMetadataTitle('[Workspace::v1: /tmp/x]')).toBe(true)
    expect(isWorkspaceMetadataTitle('[Workspace::v1: /tmp/x… #3')).toBe(true)
    expect(
      isWorkspaceMetadataTitle('<workspace_context active="true"… #6'),
    ).toBe(true)
    expect(isWorkspaceMetadataTitle('Refactor auth middleware')).toBe(false)
  })
})
