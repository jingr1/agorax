/** Lightweight onboarding completion flags — keep out of the heavy AgoraxOnboarding chunk. */

export const ONBOARDING_KEY = 'agorax-onboarding-complete'
const LEGACY_ONBOARDING_KEY = 'claude-onboarding-complete'
export const ONBOARDING_COMPLETE_EVENT = 'agorax:onboarding-complete'

export function readOnboardingComplete(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (localStorage.getItem(ONBOARDING_KEY) === 'true') return true
    if (localStorage.getItem(LEGACY_ONBOARDING_KEY) === 'true') {
      localStorage.setItem(ONBOARDING_KEY, 'true')
      localStorage.removeItem(LEGACY_ONBOARDING_KEY)
      return true
    }
  } catch {
    return false
  }
  return false
}

export function writeOnboardingComplete(completed: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (completed) {
      localStorage.setItem(ONBOARDING_KEY, 'true')
      localStorage.removeItem(LEGACY_ONBOARDING_KEY)
    } else {
      localStorage.removeItem(ONBOARDING_KEY)
      localStorage.removeItem(LEGACY_ONBOARDING_KEY)
    }
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function dispatchOnboardingCompletionChanged(completed: boolean): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(ONBOARDING_COMPLETE_EVENT, {
      detail: { completed },
    }),
  )
}
