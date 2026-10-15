/**
 * Member-hold helpers (#93129) — ported from Hermes Desktop Bot Mode.
 *
 * Only USER room messages change holds. Bot replies never flow through
 * applyGroupHoldDirective, so a bot saying "stopped working" cannot set a hold.
 */

export type GroupHoldStamp = {
  at: number
  byMessageId: string | null
  /** Activity feed already noted this hold once. */
  noted?: boolean
}

export type GroupMentionParse = {
  everyone?: boolean
  mentioned?: Iterable<string>
}

/**
 * Classify a user message's effect on member holds.
 * Conservative: any standalone stop/halt/pause next to a mention holds those
 * members — "don't stop @x" therefore also holds (wrongly-held is one mention
 * away from release; wrongly-running keeps doing work).
 */
export function classifyGroupHoldDirective(
  text: string,
  mentionedKeys: Iterable<string> | null | undefined,
  everyone: boolean,
): {
  hold: Array<string>
  holdAll: boolean
  release: Array<string>
  releaseAll: boolean
} {
  const value = String(text || '')
  const mentioned = [...(mentionedKeys || [])]
  const stop = /\b(stop|halt|pause)\b/i.test(value)
  const resume = /\b(resume|continue|go|proceed)\b/i.test(value)

  if (stop) {
    return {
      hold: mentioned,
      holdAll: Boolean(everyone),
      release: [],
      releaseAll: false,
    }
  }

  if (resume) {
    return {
      hold: [],
      holdAll: false,
      release: mentioned,
      releaseAll: Boolean(everyone),
    }
  }

  // A non-stop direct mention releases the mentioned members.
  return {
    hold: [],
    holdAll: false,
    release: mentioned,
    releaseAll: false,
  }
}

/**
 * Next holds map after one user message. Room-scoped (not thread-scoped).
 * Returns the same object when nothing changed.
 */
export function applyGroupHoldDirective(
  holds: Record<string, GroupHoldStamp> | null | undefined,
  mentions: GroupMentionParse | null | undefined,
  text: string,
  stamp: GroupHoldStamp | null | undefined,
  allMemberKeys: Array<string> = [],
): Record<string, GroupHoldStamp> {
  const prior: Record<string, GroupHoldStamp> =
    holds && typeof holds === 'object' ? holds : {}
  const action = classifyGroupHoldDirective(
    text,
    mentions?.mentioned || [],
    Boolean(mentions?.everyone),
  )

  if (action.releaseAll) {
    return Object.keys(prior).length ? {} : prior
  }

  const toHold = action.holdAll ? [...allMemberKeys] : action.hold
  let next = prior

  for (const key of toHold) {
    if (!key) continue
    if (next === prior) next = { ...prior }
    next[key] = {
      at: stamp?.at || Date.now(),
      byMessageId: stamp?.byMessageId || null,
    }
  }

  for (const key of action.release) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      if (next === prior) next = { ...prior }
      delete next[key]
    }
  }

  return next
}

/** Advance watermark past current log so a held skip never re-triggers. */
export function heldMemberWatermarkAdvance(
  seen: number | undefined,
  logLength: number,
): number | null {
  return logLength > (seen || 0) ? logLength : null
}

export function holdAllMemberKeys(
  holds: Record<string, GroupHoldStamp> | null | undefined,
  allMemberKeys: Array<string>,
  stamp: GroupHoldStamp,
): Record<string, GroupHoldStamp> {
  const next: Record<string, GroupHoldStamp> = {
    ...(holds && typeof holds === 'object' ? holds : {}),
  }
  for (const key of allMemberKeys) {
    if (key && !next[key]) {
      next[key] = { ...stamp }
    }
  }
  return next
}
