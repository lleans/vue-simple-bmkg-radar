// BMKG lightning SENSORS: parsing, drawing colour, hit testing and hover-card
// text for the sensor layer (see RadarMap.vue and useLightning.ts).
//
// The live socket frame is
//   42["data_petir", {"data": "<FeatureCollection as JSON string>",
//                     "sensor": "<array of sensors as JSON string>",
//                     "epoch": <int>}]
// so the sensor list travels NEXT TO the strikes, in the same frame, as a
// second JSON string. Only the sensors are handled here; the strike parsing
// stays in lib/lightningLive.ts, untouched.
//
// Each sensor object, as the relay forwards it (field names are BMKG's):
//   SerialNumber (int, station id, e.g. 10209)   RealName (string code, "AAILD")
//   Latitude / Longitude (STRINGS, e.g. "-3.687151")
//   Online (1 or 0)   StrikesPerMinute (int)   StrikesGoodPct (number)
//   StrikesCorrelatedPct (number)   SatellitesTracked (int)
//   CaptureLastReceived (string, "28-Nov-2026 20:23:29", already WIB)
//   LastConnected (string, same format, WIB)
// The same values the BMKG page shows in its per-station popup. They change on
// every push, so nothing here is cached between frames.
//
// Everything in this module is pure so vitest (node, no DOM, no map) covers the
// parsing, the formatting and the hit test.

import { parseLiveFramePacket, type LightningFeatureCollection } from './lightningLive'

/** One BMKG lightning sensor, as typed and cleaned up by parseLightningSensors. */
export interface LightningSensor {
  /** SerialNumber: the station id. This is what the catalog matches on. */
  id: number
  /** RealName: the short station code, e.g. "AAILD". */
  code: string
  /** Latitude converted from its string form. */
  lat: number
  /** Longitude converted from its string form. */
  lon: number
  /** `Online` === 1. */
  online: boolean
  strikesPerMinute: number
  /** StrikesGoodPct, kept raw: the display rounds it to one decimal. */
  strikesGoodPct: number
  /** StrikesCorrelatedPct, kept raw: the display rounds it to one decimal. */
  strikesCorrelatedPct: number
  satellitesTracked: number
  /** CaptureLastReceived ("Last Strikes" in the card), exactly as received, WIB. */
  captureLastReceived: string
  /** LastConnected, exactly as received, WIB. */
  lastConnected: string
}

/**
 * A finite number, or NaN when the field is missing or not numeric.
 *
 * Strict on purpose: `Number('')`, `Number(null)` and `Number(undefined)` are
 * 0 and NaN respectively, so a blank Latitude would otherwise become the valid
 * coordinate 0 and put a sensor on the equator. Only a real number or a
 * non-blank numeric STRING (which is how BMKG sends lat/lon) converts.
 */
function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return Number.NaN
    const n = Number(t)
    return Number.isFinite(n) ? n : Number.NaN
  }
  return Number.NaN
}

/** A trimmed string, or '' when the field is missing. */
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Turns the frame's `sensor` field into typed sensors.
 *
 * Accepts the JSON string the relay sends, or an already-parsed array (so the
 * caller can hand over whatever the frame carried). Anything else — a missing
 * field, a malformed JSON string, a JSON object instead of an array — yields an
 * empty list: a broken sensor list must never break the strike layer.
 *
 * Dropped, because neither can be placed or identified:
 *  - a sensor whose latitude or longitude is not a finite number (the strings
 *    are converted here, so "abc" and "" are dropped);
 *  - a sensor whose SerialNumber is not a finite number (it is the identity
 *    the catalog match and the map markers key on).
 * Duplicate ids are left alone at this level; the last one the frame carried
 * wins in the map's id lookup.
 *
 * The result is sorted by id, ascending, so the list has a stable order.
 */
