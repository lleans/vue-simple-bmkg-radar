import { describe, it, expect } from 'vitest'
import {
  CG_COLOR,
  IC_COLOR,
  MATCH_MAX_DELTA_MS,
  EMPTY_SOCKET_WINDOW,
  REST_REFRESH_MS,
  SOCKET_DISPLAY_WINDOW_MS,
  coord3,
  createRestPoller,
  expireSocketWindow,
  liveSocketUrl,
  mergeKey,
  mergeLightning,
  nextReconnectDelayMs,
  restErrorMessage,
  parseLiveFrame,
  shouldUseRestFallback,
  socketCurrentToKa,
  socketKey,
  strikeColor,
  strikeDisplay,
  strikesFromFeatures,
  updateSocketWindow,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  WS_CONSECUTIVE_FAILURE_LIMIT,
  type LightningFeature,
  type LightningFeatureCollection,
  type LightningStrike,
  type SocketStrike,
} from './lightningLive'

// A socket feature as the relay really sends it: Point geometry [lng, lat],
// no polarity, no strike_type, `current` in amperes, `time` in WIB. The `time`
// is deliberately in the future: the real feed dates every feature days to
// years ahead, and nothing may depend on it.
function feature(
  id: number,
  current: number,
  lng: number,
  lat: number,
  wib = '2030-06-19 14:27:21',
): LightningFeature {
  return {
    properties: {
      id,
      current,
      detector: 'YOGLD,SMGLD,CLPLD,SRGLD',
      detector_kode: '10150,10149,10148,10084',
      tanggal: wib.slice(0, 10),
      time: wib,
      menit: wib.slice(11, 16),
    },
    geometry: { type: 'Point', coordinates: [lng, lat] },
  }
}

// The 7 features of a real captured frame. Every one is dated in the FUTURE
// (14 days to 3.5 years ahead of the capture), which is exactly why the old
// 60 s future-drop rule hid the whole socket feed.
const CAPTURED_FRAME_FEATURES: LightningFeature[] = [
  { properties: { id: 169862539, current: 13674, time: '2030-06-19 14:27:21', epoch_sec: '1908109641.179' }, geometry: { type: 'Point', coordinates: [101.68727111816406, 3.1699540615081787] } },
  { properties: { id: 179668003, current: 19429, time: '2026-12-23 05:00:22', epoch_sec: '1798002022.120' }, geometry: { type: 'Point', coordinates: [103.1, 0.5] } },
  { properties: { id: 193570327, current: 15080, time: '2026-12-22 04:38:10', epoch_sec: '1797914290.880' }, geometry: { type: 'Point', coordinates: [104.2, 1.5] } },
  { properties: { id: 193597289, current: 5471, time: '2026-12-13 06:49:16', epoch_sec: '1797144556.331' }, geometry: { type: 'Point', coordinates: [105.3, 2.5] } },
  { properties: { id: 193570091, current: 21176, time: '2026-12-13 04:37:14', epoch_sec: '1797136634.131' }, geometry: { type: 'Point', coordinates: [106.4, 3.5] } },
  { properties: { id: 193538866, current: 21622, time: '2026-12-13 02:47:48', epoch_sec: '1797130068.168' }, geometry: { type: 'Point', coordinates: [107.5, 4.5] } },
  { properties: { id: 193519831, current: 17357, time: '2026-12-13 01:44:29', epoch_sec: '1797126269.527' }, geometry: { type: 'Point', coordinates: [108.6, 5.5] } },
]

function frameOf(features: LightningFeature[]): string {
  const data = JSON.stringify({ type: 'FeatureCollection', features })
  return `42["data_petir", {"data": ${JSON.stringify(data)}, "sensor": "[]", "epoch": 1795869860}]`
}

// The moment the page received a frame.
const ARRIVED = Date.parse('2026-11-28T12:44:20Z')

const REST = (over: Partial<LightningStrike> = {}): LightningStrike => ({
  time_utc: '2026-11-28T12:44:20Z',
  lat: -6.1806,
  lon: 106.8117,
  current_ka: 18.844,
  polarity: '-',
  strike_type: 'CG',
  ...over,
})

const SOCKET = (over: Partial<SocketStrike> = {}): SocketStrike => ({
  time_utc: new Date(ARRIVED).toISOString(),
  arrival_ms: ARRIVED,
  lat: -6.1806,
  lon: 106.8117,
  current_ka: 18.674,
  ...over,
})

