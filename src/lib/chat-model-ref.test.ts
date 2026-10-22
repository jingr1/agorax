import { describe, expect, it } from 'vitest'
import { hermesChatModelFields, parseChatModelRef } from './chat-model-ref'

describe('parseChatModelRef', () => {
  it('splits provider-prefixed Hermes picks', () => {
    expect(parseChatModelRef('tokenx/DeepSeek-V4-Flash')).toEqual({
      provider: 'tokenx',
      model: 'DeepSeek-V4-Flash',
      raw: 'tokenx/DeepSeek-V4-Flash',
    })
  })

  it('keeps bare model ids', () => {
    expect(parseChatModelRef('Kimi-K2.7-Code')).toEqual({
      model: 'Kimi-K2.7-Code',
      raw: 'Kimi-K2.7-Code',
    })
  })

  it('returns null for empty input', () => {
    expect(parseChatModelRef('')).toBeNull()
    expect(parseChatModelRef('   ')).toBeNull()
    expect(parseChatModelRef(null)).toBeNull()
  })
})

describe('hermesChatModelFields', () => {
  it('emits model + provider for prefixed keys', () => {
    expect(hermesChatModelFields('tokenx/DeepSeek-V4-Flash')).toEqual({
      model: 'DeepSeek-V4-Flash',
      provider: 'tokenx',
    })
  })

  it('omits provider for bare keys', () => {
    expect(hermesChatModelFields('DeepSeek-V4-Flash')).toEqual({
      model: 'DeepSeek-V4-Flash',
    })
  })
})
