import { createFileRoute, redirect } from '@tanstack/react-router'
import { ChatRouteLoading } from '../../screens/chat/chat-route-loading'
import { readLastAgent, writeLastAgent } from '../../screens/chat/last-session'
import { pickChatAgentId } from '../../screens/chat/pick-chat-agent'
import { fetchAgents } from '../../lib/agent-api'

/**
 * Resolve which agent `/chat` should open.
 * Prefer: last used (if still in registry) → first online → first in registry.
 * Never invent a product-specific id like `orchestrator` — if the registry is
 * empty the route still needs a param, so fall back to Hermes `default` profile
 * (vanilla single-home installs), not a swarm worker name.
 */
async function resolveDefaultAgentId(): Promise<string> {
  const lastAgent = readLastAgent()
  try {
    const data = await fetchAgents()
    const picked = pickChatAgentId(data.agents, lastAgent)
    if (picked) {
      if (lastAgent && lastAgent !== picked) {
        // Stale localStorage id — rewrite so the next visit does not bounce again.
        writeLastAgent(picked)
      }
      return picked
    }
  } catch {
    // Registry unavailable — keep last-agent only as a soft hint.
  }
  return lastAgent || 'default'
}

export const Route = createFileRoute('/chat/')({
  ssr: false,
  pendingComponent: ChatRouteLoading,
  beforeLoad: async () => {
    const agentId = await resolveDefaultAgentId()
    throw redirect({
      to: '/chat/agent/$agentId',
      params: { agentId },
      replace: true,
    })
  },
  component: function ChatIndexRoute() {
    return <ChatRouteLoading />
  },
})
