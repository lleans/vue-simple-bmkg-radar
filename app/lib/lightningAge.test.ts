// Tests for the strike age fade: the curve, its clamps, the time source per
// feed, and the 1 s repaint ticker.
import { describe, expect, it } from 'vitest'
import {
  LIGHTNING_REPAINT_MS,
  STRIKE_FADE_FLOOR,
  STRIKE_FADE_WINDOW_MS,
  ageOpacity,
  createRepaintTicker,
  strikeOpacity,
  strikeTimestampMs,
} from './lightningAge'
import type { LightningStrike, SocketStrike } from './lightningLive'

const NOW = Date.parse('2026-06-19T14:30:00.000Z')

/** A REST strike: no arrival_ms, a real time_utc. */
function restStrike(timeUtc: string): LightningStrike {
  return { time_utc: timeUtc, lat: -6.18, lon: 106.82, current_ka: 12.3 }
}

/** A socket strike: arrival_ms is the display time, time_utc repeats it. */
function socketStrike(arrivalMs: number): SocketStrike {
  return {
    time_utc: new Date(arrivalMs).toISOString(),
    arrival_ms: arrivalMs,
    lat: -6.18,
    lon: 106.82,
    current_ka: 12.3,
  }
}

describe('constants', () => {
  it('uses a 3 minute window and a 0.2 floor', () => {
    expect(STRIKE_FADE_WINDOW_MS).toBe(180_000)
    expect(STRIKE_FADE_FLOOR).toBe(0.2)
  })

  it('repaints once per second', () => {
    expect(LIGHTNING_REPAINT_MS).toBe(1000)
  })
})

describe('ageOpacity', () => {
  it('draws a brand-new strike at full opacity', () => {
    expect(ageOpacity(0)).toBe(1)
  })

  it('gives the midpoint halfway through the window', () => {
    // Linear from 1.0 down to 0.2, so the middle is (1 + 0.2) / 2 = 0.6.
    expect(ageOpacity(STRIKE_FADE_WINDOW_MS / 2)).toBeCloseTo(0.6, 12)
    // And a quarter of the way in is 1 - 0.8 * 0.25 = 0.8.
    expect(ageOpacity(STRIKE_FADE_WINDOW_MS / 4)).toBeCloseTo(0.8, 12)
  })

  it('holds the floor at the window and beyond', () => {
    expect(ageOpacity(STRIKE_FADE_WINDOW_MS)).toBe(STRIKE_FADE_FLOOR)
    expect(ageOpacity(STRIKE_FADE_WINDOW_MS + 1)).toBe(STRIKE_FADE_FLOOR)
    expect(ageOpacity(60 * 60_000)).toBe(STRIKE_FADE_FLOOR)
    expect(ageOpacity(Number.POSITIVE_INFINITY)).toBe(STRIKE_FADE_FLOOR)
  })

  it('treats a negative age (clock skew) as brand new', () => {
    expect(ageOpacity(-1)).toBe(1)
    expect(ageOpacity(-STRIKE_FADE_WINDOW_MS)).toBe(1)
  })

  it('treats an unusable age as brand new', () => {
    expect(ageOpacity(Number.NaN)).toBe(1)
  })

  it('never leaves the [floor, 1] range and falls monotonically', () => {
    let previous = Number.POSITIVE_INFINITY
    // 0 ms to 4 minutes in 250 ms steps, plus the exact edges.
    for (let age = 0; age <= 240_000; age += 250) {
      const opacity = ageOpacity(age)
      expect(opacity).toBeGreaterThanOrEqual(STRIKE_FADE_FLOOR)
      expect(opacity).toBeLessThanOrEqual(1)
      // Monotonic: it may only fall (or stay level at the floor), never rise.
      expect(opacity).toBeLessThanOrEqual(previous)
      previous = opacity
    }
  })
})

