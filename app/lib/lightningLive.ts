// Pure helpers for the live lightning feeds (see useLightning.ts).
//
// Two sources are merged, and the merge lives here so vitest (node
// environment) can cover every rule without a DOM or a WebSocket:
//
//  1. REST — `${base}/api/lightning`, ~3 minutes of strikes, refreshed
//     upstream every ~3 min and cached by the proxy for 300 s. Fetched once
//     when the layer is switched on, then every 5 min (REST_REFRESH_MS), since
//     a shorter interval can only re-read that same cache. This is the
//     FULL-DETAIL source: `current_ka` in kA, `polarity`
//     ("+"/"-"), `strike_type` ("CG"/"IC") and a true UTC `time_utc`.
//  2. WebSocket — the darma-proxy relay on /api/lightning/live, pushing
//     Socket.IO frames about every 5 s. The only frame the UI cares about is
//     `data_petir`, delivered as
//     `42["data_petir", {"data": "<GeoJSON FeatureCollection as a JSON string>",
//     "sensor": "...", "epoch": <int>}]`. Each frame is a rolling window: it
//     REPLACES the previous one, it never appends. It has NO polarity and NO
//     strike_type, its `current` appears to be AMPERES, and its `time` is NOT
//     usable (in the captured frames every feature was dated between 14 days
//     and 3.5 years in the FUTURE). A socket strike is therefore displayed at
//     OUR arrival time, never at the feed's own timestamp — see the arrival
//     time section below.

import { parseDetectorList } from './lightningDetectors'

export interface LightningStrike {
  time_utc: string
  lat: number
  lon: number
  current_ka: number
  // Upstream strike id, when the feed carries one. On the socket feed it is
  // the de-duplication identity across frames.
  id?: string | number
  // Present on the REST feed, absent on the socket feed. Mapped as
  // optional; the display layer decides what to show when they are missing.
  polarity?: string
  strike_type?: string
  // Socket only: the sensors that detected this strike, as [id, code] pairs.
  // Parsed from the strike's own `detector_kode` and `detector` lists (see
  // lib/lightningDetectors.ts) and kept here so the hover can draw a line to
  // each detector. A socket strike covered by a REST strike keeps this list:
  // the REST version wins for the VALUES, but mergeLightning copies these
  // across, because REST does not carry them.
  detectors?: { id: number, code: string }[]
}

/**
 * A socket strike, stamped with the moment our page received the frame that
 * first carried it. `time_utc` is that same arrival time (ISO), because the
 * feed's own timestamp is not trustworthy.
 */
export interface SocketStrike extends LightningStrike {
  arrival_ms: number
}

export interface LightningFeature {
  properties: Record<string, unknown>
  geometry: { type?: string, coordinates: [number, number] }
}

export interface LightningFeatureCollection {
  type: 'FeatureCollection'
  features: LightningFeature[]
}

// The one event we parse off /api/lightning/live.
const LIVE_EVENT = 'data_petir'

/**
 * The raw halves of a `data_petir` frame: the strike FeatureCollection JSON
 * string (`data`) and the sensor array JSON string (`sensor`).
 *
 * This is the shared, low-level step: parseLiveFrame below keeps returning just
 * the FeatureCollection so the strike path is unchanged, while the sensor layer
 * (lib/lightningSensors.ts) reads `sensor` off the same packet without a second
 * parse of the socket text.
 */
export interface LiveFramePacket {
  /** The FeatureCollection, already shape-checked. */
  features: LightningFeatureCollection
  /** The `sensor` field exactly as received: normally a JSON string. */
  sensor: unknown
}

/**
 * Parses one raw text frame down to its two JSON halves. Returns null for every
 * frame that carries no usable strike FeatureCollection — other Socket.IO
 * events ("0{...}", "40...", ...), malformed JSON, or a `data` that is not a
 * FeatureCollection. The `sensor` field is NOT validated here: a broken sensor
 * list must not cost the frame its strikes.
 */
