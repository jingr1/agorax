import { describe, expect, it } from 'vitest'

import { normalizeSessions, textFromMessage } from './utils'
import type { ChatMessage, SessionSummary } from './types'

describe('chat utils workspace directive cleanup', () => {
  it('hides Workspace::v1 prefixes from user-visible message text', () => {
    const message: ChatMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '[Workspace::v1: /Users/aurora/workspace]\nRun the tests',
        },
      ],
    }

    expect(textFromMessage(message)).toBe('Run the tests')
  })

  it('still strips legacy XML workspace_context from message text', () => {
    const message: ChatMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<workspace_context active="true" name="Home" path="/Users/aurora/workspace" />\n\nRun the tests',
        },
      ],
    }

    expect(textFromMessage(message)).toBe('Run the tests')
  })

  it('strips workspace prefixes from session previews and derived titles', () => {
    const sessions = normalizeSessions([
      {
        key: 'session-1',
        friendlyId: 'session-1',
        preview:
          '[Workspace::v1: /Users/aurora/workspace]\nReview the open PRs',
      },
      {
        key: 'session-2',
        friendlyId: 'session-2',
        derivedTitle:
          '<workspace_context active="true" name="Home" path="/Users/aurora/workspace" />\n\nFix Docker publish',
      },
    ] satisfies Array<SessionSummary>)

    expect(sessions[0]?.preview).toBe('Review the open PRs')
    expect(sessions[0]?.derivedTitle).toBe('Review the open PRs')
    expect(sessions[1]?.derivedTitle).toBe('Fix Docker publish')
  })

  it('drops truncated metadata-only titles so auto-rename can run', () => {
    const sessions = normalizeSessions([
      {
        key: 'session-3',
        friendlyId: 'session-3',
        title: '<workspace_context active="true"… #6',
        label: '<workspace_context active="true"… #6',
        derivedTitle: '<workspace_context active="true"… #6',
      },
    ] satisfies Array<SessionSummary>)

    expect(sessions[0]?.title).toBeUndefined()
    expect(sessions[0]?.label).toBeUndefined()
    expect(sessions[0]?.derivedTitle).toBeUndefined()
  })
})
