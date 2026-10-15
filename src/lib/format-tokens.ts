/** Compact token count formatter (matches hermes-webui `_fmtTokens`). */
export function formatTokens(n: number): string {
  if (!n || n < 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
