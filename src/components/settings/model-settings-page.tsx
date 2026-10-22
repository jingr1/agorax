'use client'

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type * as React from 'react'
import type { AgentRuntime, AgentWithStatus } from '@/lib/agent-types'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { ModelProviderScopePanel } from '@/components/settings/model-provider-scope'
import { AgentModelPanel } from '@/components/settings/agent-model-panel'
import {
  CLAUDE_CODE_SETTINGS_QUERY_KEY,
  fetchClaudeCodeSettings,
} from '@/components/settings-dialog/claude-code-settings-panel'
import { fetchAgents } from '@/lib/agent-api'
import { cn } from '@/lib/utils'

export type ModelSettingsPane = 'provider' | 'model'

export { AgentModelPanel } from '@/components/settings/agent-model-panel'

type ModelSettingsPageProps = {
  pane: ModelSettingsPane
  agentId?: string
  /** Hermes Memory / Terminal / About for the selected profile. */
  hermesExtras?: (profileName: string) => React.ReactNode
}

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

function hermesProfileForAgent(agent: AgentWithStatus): string {
  if (agent.agentId === 'default') return 'default'
  return agent.runtimeConfig.profile || agent.agentId
}

export function ModelSettingsPage({
  pane,
  agentId,
  hermesExtras,
}: ModelSettingsPageProps) {
  const navigate = useNavigate({ from: '/settings/' })
  const queryClient = useQueryClient()
  const agentsQuery = useQuery({
    queryKey: ['agents', 'settings-model'],
    queryFn: fetchAgents,
    staleTime: 30_000,
  })
  const agents = agentsQuery.data?.agents ?? []

  const selectedAgent = useMemo(() => {
    if (agents.length === 0) return null
    if (agentId) {
      const match = agents.find((agent) => agent.agentId === agentId)
      if (match) return match
    }
    return agents.find((agent) => agent.agentId === 'default') ?? agents[0]
  }, [agentId, agents])

  const [hermesProfile, setHermesProfile] = useState('default')

  useEffect(() => {
    if (!selectedAgent || selectedAgent.runtime !== 'hermes') return
    setHermesProfile(hermesProfileForAgent(selectedAgent))
  }, [selectedAgent])

  // Warm Claude Code settings while agents resolve — avoids a serial waterfall
  // when the Model tab opens on a Claude Code agent.
  useEffect(() => {
    if (pane !== 'model') return
    const runtime =
      selectedAgent?.runtime ??
      agents.find((agent) => agent.agentId === agentId)?.runtime
    if (runtime && runtime !== 'claude-code') return
    void queryClient.prefetchQuery({
      queryKey: CLAUDE_CODE_SETTINGS_QUERY_KEY,
      queryFn: fetchClaudeCodeSettings,
      staleTime: 60_000,
    })
  }, [agentId, agents, pane, queryClient, selectedAgent?.runtime])

  function setPane(next: ModelSettingsPane) {
    void navigate({
      search: (prev) => ({
        ...prev,
        section: 'model',
        pane: next,
        agent:
          next === 'model' ? (selectedAgent?.agentId ?? prev.agent) : prev.agent,
      }),
      replace: true,
    })
  }

  function setAgent(nextAgentId: string) {
    void navigate({
      search: (prev) => ({
        ...prev,
        section: 'model',
        pane: 'model',
        agent: nextAgentId,
      }),
      replace: true,
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <Tabs
        value={pane}
        onValueChange={(value) => setPane(value as ModelSettingsPane)}
        className="gap-3"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 space-y-2">
            <h2 className="text-base font-semibold text-primary-900">
              Model & Provider
            </h2>
            <TabsList variant="underline" className="justify-start">
              <TabsTab value="provider">Provider</TabsTab>
              <TabsTab value="model">Model</TabsTab>
            </TabsList>
          </div>

          {pane === 'model' ? (
            <label className="flex w-full flex-col gap-1 sm:w-56">
              <span className="text-xs font-medium text-primary-600">
                Agent
              </span>
              <select
                value={selectedAgent?.agentId ?? ''}
                onChange={(event) => setAgent(event.target.value)}
                disabled={agentsQuery.isLoading || agents.length === 0}
                className={cn(
                  'control-surface h-9 w-full rounded-lg px-3 text-sm outline-none',
                  'transition-colors focus-visible:ring-2 focus-visible:ring-[var(--theme-accent)]/35',
                )}
              >
                {agents.length === 0 ? (
                  <option value="">
                    {agentsQuery.isLoading ? 'Loading…' : 'No agents'}
                  </option>
                ) : (
                  agents.map((agent) => (
                    <option key={agent.agentId} value={agent.agentId}>
                      {agent.name} · {runtimeLabel(agent.runtime)}
                    </option>
                  ))
                )}
              </select>
            </label>
          ) : null}
        </div>

        <TabsPanel value="provider" className="pt-1">
          {pane === 'provider' ? (
            <ModelProviderScopePanel mode="provider" />
          ) : null}
        </TabsPanel>

        <TabsPanel value="model" className="space-y-4 pt-1">
          {pane !== 'model' ? null : (
            <>
              {agentsQuery.isError ? (
                <div className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-500">
                  Failed to load agents
                </div>
              ) : null}

              {selectedAgent ? (
                <AgentModelPanel
                  agent={selectedAgent}
                  hermesProfile={hermesProfile}
                  onHermesProfileChange={setHermesProfile}
                  hermesExtras={hermesExtras}
                />
              ) : agentsQuery.isLoading ? (
                <div className="space-y-4">
                  <div className="h-36 animate-pulse rounded-2xl bg-primary-100/70" />
                  <div className="h-28 animate-pulse rounded-2xl bg-primary-100/70" />
                </div>
              ) : null}
            </>
          )}
        </TabsPanel>
      </Tabs>
    </div>
  )
}
