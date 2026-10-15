/**
 * Per-agent model catalog.
 *
 * Hermes → that profile's config.yaml providers / default
 * Managed → runtime-local settings (Claude/Codex) or daemon composer-options
 */
import fs from 'node:fs'
import path from 'node:path'
import { getAgentRuntimeRouter } from './agent-runtime/router'
import type { AgentRuntimeKind } from './agent-runtime/types'
import { AgoraxManagedAgentHttpClient } from './agent-runtime/agorax-managed-agent-http-client'
import {
  listClaudeCodeModels,
  readClaudeCodeSettings,
} from './claude-code-settings'
import {
  listCodexModels,
  readCodexConfig,
  resolveCodexProviderDisplay,
} from './codex-settings'
import { providerIdForAgentRuntime } from '../lib/managed-agent-runtime/provider-status'
import {
  readModelProviderFromConfig,
  readProfile,
  resolveProfileHermesHome,
} from './profiles-browser'

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Profile-local catalog from providers / custom_providers / fallbacks / aliases. */
function catalogFromProfileConfig(
  config: Record<string, unknown>,
): Array<AgentModelEntry> {
  const out: Array<AgentModelEntry> = []
  const seen = new Set<string>()
  const push = (entry: AgentModelEntry) => {
    const id = entry.id.trim()
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push({ ...entry, id })
  }

  const pushBlock = (providerId: string, block: Record<string, unknown>) => {
    const providerModels = block.models
    if (Array.isArray(providerModels)) {
      for (const modelEntry of providerModels) {
        if (typeof modelEntry === 'string') {
          const id = modelEntry.trim()
          if (id) push({ id, name: id, provider: providerId })
          continue
        }
        const record = asRecord(modelEntry)
        const id =
          readString(record.id) ||
          readString(record.model) ||
          readString(record.name)
        if (!id) continue
        push({
          id,
          name: readString(record.name) || id,
          provider: readString(record.provider) || providerId,
        })
      }
    } else if (providerModels && typeof providerModels === 'object') {
      for (const [modelId, meta] of Object.entries(asRecord(providerModels))) {
        const id = modelId.trim()
        if (!id) continue
        const record = asRecord(meta)
        push({
          id,
          name: readString(record.name) || readString(record.display_name) || id,
          provider: readString(record.provider) || providerId,
        })
      }
    }
    const providerDefault =
      readString(block.model) ||
      readString(block.default) ||
      readString(block.default_model) ||
      readString(block.defaultModel)
    if (providerDefault) {
      push({ id: providerDefault, name: providerDefault, provider: providerId })
    }
  }

  for (const [providerId, value] of Object.entries(asRecord(config.providers))) {
    pushBlock(providerId, asRecord(value))
  }
  if (Array.isArray(config.custom_providers)) {
    for (const entry of config.custom_providers) {
      const block = asRecord(entry)
      const providerId =
        readString(block.name) ||
        readString(block.id) ||
        readString(block.provider)
      if (!providerId) continue
      pushBlock(providerId, block)
    }
  }
  if (Array.isArray(config.fallback_providers)) {
    for (const entry of config.fallback_providers) {
      const block = asRecord(entry)
      const providerId = readString(block.provider) || readString(block.name)
      const modelId = readString(block.model) || readString(block.default)
      if (!providerId || !modelId) continue
      push({ id: modelId, name: modelId, provider: providerId })
    }
  }
  for (const [alias, target] of Object.entries(
    asRecord(config.model_aliases),
  )) {
    const aliasId = alias.trim()
    if (!aliasId) continue
    const targetStr = typeof target === 'string' ? target.trim() : ''
    push({
      id: aliasId,
      name: targetStr ? `${aliasId} → ${targetStr}` : aliasId,
      provider:
        targetStr && targetStr.includes('/')
          ? targetStr.split('/')[0]!
          : 'alias',
    })
  }
  return out
}

export type AgentModelEntry = {
  id: string
  name: string
  provider: string
  alias?: string
}

export type AgentModelsResponse = {
  ok: true
  agentId: string
  runtime: AgentRuntimeKind | 'unknown'
  models: Array<AgentModelEntry>
  currentModel: string | null
  currentProvider: string | null
  providers: Array<{ id: string; name: string }>
  source: string
}

