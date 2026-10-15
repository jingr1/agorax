export type WorkspaceScope = {
  path?: string
  folderName?: string
  isValid?: boolean
}

/** Hermes WebUI-compatible prefix: `[Workspace::v1: /abs/path]\n` */
const WORKSPACE_V1_PREFIX_RE =
  /^\s*\[Workspace::v1:\s*(?:\\.|[^\]\\])+\]\s*/i

/** Older WebUI-style `[Workspace: path]` */
const WORKSPACE_LEGACY_BRACKET_RE = /^\s*\[Workspace:[^\]]+\]\s*/i

/** Prior Agorax XML directive (complete tag). */
const WORKSPACE_XML_DIRECTIVE_RE =
  /^\s*<workspace_context\b[^>]*\/?>\s*/i

function escapeWorkspacePrefixPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/]/g, '\\]')
}

/**
 * True when a session title/label is (or starts as) injected workspace
 * metadata — including gateway-truncated forms like
 * `<workspace_context active="true"… #6` or `[Workspace::v1:…`.
 */
export function isWorkspaceMetadataTitle(title: string): boolean {
  const trimmed = title.trim()
  if (!trimmed) return false
  return (
    /^\[Workspace(?:::v1)?:/i.test(trimmed) ||
    /^<workspace_context\b/i.test(trimmed)
  )
}

function messageAlreadyHasWorkspacePrefix(message: string): boolean {
  return (
    /^\s*\[Workspace(?:::v1)?:/i.test(message) ||
    /^\s*<workspace_context\b/i.test(message)
  )
}

export function buildWorkspaceDirective(workspace: WorkspaceScope): string {
  const path = workspace.path?.trim() ?? ''
  if (!path || workspace.isValid === false) return ''
  return `[Workspace::v1: ${escapeWorkspacePrefixPath(path)}]`
}

export function buildWorkspaceScopedTextMessage(
  message: string,
  workspace: WorkspaceScope | null | undefined,
): string {
  if (messageAlreadyHasWorkspacePrefix(message)) return message
  const directive = workspace ? buildWorkspaceDirective(workspace) : ''
  if (!directive) return message
  // Match Hermes WebUI: single newline after the tag, then user text.
  return `${directive}\n${message}`
}

/**
 * Remove an injected workspace prefix from message text / titles.
 * Handles WebUI v1, legacy bracket, and prior Agorax XML forms.
 */
export function stripWorkspaceDirective(message: string): string {
  if (!message) return message

  const afterV1 = message.replace(WORKSPACE_V1_PREFIX_RE, '')
  if (afterV1 !== message) return afterV1.trimStart()

  const afterLegacy = message.replace(WORKSPACE_LEGACY_BRACKET_RE, '')
  if (afterLegacy !== message) return afterLegacy.trimStart()

  const afterXml = message.replace(WORKSPACE_XML_DIRECTIVE_RE, '')
  if (afterXml !== message) return afterXml.trimStart()

  // Truncated gateway titles with no closable tag — metadata only.
  if (isWorkspaceMetadataTitle(message)) return ''

  return message.trimStart()
}