describe('parseLiveFrame', () => {
  it('parses a data_petir frame into its FeatureCollection', () => {
    const fc = parseLiveFrame(frameOf(CAPTURED_FRAME_FEATURES))
    expect(fc).not.toBeNull()
    expect(fc!.type).toBe('FeatureCollection')
    expect(fc!.features).toHaveLength(7)
    expect(fc!.features[0]!.properties.current).toBe(13674)
  })

  it('ignores engine/Socket.IO control frames', () => {
    expect(parseLiveFrame('0{"sid":"abc123","upgrades":["websocket"],"pingInterval":25000}')).toBeNull()
    expect(parseLiveFrame('1')).toBeNull()
    expect(parseLiveFrame('2')).toBeNull()
    expect(parseLiveFrame('40{"sid":"abc123"}')).toBeNull()
    expect(parseLiveFrame('41["connect",{}]')).toBeNull()
  })

  it('ignores 42 frames that are not data_petir', () => {
    const data = JSON.stringify({ type: 'FeatureCollection', features: [] })
    expect(parseLiveFrame('42["connect", {"sid":"abc"}]')).toBeNull()
    expect(parseLiveFrame(`42["other_event", {"data": ${JSON.stringify(data)}}]`)).toBeNull()
  })

  it('returns null for malformed frames', () => {
    expect(parseLiveFrame('42not json at all')).toBeNull()
    expect(parseLiveFrame('42["data_petir", {"data": "not a json string"}]')).toBeNull()
    expect(parseLiveFrame('42["data_petir", {"data": "null"}]')).toBeNull()
    expect(parseLiveFrame('42["data_petir", {"sensor": "[]"}]')).toBeNull()
    expect(parseLiveFrame('42["data_petir", {"data": "{}"}]')).toBeNull()
    expect(parseLiveFrame(`42["data_petir", {"data": ${JSON.stringify(JSON.stringify({ type: 'FeatureCollection' }))}}]`)).toBeNull()
  })

  it('returns null for non-string input', () => {
    // @ts-expect-error — defensive: the socket can hand over non-strings.
    expect(parseLiveFrame(null)).toBeNull()
  })
})

describe('strikesFromFeatures — arrival time', () => {
  it('stamps each strike with the frame arrival time, not the feed time', () => {
    const strikes = strikesFromFeatures({ type: 'FeatureCollection', features: [
      feature(1, 13674, 106.8117, -6.1806, '2030-06-19 14:27:21'),
    ] }, ARRIVED)
    expect(strikes).toHaveLength(1)
    const s = strikes[0]!
    // The display time IS the arrival time, and the feed's 2030 date is gone.
    expect(s.arrival_ms).toBe(ARRIVED)
    expect(s.time_utc).toBe('2026-11-28T12:44:20.000Z')
    expect(s.time_utc).not.toContain('2030')
    // Amperes to kA.
    expect(s.current_ka).toBe(13.674)
    // The socket feed has neither field; we must not invent values.
    expect(s.polarity).toBeUndefined()
    expect(s.strike_type).toBeUndefined()
    expect(s.id).toBe(1)
  })

  it('ignores a rubbish or missing feed time and epoch_sec', () => {
    const [a] = strikesFromFeatures({ type: 'FeatureCollection', features: [
      { properties: { id: 7, current: 1000, time: 'nope', epoch_sec: '1908109641.179' }, geometry: { type: 'Point', coordinates: [101.68, 3.17] } },
    ] }, ARRIVED)
    expect(a!.time_utc).toBe('2026-11-28T12:44:20.000Z')
    expect(a!.arrival_ms).toBe(ARRIVED)

    const [b] = strikesFromFeatures({ type: 'FeatureCollection', features: [
      { properties: { id: 8, current: 1000 }, geometry: { type: 'Point', coordinates: [106, -6] } },
    ] }, ARRIVED)
    expect(b!.time_utc).toBe('2026-11-28T12:44:20.000Z')
  })

  it('stamps every feature of the captured future-dated frame with the arrival time', () => {
    const strikes = strikesFromFeatures(
      { type: 'FeatureCollection', features: CAPTURED_FRAME_FEATURES },
      ARRIVED,
    )
    expect(strikes).toHaveLength(7)
    for (const s of strikes) {
      expect(s.arrival_ms).toBe(ARRIVED)
      expect(s.time_utc).toBe('2026-11-28T12:44:20.000Z')
    }
  })

  it('keeps negative currents and converts them the same way', () => {
    const [s] = strikesFromFeatures({ type: 'FeatureCollection', features: [
      feature(2, -42000, 112.64, -7.82),
    ] }, ARRIVED)
    expect(s!.current_ka).toBe(-42)
  })

  it('skips features without usable coordinates', () => {
    const bad: LightningFeature = {
      properties: { id: 3, current: 5 },
      // @ts-expect-error — malformed geometry: empty coordinates array.
      geometry: { coordinates: [] },
    }
    const ok = feature(4, 5000, 106.8, -6.1)
    expect(strikesFromFeatures({ type: 'FeatureCollection', features: [bad, ok] }, ARRIVED)).toHaveLength(1)
  })

  it('returns an empty list for an empty frame', () => {
    expect(strikesFromFeatures({ type: 'FeatureCollection', features: [] }, ARRIVED)).toEqual([])
  })
})