export function parseLiveFramePacket(raw: string): LiveFramePacket | null {
  if (typeof raw !== 'string' || raw[0] !== '4' || raw[1] !== '2') return null
  let packet: unknown
  try {
    packet = JSON.parse(raw.slice(2))
  } catch {
    return null
  }
  if (!Array.isArray(packet) || packet[0] !== LIVE_EVENT) return null
  const payload = packet[1]
  if (typeof payload !== 'object' || payload === null) return null
  const data = (payload as { data?: unknown }).data
  if (typeof data !== 'string') return null
  let fc: unknown
  try {
    fc = JSON.parse(data)
  } catch {
    return null
  }
  if (
    typeof fc !== 'object'
    || fc === null
    || (fc as { type?: unknown }).type !== 'FeatureCollection'
    || !Array.isArray((fc as { features?: unknown }).features)
  ) {
    return null
  }
  return {
    features: fc as LightningFeatureCollection,
    sensor: (payload as { sensor?: unknown }).sensor,
  }
}

/**
 * Parses one raw text frame from the live socket. Returns the parsed
 * FeatureCollection, or null for every frame we must ignore — other
 * Socket.IO events ("0{...}", "40...", ...), malformed JSON, or payloads
 * that are not a FeatureCollection.
 */
export function parseLiveFrame(raw: string): LightningFeatureCollection | null {
  // Only `42["data_petir", ...]` frames carry strike data; the sensor field is
  // read off the same packet by lib/lightningSensors.ts.
  return parseLiveFramePacket(raw)?.features ?? null
}

// --- Arrival time (the display time of a socket strike) ---------------------
//
// The socket's `properties.time` is NOT used for anything (display, ageing or
// de-duplication). It is wrong by weeks to years in the captured frames, and
// the separate `epoch_sec` is the same WIB wall clock read as if it were UTC,
// so it carries the same error. Nothing here trusts either field.
//
// Instead a socket strike is stamped with the moment OUR PAGE received the
// frame that first carried it (`arrival_ms`, from Date.now() at receipt), and
// that stamp is frozen for as long as the strike keeps appearing in later
// frames — see updateSocketWindow(). The tooltip shows that arrival time in
// local time, exactly as it showed `time_utc` before.
//
// Consequence, and it is an open question in the report: the displayed time is
// when we heard about the strike, not when lightning struck. The real age is
// unknown; the socket's rolling window plus the ~3 min REST window means the
// strike can already be minutes old on arrival.

// --- Window rules ----------------------------------------------------------

// De-duplication/display window for a socket strike: it is kept while BOTH
// hold, i.e. whichever ends first wins:
//   1. it is still present in the NEWEST frame (frames are authoritative — a
//      strike the newest rolling window no longer carries is gone), and
//   2. it is at most 3 minutes past its first-seen arrival time.
// So a frame that keeps re-sending a strike cannot pin it on the map forever,
// and a strike that drops out of the frame does not linger. There is NO drop
// for being future-dated or old any more: those rules only existed because the
// feed's own clock was used.
export const SOCKET_DISPLAY_WINDOW_MS = 3 * 60_000
// A socket strike matches a REST strike when they are at the same place
// (lat/lon rounded to 3 decimals) and the REST `time_utc` is within 5 minutes
// of the socket strike's ARRIVAL time. Widened from 60 s to 5 min because the
// socket time cannot be trusted to that precision. LIMIT: two real strikes at
// the same 3-decimal position less than 5 minutes apart collapse into one, and
// a socket strike can be credited with a REST strike it merely arrived near.
export const MATCH_MAX_DELTA_MS = 5 * 60_000

/** Rounds a coordinate to the 3 decimals the rules compare on. */
export function coord3(n: number): number {
  return Math.round(n * 1000) / 1000
}

// --- Amperes to kA ---------------------------------------------------------

// [MEDIUM confidence] The socket's `properties.current` appears to be
// AMPERES (a live frame carried 5471 … 21622, i.e. 5.5 … 21.6 kA, which is a
// normal peak current for a return stroke), while the REST feed's
// `current_ka` is already kA (18.8 … 52.3). So a socket strike with no REST
// match is divided by 1000 here. Upstream never documented the unit — this is
// an inference from the magnitude, and it is listed as an open question in
// the merge report.
export const SOCKET_CURRENT_PER_KA = 1000

/** Socket `current` (amperes) to kA. Non-numeric input yields the 0 kA floor. */
export function socketCurrentToKa(current: unknown): number {
  const amps = Number(current)
  return Number.isFinite(amps) ? amps / SOCKET_CURRENT_PER_KA : 0
}

