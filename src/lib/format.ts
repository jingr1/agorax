export function formatTokenCount(n: number): string {
  if (!isFinite(n) || isNaN(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatUsd(value: string | number): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value
  if (!isFinite(n) || isNaN(n)) return '$0.00'
  return `$${n.toFixed(2)}`
}