describe('socketCurrentToKa', () => {
  it('divides amperes by 1000', () => {
    expect(socketCurrentToKa(13674)).toBe(13.674)
    expect(socketCurrentToKa(19429)).toBe(19.429)
    expect(socketCurrentToKa(5471)).toBe(5.471)
    expect(socketCurrentToKa('21176')).toBe(21.176)
  })

  it('floors unusable input to 0 kA instead of NaN', () => {
    expect(socketCurrentToKa(undefined)).toBe(0)
    expect(socketCurrentToKa(null)).toBe(0)
    expect(socketCurrentToKa('abc')).toBe(0)
    expect(socketCurrentToKa(Number.NaN)).toBe(0)
  })

  it('never yields an ampere-scale number for the observed range', () => {
    // Guards the "13674.0 kA" bug: the whole observed range must read 5–22 kA.
    for (const amps of [5471, 13674, 15080, 17357, 19429, 21622]) {
      const ka = socketCurrentToKa(amps)
      expect(ka).toBeGreaterThan(5)
      expect(ka).toBeLessThan(22)
      expect(`${ka.toFixed(1)} kA`).not.toContain('13674')
    }
  })
})

describe('updateSocketWindow — de-duplication across frames', () => {
  const FIRST = ARRIVED
  const SECOND = ARRIVED + 5_000

  function frame(ids: number[], arrivedMs: number): SocketStrike[] {
    return strikesFromFeatures(
      {
        type: 'FeatureCollection',
        features: ids.map(id => feature(
          id,
          1000 + id,
          100 + id / 10,
          id / 10,
          // Still future-dated, as the real feed is.
          '2029-03-04 05:06:07',
        )),
      },
      arrivedMs,
    )
  }

  function ids(window: { strikes: SocketStrike[] }): (string | number | undefined)[] {
    return window.strikes.map(s => s.id)
  }

  it('does not duplicate a strike that the next frame re-sends', () => {
    const w1 = updateSocketWindow(EMPTY_SOCKET_WINDOW, frame([1, 2], FIRST), FIRST)
    expect(w1.strikes).toHaveLength(2)
    const w2 = updateSocketWindow(w1, frame([1, 2], SECOND), SECOND)
    expect(w2.strikes).toHaveLength(2)
    // Same strikes, and the display time did not creep forward.
    expect(ids(w2)).toEqual([1, 2])
    expect(w2.strikes.map(s => s.arrival_ms)).toEqual([FIRST, FIRST])
    expect(w2.strikes.map(s => s.time_utc)).toEqual([
      new Date(FIRST).toISOString(),
      new Date(FIRST).toISOString(),
    ])
  })

  it('keeps a strike only while the newest frame still carries it', () => {
    const w1 = updateSocketWindow(EMPTY_SOCKET_WINDOW, frame([1, 2], FIRST), FIRST)
    // Frame 2 is the newest rolling window and no longer carries strike 1.
    const w2 = updateSocketWindow(w1, frame([2], SECOND), SECOND)
    expect(ids(w2)).toEqual([2])
  })

  it('adds a strike that only the newest frame carries', () => {
    const w1 = updateSocketWindow(EMPTY_SOCKET_WINDOW, frame([1], FIRST), FIRST)
    const w2 = updateSocketWindow(w1, frame([1, 2], SECOND), SECOND)
    expect(ids(w2)).toEqual([1, 2])
    expect(w2.strikes[0]!.arrival_ms).toBe(FIRST)
    expect(w2.strikes[1]!.arrival_ms).toBe(SECOND)
  })

  it('drops a re-sent strike once it is older than the display window', () => {
    expect(SOCKET_DISPLAY_WINDOW_MS).toBe(180_000)
    const w1 = updateSocketWindow(EMPTY_SOCKET_WINDOW, frame([1], FIRST), FIRST)
    const atLimit = FIRST + SOCKET_DISPLAY_WINDOW_MS
    const past = atLimit + 1
    expect(updateSocketWindow(w1, frame([1], atLimit), atLimit).strikes).toHaveLength(1)
    expect(updateSocketWindow(w1, frame([1], past), past).strikes).toHaveLength(0)
  })

  it('never extends a strike\'s life by re-sending it, and never re-shows it', () => {
    // Frame every 5 s, well inside the window, for 4 minutes. The strike keeps
    // its first-seen stamp, so it expires 3 minutes after arrival — and the
    // frames that still carry it must not bring it back with a new stamp.
    let window = updateSocketWindow(EMPTY_SOCKET_WINDOW, frame([1], FIRST), FIRST)
    for (let t = FIRST + 5_000; t <= FIRST + 4 * 60_000; t += 5_000) {
      window = updateSocketWindow(window, frame([1], t), t)
    }
    expect(window.strikes).toHaveLength(0)
    // The key is remembered so a still-carrying frame cannot resurrect it.
    expect(window.expired).toContain(socketKey(frame([1], FIRST)[0]!))
  })

  it('expires the window with no frame at all (the between-push timer)', () => {
    const w1 = updateSocketWindow(EMPTY_SOCKET_WINDOW, frame([1], FIRST), FIRST)
    const young = expireSocketWindow(w1, FIRST + SOCKET_DISPLAY_WINDOW_MS)
    expect(young.strikes).toHaveLength(1)
    const old = expireSocketWindow(w1, FIRST + SOCKET_DISPLAY_WINDOW_MS + 1)
    expect(old.strikes).toHaveLength(0)
    // A later frame that still carries it must not resurrect it.
    expect(updateSocketWindow(old, frame([1], FIRST + 200_000), FIRST + 200_000).strikes).toHaveLength(0)
  })

  it('collapses a strike repeated inside one frame', () => {
    const dup = frame([1], FIRST)
    const window = updateSocketWindow(EMPTY_SOCKET_WINDOW, [...dup, { ...dup[0]! }], FIRST)
    expect(window.strikes).toHaveLength(1)
  })

  it('treats same-id strikes at different places as different strikes', () => {
    const a = strikesFromFeatures({ type: 'FeatureCollection', features: [feature(1, 1000, 100, 1)] }, FIRST)
    const b = strikesFromFeatures({ type: 'FeatureCollection', features: [feature(1, 1000, 101, 2)] }, FIRST)
    expect(socketKey(a[0]!)).not.toBe(socketKey(b[0]!))
    expect(updateSocketWindow(EMPTY_SOCKET_WINDOW, b, FIRST).strikes).toHaveLength(1)
    expect(updateSocketWindow(EMPTY_SOCKET_WINDOW, [...a, ...b], FIRST).strikes).toHaveLength(2)
  })

  it('carries the whole captured 7-feature frame through a second frame unchanged', () => {
    const fc = { type: 'FeatureCollection' as const, features: CAPTURED_FRAME_FEATURES }
    const w1 = updateSocketWindow(EMPTY_SOCKET_WINDOW, strikesFromFeatures(fc, FIRST), FIRST)
    const w2 = updateSocketWindow(w1, strikesFromFeatures(fc, SECOND), SECOND)
    expect(w1.strikes).toHaveLength(7)
    expect(w2.strikes).toHaveLength(7)
    expect(w2.strikes.every(s => s.arrival_ms === FIRST)).toBe(true)
  })
})