describe('strikeTimestampMs', () => {
  it('dates a socket strike from arrival_ms, not its time_utc', () => {
    const s = socketStrike(NOW)
    // A deliberately wrong time_utc: arrival_ms must win.
    expect(strikeTimestampMs({ ...s, time_utc: '2030-01-01T00:00:00.000Z' })).toBe(NOW)
  })

  it('dates a REST strike from time_utc', () => {
    expect(strikeTimestampMs(restStrike('2026-06-19T14:29:00.000Z'))).toBe(NOW - 60_000)
  })

  it('returns null when neither is usable', () => {
    expect(strikeTimestampMs(restStrike(''))).toBeNull()
    expect(strikeTimestampMs(restStrike('not a date'))).toBeNull()
  })
})

describe('strikeOpacity', () => {
  it('fades a socket strike by its arrival time', () => {
    expect(strikeOpacity(socketStrike(NOW), NOW)).toBe(1)
    expect(strikeOpacity(socketStrike(NOW - 90_000), NOW)).toBeCloseTo(0.6, 12)
    expect(strikeOpacity(socketStrike(NOW - 180_000), NOW)).toBe(STRIKE_FADE_FLOOR)
  })

  it('fades a REST strike by its time_utc', () => {
    // 30 s into a 3 min window is 1/6 of the way down: 1 - 0.8 / 6.
    expect(strikeOpacity(restStrike(new Date(NOW - 30_000).toISOString()), NOW)).toBeCloseTo(1 - 0.8 / 6, 12)
    expect(strikeOpacity(restStrike(new Date(NOW - 200_000).toISOString()), NOW)).toBe(STRIKE_FADE_FLOOR)
  })

  it('draws a strike with no usable time at full strength', () => {
    expect(strikeOpacity(restStrike('not a date'), NOW)).toBe(1)
  })

  it('draws a strike that is somehow in the future at full strength', () => {
    expect(strikeOpacity(restStrike(new Date(NOW + 5_000).toISOString()), NOW)).toBe(1)
  })
})

// A fake timer pair, so the schedule is proven without waiting a second.
function fakeTimers() {
  const intervals: { fn: () => void, ms: number, active: boolean }[] = []
  return {
    intervals,
    timers: {
      setInterval: (fn: () => void, ms: number) => {
        const handle = { fn, ms, active: true }
        intervals.push(handle)
        return handle
      },
      clearInterval: (handle: unknown) => {
        ;(handle as { active: boolean }).active = false
      },
    },
  }
}

describe('createRepaintTicker', () => {
  it('repaints on one 1 s interval, and not before the first tick', () => {
    const { intervals, timers } = fakeTimers()
    let repaints = 0
    const ticker = createRepaintTicker(() => { repaints++ }, timers)
    ticker.start()
    // The caller already draws on every data/toggle change; the ticker must
    // not add a draw of its own.
    expect(repaints).toBe(0)
    expect(intervals).toHaveLength(1)
    expect(intervals[0]!.ms).toBe(1000)
    expect(ticker.running()).toBe(true)
    intervals[0]!.fn()
    intervals[0]!.fn()
    expect(repaints).toBe(2)
  })

  it('ignores a second start while running', () => {
    const { intervals, timers } = fakeTimers()
    let repaints = 0
    const ticker = createRepaintTicker(() => { repaints++ }, timers)
    ticker.start()
    ticker.start()
    expect(intervals).toHaveLength(1)
    intervals[0]!.fn()
    expect(repaints).toBe(1)
  })

  it('stops on stop and clears the interval (layer off / unmount)', () => {
    const { intervals, timers } = fakeTimers()
    let repaints = 0
    const ticker = createRepaintTicker(() => { repaints++ }, timers)
    ticker.start()
    const handle = intervals[0]!
    ticker.stop()
    expect(ticker.running()).toBe(false)
    expect(handle.active).toBe(false)
    ticker.stop()
    expect(handle.active).toBe(false)
    expect(repaints).toBe(0)
  })

  it('can be restarted after stop, with exactly one timer again', () => {
    const { intervals, timers } = fakeTimers()
    let repaints = 0
    const ticker = createRepaintTicker(() => { repaints++ }, timers)
    ticker.start()
    ticker.stop()
    ticker.start()
    expect(intervals).toHaveLength(2)
    expect(intervals[1]!.active).toBe(true)
    intervals[1]!.fn()
    expect(repaints).toBe(1)
  })
})
