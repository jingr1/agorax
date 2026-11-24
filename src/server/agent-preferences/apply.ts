/**
 * Server-side inject for workspace agent preferences (loads md / env).
 */
import {
  formatAgentPreferencesBlock,
  hasAgentPreferences,
  prependAgentPreferences,
  stripAgentPreferences,
  AGENT_PREFERENCES_END,
  AGENT_PREFERENCES_START,
} from '../../lib/agent-preferences-text'
import { loadAgentPreferencesText } from './load'

export {
  formatAgentPreferencesBlock,
  hasAgentPreferences,
  stripAgentPreferences,
  AGENT_PREFERENCES_END,
  AGENT_PREFERENCES_START,
}

/**
 * Prepend preferences unless already present or disabled (empty load).
 */
export function applyAgentPreferences(text: string): string {
  return prependAgentPreferences(text, loadAgentPreferencesText())
}
