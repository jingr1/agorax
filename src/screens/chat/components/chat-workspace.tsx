'use client'

import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChatScreen } from '../chat-screen'
import { useProfiles } from '../hooks/use-profiles'
import { ChatRouteLoading } from '../chat-route-loading'
import { ManagedAgentChatView } from './managed-agent-chat-view'
import { pickChatAgentId } from '../pick-chat-agent'
import { useAgentStore } from '@/stores/agent-store'
import { AssistantAvatarProvider } from '@/components/avatars'
import { resolveAgentAvatarSrc } from '@/lib/agent-avatar'

export function ChatWorkspace() {
  const navigate = useNavigate()
  const agent = useAgentStore((state) =>
    state.agents.find((a) => a.agentId === state.activeAgentId),
  )
  const activeAgentId = useAgentStore((state) => state.activeAgentId)
  const agentsLoading = useAgentStore((state) => state.agentsLoading)
  const agents = useAgentStore((state) => state.agents)
  const sessionId = useAgentStore((state) => state.activeSessionId)

  // Stale / missing activeAgentId while the registry has real entries — recover
  // instead of painting "Select an agent to start chatting."
  useEffect(() => {
    if (agentsLoading || agent || agents.length === 0) return
    const fallback = pickChatAgentId(agents, null)
    if (!fallback || fallback === activeAgentId) return
    void navigate({
      to: '/chat/agent/$agentId',
      params: { agentId: fallback },
      replace: true,
    })
  }, [activeAgentId, agent, agents, agentsLoading, navigate])

  if (!agent) {
    // Registry empty and settled → real empty state.
    if (!agentsLoading && agents.length === 0) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-primary-500 dark:text-primary-400">
          Select an agent to start chatting.
        </div>
      )
    }
    // Still loading, or recovering a stale/missing selection.
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <ChatRouteLoading />
      </div>
    )
  }

  if (agent.runtime === 'hermes') {
    // Keyed by agentId so profile/session state does not leak across Hermes
    // agents the way ManagedAgentChatView already remounts per agent.
    return (
      <HermesChatShell
        key={agent.agentId}
        agentId={agent.agentId}
        sessionId={sessionId ?? null}
      />
    )
  }

  // Every non-hermes runtime goes through the managed chat shell — the router
  // decides per runtime whether the daemon hosts it or a direct adapter does.
  // Keyed by agentId: the chat hook bakes agentId into long-lived refs
  // (command port, reconcile port). Without a remount, switching agents
  // kept answering with the previous agent's runtime.
  return (
    <ManagedAgentChatView
      key={agent.agentId}
      agent={agent}
      sessionId={sessionId ?? null}
    />
  )
}

function HermesChatShell({
  agentId,
  sessionId,
}: {
  agentId: string
  sessionId: string | null
}) {
  const agent = useAgentStore((state) =>
    state.agents.find((a) => a.agentId === agentId),
  )
  const { activateProfile, activeProfileName } = useProfiles()
  const targetProfile = agent?.runtimeConfig.profile ?? agentId

  // Activate in the background — never unmount ChatScreen for this, or the
  // chat pane flashes empty (reads as a black screen in dark theme).
  // Session lists are keyed by profile and already refetch on that key change.
  // Invalidating them here waited out workspace catalog load, then fetched
  // the list a second time.
  useEffect(() => {
    if (!agent || activeProfileName === targetProfile) return
    activateProfile(targetProfile)
  }, [activateProfile, activeProfileName, targetProfile, agent])

  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <ChatRouteLoading />
      </div>
    )
  }

  const activeFriendlyId = sessionId ?? 'new'
  const isNewChat = activeFriendlyId === 'new'

  return (
    <AssistantAvatarProvider
      value={{
        src: resolveAgentAvatarSrc(agent.runtime),
        alt: agent.name,
      }}
    >
      <ChatScreen
        activeFriendlyId={activeFriendlyId}
        isNewChat={isNewChat}
        hermesChrome
        skillsAgentId={agentId}
        agentName={agent.name}
        agentRuntime={agent.runtime}
        runtimeLabel={agent.name}
        modelsEndpoint={`/api/agents/${encodeURIComponent(agentId)}/models`}
        onSessionResolved={(payload) => {
          void payload
        }}
      />
    </AssistantAvatarProvider>
  )
}