/**
 * Maps one socket FeatureCollection to arrival-stamped strikes.
 *
 * The socket has no `polarity` and no `strike_type` — we do not invent values,
 * so those stay undefined and the display layer shows only what it has.
 * `current` is converted from amperes to kA (see SOCKET_CURRENT_PER_KA).
 *
 * `arrivedMs` is the moment the frame was received (Date.now() at the call
 * site). Every feature of the frame gets it, and it becomes both `arrival_ms`
 * and the displayed `time_utc`. The feature's own `time` / `epoch_sec` are
 * deliberately ignored: they are unreliable (see the arrival-time note above).
 * A feature without usable coordinates is skipped.
 */
export function strikesFromFeatures(
  fc: LightningFeatureCollection,
  arrivedMs: number,
): SocketStrike[] {
  const out: SocketStrike[] = []
  for (const f of fc.features) {
    const p = f?.properties ?? {}
    const coords = f?.geometry?.coordinates
    const lat = Number(p.lat ?? coords?.[1])
    const lon = Number(p.lon ?? coords?.[0])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const id = p.id
    // The detector lists are carried on the strike: the hover draws a line to
    // each detecting sensor, and nothing else in the pipeline has them.
    const detectors = parseDetectorList(p.detector_kode, p.detector).detectors
    out.push({
      ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}),
      time_utc: new Date(arrivedMs).toISOString(),
      arrival_ms: arrivedMs,
      lat,
      lon,
      current_ka: socketCurrentToKa(p.current),
      ...(detectors.length > 0 ? { detectors } : {}),
    })
  }
  return out
}

// --- Cross-frame de-duplication --------------------------------------------

/**
 * Identity of a socket strike across frames: its id when the feed carries one,
 * plus the 3-decimal position. The id alone is not enough (it is only unique
 * upstream), and the position alone would collapse two strikes at one spot, so
 * both are used. A feature with no id falls back to position + kA, which still
 * separates distinct strikes at the same coordinates.
 */
export function socketKey(s: LightningStrike): string {
  const id = s.id === undefined || s.id === null || s.id === '' ? '' : String(s.id)
  const cur = Number.isFinite(s.current_ka) ? s.current_ka : 0
  return `${id}|${coord3(s.lat)},${coord3(s.lon)}|${cur}`
}

/**
 * The socket side of the merge: the strikes on screen, plus the keys that have
 * already aged out. `expired` exists because the frames are rolling windows —
 * a strike that aged out is still carried by the next frames for a while, and
 * without remembering it, it would come back with a fresh arrival stamp and
 * live forever.
 */
export interface SocketWindow {
  strikes: SocketStrike[]
  expired: string[]
}

export const EMPTY_SOCKET_WINDOW: SocketWindow = { strikes: [], expired: [] }

/**
 * Carries the previous window forward through one new frame.
 *
 * Rule (see SOCKET_DISPLAY_WINDOW_MS), the shorter of the two always wins:
 *   1. the strike must still be in the NEWEST frame — frames are rolling
 *      windows, so being absent means the strike has scrolled out and is gone
 *      even if it is still young;
 *   2. it must be at most 3 minutes past its FIRST-SEEN arrival time.
 *
 * The first-seen arrival stamp is what survives, never the newer frame's, so a
 * strike that keeps being re-sent stops advancing its clock and expires on
 * schedule. Once it expires, its key is remembered in `expired` for as long as
 * the newest frame keeps carrying it, so it cannot be re-stamped as new and
 * shown again.
 */
export function updateSocketWindow(
  previous: SocketWindow,
  frame: readonly SocketStrike[],
  nowMs: number,
): SocketWindow {
  const expired = new Set(previous.expired)
  const firstSeen = new Map<string, number>()
  for (const s of previous.strikes) firstSeen.set(socketKey(s), s.arrival_ms)
  // Only keys this frame still carries need to be remembered; the rest have
  // scrolled out of the rolling window and cannot be resurrected any more.
  const inFrame = new Set(frame.map(socketKey))
  for (const key of [...expired]) {
    if (!inFrame.has(key)) expired.delete(key)
  }

  const out: SocketStrike[] = []
  const kept = new Set<string>()
  for (const s of frame) {
    const key = socketKey(s)
    // A key repeated inside one frame is the same strike pushed twice.
    if (kept.has(key)) continue
    kept.add(key)
    // Already aged out and still being re-sent: stay hidden.
    if (expired.has(key)) continue
    const seenAt = firstSeen.get(key)
    if (seenAt === undefined) {
      out.push(s)
      continue
    }
    if (nowMs - seenAt > SOCKET_DISPLAY_WINDOW_MS) {
      expired.add(key)
      continue
    }
    // Keep the original arrival stamp: the display time must not creep.
    out.push({ ...s, arrival_ms: seenAt, time_utc: new Date(seenAt).toISOString() })
  }
  return { strikes: out, expired: [...expired] }
}