describe('mergeLightning — no future/age drop', () => {
  it('keeps a socket strike whose feed time is years in the future', () => {
    // The old rule dropped this. The arrival stamp is "now", so it is shown.
    const socket = strikesFromFeatures(
      { type: 'FeatureCollection', features: CAPTURED_FRAME_FEATURES },
      ARRIVED,
    )
    const { strikes, stats } = mergeLightning([], socket)
    expect(strikes).toHaveLength(7)
    expect(stats.socketTotal).toBe(7)
    expect(stats.socketOnly).toBe(7)
    expect(stats.dropped).toBe(0)
    expect(stats.merged).toBe(7)
  })

  it('shows all 7 strikes of the live-like fixture, none dropped for their date', () => {
    const fc = parseLiveFrame(frameOf(CAPTURED_FRAME_FEATURES))!
    const arrived = Date.now()
    const window = updateSocketWindow(EMPTY_SOCKET_WINDOW, strikesFromFeatures(fc, arrived), arrived)
    const { strikes } = mergeLightning([], window.strikes)
    expect(strikes).toHaveLength(7)
    for (const s of strikes) {
      expect(s.time_utc).toBe(new Date(arrived).toISOString())
    }
  })

  it('keeps an old socket strike: age no longer drops anything', () => {
    const old = SOCKET({ arrival_ms: ARRIVED - 60 * 60_000 })
    expect(mergeLightning([], [old]).strikes).toHaveLength(1)
  })
})

