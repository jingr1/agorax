/**
 * Normalize AI LaTeX delimiters so remark-math can parse them the same way
 * hermes-webui stashes math before markdown.
 *
 * webui (`static/ui.js` renderMd) extracts, in order, after protecting fences:
 *   $$...$$  display
 *   \[...\]  display
 *   $...$    inline (currency + table-pipe guards)
 *   \(...\)  inline
 *
 * remark-math only tokenizes $ / $$ reliably, so \[ \] and \( \) are rewritten
 * to those forms. Code fences and inline backticks are left untouched.
 */

const CODE_PLACEHOLDER = '\x00C'

function restoreStash(text: string, stash: Array<string>): string {
  return text.replace(
    new RegExp(`${CODE_PLACEHOLDER}(\\d+)\x00`, 'g'),
    (_match, index: string) => stash[Number(index)] ?? '',
  )
}

function withProtectedCode(
  text: string,
  transform: (prose: string) => string,
): string {
  const stash: Array<string> = []
  const remember = (block: string): string => {
    stash.push(block)
    return `${CODE_PLACEHOLDER}${stash.length - 1}\x00`
  }

  // Fenced blocks first — same ordering as webui fence_stash before math_stash.
  let next = text.replace(
    /(^|\n)[ ]{0,3}(`{3,})([^\n`]*)\n(?:([\s\S]*?)\n)?[ ]{0,3}\2`*[ \t]*(?=\n|$)/g,
    (block) => remember(block),
  )
  next = next.replace(/`([^`\n]+)`/g, (block) => remember(block))
  return restoreStash(transform(next), stash)
}

function toDisplayMath(body: string): string {
  const compact = body.replace(/\n{2,}/g, '\n').trim()
  return `$$\n${compact}\n$$`
}

function transformMathDelimiters(prose: string): string {
  let next = prose
  // Display first so $$...$$ is not later eaten as $...$.
  next = next.replace(/\\\[([\s\S]+?)\\\]/g, (_match, body: string) =>
    toDisplayMath(body),
  )
  next = next.replace(/\\\((.+?)\\\)/g, (_match, body: string) => `$${body}$`)
  // webui skips $...$ that looks like a table cell (` | ` inside).
  next = next.replace(
    /\$([^\s$\d\n][^$\n]*?[^\s$\n]|[^\s\d])\$/g,
    (match, body: string) => (body.includes(' | ') ? `\\$${body}\\$` : match),
  )
  return next
}

export function normalizeMathDelimiters(content: string): string {
  if (!content) return content
  if (
    !content.includes('$') &&
    !content.includes('\\[') &&
    !content.includes('\\(')
  ) {
    return content
  }
  return withProtectedCode(content, transformMathDelimiters)
}
