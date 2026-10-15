export type JobModelPinMode = 'inherit' | 'pinned'

export type JobFormSubmitInput = {
  profile: string
  name: string
  schedule: string
  prompt: string
  deliver?: Array<string>
  skills?: Array<string>
  repeat?: number
  modelPin: JobModelPinMode
  model?: string
  provider?: string
}

function readPinnedModelFields(input: JobFormSubmitInput): {
  model: string
  provider: string
} {
  const model = input.model?.trim()
  const provider = input.provider?.trim()
  if (!model || !provider) {
    throw new Error(
      'Select both a provider and model, or use the profile default.',
    )
  }
  return { model, provider }
}

export function jobModelFieldsToCreatePayload(input: JobFormSubmitInput): {
  model?: string
  provider?: string
} {
  if (input.modelPin !== 'pinned') return {}
  return readPinnedModelFields(input)
}

export function jobModelFieldsToUpdatePayload(input: JobFormSubmitInput): {
  model: string
  provider: string
} {
  if (input.modelPin === 'pinned') return readPinnedModelFields(input)
  return { model: '', provider: '' }
}

export function readJobModelPinFromRecord(job: {
  model?: unknown
  provider?: unknown
}): {
  modelPin: JobModelPinMode
  model: string
  provider: string
} {
  const model =
    typeof job.model === 'string' && job.model.trim() ? job.model.trim() : ''
  const provider =
    typeof job.provider === 'string' && job.provider.trim()
      ? job.provider.trim()
      : ''

  if (model) {
    return { modelPin: 'pinned', model, provider }
  }

  return { modelPin: 'inherit', model: '', provider: '' }
}