export function parseLightningSensors(raw: unknown): LightningSensor[] {
  let list: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return []
    try {
      list = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []

  const out: LightningSensor[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const s = entry as Record<string, unknown>
    const id = num(s.SerialNumber)
    const lat = num(s.Latitude)
    const lon = num(s.Longitude)
    if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    out.push({
      id,
      code: str(s.RealName),
      lat,
      lon,
      online: num(s.Online) === 1,
      strikesPerMinute: num(s.StrikesPerMinute),
      strikesGoodPct: num(s.StrikesGoodPct),
      strikesCorrelatedPct: num(s.StrikesCorrelatedPct),
      satellitesTracked: num(s.SatellitesTracked),
      captureLastReceived: str(s.CaptureLastReceived),
      lastConnected: str(s.LastConnected),
    })
  }
  out.sort((a, b) => a.id - b.id)
  return out
}

/** One parsed socket frame: the strikes' FeatureCollection and the sensors. */
export interface LiveFrameWithSensors {
  features: LightningFeatureCollection
  sensors: LightningSensor[]
}

/**
 * Parses one raw socket frame into BOTH halves: the strike
 * FeatureCollection (via lib/lightningLive.ts, unchanged) and the sensor list.
 * Returns null for every frame the strike parser returns null for, and for
 * nothing else — a frame with a broken `sensor` field still yields its strikes,
 * just with an empty sensor list.
 */
export function parseLiveFrameWithSensors(raw: string): LiveFrameWithSensors | null {
  const packet = parseLiveFramePacket(raw)
  if (!packet) return null
  return { features: packet.features, sensors: parseLightningSensors(packet.sensor) }
}

// --- Marker positions (socket + optional catalog) --------------------------

/** A catalog entry as far as the map needs it: id plus its coordinates. */
export interface CatalogPosition {
  lat: number
  lon: number
}

/** A sensor plus the coordinates its marker is drawn at. */
export interface SensorMarker {
  sensor: LightningSensor
  lat: number
  lon: number
}

/**
 * Joins the socket sensors with the catalog by id (`catalog.id` is the same
 * numeric serial number as `SerialNumber`).
 *
 * The socket is the source of truth for everything the card shows: status,
 * strikes, satellites and times. The catalog only ever contributes the marker
 * POSITION, and only when it has an entry for that id — otherwise the socket's
 * own Latitude/Longitude are used. There is no /api/stations lookup here: its
 * ids are different strings (JAK, CGK, …) and belong to other features.
 */
export function sensorMarkers(
  sensors: readonly LightningSensor[],
  catalog: ReadonlyMap<number, CatalogPosition>,
): SensorMarker[] {
  return sensors.map((sensor) => {
    const entry = catalog.get(sensor.id)
    return {
      sensor,
      lat: entry ? entry.lat : sensor.lat,
      lon: entry ? entry.lon : sensor.lon,
    }
  })
}

// --- Colours ---------------------------------------------------------------

// A sensor is a RING, never a filled strike dot, so the two layers cannot be
// confused. Two accents, by online state.
export const SENSOR_ONLINE_COLOR = '#2DD4BF' // teal
export const SENSOR_OFFLINE_COLOR = '#9CA3AF' // grey

export function sensorColor(s: Pick<LightningSensor, 'online'>): string {
  return s.online ? SENSOR_ONLINE_COLOR : SENSOR_OFFLINE_COLOR
}

// --- Hit testing -----------------------------------------------------------

// Hover tolerance in CSS px around a sensor ring's centre. Slightly wider than
// the strike one (8 px): a ring is an outline, and the pointer is expected to
// land inside it as well as on it.
export const SENSOR_HIT_PX = 10

export interface ScreenPoint { x: number, y: number }

/**
 * The nearest marker within `maxPx` of a CSS-px point, or null.
 *
 * Pure: the caller passes the projection (lon/lat → screen px), so this is
 * unit-tested without a map. `project` is called once per marker. Ties keep the
 * LAST marker at the same distance, which is what the strike hit test does too.
 */
export function nearestSensor<T extends CatalogPosition>(
  point: ScreenPoint,
  markers: readonly T[],
  project: (lon: number, lat: number) => ScreenPoint,
  maxPx: number = SENSOR_HIT_PX,
): T | null {
  let best: T | null = null
  let bestD = maxPx * maxPx
  for (const m of markers) {
    const p = project(m.lon, m.lat)
    const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2
    if (d <= bestD) {
      bestD = d
      best = m
    }
  }
  return best
}

// --- Hover card ------------------------------------------------------------

export interface SensorRow {
  label: string
  value: string
}

export interface SensorDisplay {
  /** Card header: the id and the station code, e.g. "10209 AAILD". */
  title: string
  /** The card rows, in display order. */
  rows: SensorRow[]
  online: boolean
}

/**
 * A "Last Strikes" / "Last Connected" value: the timestamp as received, with
 * WIB appended. BMKG already sends WIB wall-clock strings, so they are NOT
 * converted or re-parsed — a Date round-trip would shift them by the local
 * offset. A missing value stays missing rather than printing a fake epoch.
 */
export function wibText(v: string): string {
  const t = typeof v === 'string' ? v.trim() : ''
  if (!t) return '—'
  // Some frames may already carry the suffix; do not print "WIB WIB".
  return /\bWIB$/i.test(t) ? t : `${t} WIB`
}

/** A count/percentage with one decimal, or an em dash when unusable. */
function oneDecimal(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '—'
}

/** An integer count, or an em dash when unusable. */
function integer(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n)) : '—'
}

/**
 * The sensor hover card's text, in the order it is shown:
 *
 *   [id] CODE
 *   Status                Online | Offline
 *   Strikes/Min           143
 *   Strikes % Good        100.0
 *   Strikes % Correlated  67.9
 *   Satellites            12 tracked
 *   Last Strikes          28-Nov-2026 20:17:38 WIB
 *   Last Connected        28-Nov-2026 09:16:52 WIB
 *
 * Formatted here rather than in the template so the row order, the labels and
 * the rounding are unit-tested.
 */
export function sensorDisplay(s: LightningSensor): SensorDisplay {
  return {
    title: s.code ? `${s.id} ${s.code}` : String(s.id),
    online: s.online,
    rows: [
      { label: 'Status', value: s.online ? 'Online' : 'Offline' },
      { label: 'Strikes/Min', value: integer(s.strikesPerMinute) },
      { label: 'Strikes % Good', value: oneDecimal(s.strikesGoodPct) },
      { label: 'Strikes % Correlated', value: oneDecimal(s.strikesCorrelatedPct) },
      { label: 'Satellites', value: `${integer(s.satellitesTracked)} tracked` },
      { label: 'Last Strikes', value: wibText(s.captureLastReceived) },
      { label: 'Last Connected', value: wibText(s.lastConnected) },
    ],
  }
}
