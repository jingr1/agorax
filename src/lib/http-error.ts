/** Turn proxy HTML / empty upstream failures into a short user-facing message. */
export function sanitizeHttpErrorText(
  text: string,
  fallback = 'Request failed',
): string {
  const trimmed = text.trim()
  if (!trimmed) return fallback
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
    if (/ERR_ZERO_SIZE_OBJECT/i.test(trimmed)) {
      return '代理或服务器连接中断（响应为空），请稍后重试'
    }
    return '服务器返回了无效页面（可能是代理超时或 dev server 正在重启）'
  }
  return trimmed
}
