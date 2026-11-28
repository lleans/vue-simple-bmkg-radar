// Age fade for the lightning strikes on the map canvas (see RadarMap.vue,
// drawLightning()).
//
// Every strike used to be drawn at one fixed alpha, so a strike three minutes
// old looked exactly like one that arrived a second ago. Here the alpha is
// scaled by the strike's age instead: brand new strikes are drawn at full
// strength and the fade runs linearly down to a floor at the end of the window.
//
// Pure: no DOM, no canvas, no timers of its own (the repaint ticker takes its
// timer functions as an argument), so vitest covers every rule without Nuxt.

import { strikeTimeMs, type LightningStrike } from './lightningLive'

/**
 * How long a strike keeps fading: 3 minutes.
 *
 * Both feeds cover about the same span, so this is the point where a strike is
 * leaving the map anyway rather than a separate visual choice:
 *  - the socket feed is a rolling window of roughly 3 minutes, and
 *    SOCKET_DISPLAY_WINDOW_MS (lib/lightningLive.ts) drops a socket strike at
 *    3 minutes past its first-seen arrival time;
 *  - the REST feed carries ~3 minutes of strikes.
 * Reusing that span means the oldest strike still on screen is the one at the
 * floor, and nothing is faded out while it is still worth looking at.
 */
export const STRIKE_FADE_WINDOW_MS = 3 * 60_000

/**
 * The dimmest a strike is ever drawn: 0.2, i.e. one fifth of full strength.
 *
 * It is a floor, not 0, because the oldest strikes must stay findable — the
 * point is to make the NEW ones stand out, not to hide the old ones. 0.2 also
 * keeps a strike hoverable-looking at the end of its life: the hover card and
 * the hit test do not depend on alpha, so a strike the user can still hover
 * must not look switched off.
 */
export const STRIKE_FADE_FLOOR = 0.2

/**
 * Opacity for a strike of this age, in ms: 1.0 when brand new, falling
 * linearly to STRIKE_FADE_FLOOR at STRIKE_FADE_WINDOW_MS and staying there.
 *
 * The curve is linear because the fade is a reading aid, not an animation: a
 * straight ramp makes "how much older" readable at a glance.
 *
 * Edge cases, all clamped to [STRIKE_FADE_FLOOR, 1]:
 *  - a NEGATIVE age (the strike's clock is ahead of ours: clock skew between
 *    the feed and the browser) is treated as brand new and returns 1.0, never
 *    more than 1;
 *  - a non-finite age (NaN from an unparseable timestamp) returns 1.0, the
 *    same as "unknown age": a strike we cannot date is drawn at full strength
 *    rather than dropped to the floor;
 *  - +Infinity lands on the floor through the normal window comparison.
 */
export function ageOpacity(ageMs: number): number {
  if (Number.isNaN(ageMs)) return 1
  if (ageMs <= 0) return 1
  const t = ageMs / STRIKE_FADE_WINDOW_MS
  if (t >= 1) return STRIKE_FADE_FLOOR
  const opacity = 1 - (1 - STRIKE_FADE_FLOOR) * t
  // The branches above already keep this in range; the clamp makes the
  // contract explicit and survives a future change to the curve.
  return Math.min(1, Math.max(STRIKE_FADE_FLOOR, opacity))
}

/**
 * The instant a strike is dated from, in epoch ms, or null when it carries no
 * usable time. One rule for both feeds, and the same one mergeLightning uses:
 *  - a SOCKET strike is dated from its `arrival_ms` — the moment our page
 *    received the frame that first carried it. The socket's own `time` is
 *    weeks to years in the future (see lib/lightningLive.ts), so it is never
 *    read;
 *  - a REST strike is dated from its `time_utc`, the real strike time.
 * When neither is usable the strike cannot be aged.
 */
export function strikeTimestampMs(s: LightningStrike): number | null {
  return strikeTimeMs(s)
}

/**
 * The opacity a strike is drawn at, at `nowMs`: ageOpacity() of its age.
 *
 * A strike with NO usable time (see strikeTimestampMs) is drawn at full
 * strength (1.0): it cannot be aged, and guessing "old" would hide data the
 * feeds did give us. In practice the merge already drops such socket strikes;
 * this only covers a REST strike with an unparseable `time_utc`.
 */
export function strikeOpacity(s: LightningStrike, nowMs: number): number {
  const at = strikeTimestampMs(s)
  if (at === null) return 1
  return ageOpacity(nowMs - at)
}

// --- Repaint ticker --------------------------------------------------------
//
// The fade only moves on screen if the canvas is repainted as time passes:
// drawLightning() runs on data changes and map moves, and neither happens
// between socket frames (one every ~5 s) or during a REST-only spell (one every
// 5 min). So one slow interval repaints the lightning layer while it is on.
//
// 1000 ms and not a frame loop: the fade is a slow linear ramp over 3 minutes,
// so a 1 s step is visually continuous (0.2 / 180 ≈ 0.0011 of alpha per tick)
// and costs one canvas pass per second instead of 60. It is a repaint only —
// no fetch, no merge, no state change.
export const LIGHTNING_REPAINT_MS = 1000

/** The two timer functions the ticker needs, injectable so tests can fake them. */
export interface RepaintTimers {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
}

const GLOBAL_TIMERS: RepaintTimers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: id => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
}

export interface RepaintTicker {
  /** Starts the 1 s repaint. Idempotent: a second call adds no second timer. */
  start: () => void
  /** Stops it. Idempotent. */
  stop: () => void
  running: () => boolean
}

/**
 * The fade repaint schedule: `start()` repaints every LIGHTNING_REPAINT_MS,
 * `stop()` ends it for good (the layer is off, or the component unmounted).
 * It does NOT repaint immediately on start — the caller already draws on every
 * data/toggle change, and the first tick lands one interval later.
 *
 * Same shape as createRestPoller in lib/lightningLive.ts, and kept pure for the
 * same reason: the "exactly one timer, stopped on disable" rule is unit-tested
 * without Nuxt or a canvas.
 */
export function createRepaintTicker(
  repaint: () => void,
  timers: RepaintTimers = GLOBAL_TIMERS,
): RepaintTicker {
  let id: unknown = null
  return {
    start() {
      if (id !== null) return
      id = timers.setInterval(repaint, LIGHTNING_REPAINT_MS)
    },
    stop() {
      if (id === null) return
      timers.clearInterval(id)
      id = null
    },
    running: () => id !== null,
  }
}