describe('detector lists on a strike', () => {
  // A real socket feature: the two parallel detector lists are in properties.
  const DETECTOR_FEATURE: LightningFeature = {
    properties: {
      id: 193538866,
      current: 21622,
      detector: 'YOGLD,SMGLD,CLPLD,SRGLD',
      detector_kode: '10150,10149,10148,10084',
    },
    geometry: { type: 'Point', coordinates: [107.5, 4.5] },
  }

  it('keeps the detector lists from the frame on the strike', () => {
    const [s] = strikesFromFeatures({ type: 'FeatureCollection', features: [DETECTOR_FEATURE] }, ARRIVED)
    expect(s!.detectors).toEqual([
      { id: 10150, code: 'YOGLD' },
      { id: 10149, code: 'SMGLD' },
      { id: 10148, code: 'CLPLD' },
      { id: 10084, code: 'SRGLD' },
    ])
  })

  it('leaves detectors off a strike whose properties carry none', () => {
    const [s] = strikesFromFeatures({ type: 'FeatureCollection', features: [
      { properties: { id: 1, current: 1000 }, geometry: { type: 'Point', coordinates: [101, 3] } },
    ] }, ARRIVED)
    expect(s!.detectors).toBeUndefined()
  })

  it('copies the socket detector list onto the REST strike that covered it', () => {
    const rest = REST()
    const socket = SOCKET({ detectors: [{ id: 10150, code: 'YOGLD' }] })
    const { strikes, stats } = mergeLightning([rest], [socket])
    expect(stats.matched).toBe(1)
    expect(strikes).toHaveLength(1)
    // The REST version of the strike is kept, with the socket's detector list.
    expect(strikes[0]!.polarity).toBe('-')
    expect(strikes[0]!.detectors).toEqual([{ id: 10150, code: 'YOGLD' }])
    // The REST input array is not mutated by the copy.
    expect(rest.detectors).toBeUndefined()
  })

  it('does not touch a REST strike with no socket detector list', () => {
    const rest = REST()
    const { strikes } = mergeLightning([rest], [SOCKET()])
    expect(strikes[0]).toBe(rest)
    expect(strikes[0]!.detectors).toBeUndefined()
  })
})

describe('mergeLightning — REST match window', () => {
  it('matches a REST strike inside the 5 min window and not one ms outside', () => {
    expect(MATCH_MAX_DELTA_MS).toBe(5 * 60_000)
    const inside = REST({ time_utc: new Date(ARRIVED - 4 * 60_000).toISOString() })
    const atLimit = REST({ time_utc: new Date(ARRIVED - MATCH_MAX_DELTA_MS).toISOString() })
    const outside = REST({ time_utc: new Date(ARRIVED - MATCH_MAX_DELTA_MS - 1).toISOString() })
    expect(mergeLightning([inside], [SOCKET()]).stats.matched).toBe(1)
    expect(mergeLightning([atLimit], [SOCKET()]).stats.matched).toBe(1)
    expect(mergeLightning([outside], [SOCKET()]).stats.matched).toBe(0)
  })

  it('measures the window against the ARRIVAL time, not the feed time', () => {
    // The socket strike's feed time is a year off; only arrival_ms counts.
    const socket = SOCKET({ time_utc: '2027-12-13T01:44:29.000Z' })
    const rest = REST({ time_utc: new Date(ARRIVED - 60_000).toISOString() })
    const { stats, strikes } = mergeLightning([rest], [socket])
    expect(stats.matched).toBe(1)
    expect(strikes).toEqual([rest])
  })

  it('drops the socket strike when a REST strike covers it (REST version wins)', () => {
    const rest = REST({ current_ka: 18.844, polarity: '-', strike_type: 'CG' })
    const { strikes, stats } = mergeLightning([rest], [SOCKET({ current_ka: 13.674 })])
    expect(stats.matched).toBe(1)
    expect(stats.socketOnly).toBe(0)
    // Exactly one strike, and it is the REST one: kA, polarity and type.
    expect(strikes).toHaveLength(1)
    expect(strikes[0]).toEqual(rest)
    expect(strikes[0]!.current_ka).toBe(18.844)
    expect(strikes[0]!.polarity).toBe('-')
    expect(strikes[0]!.strike_type).toBe('CG')
  })

  it('matches on lat/lon rounded to 3 decimals', () => {
    const rest = REST({ lat: -6.18064, lon: 106.81174 })
    const socket = SOCKET({ lat: -6.18061, lon: 106.81171 })
    expect(mergeLightning([rest], [socket]).stats.matched).toBe(1)
    // One more decimal of separation is a different place.
    const off = SOCKET({ lat: -6.1790, lon: 106.8117 })
    expect(mergeLightning([rest], [off]).stats.matched).toBe(0)
  })

  it('keeps an unmatched socket strike with socket-only data', () => {
    const rest = REST({ lat: -14.088382, lon: 130.418826 })
    const { strikes, stats } = mergeLightning([rest], [SOCKET({ current_ka: 13.674 })])
    expect(stats.matched).toBe(0)
    expect(stats.socketOnly).toBe(1)
    expect(strikes).toHaveLength(2)
    const socket = strikes.find(s => !s.strike_type)!
    expect(socket.current_ka).toBe(13.674)
    expect(socket.polarity).toBeUndefined()
  })

  it('keeps REST-only strikes with full details', () => {
    const rest = [REST(), REST({ lat: 3.1, lon: 101.2, polarity: '+', strike_type: 'IC' })]
    const { strikes, stats } = mergeLightning(rest, [])
    expect(stats.restTotal).toBe(2)
    expect(strikes).toEqual(rest)
    expect(stats.duplicates).toBe(0)
  })
})

