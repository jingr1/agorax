/**
 * Format enabled platform skills for managed-agent turn/session injection.
 */
import { listEnabledSkillsWithContent } from './store'
import type { PlatformSkill } from './types'

export type FormatSkillBundleOptions = {
  selectedNames?: Array<string>
  /**
   * `bodies` (default for /skill triggers): full SKILL.md + files.
   * `catalog`: names + descriptions only — used for session activate so we
   * do not persist multi-MB skill dumps into every durable user message.
   */
  detail?: 'bodies' | 'catalog'
}

export function formatSkillBundleForPrompt(
  skills: Array<PlatformSkill>,
  opts?: FormatSkillBundleOptions,
): string {
  const selected = opts?.selectedNames?.map((n) => n.toLowerCase())
  const filtered = selected?.length
    ? skills.filter((s) => selected.includes(s.name.toLowerCase()))
    : skills
  if (filtered.length === 0) return ''
  const detail = opts?.detail ?? 'bodies'
  const parts = filtered.map((skill) => {
    if (detail === 'catalog') {
      return `## Skill: ${skill.name}\n${skill.description?.trim() || '(no description)'} — invoke with \`/${skill.name}\` when needed.`
    }
    const files =
      skill.files
        ?.map((f) => `\n\n### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
        .join('') ?? ''
    return `## Skill: ${skill.name}\n${skill.description ? `${skill.description}\n\n` : ''}${skill.content}${files}`
  })
  return [
    '<!-- agorax-platform-skills -->',
    detail === 'catalog'
      ? 'Enabled workspace skills (catalog). Use /skill-name to load full instructions when needed.'
      : 'The following workspace skills are bound and enabled for this agent. Follow them when relevant.',
    ...parts,
    '<!-- /agorax-platform-skills -->',
  ].join('\n\n')
}

/** Extract leading `/skill-name` tokens from a composer message. */
export function extractLeadingSkillTriggers(text: string): {
  skillNames: Array<string>
  remainder: string
} {
  const tokens = text.trimStart().split(/\s+/)
  const skillNames: Array<string> = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] ?? ''
    if (!token.startsWith('/') || token.length < 2) break
    const name = token.slice(1).toLowerCase()
    // Skip known UI slash commands
    if (
      name === 'new' ||
      name === 'clear' ||
      name === 'model' ||
      name === 'help' ||
      name === 'skills' ||
      name === 'skill'
    ) {
      break
    }
    skillNames.push(name)
    i += 1
  }
  const remainder = tokens.slice(i).join(' ').trim()
  return { skillNames, remainder }
}

export function buildManagedSkillPromptPrefix(agentId: string): string {
  const skills = listEnabledSkillsWithContent(agentId)
  // Session activate: catalog only. Full bodies are reserved for /skill turns
  // so durable history stays small enough to hydrate quickly.
  return formatSkillBundleForPrompt(skills, { detail: 'catalog' })
}

export function buildTurnSkillInjection(
  agentId: string,
  userText: string,
): { text: string; injected: Array<string> } {
  const { skillNames, remainder } = extractLeadingSkillTriggers(userText)
  if (skillNames.length === 0) {
    return { text: userText, injected: [] }
  }
  const skills = listEnabledSkillsWithContent(agentId)
  const bundle = formatSkillBundleForPrompt(skills, {
    selectedNames: skillNames,
  })
  if (!bundle) {
    return { text: userText, injected: [] }
  }
  const text = remainder
    ? `${bundle}\n\n${remainder}`
    : `${bundle}\n\n(Use the skill(s) above.)`
  return { text, injected: skillNames }
}

/**
 * Replace the first text block with `runtimeText`, or prepend one when missing.
 * Used so attachments stay while platform-skill injection rewrites the prompt.
 */
export function rewritePromptContentText<T extends { type: string; text?: string }>(
  promptContent: Array<T>,
  runtimeText: string,
): Array<T | { type: 'text'; text: string }> {
  if (promptContent.length === 0) {
    return [{ type: 'text', text: runtimeText }]
  }
  const textIdx = promptContent.findIndex((block) => block.type === 'text')
  if (textIdx >= 0) {
    return promptContent.map((block, index) =>
      index === textIdx && block.type === 'text'
        ? { ...block, type: 'text' as const, text: runtimeText }
        : block,
    )
  }
  return [{ type: 'text', text: runtimeText }, ...promptContent]
}

/**
 * Session activate: prepend all enabled skills when the user did not /trigger
 * a subset. Returns runtime prompt + the unchanged user-visible text.
 */
export function buildManagedActivatePrompt(
  agentId: string,
  userMessage: string,
): { runtimeText: string; displayPrompt: string } {
  const turnInject = buildTurnSkillInjection(agentId, userMessage)
  if (turnInject.injected.length > 0) {
    return { runtimeText: turnInject.text, displayPrompt: userMessage }
  }
  const sessionPrefix = buildManagedSkillPromptPrefix(agentId)
  if (!sessionPrefix) {
    return { runtimeText: userMessage, displayPrompt: userMessage }
  }
  return {
    runtimeText: `${sessionPrefix}\n\n${userMessage}`,
    displayPrompt: userMessage,
  }
}
