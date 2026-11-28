// The sound-travel PING that follows each new socket strike (see RadarMap.vue).
//
// When a NEW socket strike appears, a pale yellow ring grows out of its dot and
// fades away. The ring stands for the sound wave the thunder makes: it travels
// at 343 m/s, so its on-screen speed is derived from that speed and the map's
// current metres-per-pixel. At REAL speed the ring would barely move (a whole
// minute of sound crosses only a few hundred metres), so the distance is
// multiplied by SOUND_TIME_SCALE.
//
// Pure: no DOM, no canvas, no map. The component only projects, draws and asks
// for the radius/opacity here, so vitest covers the maths.

/** Speed of sound in air at ~20 °C. */
export const SOUND_SPEED_MPS = 343

/**
 * Speed-up for the on-screen wave: 1 real MINUTE of sound per 1 real SECOND on
 * screen. This is a PRODUCT CHOICE, not physics — at 1:1 the ring would be
 * invisible (343 m is under one pixel at any country-scale zoom), and at a much
 * larger scale it would cross the screen before the eye found the strike.
 */
export const SOUND_TIME_SCALE = 60

/** The ring stops growing here, whatever the clock says (see ringRadiusPx). */
export const MAX_RING_RADIUS_PX = 220

/** A ring is gone after this long, even if it never reached the max radius. */
export const RING_LIFETIME_MS = 4000

/** At most this many rings are alive at once; the oldest is dropped first. */
export const MAX_RINGS = 20

/** Pale yellow, in the same family as the gold strike dot. */
export const RING_COLOR = '#FFE97F'

/** Alpha at birth; it falls linearly to 0 over RING_LIFETIME_MS. */
export const RING_START_ALPHA = 0.8

// MapLibre's Web Mercator world is TILE_SIZE_PX * 2^zoom CSS px wide.
const TILE_SIZE_PX = 512
const EARTH_CIRCUMFERENCE_M = 40075016.686

/**
 * Map metres per CSS pixel at a zoom level and latitude, for MapLibre's Web
 * Mercator projection (512 px tiles). Longitude scale depends on zoom only;
 * the latitude term is the Mercator stretch away from the equator.
 */
export function metresPerPixel(zoom: number, latitude: number): number {
  const z = Number.isFinite(zoom) ? zoom : 0
  const lat = Number.isFinite(latitude) ? latitude : 0
  return Math.cos((lat * Math.PI) / 180) * EARTH_CIRCUMFERENCE_M / (TILE_SIZE_PX * 2 ** z)
}

/**
 * How far the ring has travelled after `elapsedMs`, in CSS px, INCLUDING the
 * strike dot's own radius (the ring starts at the dot, not at its centre).
 *
 * `distance_px = 343 m/s * seconds / (m per px) * SOUND_TIME_SCALE`, clamped to
 * MAX_RING_RADIUS_PX. A non-finite or non-positive metres-per-pixel (a map that
 * has not sized itself yet) returns the start radius rather than NaN.
 */
export function ringRadiusPx(
  elapsedMs: number,
  mpp: number,
  startRadiusPx: number,
  scale: number = SOUND_TIME_SCALE,
): number {
  const start = Number.isFinite(startRadiusPx) ? startRadiusPx : 0
  const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  if (!Number.isFinite(mpp) || mpp <= 0) return Math.min(start, MAX_RING_RADIUS_PX)
  const travelled = (SOUND_SPEED_MPS * (ms / 1000) / mpp) * scale
  return Math.min(start + travelled, MAX_RING_RADIUS_PX)
}

/** The ring's alpha at `elapsedMs`: 0.8 at birth, 0 at the end of its life. */
export function ringAlpha(elapsedMs: number): number {
  const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  const progress = Math.min(1, ms / RING_LIFETIME_MS)
  return RING_START_ALPHA * (1 - progress)
}

/**
 * True while the ring should still be drawn: under RING_LIFETIME_MS AND under
 * MAX_RING_RADIUS_PX, whichever ends first.
 */
export function ringAlive(elapsedMs: number, radiusPx: number): boolean {
  return elapsedMs >= 0 && elapsedMs < RING_LIFETIME_MS && radiusPx < MAX_RING_RADIUS_PX
}

/**
 * The strike dot's radius for a strike's |kA|, which is where a ring starts.
 * Same formula the strike layer draws with (2.5 px + 2.5 px scaled by |kA| up
 * to 50 kA), kept here so the ring and the dot cannot drift apart.
 */
export function strikeDotRadiusPx(currentKa: number): number {
  const ka = Math.abs(Number(currentKa) || 0)
  const k = Math.min(50, ka) / 50
  return 2.5 + 2.5 * k
}

/** One live ring: where it started, and when. */
export interface SoundRing {
  lat: number
  lon: number
  /** Radius of the dot it grew out of, in CSS px. */
  startRadiusPx: number
  /** Date.now() at the strike's first appearance. */
  startedMs: number
}

/**
 * Appends a ring, keeping at most `max` alive and dropping the OLDEST when the
 * limit is exceeded. Returns a new array; the input is not mutated.
 */
export function pushRing(
  rings: readonly SoundRing[],
  ring: SoundRing,
  max: number = MAX_RINGS,
): SoundRing[] {
  const next = [...rings, ring]
  return next.length > max ? next.slice(next.length - max) : next
}

/**
 * Drops the rings that are finished (past their lifetime, or at the max radius)
 * and returns what is left. Called from the draw loop, so a ring stops being
 * drawn the moment it ends.
 */
export function aliveRings(
  rings: readonly SoundRing[],
  nowMs: number,
  mpp: number,
): SoundRing[] {
  return rings.filter((r) => {
    const elapsed = nowMs - r.startedMs
    const radius = ringRadiusPx(elapsed, mpp, r.startRadiusPx)
    return ringAlive(elapsed, radius)
  })
}