function resolveRuntime(agentId: string): {
  runtime: AgentRuntimeKind | 'unknown'
  isHermes: boolean
  profileName: string
} {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  if (decl) {
    return {
      runtime: decl.runtime,
      isHermes: decl.runtime === 'hermes',
      profileName: decl.profile ?? agentId,
    }
  }
  if (
    router.registry.orphanProfiles.includes(agentId) ||
    agentId === 'default'
  ) {
    return { runtime: 'hermes', isHermes: true, profileName: agentId }
  }
  return { runtime: 'unknown', isHermes: false, profileName: agentId }
}

function agentExists(agentId: string): boolean {
  const router = getAgentRuntimeRouter()
  return (
    router.registry.byId.has(agentId) ||
    router.registry.orphanProfiles.includes(agentId) ||
    agentId === 'default'
  )
}

function readProfileModelsJson(profileName: string): Array<AgentModelEntry> {
  const home = resolveProfileHermesHome(profileName)
  const modelsPath = path.join(home, 'models.json')
  try {
    if (!fs.existsSync(modelsPath)) return []
    const entries = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'))
    if (!Array.isArray(entries)) return []
    const out: Array<AgentModelEntry> = []
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const id =
        (typeof record.model === 'string' && record.model.trim()) ||
        (typeof record.id === 'string' && record.id.trim()) ||
        ''
      if (!id) continue
      out.push({
        id,
        name:
          (typeof record.name === 'string' && record.name.trim()) || id,
        provider:
          (typeof record.provider === 'string' && record.provider.trim()) ||
          'unknown',
      })
    }
    return out
  } catch {
    return []
  }
}

function mergeModelEntries(
  ...sources: Array<Array<AgentModelEntry>>
): Array<AgentModelEntry> {
  const merged: Array<AgentModelEntry> = []
  const seen = new Set<string>()
  for (const source of sources) {
    for (const model of source) {
      const id = model.id?.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      merged.push({ ...model, id })
    }
  }
  return merged
}

function providersFromModels(
  models: Array<AgentModelEntry>,
): Array<{ id: string; name: string }> {
  const seen = new Set<string>()
  const out: Array<{ id: string; name: string }> = []
  for (const model of models) {
    const id = model.provider?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: id })
  }
  return out
}

function buildHermesAgentModels(
  agentId: string,
  profileName: string,
): AgentModelsResponse {
  const profile = readProfile(profileName)
  const { model: currentModel, provider: currentProvider } =
    readModelProviderFromConfig(profile.config)
  const fromConfig = catalogFromProfileConfig(profile.config)
  const fromJson = readProfileModelsJson(profileName)

  let models = mergeModelEntries(fromConfig, fromJson)
  if (currentModel) {
    models = mergeModelEntries(
      [
        {
          id: currentModel,
          name: currentModel,
          provider: currentProvider || 'unknown',
        },
      ],
      models,
    )
  }

  // Nested model.<provider>.models (legacy orchestrator shape) — catalogFromConfig
  // only reads top-level providers:; keep these so profile-local lists stay complete.
  const modelBlock = profile.config.model
  if (modelBlock && typeof modelBlock === 'object' && !Array.isArray(modelBlock)) {
    const nested: Array<AgentModelEntry> = []
    for (const [key, value] of Object.entries(
      modelBlock as Record<string, unknown>,
    )) {
      if (key === 'default' || key === 'provider' || key === 'openai_runtime') {
        continue
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const block = value as Record<string, unknown>
      const list = block.models
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (typeof item !== 'string' || !item.trim()) continue
        nested.push({ id: item.trim(), name: item.trim(), provider: key })
      }
    }
    models = mergeModelEntries(models, nested)
  }

  return {
    ok: true,
    agentId,
    runtime: 'hermes',
    models,
    currentModel: currentModel || null,
    currentProvider: currentProvider || null,
    providers: providersFromModels(models),
    source: `hermes-profile:${profileName}`,
  }
}

function buildClaudeCodeModels(agentId: string): AgentModelsResponse {
  const listed = listClaudeCodeModels(readClaudeCodeSettings())
  return {
    ok: true,
    agentId,
    runtime: 'claude-code',
    models: listed.models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      ...(m.alias ? { alias: m.alias } : {}),
    })),
    currentModel: listed.currentModel || null,
    currentProvider: listed.currentProvider || null,
    providers: listed.currentProvider
      ? [{ id: listed.currentProvider, name: listed.currentProvider }]
      : [],
    source: 'claude-code-settings',
  }
}

