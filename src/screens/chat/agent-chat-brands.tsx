import {
  BrainIcon,
  CodeIcon,
  PuzzleIcon,
} from '@hugeicons/core-free-icons'

export type AgentChatSuggestion = {
  label: string
  prompt: string
  icon: unknown
}

/**
 * Runtime-scoped suggestion chips for the new-session empty state.
 * Identity (avatar + name) is supplied separately by ChatEmptyState —
 * brands no longer carry title / tagline / status-line / avatar.
 */
export type AgentChatBrand = {
  id: string
  suggestions: Array<AgentChatSuggestion>
}

const HERMES_SUGGESTIONS: Array<AgentChatSuggestion> = [
  {
    label: 'Analyze workspace',
    prompt:
      'Analyze this workspace structure and give me 3 engineering risks. Use tools and keep it concise.',
    icon: CodeIcon,
  },
  {
    label: 'Save a preference',
    prompt:
      'Save this to memory exactly: "For demos, respond in 3 bullets max and put risk first." Then confirm saved.',
    icon: BrainIcon,
  },
  {
    label: 'Create a file',
    prompt: 'Create demo-checklist.md with 5 launch checks for this app.',
    icon: PuzzleIcon,
  },
]

const MANAGED_CODING_SUGGESTIONS: Array<AgentChatSuggestion> = [
  {
    label: 'Explain this repo',
    prompt:
      'Summarize this repository: what it does, key entry points, and how to run it locally. Keep it concise.',
    icon: CodeIcon,
  },
  {
    label: 'Find a bug',
    prompt:
      'Scan the recent changes and likely hotspots for bugs. List the top 3 risks with file paths.',
    icon: BrainIcon,
  },
  {
    label: 'Write a test',
    prompt:
      'Propose one focused unit test for the riskiest module here, and draft the test file contents.',
    icon: PuzzleIcon,
  },
]

export const HERMES_CHAT_BRAND: AgentChatBrand = {
  id: 'hermes',
  suggestions: HERMES_SUGGESTIONS,
}

export const CLAUDE_CODE_CHAT_BRAND: AgentChatBrand = {
  id: 'claude-code',
  suggestions: MANAGED_CODING_SUGGESTIONS,
}

export const CODEX_CHAT_BRAND: AgentChatBrand = {
  id: 'codex',
  suggestions: MANAGED_CODING_SUGGESTIONS,
}

/** Resolve suggestion brand for a managed / Hermes runtime. */
export function chatBrandForRuntime(runtime: string): AgentChatBrand {
  switch (runtime) {
    case 'codex':
      return CODEX_CHAT_BRAND
    case 'claude-code':
    case 'cursor':
    case 'opencode':
    case 'kimi':
    case 'deepseek-harness':
      return CLAUDE_CODE_CHAT_BRAND
    case 'hermes':
    default:
      return HERMES_CHAT_BRAND
  }
}
