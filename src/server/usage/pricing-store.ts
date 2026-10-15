import * as fs from 'node:fs'
import * as path from 'node:path'
import { getStateDir } from '../workspace-state-dir'
import type { ModelPricingEntry, PricingConfig } from './usage-types'

const PRICING_FILE = 'model-pricing.json'

export function getPricingFilePath(): string {
  const dir = getStateDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return path.join(dir, PRICING_FILE)
}

export function loadPricingConfig(): PricingConfig {
  const filePath = getPricingFilePath()
  if (!fs.existsSync(filePath)) {
    return {
      defaultMultiplier: '1',
      models: {},
      updatedAt: Date.now(),
    }
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PricingConfig>
    return {
      defaultMultiplier: parsed.defaultMultiplier ?? '1',
      models: parsed.models ?? {},
      updatedAt: parsed.updatedAt ?? Date.now(),
    }
  } catch {
    return {
      defaultMultiplier: '1',
      models: {},
      updatedAt: Date.now(),
    }
  }
}

export function savePricingConfig(config: PricingConfig): void {
  const filePath = getPricingFilePath()
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(
    filePath,
    JSON.stringify(config, null, 2) + '\n',
    'utf-8',
  )
}

export function getPricingForModel(modelId: string): ModelPricingEntry | null {
  const config = loadPricingConfig()
  const entry = config.models[modelId]
  if (!entry) return null
  return entry
}

export function setPricingForModel(entry: ModelPricingEntry): void {
  const config = loadPricingConfig()
  config.models[entry.modelId] = {
    ...entry,
    updatedAt: Date.now(),
  }
  config.updatedAt = Date.now()
  savePricingConfig(config)
}

export function removePricingForModel(modelId: string): boolean {
  const config = loadPricingConfig()
  if (!config.models[modelId]) return false
  delete config.models[modelId]
  config.updatedAt = Date.now()
  savePricingConfig(config)
  return true
}

export function setDefaultMultiplier(multiplier: string): void {
  const config = loadPricingConfig()
  config.defaultMultiplier = multiplier
  config.updatedAt = Date.now()
  savePricingConfig(config)
}