function buildCodexModels(agentId: string): AgentModelsResponse {
  const cfg = readCodexConfig()
  const providerName = resolveCodexProviderDisplay(cfg)
  const models = listCodexModels(cfg)
  return {
    ok: true,
    agentId,
    runtime: 'codex',
    models,
    currentModel: cfg.model || null,
    currentProvider: providerName || cfg.provider || null,
    providers: cfg.provider
      ? [{ id: cfg.provider, name: providerName || cfg.provider }]
      : [],
    source: 'codex-config',
  }
}

async function buildManagedViaDaemon(
  agentId: string,
  runtime: AgentRuntimeKind,
): Promise<AgentModelsResponse | null> {
  const provider = providerIdForAgentRuntime(runtime)
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
  const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
  if (!provider || !baseUrl || !workspaceId) return null

  try {
    const client = new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
    const response = await client.getComposerOptions({ provider })
    const modelConfig =
      response && typeof response === 'object'
        ? (response as Record<string, unknown>).modelConfig
        : null
    const options =
      modelConfig && typeof modelConfig === 'object'
        ? (modelConfig as Record<string, unknown>).options
        : null
    const models: Array<AgentModelEntry> = []
    if (Array.isArray(options)) {
      for (const raw of options) {
        if (!raw || typeof raw !== 'object') continue
        const entry = raw as Record<string, unknown>
        const id =
          (typeof entry.value === 'string' && entry.value.trim()) ||
          (typeof entry.id === 'string' && entry.id.trim()) ||
          ''
        if (!id) continue
        // OpenCode (and other provider-prefixed catalogs) encode the real
        // upstream provider in the model id (`github-copilot/gpt-5.4`). Prefer
        // that over the agent-runtime id so the picker groups correctly and
        // session settings keep the exact OpenCode model key.
        const slash = id.indexOf('/')
        const modelProvider =
          slash > 0 ? id.slice(0, slash) : provider
        models.push({
          id,
          name:
            (typeof entry.label === 'string' && entry.label.trim()) ||
            (typeof entry.name === 'string' && entry.name.trim()) ||
            id,
          provider: modelProvider,
        })
      }
    }
    let currentModel: string | null = null
    if (modelConfig && typeof modelConfig === 'object') {
      const cfg = modelConfig as Record<string, unknown>
      const effective =
        typeof cfg.effectiveValue === 'string' ? cfg.effectiveValue.trim() : ''
      const current =
        typeof cfg.currentValue === 'string' ? cfg.currentValue.trim() : ''
      currentModel = effective || current || null
    }

    const currentProvider =
      currentModel && currentModel.includes('/')
        ? currentModel.slice(0, currentModel.indexOf('/'))
        : provider

    const modelsWithDefault: Array<AgentModelEntry> =
      currentModel && !models.some((m) => m.id === currentModel)
        ? [
            {
              id: currentModel,
              name: currentModel,
              provider: currentProvider,
            },
            ...models,
          ]
        : models

    return {
      ok: true,
      agentId,
      runtime,
      models: modelsWithDefault,
      currentModel,
      currentProvider,
      providers: providersFromModels(modelsWithDefault),
      source: `daemon-composer-options:${provider}`,
    }
  } catch {
    return null
  }
}

/**
 * Build the model picker payload for one registry agent.
 * Fail-closed: unknown agents throw; managed without a catalog returns empty models.
 */
export async function buildAgentModels(
  agentId: string,
): Promise<AgentModelsResponse> {
  const id = agentId.trim()
  if (!id) throw new Error('agentId is required')
  if (!agentExists(id)) throw new Error(`Unknown agent: ${id}`)

  const { runtime, isHermes, profileName } = resolveRuntime(id)
  if (isHermes) {
    return buildHermesAgentModels(id, profileName)
  }

  if (runtime === 'claude-code') {
    return buildClaudeCodeModels(id)
  }
  if (runtime === 'codex') {
    return buildCodexModels(id)
  }

  const fromDaemon = await buildManagedViaDaemon(id, runtime as AgentRuntimeKind)
  if (fromDaemon) return fromDaemon

  // Honest empty catalog (tutti fail-closed) — never invent Hermes models.
  return {
    ok: true,
    agentId: id,
    runtime,
    models: [],
    currentModel: null,
    currentProvider: null,
    providers: [],
    source: `managed-empty:${runtime}`,
  }
}

/** Synchronous Hermes-only helper for tests. */
export function buildHermesProfileModels(
  profileName: string,
): AgentModelsResponse {
  return buildHermesAgentModels(profileName, profileName)
}
