export type PlatformSkillOrigin = {
  kind: 'manual' | 'agents_yaml' | 'hub' | 'profile_fs' | 'import'
  source?: string
  importedAt?: number
}

export type PlatformSkillFile = {
  path: string
  content: string
}

export type PlatformSkill = {
  id: string
  name: string
  description: string
  category: string
  content: string
  origin: PlatformSkillOrigin
  createdAt: number
  updatedAt: number
  files?: Array<PlatformSkillFile>
}

export type PlatformSkillSummary = {
  id: string
  name: string
  description: string
  category: string
  origin: PlatformSkillOrigin
  createdAt: number
  updatedAt: number
  boundAgentCount: number
}

export type AgentSkillBinding = {
  agentId: string
  skillId: string
  enabled: boolean
  createdAt: number
  name: string
  description: string
}

export type ComposerSkillOption = {
  id: string
  name: string
  description: string
  trigger: string
  content?: string
}

export type CreatePlatformSkillInput = {
  name: string
  description?: string
  category?: string
  content?: string
  files?: Array<PlatformSkillFile>
  origin?: PlatformSkillOrigin
  id?: string
}

export type UpdatePlatformSkillInput = {
  name?: string
  description?: string
  category?: string
  content?: string
  files?: Array<PlatformSkillFile>
  origin?: PlatformSkillOrigin
}
