import { beforeEach, describe, expect, it } from 'vitest'
import {
  PENDING_SESSION_MODEL_KEY,
  pendingSessionModelKey,
  useSessionModelStore,
} from './session-model-store'

describe('session-model-store', () => {
  beforeEach(() => {
    useSessionModelStore.setState({ models: {} })
  })

  it('stores a pending new-chat model pick under the draft key', () => {
    useSessionModelStore
      .getState()
      .setModel(PENDING_SESSION_MODEL_KEY, 'deepseek/deepseek-v4-flash')

    expect(
      useSessionModelStore.getState().models[PENDING_SESSION_MODEL_KEY],
    ).toBe('deepseek/deepseek-v4-flash')
  })

  it('scopes pending keys per agent so picks do not leak', () => {
    expect(pendingSessionModelKey('cc-impl')).toBe('new:cc-impl')
    expect(pendingSessionModelKey('')).toBe('new')
    expect(pendingSessionModelKey(null)).toBe('new')

    useSessionModelStore
      .getState()
      .setModel(pendingSessionModelKey('cc-impl'), 'DeepSeek-V4-Flash')
    useSessionModelStore
      .getState()
      .setModel(pendingSessionModelKey('developer'), 'Kimi-K2.7-Code')

    expect(useSessionModelStore.getState().models).toEqual({
      'new:cc-impl': 'DeepSeek-V4-Flash',
      'new:developer': 'Kimi-K2.7-Code',
    })
  })

  it('transfers a pending pick onto the concrete session id', () => {
    const pending = pendingSessionModelKey('kimi-impl')
    useSessionModelStore
      .getState()
      .setModel(pending, 'moonshot-coding-plan/k3')
    useSessionModelStore.getState().transferModel(pending, 'thread-123')

    expect(useSessionModelStore.getState().models).toEqual({
      'thread-123': 'moonshot-coding-plan/k3',
    })
  })
})
