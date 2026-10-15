import Prism from 'prismjs'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-markdown'

/** Maps resolved language ids to Prism grammar keys we ship. */
const PRISM_GRAMMAR_KEYS: Record<string, string> = {
  bash: 'bash',
  shell: 'bash',
  python: 'python',
  javascript: 'javascript',
  typescript: 'typescript',
  json: 'json',
  yaml: 'yaml',
  markdown: 'markdown',
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function prismGrammarKey(language: string): string | null {
  return PRISM_GRAMMAR_KEYS[language] ?? null
}

export function highlightWithPrism(content: string, language: string): string {
  const grammarKey = prismGrammarKey(language)
  if (!grammarKey) return escapeHtml(content)

  const grammar = Prism.languages[grammarKey]
  if (!grammar) return escapeHtml(content)

  try {
    return Prism.highlight(content, grammar, grammarKey)
  } catch {
    return escapeHtml(content)
  }
}
