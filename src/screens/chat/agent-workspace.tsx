'use client'

import { ChatWorkspace } from './components/chat-workspace'
import { useAgentWorkspace } from './hooks/use-agent-workspace'

/**
 * Agent workspace shell: load agents into the store and render ChatWorkspace.
 * Session sidebar lives inside ChatScreen (pluggable SessionController) —
 * do not mount a second ChatSessionSidebar here.
 */
export function AgentWorkspace() {
  useAgentWorkspace()

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatWorkspace />
      </div>
    </div>
  )
}
