// Tests for the sound-travel ping: metres-per-pixel, the ring radius over time,
// the max radius and lifetime cut-offs, and the 20-ring cap.
import { describe, expect, it } from 'vitest'
import {
  MAX_RING_RADIUS_PX,
  MAX_RINGS,
  RING_LIFETIME_MS,
  RING_START_ALPHA,
  SOUND_SPEED_MPS,
  SOUND_TIME_SCALE,
  aliveRings,
  metresPerPixel,
  pushRing,
  ringAlive,
  ringAlpha,
  ringRadiusPx,
  strikeDotRadiusPx,
  type SoundRing,
} from './soundPing'

describe('metresPerPixel', () => {
  it('halves with every zoom level', () => {
    const z5 = metresPerPixel(5, 0)
    const z6 = metresPerPixel(6, 0)
    expect(z6).toBeCloseTo(z5 / 2, 10)
  })

  it('matches the Web Mercator value at the equator', () => {
    // 40075016.686 m / 512 px at zoom 0.
    expect(metresPerPixel(0, 0)).toBeCloseTo(40075016.686 / 512, 3)
    // Zoom 4 at the equator, where cos(lat) = 1.
    expect(metresPerPixel(4, 0)).toBeCloseTo(40075016.686 / (512 * 16), 3)
  })

  it('shrinks towards the poles by cos(latitude)', () => {
    const equator = metresPerPixel(6, 0)
    expect(metresPerPixel(6, 60)).toBeCloseTo(equator * Math.cos(Math.PI / 3), 6)
    // A real BMKG latitude, for scale: about 1.2 km/px at zoom 6.
    expect(metresPerPixel(6, -6.18)).toBeCloseTo(1215.885, 2)
  })

  it('is finite for junk input', () => {
    expect(Number.isFinite(metresPerPixel(Number.NaN, 0))).toBe(true)
    expect(Number.isFinite(metresPerPixel(5, Number.NaN))).toBe(true)
  })
})

describe('ringRadiusPx', () => {
  const START = 4

  it('starts at the dot radius', () => {
    expect(ringRadiusPx(0, 1000, START)).toBe(START)
    expect(ringRadiusPx(-500, 1000, START)).toBe(START)
  })

  it('grows with elapsed time, metres-per-pixel and the time scale', () => {
    // 1 s of sound = 343 m. At 4 m/px that is 85.75 px, under the max radius.
    expect(ringRadiusPx(1000, 4, 0, 1)).toBeCloseTo(SOUND_SPEED_MPS / 4, 6)
    // Doubling the elapsed time doubles the travel.
    expect(ringRadiusPx(500, 4, 0, 1)).toBeCloseTo(SOUND_SPEED_MPS / 8, 6)
    // Coarser pixels mean less on-screen travel for the same distance.
    expect(ringRadiusPx(1000, 8, 0, 1)).toBeCloseTo(SOUND_SPEED_MPS / 8, 6)
    // A larger scale multiplies it, and it is clamped at the max radius.
    expect(ringRadiusPx(1000, 4, 0, 2)).toBeCloseTo(SOUND_SPEED_MPS / 2, 6)
    expect(ringRadiusPx(1000, 1, 0, SOUND_TIME_SCALE)).toBe(MAX_RING_RADIUS_PX)
  })

  it('is derived from 343 m/s and the scale, not a fixed speed', () => {
    const mpp = metresPerPixel(6, -6.18)
    const radius = ringRadiusPx(1000, mpp, 0)
    expect(radius).toBeCloseTo(SOUND_SPEED_MPS * SOUND_TIME_SCALE / mpp, 6)
  })

  it('starts from the dot radius and ends at the max radius', () => {
    expect(ringRadiusPx(1000, 4, 4, 1)).toBeCloseTo(4 + SOUND_SPEED_MPS / 4, 6)
    const huge = ringRadiusPx(RING_LIFETIME_MS, 0.001, 4, 1000)
    expect(huge).toBe(MAX_RING_RADIUS_PX)
    expect(ringRadiusPx(10_000_000, 1, 4)).toBe(MAX_RING_RADIUS_PX)
  })

  it('returns the start radius for an unusable metres-per-pixel', () => {
    expect(ringRadiusPx(1000, 0, START)).toBe(START)
    expect(ringRadiusPx(1000, Number.NaN, START)).toBe(START)
    expect(ringRadiusPx(1000, -1, START)).toBe(START)
  })
})

describe('ringAlpha / lifetime', () => {
  it('falls from 0.8 to 0 over the lifetime', () => {
    expect(RING_START_ALPHA).toBe(0.8)
    expect(ringAlpha(0)).toBeCloseTo(0.8, 10)
    expect(ringAlpha(RING_LIFETIME_MS / 2)).toBeCloseTo(0.4, 10)
    expect(ringAlpha(RING_LIFETIME_MS)).toBe(0)
    expect(ringAlpha(RING_LIFETIME_MS * 3)).toBe(0)
  })

  it('is alive under the lifetime and under the max radius', () => {
    expect(RING_LIFETIME_MS).toBe(4000)
    expect(ringAlive(0, 10)).toBe(true)
    expect(ringAlive(RING_LIFETIME_MS - 1, 10)).toBe(true)
    expect(ringAlive(RING_LIFETIME_MS, 10)).toBe(false)
    // Whichever comes first: the max radius ends it early.
    expect(ringAlive(1, MAX_RING_RADIUS_PX)).toBe(false)
  })

  it('drops finished rings and keeps live ones', () => {
    const rings: SoundRing[] = [
      { lat: 0, lon: 0, startRadiusPx: 4, startedMs: 0 },
      { lat: 1, lon: 1, startRadiusPx: 4, startedMs: 3800 },
    ]
    // 100 ms in, at 200 m/px: 343 * 0.1 / 200 * 60 = 10 px travelled.
    const alive = aliveRings(rings, 3900, 200)
    expect(alive).toHaveLength(1)
    expect(alive[0]!.lat).toBe(1)
    expect(aliveRings(rings, 8000, 1)).toHaveLength(0)
  })
})

describe('pushRing — the 20-ring cap', () => {
  const ring = (n: number): SoundRing => ({ lat: n, lon: n, startRadiusPx: 4, startedMs: n })

  it('keeps at most 20 rings and drops the oldest', () => {
    expect(MAX_RINGS).toBe(20)
    let rings: SoundRing[] = []
    for (let i = 0; i < 25; i++) rings = pushRing(rings, ring(i))
    expect(rings).toHaveLength(20)
    // The 5 oldest (0..4) are gone; the newest is last.
    expect(rings[0]!.lat).toBe(5)
    expect(rings.at(-1)!.lat).toBe(24)
  })

  it('does not mutate the input', () => {
    const rings: SoundRing[] = [ring(1)]
    const next = pushRing(rings, ring(2))
    expect(rings).toHaveLength(1)
    expect(next).toHaveLength(2)
  })
})

describe('strikeDotRadiusPx', () => {
  it('matches the strike dot it grows out of', () => {
    expect(strikeDotRadiusPx(0)).toBe(2.5)
    expect(strikeDotRadiusPx(50)).toBe(5)
    expect(strikeDotRadiusPx(500)).toBe(5)
    expect(strikeDotRadiusPx(Number.NaN)).toBe(2.5)
  })
})