describe('mergeLightning — de-duplication', () => {
  it('de-duplicates REST strikes repeated in one list', () => {
    const rest = REST()
    const { strikes, stats } = mergeLightning([rest, { ...rest }], [])
    expect(strikes).toHaveLength(1)
    expect(stats.duplicates).toBe(1)
  })

  it('de-duplicates a socket strike repeated in the merged input', () => {
    const socket = SOCKET()
    const { strikes, stats } = mergeLightning([], [socket, { ...socket }])
    expect(strikes).toHaveLength(1)
    expect(stats.duplicates).toBe(1)
    expect(stats.socketOnly).toBe(1)
  })

  it('keeps two distinct socket strikes at the same place', () => {
    // Different upstream ids at the same 3-decimal position are two strikes.
    const a = SOCKET({ id: 1 })
    const b = SOCKET({ id: 2 })
    expect(mergeLightning([], [a, b]).strikes).toHaveLength(2)
  })

  it('keeps strikes that differ in place', () => {
    const a = SOCKET({ id: 1 })
    const b = SOCKET({ id: 2, lat: 9.9, lon: 99.9 })
    const { strikes } = mergeLightning([], [a, b])
    expect(strikes).toHaveLength(2)
    expect(mergeKey(SOCKET({ lat: -6.18061 }))).toBe(mergeKey(SOCKET({ lat: -6.18064 })))
    expect(coord3(-6.18064)).toBe(-6.181)
  })

  it('reports a merged total that matches the drawn list', () => {
    const { strikes, stats } = mergeLightning(
      [REST(), REST({ lat: 1.1, lon: 110.2 })],
      [
        SOCKET({ id: 1, lat: 9.9, lon: 99.9 }),
        SOCKET({ id: 2, lat: 8.8, lon: 88.8 }),
        // Matches the first REST strike.
        SOCKET({ id: 3 }),
      ],
    )
    expect(stats.matched).toBe(1)
    expect(stats.socketOnly).toBe(2)
    expect(stats.merged).toBe(strikes.length)
    expect(strikes).toHaveLength(4)
    expect(stats.dropped).toBe(0)
  })
})

describe('empty and malformed input', () => {
  it('merges an empty frame to nothing', () => {
    const fc = parseLiveFrame(frameOf([]))!
    expect(fc.features).toEqual([])
    const socket = strikesFromFeatures(fc, ARRIVED)
    expect(socket).toEqual([])
    const { strikes, stats } = mergeLightning([], socket)
    expect(strikes).toEqual([])
    expect(stats.socketTotal).toBe(0)
    expect(stats.merged).toBe(0)
  })

  it('ignores a malformed frame entirely (no crash, no strikes)', () => {
    const fc = parseLiveFrame('42["data_petir", {"data": "not json"}]')
    expect(fc).toBeNull()
    const { strikes } = mergeLightning([], [])
    expect(strikes).toEqual([])
  })

  it('does not crash on a frame whose features are junk', () => {
    // Deliberately malformed features from upstream.
    const fc = { type: 'FeatureCollection', features: [null, {}, { properties: {} }] } as unknown as LightningFeatureCollection
    expect(strikesFromFeatures(fc, ARRIVED)).toEqual([])
  })

  it('counts a socket strike with no usable time as dropped', () => {
    const { strikes, stats } = mergeLightning([], [SOCKET({ time_utc: '', arrival_ms: Number.NaN })])
    expect(strikes).toHaveLength(0)
    expect(stats.droppedInvalid).toBe(1)
    expect(stats.dropped).toBe(1)
  })
})

