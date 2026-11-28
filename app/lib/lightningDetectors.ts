// WHICH SENSORS DETECTED A STRIKE (the hover "detector lines").
//
// Each socket strike carries two comma-separated lists in its properties:
//   detector_kode: "10150,10149,10148,10084"   (sensor ids = SerialNumber)
//   detector:      "YOGLD,SMGLD,CLPLD,SRGLD"   (the matching station codes)
// They are parallel lists, so index i of one belongs to index i of the other.
// The strike parser keeps them on the mapped strike (see LightningStrike.detectors
// in lib/lightningLive.ts); this module turns them into the [id, code] pairs the
// map needs, resolves each id to a position, and provides the animation maths
// for the line and the sensor pulses.
//
// Pure: no map, no canvas. RadarMap.vue only projects and strokes.

import type { LightningStrike } from './lightningLive'
import type { LightningSensor } from './lightningSensors'

// --- Parsing ---------------------------------------------------------------

/** One detecting sensor, as the strike's own properties name it. */
export interface DetectorRef {
  /** The sensor serial number (matches SerialNumber / the catalog id). */
  id: number
  /** The station code, or '' when the code list was short. */
  code: string
}

export const DETECTOR_CODE_PATTERN = /^[A-Z0-9]+$/

export interface ParsedDetectors {
  /** The usable pairs, in the order the feed listed them, de-duplicated by id. */
  detectors: DetectorRef[]
  /** How many entries were thrown away (shorter list, junk id, junk code). */
  dropped: number
}

/** One comma-separated field to non-blank strings. */
function splitField(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw.split(',').map(s => s.trim())
}

/**
 * Pairs the strike's two detector lists.
 *
 * A pair is kept only when BOTH halves are usable:
 *  - `detector_kode[i]` must be a finite number (it is the sensor id we look the
 *    position up by);
 *  - `detector[i]` must be an uppercase alphanumeric station code, as BMKG sends
 *    it. A blank code is accepted for a real id (the card shows the id), but a
 *    code that is not a code is not.
 * A pair missing either half is dropped and counted, because a mismatch between
 * the two lists means the feed disagrees with itself and a guessed pairing would
 * draw a line to the wrong station. Duplicate ids are collapsed, keeping the
 * first, since one sensor draws one line.
 */
export function parseDetectorList(idsRaw: unknown, codesRaw: unknown): ParsedDetectors {
  const ids = splitField(idsRaw)
  const codes = splitField(codesRaw)
  const count = Math.max(ids.length, codes.length)
  const detectors: DetectorRef[] = []
  const seen = new Set<number>()
  let dropped = 0
  for (let i = 0; i < count; i++) {
    const rawId = ids[i]
    const rawCode = codes[i]
    const id = rawId === undefined || rawId === '' ? Number.NaN : Number(rawId)
    // A pair must have BOTH halves present: an id with no code, or a code with
    // no id, is a mismatch between the lists.
    if (rawId === undefined || rawCode === undefined) { dropped++; continue }
    if (!Number.isFinite(id) || !Number.isInteger(id)) { dropped++; continue }
    const code = rawCode.trim().toUpperCase()
    if (code !== '' && !DETECTOR_CODE_PATTERN.test(code)) { dropped++; continue }
    if (seen.has(id)) { dropped++; continue }
    seen.add(id)
    detectors.push({ id, code })
  }
  return { detectors, dropped }
}

// --- Strike → the sensors to link ------------------------------------------

/** A sensor position to draw a detector line to. */
export interface DetectorTarget {
  id: number
  code: string
  lat: number
  lon: number
}

/** A socket sensor with its resolved marker position (see SensorMarker). */
export interface PositionedSensor {
  sensor: LightningSensor
  lat: number
  lon: number
}

/** A catalog entry, as the position fallback: id → coordinates. */
export interface CatalogPositionEntry {
  lat: number
  lon: number
}

/**
 * The sensors a strike's detector lines point at.
 *
 * Position, per id, in order of preference:
 *  1. the socket sensor list (`sensorMarkers`, which already prefers the
 *     catalog position for a matched id), because it is live;
 *  2. the catalog alone, when the sensor is not in the current socket frame but
 *     the catalog has an entry for it.
 * An id with no position in either is skipped: no line, rather than a line to a
 * guessed place.
 *
 * Order follows the strike's own detector list, so the drawing order is stable.
 * A strike with no detector list (every REST strike, and a socket strike whose
 * properties carried none) yields an empty list, i.e. no lines.
 */
export function detectorTargets(
  strike: Pick<LightningStrike, 'detectors'>,
  sensors: readonly PositionedSensor[],
  catalog: ReadonlyMap<number, CatalogPositionEntry> = new Map(),
): DetectorTarget[] {
  const refs = strike.detectors ?? []
  if (refs.length === 0) return []
  const byId = new Map<number, PositionedSensor>()
  for (const s of sensors) byId.set(s.sensor.id, s)
  const out: DetectorTarget[] = []
  for (const ref of refs) {
    const live = byId.get(ref.id)
    if (live) {
      out.push({ id: ref.id, code: ref.code || live.sensor.code, lat: live.lat, lon: live.lon })
      continue
    }
    const entry = catalog.get(ref.id)
    if (entry) out.push({ id: ref.id, code: ref.code, lat: entry.lat, lon: entry.lon })
  }
  return out
}

// --- Visibility rules ------------------------------------------------------

/**
 * The sensor layer follows the Lightning toggle: no separate switch, so the
 * sensors (and their rings) are on exactly while the lightning layer is on.
 */
export function sensorsVisible(layerOn: boolean): boolean {
  return layerOn
}

// --- Animation (the hovered strike's lines and sensor pulses) ---------------

/** Line colour for a detector line: the same teal the sensor rings use. */
export const DETECTOR_LINE_COLOR = '#2DD4BF'

/** Dash pattern of the line, in CSS px: [on, off]. */
export const DETECTOR_DASH: readonly [number, number] = [6, 6]

/**
 * How fast the dashes travel, in CSS px per second. DELIBERATELY SLOW: the
 * line is a readout, not an alarm, so a full dash cycle takes a couple of
 * seconds at most zooms.
 */
export const DETECTOR_DASH_SPEED_PX_PER_S = 10

/** Dash offset at a moment, so the dashes appear to march along the line. */
export function dashOffsetPx(elapsedMs: number, speed: number = DETECTOR_DASH_SPEED_PX_PER_S): number {
  const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  const period = DETECTOR_DASH[0] + DETECTOR_DASH[1]
  // Wrapped to one dash period so the number never grows without bound.
  return ((ms / 1000) * speed) % period
}

/** One pulse of a detecting sensor takes this long, then repeats. */
export const SENSOR_PULSE_CYCLE_MS = 1600

/** Phase of the pulse at a moment, in [0, 1). */
export function pulsePhase(elapsedMs: number, cycleMs: number = SENSOR_PULSE_CYCLE_MS): number {
  const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  const cycle = Number.isFinite(cycleMs) && cycleMs > 0 ? cycleMs : SENSOR_PULSE_CYCLE_MS
  return (ms % cycle) / cycle
}

/** The pulse ring at a phase: same grow-and-fade shape as the strike ping. */
export function pulseRing(phase: number): { radius: number, alpha: number } {
  const p = Number.isFinite(phase) ? Math.min(1, Math.max(0, phase)) : 0
  return {
    // Starts just outside the sensor ring (which is 3.5 px) and fades out.
    radius: 5 + 16 * p,
    alpha: 0.6 * (1 - p),
  }
}
