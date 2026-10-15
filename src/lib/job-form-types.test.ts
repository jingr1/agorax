import { describe, expect, it } from 'vitest'
import {
  jobModelFieldsToCreatePayload,
  jobModelFieldsToUpdatePayload,
  readJobModelPinFromRecord,
} from '../screens/jobs/job-form-types'

describe('job model form helpers', () => {
  it('reads pinned model state from cron job records', () => {
    expect(
      readJobModelPinFromRecord({
        model: 'deepseek-v4-flash',
        provider: 'deepseek',
      }),
    ).toEqual({
      modelPin: 'pinned',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
    })

    expect(readJobModelPinFromRecord({ model: null, provider: null })).toEqual({
      modelPin: 'inherit',
      model: '',
      provider: '',
    })
  })

  it('omits model fields on create when inheriting profile default', () => {
    expect(
      jobModelFieldsToCreatePayload({
        profile: 'default',
        name: 'Daily',
        schedule: '0 9 * * *',
        prompt: 'run',
        modelPin: 'inherit',
      }),
    ).toEqual({})
  })

  it('includes model fields on create when pinned', () => {
    expect(
      jobModelFieldsToCreatePayload({
        profile: 'default',
        name: 'Daily',
        schedule: '0 9 * * *',
        prompt: 'run',
        modelPin: 'pinned',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
      }),
    ).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    })
  })

  it('clears model fields on update when inheriting profile default', () => {
    expect(
      jobModelFieldsToUpdatePayload({
        profile: 'default',
        name: 'Daily',
        schedule: '0 9 * * *',
        prompt: 'run',
        modelPin: 'inherit',
      }),
    ).toEqual({
      model: '',
      provider: '',
    })
  })
})
