export const CHAT_OPEN_MESSAGE_SEARCH_EVENT = 'claude:chat-open-message-search'

export const CHAT_RUN_COMMAND_EVENT = 'claude:chat-run-command'

export const CHAT_SUBMIT_SELECTION_EVENT = 'claude:chat-submit-selection'

export const CHAT_PENDING_COMMAND_STORAGE_KEY = 'claude.pending-chat-command'

/** Prefill composer after navigating to an existing agent chat (e.g. Knowledge Ask). */
export const CHAT_PENDING_MESSAGE_STORAGE_KEY = 'hermes.pending-chat-message'

export type ChatRunCommandDetail = {
  command: string
}

export type ChatSubmitSelectionDetail = {
  text: string
}

export const CHAT_OPEN_SETTINGS_EVENT = 'claude:chat-open-settings'

export type ChatOpenSettingsDetail = {
  section: 'claude' | 'appearance'
}
