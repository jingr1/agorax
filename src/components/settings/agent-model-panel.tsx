'use client'

import type * as React from 'react'
import type { AgentRuntime, AgentWithStatus } from '@/lib/agent-types'
import { ClaudeCodeSettingsPanel } from '@/components/settings-dialog/claude-code-settings-panel'
import { CodexSettingsPanel } from '@/components/settings-dialog/codex-settings-panel'
import { ModelProviderScopePanel } from '@/components/settings/model-provider-scope'

function runtimeLabel(runtime: AgentRuntime): string {
  switch (runtime) {
    case 'hermes':
      return 'Hermes'
    case 'claude-code':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    case 'cursor':
      return 'Cursor'
    case 'opencode':
      return 'OpenCode'
    case 'kimi':
      return 'Kimi'
    case 'deepseek-harness':
      return 'DeepSeek'
    default:
      return runtime
  }
}

/** Per-agent model body shared by /settings Model tab and the chat Settings dialog. */
export function AgentModelPanel({
  agent,
  hermesProfile,
  onHermesProfileChange,
  hermesExtras,
}: {
  agent: AgentWithStatus
  hermesProfile: string
  onHermesProfileChange: (name: string) => void
  hermesExtras?: (profileName: string) => React.ReactNode
}) {
  if (agent.runtime === 'hermes') {
    return (
      <div className="flex flex-col gap-4">
        <ModelProviderScopePanel
          mode="model"
          profileName={hermesProfile}
          onProfileChange={onHermesProfileChange}
          lockProfile
        />
        {hermesExtras?.(hermesProfile)}
      </div>
    )
  }

  if (agent.runtime === 'claude-code') {
    return <ClaudeCodeSettingsPanel agentId={agent.agentId} />
  }

  if (agent.runtime === 'codex') {
    return <CodexSettingsPanel agentId={agent.agentId} />
  }

  return (
    <div className="rounded-xl border border-primary-200 bg-primary-50/80 px-4 py-6 text-sm text-primary-600">
      No standalone model settings for {runtimeLabel(agent.runtime)} yet.
      Configure shared providers under Provider if this runtime uses them.
    </div>
  )
}
