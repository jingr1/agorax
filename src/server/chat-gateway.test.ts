import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tempDirs: Array<string> = []

function makeHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hermes-chat-gateway-'))
  tempDirs.push(root)
  const hermesHome = path.join(root, '.hermes')
  mkdirSync(path.join(hermesHome, 'profiles'), { recursive: true })
  mkdirSync(path.join(hermesHome, 'workspace'), { recursive: true })
  process.env.HERMES_HOME = hermesHome
  process.env.AGORAX_STATE_DIR = path.join(hermesHome, 'workspace')
  return hermesHome
}

afterEach(() => {
  vi.resetModules()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveChatGateway', () => {
  it('uses the profile port and key while the pool is on', async () => {
    const home = makeHome()
    const writerHome = path.join(home, 'profiles', 'writer')
    mkdirSync(writerHome, { recursive: true })
    writeFileSync(path.join(writerHome, '.env'), 'API_SERVER_KEY=writer-key\n')
    writeFileSync(path.join(home, '.env'), 'API_SERVER_KEY=default-key\n')
    process.env.HERMES_GATEWAY_POOL = '1'
    process.env.HERMES_API_URL = 'http://127.0.0.1:8642'
    vi.resetModules()

    const ports = await import('./gateway-ports')
    const chat = await import('./chat-gateway')
    const writer = chat.resolveChatGateway('writer')

    expect(writer.profile).toBe('writer')
    expect(writer.url).toBe(ports.getProfileGatewayUrl('writer'))
    expect(writer.url).not.toBe('http://127.0.0.1:8642')
    expect(writer.token).toBe('writer-key')

    chat.enterChatGateway(writer)
    expect(chat.resolveChatGateway().url).toBe(writer.url)
    expect(chat.resolveChatGateway('default').url).toBe(
      ports.getProfileGatewayUrl('default'),
    )
    expect(chat.resolveChatGateway('default').token).toBe('default-key')
  })

  it('shares HERMES_API when the pool is off', async () => {
    makeHome()
    process.env.HERMES_GATEWAY_POOL = '0'
    process.env.HERMES_API_URL = 'http://127.0.0.1:8642'
    vi.resetModules()

    const caps = await import('./gateway-capabilities')
    const chat = await import('./chat-gateway')
    const target = chat.resolveChatGateway('writer')

    expect(target.url).toBe(caps.HERMES_API)
    expect(target.url).toBe('http://127.0.0.1:8642')
  })
})