describe('strikeColor', () => {
  it('CG is gold, IC is pale, unknown keeps the gold', () => {
    expect(strikeColor({ strike_type: 'CG' })).toBe('#FFD700')
    expect(strikeColor({ strike_type: 'IC' })).toBe('#FFF3A3')
    expect(strikeColor({})).toBe('#FFD700')
  })

  it('exposes the same constants it returns', () => {
    expect(strikeColor({ strike_type: 'CG' })).toBe(CG_COLOR)
    expect(strikeColor({ strike_type: 'IC' })).toBe(IC_COLOR)
  })
})

describe('strikeDisplay', () => {
  const base: LightningStrike = {
    time_utc: '2026-11-28T12:21:15.000Z',
    lat: -7.25,
    lon: 112.75,
    current_ka: 13.674,
  }
  const fmt = () => '19:21:15'

  it('shows the arrival time for a socket strike', () => {
    const [s] = strikesFromFeatures({ type: 'FeatureCollection', features: [feature(1, 13674, 112.75, -7.25)] }, ARRIVED)
    // Arrival 12:44:20Z is 19:44:20 WIB; the formatter below is the real one.
    const d = strikeDisplay(s!)
    expect(d.time).toBe(new Date(ARRIVED).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    expect(d.time).not.toContain('2030')
  })

  it('socket-only strike: current only, polarity and type hidden', () => {
    const d = strikeDisplay(base, fmt)
    expect(d.detail).toBe('13.7 kA')
    expect(d.polarity).toBe('')
    expect(d.type).toBe('')
    expect(d.time).toBe('19:21:15')
  })

  it('REST strike: current, polarity and the named type', () => {
    const cg = strikeDisplay({ ...base, polarity: '+', strike_type: 'CG' }, fmt)
    expect(cg.detail).toBe('13.7 kA · + polarity')
    expect(cg.type).toBe('Cloud-to-ground')
    const ic = strikeDisplay({ ...base, polarity: '-', strike_type: 'IC' }, fmt)
    expect(ic.detail).toBe('13.7 kA · - polarity')
    expect(ic.type).toBe('In-cloud')
  })

  it('never formats an ampere-scale current as kA', () => {
    // The whole observed socket range, already converted.
    for (const amps of [5471, 13674, 17357, 19429, 21622]) {
      const d = strikeDisplay({ ...base, current_ka: socketCurrentToKa(amps) }, fmt)
      expect(d.currentText).not.toContain(String(amps))
      expect(Number(d.currentText.split(' ')[0])).toBeLessThan(22)
    }
  })

  it('always shows exactly one decimal', () => {
    expect(strikeDisplay({ ...base, current_ka: 5 }, fmt).currentText).toBe('5.0 kA')
    expect(strikeDisplay({ ...base, current_ka: -42.25 }, fmt).currentText).toBe('-42.3 kA')
    expect(strikeDisplay({ ...base, current_ka: 18.844 }, fmt).currentText).toBe('18.8 kA')
  })

  it('hides the type line for an unknown type but keeps the polarity line', () => {
    const d = strikeDisplay({ ...base, polarity: '-', strike_type: 'XX' }, fmt)
    expect(d.detail).toBe('13.7 kA · - polarity')
    expect(d.type).toBe('')
  })

  it('tolerates a missing time', () => {
    expect(strikeDisplay({ ...base, time_utc: '' }, fmt).time).toBe('—')
  })
})

describe('REST poll schedule', () => {
  // A fake timer pair, so the schedule is proven without waiting 5 minutes.
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

  it('fetches once on enable, then every 5 minutes', () => {
    expect(REST_REFRESH_MS).toBe(300_000)
    const { intervals, timers } = fakeTimers()
    let fetches = 0
    const poller = createRestPoller(() => { fetches++ }, timers)
    poller.start()
    // One immediate fetch, before any interval has fired.
    expect(fetches).toBe(1)
    expect(intervals).toHaveLength(1)
    expect(intervals[0]!.ms).toBe(300_000)
    expect(poller.running()).toBe(true)
    // Two interval ticks, two more fetches.
    intervals[0]!.fn()
    intervals[0]!.fn()
    expect(fetches).toBe(3)
  })

  it('does not fetch again after disable', () => {
    const { intervals, timers } = fakeTimers()
    let fetches = 0
    const poller = createRestPoller(() => { fetches++ }, timers)
    poller.start()
    expect(fetches).toBe(1)
    const handle = intervals[0]!
    poller.stop()
    expect(poller.running()).toBe(false)
    // The composable's stop path clears the interval, so the timer is gone.
    expect(handle.active).toBe(false)
    expect(fetches).toBe(1)
  })

  it('ignores a second start while already running', () => {
    const { intervals, timers } = fakeTimers()
    let fetches = 0
    const poller = createRestPoller(() => { fetches++ }, timers)
    poller.start()
    poller.start()
    // A toggle that is already on must not double the poll rate or the fetch.
    expect(fetches).toBe(1)
    expect(intervals).toHaveLength(1)
  })

  it('can be restarted after stop, fetching immediately again', () => {
    const { intervals, timers } = fakeTimers()
    let fetches = 0
    const poller = createRestPoller(() => { fetches++ }, timers)
    poller.start()
    poller.stop()
    poller.start()
    expect(fetches).toBe(2)
    expect(intervals).toHaveLength(2)
    expect(intervals[1]!.ms).toBe(300_000)
  })

  it('is a no-op to stop when never started', () => {
    const { intervals, timers } = fakeTimers()
    const poller = createRestPoller(() => {}, timers)
    expect(() => poller.stop()).not.toThrow()
    expect(intervals).toHaveLength(0)
  })
})

describe('nextReconnectDelayMs', () => {
  it('backs off from 1 s, doubling each consecutive failure, capped at 30 s', () => {
    expect(RECONNECT_MIN_MS).toBe(1000)
    expect(RECONNECT_MAX_MS).toBe(30_000)
    expect(nextReconnectDelayMs(0)).toBe(1000)
    expect(nextReconnectDelayMs(1)).toBe(2000)
    expect(nextReconnectDelayMs(4)).toBe(16000)
    expect(nextReconnectDelayMs(5)).toBe(30_000)
    expect(nextReconnectDelayMs(10)).toBe(30_000)
  })

  it('treats negative failure counts like the first retry', () => {
    expect(nextReconnectDelayMs(-1)).toBe(1000)
  })
})

describe('shouldUseRestFallback', () => {
  it('is true while the socket is down or not yet delivering', () => {
    expect(shouldUseRestFallback({ connected: false, hasData: false, failures: 1 })).toBe(true)
    expect(shouldUseRestFallback({ connected: true, hasData: false, failures: 0 })).toBe(true)
  })

  it('is false once the socket is connected and delivering data', () => {
    expect(shouldUseRestFallback({ connected: true, hasData: true, failures: 0 })).toBe(false)
  })

  it('is true again after too many consecutive failures', () => {
    const atLimit = { connected: true, hasData: true, failures: WS_CONSECUTIVE_FAILURE_LIMIT }
    expect(shouldUseRestFallback(atLimit)).toBe(true)
    expect(shouldUseRestFallback({ ...atLimit, failures: WS_CONSECUTIVE_FAILURE_LIMIT - 1 })).toBe(false)
  })
})

describe('liveSocketUrl', () => {
  it('switches https to wss and http to ws, appending the live path', () => {
    expect(liveSocketUrl('https://darma-proxy.lleans.dev')).toBe('wss://darma-proxy.lleans.dev/api/lightning/live')
    expect(liveSocketUrl('http://localhost:8787')).toBe('ws://localhost:8787/api/lightning/live')
  })
})

describe('restErrorMessage', () => {
  it('uses the Error message', () => {
    expect(restErrorMessage(new Error('fetch failed'))).toBe('fetch failed')
    expect(restErrorMessage(new Error('502 Bad Gateway'))).toBe('502 Bad Gateway')
  })

  it('uses a thrown string as-is', () => {
    expect(restErrorMessage('network down')).toBe('network down')
  })

  it('never reports an empty message', () => {
    expect(restErrorMessage(new Error(''))).toBe('REST lightning fetch failed')
    expect(restErrorMessage(new Error('   '))).toBe('REST lightning fetch failed')
    expect(restErrorMessage(undefined)).toBe('REST lightning fetch failed')
    expect(restErrorMessage(null)).toBe('REST lightning fetch failed')
    expect(restErrorMessage({ status: 500 })).toBe('REST lightning fetch failed')
  })
})
