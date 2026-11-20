/**
 * Format enabled platform skills for managed-agent turn/session injection.
 */
import { listEnabledSkillsWithContent } from './store'
import { reconcilePlatformSkill } from './reconcile'
import type { PlatformSkill } from './types'

export type FormatSkillBundleOptions = {
  selectedNames?: Array<string>
  /**
   * `bodies` (default for /skill triggers): full SKILL.md + files.
   * `catalog`: names + descriptions only — used for session activate so we
   * do not persist multi-MB skill dumps into every durable user message.
   */
  detail?: 'bodies' | 'catalog'
  directories?: Record<string, string>
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
      const directory = opts?.directories?.[skill.id]
      return `## Skill: ${skill.name}\n${skill.description.trim() || '(no description)'}${directory ? `\nRead ${JSON.stringify(`${directory}/SKILL.md`)} when relevant. Supporting scripts and references are in the same directory.` : ` — invoke with \`/${skill.name}\` when needed.`}`
    }
    const directory = opts?.directories?.[skill.id]
    const files =
      (directory ? [] : skill.files)
        ?.map((file) =>
          file.encoding === 'base64'
            ? `\n\nBinary attachment: ${file.path}`
            : `\n\n### File: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``,
        )
        .join('') ?? ''
    return `## Skill: ${skill.name}\n${skill.description ? `${skill.description}\n\n` : ''}${skill.content}${files}${directory ? `\n\nSupporting files: ${JSON.stringify(directory)}` : ''}`
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
export function extractLeadingSkillTriggers(
  text: string,
  allowed?: Set<string>,
): {
  skillNames: Array<string>
  remainder: string
} {
  const skillNames: Array<string> = []
  let remainder = text.trimStart()
  const reserved = new Set(['new', 'clear', 'model', 'help', 'skills', 'skill'])
  for (;;) {
    const match = remainder.match(/^\/([a-z0-9._-]+)(?=\s|$)/i)
    if (!match) break
    const name = match[1].toLowerCase()
    if (reserved.has(name) || (allowed && !allowed.has(name))) break
    skillNames.push(name)
    remainder = remainder.slice(match[0].length).trimStart()
  }
  return { skillNames, remainder }
}

function prepareSkillDirectories(agentId: string): Record<string, string> {
  const directories: Record<string, string> = {}
  for (const skill of listEnabledSkillsWithContent(agentId)) {
    const deployment = reconcilePlatformSkill(skill.id).find(
      (entry) =>
        entry.agentId === agentId && entry.status === 'in-sync' && entry.path,
    )
    if (deployment?.path) directories[skill.id] = deployment.path
  }
  return directories
}

export function buildManagedSkillPromptPrefix(agentId: string): string {
  const skills = listEnabledSkillsWithContent(agentId)
  // Session activate: catalog only. Full bodies are reserved for /skill turns
  // so durable history stays small enough to hydrate quickly.
  return formatSkillBundleForPrompt(skills, {
    detail: 'catalog',
    directories: prepareSkillDirectories(agentId),
  })
}

export function buildTurnSkillInjection(
  agentId: string,
  userText: string,
): { text: string; injected: Array<string> } {
  const available = listEnabledSkillsWithContent(agentId)
  const { skillNames, remainder } = extractLeadingSkillTriggers(
    userText,
    new Set(available.map((skill) => skill.name.toLowerCase())),
  )
  if (skillNames.length === 0) {
    return { text: userText, injected: [] }
  }
  const directories = prepareSkillDirectories(agentId)
  const skills = listEnabledSkillsWithContent(agentId)
  const bundle = formatSkillBundleForPrompt(skills, {
    selectedNames: skillNames,
    directories,
  })
  if (!bundle) {
    return { text: userText, injected: [] }
  }
  const text = remainder
    ? `${bundle}\n\n${remainder}`
    : `${bundle}\n\n(Use the skill(s) above.)`
  return {
    text,
    injected: skills
      .filter((skill) => skillNames.includes(skill.name.toLowerCase()))
      .map((skill) => skill.name),
  }
}

/**
 * Replace the first text block with `runtimeText`, or prepend one when missing.
 * Used so attachments stay while platform-skill injection rewrites the prompt.
 */
export function rewritePromptContentText<
  T extends { type: string; text?: string },
>(
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
