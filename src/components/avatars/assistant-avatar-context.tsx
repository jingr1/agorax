'use client'

import { createContext, useContext, type ReactNode } from 'react'

export type AssistantAvatarConfig = {
  src: string
  alt: string
}

/** Hermes is the default chat host; managed runtimes override via Provider. */
const DEFAULT_ASSISTANT_AVATAR: AssistantAvatarConfig = {
  src: '/agent-avatars/hermes-rounded.png',
  alt: 'Hermes Agent',
}

const AssistantAvatarContext = createContext<AssistantAvatarConfig>(
  DEFAULT_ASSISTANT_AVATAR,
)

export function AssistantAvatarProvider({
  value,
  children,
}: {
  value: AssistantAvatarConfig
  children: ReactNode
}) {
  return (
    <AssistantAvatarContext.Provider value={value}>
      {children}
    </AssistantAvatarContext.Provider>
  )
}

export function useAssistantAvatarConfig(): AssistantAvatarConfig {
  return useContext(AssistantAvatarContext)
}