/**
 * Ages the window out without a frame, for the timer that runs between pushes.
 * Strikes past the display window are removed and their keys remembered, so a
 * later frame that still carries them cannot bring them back.
 */
export function expireSocketWindow(previous: SocketWindow, nowMs: number): SocketWindow {
  const expired = new Set(previous.expired)
  const strikes: SocketStrike[] = []
  for (const s of previous.strikes) {
    if (nowMs - s.arrival_ms > SOCKET_DISPLAY_WINDOW_MS) expired.add(socketKey(s))
    else strikes.push(s)
  }
  return { strikes, expired: [...expired] }
}

// --- REST + socket merge ---------------------------------------------------

export interface MergeStats {
  // Socket strikes in the input (the current window).
  socketTotal: number
  // Socket strikes with unusable coordinates dropped by the merge.
  droppedInvalid: number
  dropped: number
  // Socket strikes that a REST strike covered, so the REST details win.
  matched: number
  // Socket strikes kept with socket-only data (no polarity, no type).
  socketOnly: number
  // REST strikes in the input.
  restTotal: number
  // Exact duplicates removed from the merged list.
  duplicates: number
  // Size of the merged list.
  merged: number
}

export interface MergeResult {
  strikes: LightningStrike[]
  stats: MergeStats
}

// --- REST failure text -----------------------------------------------------

/**
 * The message recorded for a failed REST fetch: the Error message when there
 * is one, the thrown string otherwise, and a fixed fallback for an empty throw
 * so a failure is never reported as an empty string.
 */
export function restErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return message.trim() || 'REST lightning fetch failed'
}

/** UTC epoch ms for a strike's `time_utc`, or null when it is unusable. */
function utcMs(s: LightningStrike): number | null {
  const t = s.time_utc ? Date.parse(s.time_utc) : Number.NaN
  return Number.isFinite(t) ? t : null
}

/**
 * Arrival/observation instant of a strike in ms: the socket strike's own
 * `arrival_ms`, or the REST `time_utc`. Null when neither is usable.
 *
 * Exported because the age fade (lib/lightningAge.ts) must date a strike from
 * exactly the same instant the merge de-duplicates it on — two rules would
 * let a strike be matched as young and drawn as old.
 */
export function strikeTimeMs(s: LightningStrike): number | null {
  const arrival = (s as Partial<SocketStrike>).arrival_ms
  if (typeof arrival === 'number' && Number.isFinite(arrival)) return arrival
  return utcMs(s)
}

/** De-duplication key for REST strikes: same lat, lon (3 decimals), same UTC time. */
export function mergeKey(s: LightningStrike): string {
  return `at:${coord3(s.lat)},${coord3(s.lon)},${s.time_utc}`
}

/** Position bucket key for the match lookup (lat/lon to 3 decimals). */
function posKey(s: LightningStrike): string {
  return `${coord3(s.lat)},${coord3(s.lon)}`
}

/**
 * The REST strike at this place whose `time_utc` is within MATCH_MAX_DELTA_MS
 * of the socket strike's arrival time, or null. A match means the socket strike
 * is covered by REST, and every REST strike is kept anyway; the match is
 * returned so the merge can copy the socket's detector list onto it.
 */
function matchingRest(candidates: readonly LightningStrike[], arrival: number): LightningStrike | null {
  for (const c of candidates) {
    const t = utcMs(c)
    if (t !== null && Math.abs(t - arrival) <= MATCH_MAX_DELTA_MS) return c
  }
  return null
}

/**
 * Merges the REST (full detail) and socket (realtime) strike lists.
 *
 * Rules, per socket strike:
 *  - its time is its ARRIVAL time (`arrival_ms`); the feed's own timestamp is
 *    not used at all, and no strike is dropped for being future-dated or old;
 *  - match it to a REST strike at the same place (lat/lon rounded to 3
 *    decimals) whose `time_utc` is within 5 min of the arrival time. A match
 *    means REST already carries polarity, type and kA, so the socket strike is
 *    not added at all and the REST version wins;
 *  - otherwise keep it with socket data only (kA from amperes / 1000, no
 *    polarity, no type).
 * REST strikes are always kept as they are, with full details.
 * The merged list is then de-duplicated by lat, lon and UTC time, with REST
 * folded in first so the REST version of any duplicate survives.
 */
