/** Build Hermes task arguments; the active profile supplies model defaults. */
export function buildHermesChatQueryArgs(prompt: string): string[] {
  // `hermes chat -q` requires the query as the immediate next argv item.
  return [
    'chat',
    '-q',
    prompt,
    '-Q',
    '--yolo',
    '--ignore-rules',
    '--accept-hooks',
    '--max-turns',
    '15',
    '--source',
    'swarm-dispatch',
  ]
}
