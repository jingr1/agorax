import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const documents = [
  'docs/architecture.md',
  'docs/managed-agent-daemon-mapping.md',
  'docs/hermes-native-bridge.md',
  'docs/mission-task-domain.md',
  'agorax-agent-daemon/README.md',
]
let failures = 0
for (const file of documents) {
  const tokens = marked.lexer(readFileSync(resolve(root, file), 'utf8'))
  marked.walkTokens(tokens, (token) => {
    if (token.type !== 'link' && token.type !== 'image') return
    const href = token.href
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return
    const path = decodeURIComponent(href.split(/[?#]/)[0])
    const target = path.startsWith('/') ? resolve(root, `.${path}`) : resolve(root, dirname(file), path)
    if (path && !existsSync(target)) {
      console.error(`${file}: missing local link ${href}`)
      failures++
    }
  })
}
if (failures) process.exitCode = 1
else console.log(`Architecture contract links: ${documents.length} documents passed`)