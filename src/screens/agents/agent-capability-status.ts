export function agentMcpStatus(status: string | undefined, enabled: boolean): 'ok' | 'error' | 'disabled' | 'assigned' | 'unknown' {
  if (!enabled) return 'disabled'
  if (status === 'ok' || status === 'connected') return 'ok'
  if (status === 'error' || status === 'failed') return 'error'
  if (status === 'assigned') return 'assigned'
  return 'unknown'
}