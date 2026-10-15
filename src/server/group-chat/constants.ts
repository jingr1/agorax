/**
 * Group chat constants — translated from upstream Bot Mode plugin.
 *
 * These values shape the round-robin conversation control flow and are kept
 * as constants (not config) so the runner stays deterministic and easy to
 * reason about. Tune later via environment variables if needed.
 */

/** Max full round-robin rounds per user-triggered drive. */
export const GROUP_CHAT_MAX_ROUNDS = 3

/** Hard cap on messages posted by bots during one drive. */
export const GROUP_CHAT_MAX_MESSAGES = 10

/** Extra bounded rounds triggered by unaddressed @mentions after a quiet round. */
export const GROUP_CHAT_MAX_CONTINUATIONS = 2

/** Number of recent delta lines included in each member's turn prompt. */
export const GROUP_CHAT_HISTORY_LIMIT = 24

/** Max members allowed in a single room. */
export const GROUP_CHAT_MAX_MEMBERS = 6

/** Base timeout for a member turn before it is considered stranded. */
export const GROUP_TURN_TIMEOUT_MS = 180_000

/** Hard cap: a still-running turn keeps its slot alive up to this long. */
export const GROUP_TURN_HARD_CAP_MS = 20 * 60_000

/** Poll interval while waiting for a member turn to complete. */
export const GROUP_TURN_POLL_MS = 2_000

/** Window for duplicate append detection. */
export const GROUP_DUPLICATE_APPEND_WINDOW_MS = 10 * 60_000

/** Threshold of messages before a rolling LLM summary is generated. */
export const GROUP_SUMMARY_THRESHOLD = 8

/**
 * Max messages included in a single summary LLM call. Larger backlogs are
 * summarized oldest-first across ticks so one prompt cannot blow the gateway.
 */
export const GROUP_SUMMARY_WINDOW_MAX = 40

/** Max age of a pending human turn before it expires (30 minutes). */
export const PENDING_TURN_EXPIRY_MS = 30 * 60_000

/** Tick interval for the room runner. */
export const GROUP_RUNNER_TICK_MS = 5_000

/**
 * After a transient gateway/session verify failure, skip re-driving the room
 * for this long. Prevents tight retry storms when a profile port is down.
 */
export const GROUP_RUNNER_ERROR_COOLDOWN_MS = 30_000

/** Max pending turns processed per tick. */
export const GROUP_MAX_PENDING_PER_TICK = 10

/** Background stranded-harvest poll interval (Bot Mode: 5s). */
export const GROUP_HARVEST_INTERVAL_MS = 5_000

/** Max background harvest attempts after a drive settles (~5 min). */
export const GROUP_HARVEST_MAX_TRIES = 60
