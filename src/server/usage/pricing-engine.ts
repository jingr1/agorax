import { loadPricingConfig } from './pricing-store'
import type { ModelPricingEntry } from './usage-types'

/**
 * Token semantics for input token accounting.
 *
 * - `cache-inclusive`: the reported input_tokens already include cache
 *   read/creation. We must subtract them before pricing fresh input.
 *   Used by OpenAI/Codex/Gemini/Grok style gateways.
 * - `fresh-input`: input_tokens are the fresh (non-cache) tokens only.
 *   Cache read/creation are reported separately. Used by Anthropic.
 */
export type InputTokenSemantics = 'cache-inclusive' | 'fresh-input'

/**
 * Detect the input token semantics for a given provider/model pair.
 *
 * This mirrors cc-switch's CostCalculator behavior: OpenAI, Codex, Gemini,
 * and Grok-style providers report cache tokens inside input_tokens;
 * Anthropic/Claude reports them separately.
 */
export function detectInputTokenSemantics(
  providerId: string,
  modelId: string,
): InputTokenSemantics {
  const p = providerId.toLowerCase()
  const m = modelId.toLowerCase()

  if (p.includes('anthropic') || p.includes('claude')) return 'fresh-input'
  if (m.startsWith('claude-')) return 'fresh-input'

  // Everything else is treated as cache-inclusive by default: OpenAI,
  // Codex, Gemini, Grok, local proxies fronting those APIs, etc.
  return 'cache-inclusive'
}

function parseCost(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function parseMultiplier(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function toDecimalString(n: number): string {
  if (!Number.isFinite(n)) return '0'
  // Avoid scientific notation and keep up to 12 decimal places.
  return n.toLocaleString('en-US', {
    maximumFractionDigits: 12,
    useGrouping: false,
  })
}

export interface CostBreakdown {
  inputCost: string
  outputCost: string
  cacheReadCost: string
  cacheCreationCost: string
  totalCost: string
}

export interface PricingInputs {
  providerId: string
  modelId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  multiplier?: string
}

/**
 * Compute cost from raw token counts and stored pricing.
 *
 * Prices are stored "per million tokens". The caller is responsible for
 * normalizing input_tokens according to the provider semantics before
 * calling this function (see `normalizeInputTokens`).
 */
export function calculateCost(inputs: PricingInputs): CostBreakdown {
  const config = loadPricingConfig()
  const pricing: ModelPricingEntry | null =
    config.models[inputs.modelId] ?? null

  const multiplier = parseMultiplier(
    inputs.multiplier ?? pricing?.multiplier ?? config.defaultMultiplier,
    1,
  )
  const inputSemantics =
    pricing?.inputTokenMode ?? detectInputTokenSemantics(inputs.providerId, inputs.modelId)

  const inputRate = parseCost(pricing?.inputCostPerMillion, 0)
  const outputRate = parseCost(pricing?.outputCostPerMillion, 0)
  const cacheReadRate = parseCost(
    pricing?.cacheReadCostPerMillion,
    inputRate,
  )
  const cacheCreationRate = parseCost(
    pricing?.cacheCreationCostPerMillion,
    inputRate,
  )

  const freshInput =
    inputSemantics === 'cache-inclusive'
      ? Math.max(0, inputs.inputTokens - inputs.cacheReadTokens - inputs.cacheCreationTokens)
      : Math.max(0, inputs.inputTokens)
  const output = Math.max(0, inputs.outputTokens)
  const cacheRead = Math.max(0, inputs.cacheReadTokens)
  const cacheCreation = Math.max(0, inputs.cacheCreationTokens)

  const inputCost = (freshInput * inputRate) / 1_000_000
  const outputCost = (output * outputRate) / 1_000_000
  const cacheReadCost = (cacheRead * cacheReadRate) / 1_000_000
  const cacheCreationCost = (cacheCreation * cacheCreationRate) / 1_000_000

  const total =
    (inputCost + outputCost + cacheReadCost + cacheCreationCost) * multiplier

  return {
    inputCost: toDecimalString(inputCost * multiplier),
    outputCost: toDecimalString(outputCost * multiplier),
    cacheReadCost: toDecimalString(cacheReadCost * multiplier),
    cacheCreationCost: toDecimalString(cacheCreationCost * multiplier),
    totalCost: toDecimalString(total),
  }
}

/**
 * Normalize input tokens depending on provider semantics.
 *
 * For cache-inclusive providers, the gateway may include cache tokens in
 * the input count. We subtract cache_read and cache_creation so we don't
 * double-charge. For fresh-input providers, input_tokens are already
 * fresh-only, so return them as-is.
 */
export function normalizeInputTokens(
  providerId: string,
  modelId: string,
  inputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  const semantics = detectInputTokenSemantics(providerId, modelId)
  if (semantics === 'fresh-input') {
    return Math.max(0, inputTokens)
  }
  return Math.max(
    0,
    inputTokens - cacheReadTokens - cacheCreationTokens,
  )
}

export function calculateNormalizedCost(
  inputs: PricingInputs,
): CostBreakdown {
  // calculateCost now applies the provider/model semantics internally, so
  // pass raw token counts directly to preserve cache-aware pricing.
  return calculateCost(inputs)
}
