import { describe, it, expect } from 'vitest'
import {
  MASTER_GAIN,
  SEEN_KEY_LIMIT,
  SOUND_MAX_PLAYS,
  SOUND_RATE_WINDOW_MS,
  ZAP_TOTAL_S,
  pickNewStrikes,
  soundAllowed,
  soundButtonVisible,
  takeSoundSlot,
} from './lightningSound'
import { socketKey, type LightningStrike, type SocketStrike } from './lightningLive'

const ARRIVED = Date.parse('2026-11-28T12:44:20Z')

const STRIKE = (over: Partial<SocketStrike> = {}): LightningStrike => ({
  time_utc: new Date(ARRIVED).toISOString(),
  arrival_ms: ARRIVED,
  lat: -6.1806,
  lon: 106.8117,
  current_ka: 18.674,
  id: 1,
  ...over,
})

describe('pickNewStrikes', () => {
  it('treats every strike of an empty history as new', () => {
    const { fresh } = pickNewStrikes([], [STRIKE({ id: 1 }), STRIKE({ id: 2 })])
    expect(fresh).toHaveLength(2)
  })

  it('does not report a strike it has seen before', () => {
    const first = pickNewStrikes([], [STRIKE({ id: 1 })])
    expect(first.fresh).toHaveLength(1)
    // The same strike arrives again on the next frame: not new, no sound.
    const second = pickNewStrikes(first.seenKeys, [STRIKE({ id: 1 })])
    expect(second.fresh).toHaveLength(0)
    expect(second.seenKeys).toEqual(first.seenKeys)
  })

  it('reports only the strikes that are new in a partly-seen frame', () => {
    const first = pickNewStrikes([], [STRIKE({ id: 1 }), STRIKE({ id: 2 })])
    const second = pickNewStrikes(first.seenKeys, [
      STRIKE({ id: 1 }),
      STRIKE({ id: 2 }),
      STRIKE({ id: 3, lat: 1.5, lon: 101.2 }),
    ])
    expect(second.fresh).toHaveLength(1)
    // The new one is the 3rd, not a re-sent one.
    expect(socketKey(second.fresh[0]!)).toBe(socketKey(STRIKE({ id: 3, lat: 1.5, lon: 101.2 })))
  })

  it('collapses a strike repeated inside one frame into a single play', () => {
    const dup = STRIKE({ id: 7 })
    const { fresh, seenKeys } = pickNewStrikes([], [dup, { ...dup }])
    expect(fresh).toHaveLength(1)
    expect(seenKeys).toHaveLength(1)
  })

  it('does not sound for a re-sent strike even when its arrival time changed', () => {
    // The display stamp is frozen by the socket window, but even a fresh stamp
    // must not make a strike look new: the key is id + position + kA.
    const first = pickNewStrikes([], [STRIKE({ id: 5 })])
    const later = pickNewStrikes(first.seenKeys, [STRIKE({ id: 5, arrival_ms: ARRIVED + 300_000 })])
    expect(later.fresh).toHaveLength(0)
  })

  it('sees two strikes at the same place with different ids as new', () => {
    const { fresh } = pickNewStrikes([], [STRIKE({ id: 1 }), STRIKE({ id: 2 })])
    expect(fresh).toHaveLength(2)
  })

  it('bounds the history so it cannot grow without limit', () => {
    let seen: string[] = []
    for (let i = 0; i < SEEN_KEY_LIMIT + 20; i++) {
      seen = pickNewStrikes(seen, [STRIKE({ id: i, lat: i / 100, lon: 100 + i / 100 })]).seenKeys
    }
    expect(seen).toHaveLength(SEEN_KEY_LIMIT)
  })
})

describe('takeSoundSlot — at most 3 plays per second', () => {
  it('allows exactly 3 plays inside one second and refuses the 4th', () => {
    expect(SOUND_MAX_PLAYS).toBe(3)
    expect(SOUND_RATE_WINDOW_MS).toBe(1000)
    const t0 = ARRIVED
    let plays: number[] = []
    for (let i = 0; i < 3; i++) {
      const slot = takeSoundSlot(plays, t0 + i * 100)
      expect(slot.allowed).toBe(true)
      plays = slot.plays
    }
    const fourth = takeSoundSlot(plays, t0 + 400)
    expect(fourth.allowed).toBe(false)
    // A refused play is not recorded.
    expect(fourth.plays).toEqual(plays)
  })

  it('allows again once the oldest play leaves the window', () => {
    let plays: number[] = []
    for (let i = 0; i < 3; i++) plays = takeSoundSlot(plays, ARRIVED + i * 100).plays
    expect(takeSoundSlot(plays, ARRIVED + 999).allowed).toBe(false)
    // At exactly 1000 ms the play at +0 has left the 1 s window.
    expect(takeSoundSlot(plays, ARRIVED + 1000).allowed).toBe(true)
  })

  it('stays at 3 per second over a long burst of new strikes', () => {
    // 40 new strikes spread over 3 s: at most 3 plays in any one second.
    let plays: number[] = []
    let allowed = 0
    for (let i = 0; i < 40; i++) {
      const now = ARRIVED + i * 75
      const slot = takeSoundSlot(plays, now)
      plays = slot.plays
      if (slot.allowed) allowed++
    }
    // 3 s of burst can carry at most 9-10 plays, never one per strike.
    expect(allowed).toBeLessThanOrEqual(10)
    expect(allowed).toBeGreaterThanOrEqual(8)
  })

  it('prunes old timestamps so the list does not grow', () => {
    let plays: number[] = []
    for (let i = 0; i < 50; i++) {
      plays = takeSoundSlot(plays, ARRIVED + i * 500).plays
    }
    expect(plays.length).toBeLessThanOrEqual(SOUND_MAX_PLAYS)
  })
})

describe('soundAllowed — mute rules', () => {
  it('is off until the user turns the speaker on', () => {
    expect(soundAllowed({ soundOn: false, layerOn: true, hidden: false })).toBe(false)
  })

  it('plays only with the toggle on, the layer on and the tab visible', () => {
    expect(soundAllowed({ soundOn: true, layerOn: true, hidden: false })).toBe(true)
  })

  it('is muted while the document is hidden', () => {
    expect(soundAllowed({ soundOn: true, layerOn: true, hidden: true })).toBe(false)
  })

  it('is muted when the lightning layer is off', () => {
    expect(soundAllowed({ soundOn: true, layerOn: false, hidden: false })).toBe(false)
  })
})

describe('soundButtonVisible — the speaker follows the layer', () => {
  it('hides the speaker button while the lightning layer is off', () => {
    expect(soundButtonVisible(false)).toBe(false)
  })

  it('shows it while the layer is on', () => {
    expect(soundButtonVisible(true)).toBe(true)
  })

  it('is the same rule as the mute gate\'s layer term', () => {
    // The button and the gate must agree: if the button can be used, the layer
    // is on, and the gate can then play.
    for (const layerOn of [false, true]) {
      expect(soundButtonVisible(layerOn)).toBe(layerOn)
      expect(soundAllowed({ soundOn: true, layerOn, hidden: false })).toBe(layerOn)
    }
  })
})

describe('sound constants', () => {
  it('stays short and quiet', () => {
    expect(ZAP_TOTAL_S).toBeLessThanOrEqual(1.5)
    expect(MASTER_GAIN).toBeCloseTo(0.25)
  })
})