export function mergeLightning(
  rest: readonly LightningStrike[],
  socket: readonly LightningStrike[],
): MergeResult {
  const stats: MergeStats = {
    socketTotal: socket.length,
    droppedInvalid: 0,
    dropped: 0,
    matched: 0,
    socketOnly: 0,
    restTotal: rest.length,
    duplicates: 0,
    merged: 0,
  }

  const out: LightningStrike[] = []
  const seen = new Set<string>()
  // REST first, so its version of any duplicate is the one kept.
  for (const s of rest) {
    const key = mergeKey(s)
    if (seen.has(key)) { stats.duplicates++; continue }
    seen.add(key)
    out.push(s)
  }
  // Index the REST strikes by position so a frame of N socket strikes does
  // not scan the whole REST list.
  const byPos = new Map<string, LightningStrike[]>()
  for (const s of rest) {
    const k = posKey(s)
    const bucket = byPos.get(k)
    if (bucket) bucket.push(s)
    else byPos.set(k, [s])
  }
  // Detector lists to graft onto the REST strikes that covered a socket strike:
  // REST carries none, and the hover needs the socket's.
  const graftDetectors = new Map<LightningStrike, { id: number, code: string }[]>()

  for (const s of socket) {
    const arrival = strikeTimeMs(s)
    if (arrival === null) { stats.droppedInvalid++; continue }
    // Socket strikes are de-duplicated on their own key (id + position + kA),
    // NOT on the place+time key REST uses: two distinct strikes can arrive in
    // the same frame at the same 3-decimal position, and both must be drawn.
    // A REST strike covering a socket strike is handled by matchingRest below,
    // where REST wins.
    const key = `sock:${socketKey(s)}`
    if (seen.has(key)) { stats.duplicates++; continue }
    const match = matchingRest(byPos.get(posKey(s)) ?? [], arrival)
    if (match) {
      stats.matched++
      // The REST version of the strike is the one on screen, but REST carries
      // no detector lists: remember the socket's so a matched strike still
      // draws its detector lines ("strikes matched to REST keep the socket
      // detector list"). Filled in below, without mutating the REST input.
      if (s.detectors?.length && !match.detectors?.length && !graftDetectors.has(match)) {
        graftDetectors.set(match, s.detectors)
      }
      continue
    }
    seen.add(key)
    out.push(s)
    stats.socketOnly++
  }

  // Replace (never mutate) each matched REST strike so it carries the socket's
  // detector list. A new object keeps the REST input array untouched, which
  // matters because it is reused across merges.
  if (graftDetectors.size > 0) {
    for (let i = 0; i < out.length; i++) {
      const strike = out[i]!
      const detectors = graftDetectors.get(strike)
      if (detectors) out[i] = { ...strike, detectors }
    }
  }

  stats.dropped = stats.droppedInvalid
  stats.merged = out.length
  return { strikes: out, stats }
}

// --- Colour (old design) ---------------------------------------------------

// The old layer coloured CG strikes gold and IC strikes a paler tone. A strike
// whose type is unknown (every socket-only strike) keeps the gold, which is
// also what the old code drew because it only checked for 'CG'.
export const CG_COLOR = '#FFD700'
export const IC_COLOR = '#FFF3A3'

export function strikeColor(s: Pick<LightningStrike, 'strike_type'>): string {
  return s.strike_type === 'IC' ? IC_COLOR : CG_COLOR
}

// --- Hover card ------------------------------------------------------------

/**
 * Display strings for a strike's hover card, in the old design's format:
 *
 *   ⚡ Lightning strike
 *   <time>
 *   12.3 kA · + polarity        (or just "12.3 kA" when polarity is unknown)
 *   Cloud-to-ground             (omitted when the type is unknown)
 *
 * kA is always shown with one decimal. Nothing is invented: a socket-only
 * strike has neither polarity nor type, so those lines are hidden rather than
 * filled with a placeholder, and the ampere-to-kA conversion happened in the
 * mapping layer, so this never prints an ampere-scale number.
 */
