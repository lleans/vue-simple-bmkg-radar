import { describe, it, expect } from 'vitest'
import {
  VCUT_DEBOUNCE_MS,
  VCUT_MAX_AGE_MS,
  VCUT_TOO_OLD_MESSAGE,
  createDebouncer,
  frameForVcut,
  pickVcutTime,
  truncToMinute,
} from './vcutTime'
import type { RadarFrame } from '../composables/useRadarApi'

const NOW = Date.parse('2026-11-28T12:44:20Z')
const frame = (iso: string): RadarFrame => ({ url: '', time_utc: iso, forecast_offset_minutes: null })

describe('pickVcutTime', () => {
  it('uses the time of the frame the seekbar shows, floored to the minute', () => {
    const res = pickVcutTime({
      frameTimeUtc: '2026-11-28T12:40:37.000Z',
      fallbackUtc: '2026-11-28T12:44:00.000Z',
      nowMs: NOW,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.source).toBe('frame')
    // The frame wins over the radar's latest time, at minute precision.
    expect(new Date(res.ms).toISOString()).toBe('2026-11-28T12:40:00.000Z')
  })

  it('follows the playhead, not the newest scan', () => {
    const older = pickVcutTime({ frameTimeUtc: '2026-11-28T11:15:00.000Z', fallbackUtc: '2026-11-28T12:44:00.000Z', nowMs: NOW })
    const newer = pickVcutTime({ frameTimeUtc: '2026-11-28T12:35:00.000Z', fallbackUtc: '2026-11-28T12:44:00.000Z', nowMs: NOW })
    expect(older.ok && newer.ok).toBe(true)
    if (!older.ok || !newer.ok) return
    expect(newer.ms - older.ms).toBe(80 * 60_000)
  })

  it('falls back to the latest scan time when no frame is selected', () => {
    const res = pickVcutTime({ frameTimeUtc: null, fallbackUtc: '2026-11-28T12:40:12.000Z', nowMs: NOW })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.source).toBe('fallback')
    expect(new Date(res.ms).toISOString()).toBe('2026-11-28T12:40:00.000Z')
  })

  it('treats an unparsable frame time as no frame', () => {
    const res = pickVcutTime({ frameTimeUtc: 'not a date', fallbackUtc: '2026-11-28T12:40:00.000Z', nowMs: NOW })
    expect(res.ok && res.source).toBe('fallback')
  })

  it('falls back to now minus 5 minutes when there is neither frame nor latest', () => {
    const res = pickVcutTime({ frameTimeUtc: undefined, fallbackUtc: null, nowMs: NOW })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.source).toBe('fallback')
    expect(res.ms).toBe(truncToMinute(NOW - 5 * 60_000))
  })

  it('refuses a frame older than 48 hours and does not send it', () => {
    // A minute-aligned clock, so "exactly 48 h" survives the minute floor.
    const clock = Date.parse('2026-11-28T12:44:00Z')
    const atLimit = pickVcutTime({ frameTimeUtc: new Date(clock - VCUT_MAX_AGE_MS).toISOString(), nowMs: clock })
    expect(atLimit.ok).toBe(true)
    const older = pickVcutTime({ frameTimeUtc: new Date(clock - VCUT_MAX_AGE_MS - 60_000).toISOString(), nowMs: clock })
    expect(older.ok).toBe(false)
    if (older.ok) return
    expect(older.error).toBe(VCUT_TOO_OLD_MESSAGE)
    expect(older.error).toContain('48 hours')
  })

  it('checks the age after flooring, so a frame right on the limit is refused', () => {
    // 48 h + 30 s: flooring moves it to 48 h + 1 min, definitely too old.
    const borderline = new Date(NOW - VCUT_MAX_AGE_MS - 30_000).toISOString()
    expect(pickVcutTime({ frameTimeUtc: borderline, nowMs: NOW }).ok).toBe(false)
  })

  it('reports the error as a short, user-readable sentence', () => {
    expect(VCUT_TOO_OLD_MESSAGE.length).toBeLessThan(110)
    expect(VCUT_TOO_OLD_MESSAGE.endsWith('.')).toBe(true)
  })
})

