import { describe, expect, it } from 'vitest'

import { buildHermesChatQueryArgs } from './swarm-chat-command'

describe('swarm-chat-command', () => {
  it('leaves chat args unchanged when no runtime model is provided', () => {
    const prompt = 'ping'
    const args = buildHermesChatQueryArgs(prompt)
    expect(args.slice(0, 3)).toEqual(['chat', '-q', prompt])
    expect(args).not.toContain('--model')
  })
})