export interface StrikeDisplay {
  time: string
  currentText: string
  detail: string
  // '' when the feed did not say; the template hides those lines.
  polarity: string
  type: string
}

export function strikeDisplay(
  s: LightningStrike,
  formatTime: (iso: string) => string = iso => new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }),
): StrikeDisplay {
  const polarity = s.polarity?.trim() || ''
  const type = s.strike_type === 'CG'
    ? 'Cloud-to-ground'
    : s.strike_type === 'IC'
      ? 'In-cloud'
      : ''
  const current = Number(s.current_ka)
  const currentText = Number.isFinite(current) ? `${current.toFixed(1)} kA` : '—'
  return {
    time: s.time_utc ? formatTime(s.time_utc) : '—',
    currentText,
    detail: polarity ? `${currentText} · ${polarity} polarity` : currentText,
    polarity,
    type,
  }
}

// --- REST poll schedule ----------------------------------------------------
//
// 300 s, and not 90 s: the proxy caches /api/lightning for 300 seconds, so a
// shorter interval can only ever return the same payload. One fetch happens
// immediately when the layer is switched on (so the map is not empty while the
// first socket frame is in flight), then every REST_REFRESH_MS for as long as
// it stays on. The same timer serves the "socket is down" fallback: there is no
// separate faster poller, the socket outage just keeps using this schedule.
export const REST_REFRESH_MS = 5 * 60_000

/** The two timer functions the poller needs, injectable so tests can fake them. */
export interface RestPollTimers {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
}

const GLOBAL_TIMERS: RestPollTimers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: id => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
}

export interface RestPoller {
  /** Fetches once immediately, then every REST_REFRESH_MS. Idempotent. */
  start: () => void
  /** Stops the schedule; no further fetch happens. Idempotent. */
  stop: () => void
  running: () => boolean
}

/**
 * The REST poll schedule, kept pure so vitest can prove it without Nuxt:
 * `start()` fetches ONCE right away and then every REST_REFRESH_MS, `stop()`
 * ends the schedule for good. A second `start()` while running is a no-op, so a
 * toggle that is already on cannot queue up a second fetch or a second timer.
 */
export function createRestPoller(
  fetchOnce: () => void,
  timers: RestPollTimers = GLOBAL_TIMERS,
): RestPoller {
  let id: unknown = null
  return {
    start() {
      if (id !== null) return
      fetchOnce()
      id = timers.setInterval(fetchOnce, REST_REFRESH_MS)
    },
    stop() {
      if (id === null) return
      timers.clearInterval(id)
      id = null
    },
    running: () => id !== null,
  }
}

// --- Socket client plumbing ------------------------------------------------

// Reconnect backoff: 1 s, 2 s, 4 s, ... capped at 30 s. `failures` is the
// number of consecutive failures already counted, so the first retry waits
// 1 s and the sixth and later wait the 30 s cap.
export const RECONNECT_MIN_MS = 1000
export const RECONNECT_MAX_MS = 30_000

export function nextReconnectDelayMs(failures: number): number {
  return Math.min(RECONNECT_MIN_MS * 2 ** Math.max(0, failures), RECONNECT_MAX_MS)
}

// After this many consecutive failures the socket is considered failed too
// many times in a row and the REST feed is the source of truth for sure.
export const WS_CONSECUTIVE_FAILURE_LIMIT = 3

export interface LiveSocketState {
  // The socket is open right now.
  connected: boolean
  // At least one data_petir frame has arrived on THIS connection.
  hasData: boolean
  // Consecutive failures (resets to 0 on a successful message).
  failures: number
}

/**
 * True while the socket is unavailable (down, or up but not delivering data
 * yet) or has failed too many times in a row. The REST poll runs on its own
 * 5 minute cadence regardless — it is the full-detail source, not just a
 * fallback — so this only decides when the composable refreshes REST
 * *immediately*, i.e. right after the socket drops.
 */
export function shouldUseRestFallback(state: LiveSocketState): boolean {
  return !state.connected || !state.hasData || state.failures >= WS_CONSECUTIVE_FAILURE_LIMIT
}

/**
 * The live socket URL for a proxy base URL: https→wss, http→ws, plus the
 * /api/lightning/live path.
 */
export function liveSocketUrl(httpBase: string): string {
  return `${httpBase.replace(/^http/i, 'ws')}/api/lightning/live`
}