describe('truncToMinute', () => {
  it('floors to the UTC minute', () => {
    expect(new Date(truncToMinute(Date.parse('2026-11-28T12:40:59.999Z'))).toISOString())
      .toBe('2026-11-28T12:40:00.000Z')
    expect(truncToMinute(Date.parse('2026-11-28T12:40:00.000Z'))).toBe(Date.parse('2026-11-28T12:40:00.000Z'))
  })
})

describe('frameForVcut', () => {
  const frames = [
    frame('2026-11-28T11:00:00.000Z'),
    frame('2026-11-28T11:05:00.000Z'),
    frame('2026-11-28T11:10:00.000Z'),
  ]

  it('returns the frame at the playhead', () => {
    expect(frameForVcut(frames, 1, true)?.time_utc).toBe('2026-11-28T11:05:00.000Z')
    expect(frameForVcut(frames, 2, true)?.time_utc).toBe('2026-11-28T11:10:00.000Z')
  })

  it('returns null when the frame list is not for this station', () => {
    // Archive frames belong to the archive anchor station only.
    expect(frameForVcut(frames, 1, false)).toBeNull()
  })

  it('returns null for a stale index or an empty list', () => {
    expect(frameForVcut(frames, 5, true)).toBeNull()
    expect(frameForVcut(frames, -1, true)).toBeNull()
    expect(frameForVcut([], 0, true)).toBeNull()
  })

  it('floors a fractional index', () => {
    expect(frameForVcut(frames, 1.9, true)?.time_utc).toBe('2026-11-28T11:05:00.000Z')
  })
})

describe('createDebouncer', () => {
  function fakeTimers() {
    const pending: { fn: () => void, ms: number, active: boolean }[] = []
    return {
      pending,
      timers: {
        setTimeout: (fn: () => void, ms: number) => {
          const handle = { fn, ms, active: true }
          pending.push(handle)
          return handle
        },
        clearTimeout: (handle: unknown) => {
          ;(handle as { active: boolean }).active = false
        },
      },
      /** Fires every still-active timer, as the event loop would. */
      run() {
        for (const p of [...pending]) if (p.active) { p.active = false; p.fn() }
      },
    }
  }

  it('waits about 300 ms after the last move before re-running the cut', () => {
    expect(VCUT_DEBOUNCE_MS).toBe(300)
    const { pending, timers, run } = fakeTimers()
    let runs = 0
    const d = createDebouncer(() => { runs++ }, VCUT_DEBOUNCE_MS, timers)
    d.schedule()
    expect(pending[0]!.ms).toBe(300)
    expect(runs).toBe(0)
    // A second move inside the delay must restart it, not queue a second run.
    d.schedule()
    expect(pending[1]!.ms).toBe(300)
    expect(pending[0]!.active).toBe(false)
    run()
    expect(runs).toBe(1)
    expect(d.pending()).toBe(false)
  })

  it('runs again for the next settle', () => {
    const { timers, run } = fakeTimers()
    let runs = 0
    const d = createDebouncer(() => { runs++ }, 300, timers)
    d.schedule()
    run()
    d.schedule()
    run()
    expect(runs).toBe(2)
  })

  it('drops a pending run when cancelled', () => {
    const { timers, run } = fakeTimers()
    let runs = 0
    const d = createDebouncer(() => { runs++ }, 300, timers)
    d.schedule()
    expect(d.pending()).toBe(true)
    d.cancel()
    expect(d.pending()).toBe(false)
    run()
    expect(runs).toBe(0)
    // Cancelling with nothing pending is a no-op.
    expect(() => d.cancel()).not.toThrow()
  })
})
