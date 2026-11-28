// Time selection and debounce for the vertical cut (VCUT) request.
//
// The cut used to be taken at the radar's LATEST scan time, whatever the
// seekbar was showing. It now follows the seekbar: the time is the `time_utc`
// of the frame the playhead is on, for the anchor radar of the cut. The old
// "latest, else now minus 5 minutes" time is only the fallback for when no
// frame is selected.
//
// The proxy only accepts datetimes inside the last 48 hours, so an older frame
// must not be sent at all — the caller shows the message instead of burning a
// request that can only come back 400.
//
// Both rules live here, pure and testable: pickVcutTime() for the time and
// createDebouncer() for the re-run-on-playhead-move behaviour.

import type { RadarFrame } from '../composables/useRadarApi'

// The upstream/proxy rule: nothing older than 48 hours is accepted.
export const VCUT_MAX_AGE_MS = 48 * 60 * 60_000

// A playhead move re-runs the cut only after it settles this long. The
// animation ticks every 1.5 s, so the cut follows the playhead without a
// request per intermediate frame while the user drags the seekbar.
export const VCUT_DEBOUNCE_MS = 300

export const VCUT_TOO_OLD_MESSAGE =
  'That frame is more than 48 hours old, the limit for a vertical cut. Pick a more recent frame.'

// The fallback when no frame is selected, unchanged from before.
const FALLBACK_LOOKBACK_MS = 5 * 60_000

const MINUTE_MS = 60_000

/** The UTC minute floor of an epoch ms value: the precision the API takes. */
export function truncToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS
}

/** Epoch ms for an ISO string, or null when it is missing or unparsable. */
function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

export type VcutTimeSource = 'frame' | 'fallback'

export interface VcutTimeOk {
  ok: true
  /** Already floored to the UTC minute the API accepts. */
  ms: number
  source: VcutTimeSource
}

export interface VcutTimeErr {
  ok: false
  /** Short message for the VCUT panel. */
  error: string
}

export type VcutTime = VcutTimeOk | VcutTimeErr

export interface VcutTimeInput {
  /** `time_utc` of the frame the playhead shows for the anchor radar. */
  frameTimeUtc?: string | null
  /** The radar's latest scan time (productsByStation `latest.time_utc`). */
  fallbackUtc?: string | null
  /** Now, injected so the 48 hour rule is testable. */
  nowMs: number
}

/**
 * The datetime to request the cut for.
 *
 *  1. the playhead frame's `time_utc`, when there is one;
 *  2. otherwise the radar's latest scan time, else now minus 5 minutes — the
 *     old behaviour, kept only as a fallback.
 *
 * Either way the value is floored to the minute (the API's precision), and a
 * time older than VCUT_MAX_AGE_MS is refused with a message instead of being
 * sent.
 */
export function pickVcutTime(input: VcutTimeInput): VcutTime {
  const frameMs = parseMs(input.frameTimeUtc)
  const source: VcutTimeSource = frameMs === null ? 'fallback' : 'frame'
  const rawMs = frameMs ?? parseMs(input.fallbackUtc) ?? input.nowMs - FALLBACK_LOOKBACK_MS
  // Floor first, then check the age: flooring can only make the value older,
  // so the check must see the value that would actually be sent.
  const ms = truncToMinute(rawMs)
  if (input.nowMs - ms > VCUT_MAX_AGE_MS) return { ok: false, error: VCUT_TOO_OLD_MESSAGE }
  return { ok: true, ms, source }
}

/**
 * The frame the seekbar is showing for one radar: the playhead index into the
 * frame list the timeline actually uses (the archive window in archive mode,
 * the synthesized live window in live mode, see framesRef in RadarMap).
 *
 * In archive mode the list belongs to the archive's anchor station, so a cut
 * anchored to a different radar has no frame here and falls back. A stale
 * index (the list shrank) yields null rather than a wrong frame.
 */
export function frameForVcut(
  frames: readonly RadarFrame[],
  index: number,
  sameStation: boolean,
): RadarFrame | null {
  if (!sameStation || !Number.isFinite(index) || index < 0) return null
  return frames[Math.floor(index)] ?? null
}

/** The timer functions the debouncer needs, injectable so tests can fake them. */
export interface DebounceTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

const GLOBAL_TIMERS: DebounceTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: id => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
}

export interface Debouncer {
  /** (Re)starts the delay; the action runs once, `delayMs` after the last call. */
  schedule: () => void
  /** Drops a pending run. */
  cancel: () => void
  /** True while a run is pending. */
  pending: () => boolean
}

/**
 * Trailing-edge debounce for the "playhead moved, re-run the cut" case: every
 * playhead move restarts the timer, so only the frame the playhead settles on
 * is requested. Kept pure (timers injected) so the behaviour is unit-tested
 * without waiting.
 */
export function createDebouncer(
  action: () => void,
  delayMs: number = VCUT_DEBOUNCE_MS,
  timers: DebounceTimers = GLOBAL_TIMERS,
): Debouncer {
  let id: unknown = null
  return {
    schedule() {
      if (id !== null) timers.clearTimeout(id)
      id = timers.setTimeout(() => {
        id = null
        action()
      }, delayMs)
    },
    cancel() {
      if (id === null) return
      timers.clearTimeout(id)
      id = null
    },
    pending: () => id !== null,
  }
}
