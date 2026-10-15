import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getHermesRoot } from '../hermes-paths'
import type { AgoraxManagedAgentBackend } from './agorax-managed-agent-bridge'

export type AgoraxManagedRunBinding = {
  runId: string
  backend: AgoraxManagedAgentBackend
  agentSessionId: string
  displaySessionId?: string
  turnId?: string
  updatedAt: number
}

const DEFAULT_ROOT = path.join(
  getHermesRoot(),
  'webui-mvp',
  'agorax-managed-runs',
)

function bindingPath(root: string, runId: string): string {
  return path.join(root, `${encodeURIComponent(runId)}.json`)
}

function displaySessionPath(root: string, displaySessionId: string): string {
  return path.join(root, `session-${encodeURIComponent(displaySessionId)}.json`)
}

/**
 * Persists only the correlation between an Agorax display run and Agorax's
 * canonical identities. Session/Turn lifecycle remains owned by managed-agent Host.
 */
export class AgoraxManagedRunStore {
  constructor(private readonly root = DEFAULT_ROOT) {}

  async bind(input: Omit<AgoraxManagedRunBinding, 'updatedAt'>): Promise<AgoraxManagedRunBinding> {
    const binding: AgoraxManagedRunBinding = {
      ...input,
      updatedAt: Date.now(),
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const target = bindingPath(this.root, input.runId)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporary, target)
    if (binding.displaySessionId) {
      const sessionTarget = displaySessionPath(this.root, binding.displaySessionId)
      const sessionTemporary = `${sessionTarget}.${process.pid}.${Date.now()}.tmp`
      await writeFile(sessionTemporary, `${JSON.stringify(binding, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await rename(sessionTemporary, sessionTarget)
    }
    return binding
  }

  async get(runId: string): Promise<AgoraxManagedRunBinding | null> {
    try {
      const raw = await readFile(bindingPath(this.root, runId), 'utf8')
      return JSON.parse(raw) as AgoraxManagedRunBinding
    } catch {
      return null
    }
  }

  async getByDisplaySession(
    displaySessionId: string,
  ): Promise<AgoraxManagedRunBinding | null> {
    try {
      const raw = await readFile(displaySessionPath(this.root, displaySessionId), 'utf8')
      return JSON.parse(raw) as AgoraxManagedRunBinding
    } catch {
      return null
    }
  }
}