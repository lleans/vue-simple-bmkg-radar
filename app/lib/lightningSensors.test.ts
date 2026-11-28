// Tests for the sensor parser, marker joining, hit test and hover-card text.
//
// Pure node tests: no Nuxt, no DOM, no map. The projection the hit test needs
// is faked with a plain lon/lat → px function.
import { describe, expect, it } from 'vitest'
import {
  SENSOR_HIT_PX,
  SENSOR_OFFLINE_COLOR,
  SENSOR_ONLINE_COLOR,
  nearestSensor,
  parseLightningSensors,
  parseLiveFrameWithSensors,
  sensorColor,
  sensorDisplay,
  sensorMarkers,
  wibText,
  type LightningSensor,
  type SensorMarker,
} from './lightningSensors'

// One sensor as the relay really sends it: id/status numbers, coordinates as
// STRINGS, times as WIB strings. Values from the BMKG page popup for AAILD.
const RAW_SENSOR = {
  SerialNumber: 10209,
  RealName: 'AAILD',
  Latitude: '-3.687151',
  Longitude: '128.181503',
  Online: 1,
  StrikesPerMinute: 143,
  StrikesGoodPct: 100,
  StrikesCorrelatedPct: 67.851321,
  SatellitesTracked: 12,
  CaptureLastReceived: '28-Nov-2026 20:17:38',
  LastConnected: '28-Nov-2026 09:16:52',
}

const SENSOR = (over: Partial<LightningSensor> = {}): LightningSensor => ({
  id: 10209,
  code: 'AAILD',
  lat: -3.687151,
  lon: 128.181503,
  online: true,
  strikesPerMinute: 143,
  strikesGoodPct: 100,
  strikesCorrelatedPct: 67.851321,
  satellitesTracked: 12,
  captureLastReceived: '28-Nov-2026 20:17:38',
  lastConnected: '28-Nov-2026 09:16:52',
  ...over,
})

describe('parseLightningSensors', () => {
  it('parses a valid sensor from the JSON string the frame carries', () => {
    const [s] = parseLightningSensors(JSON.stringify([RAW_SENSOR]))
    expect(s).toEqual({
      id: 10209,
      code: 'AAILD',
      lat: -3.687151,
      lon: 128.181503,
      online: true,
      strikesPerMinute: 143,
      strikesGoodPct: 100,
      strikesCorrelatedPct: 67.851321,
      satellitesTracked: 12,
      captureLastReceived: '28-Nov-2026 20:17:38',
      lastConnected: '28-Nov-2026 09:16:52',
    })
  })

  it('converts the Latitude and Longitude strings to numbers', () => {
    const [s] = parseLightningSensors([{
      ...RAW_SENSOR,
      Latitude: '-6.171296',
      Longitude: '106.05143',
    }])
    expect(typeof s!.lat).toBe('number')
    expect(typeof s!.lon).toBe('number')
    expect(s!.lat).toBe(-6.171296)
    expect(s!.lon).toBe(106.05143)
    // A positive string works the same way (no sign-dropping).
    const [north] = parseLightningSensors([{ ...RAW_SENSOR, Latitude: '3.169954', Longitude: '101.687271' }])
    expect(north!.lat).toBe(3.169954)
    expect(north!.lon).toBe(101.687271)
  })

  it('drops a sensor whose coordinate is not a finite number', () => {
    const list = parseLightningSensors([
      { ...RAW_SENSOR, SerialNumber: 1, Latitude: 'north' },
      { ...RAW_SENSOR, SerialNumber: 2, Longitude: '' },
      { ...RAW_SENSOR, SerialNumber: 3, Latitude: null },
      { ...RAW_SENSOR, SerialNumber: 4, Longitude: 'Infinity' },
      { ...RAW_SENSOR, SerialNumber: 5, RealName: 'KEPT1' },
    ])
    expect(list.map(s => s.id)).toEqual([5])
    expect(list[0]!.code).toBe('KEPT1')
  })

  it('returns an empty list for a malformed sensor string', () => {
    expect(parseLightningSensors('not json at all')).toEqual([])
    expect(parseLightningSensors('{"SerialNumber": 10209}')).toEqual([])
    expect(parseLightningSensors('null')).toEqual([])
    expect(parseLightningSensors('')).toEqual([])
    // Missing field (older relay, or a frame that drops it) and non-strings.
    expect(parseLightningSensors(undefined)).toEqual([])
    expect(parseLightningSensors(null)).toEqual([])
    expect(parseLightningSensors(42)).toEqual([])
    expect(parseLightningSensors('[]')).toEqual([])
  })

  it('drops a sensor with no usable id, since the id is its identity', () => {
    expect(parseLightningSensors([{ ...RAW_SENSOR, SerialNumber: 'nope' }])).toEqual([])
    expect(parseLightningSensors([{ ...RAW_SENSOR, SerialNumber: undefined }])).toEqual([])
  })

  it('keeps the list sorted by id', () => {
    const list = parseLightningSensors([
      { ...RAW_SENSOR, SerialNumber: 10209 },
      { ...RAW_SENSOR, SerialNumber: 10083 },
      { ...RAW_SENSOR, SerialNumber: 10150 },
    ])
    expect(list.map(s => s.id)).toEqual([10083, 10150, 10209])
  })

  it('reads Online as a boolean and tolerates a numeric string', () => {
    const [online, offline, stringOffline] = parseLightningSensors([
      { ...RAW_SENSOR, SerialNumber: 1, Online: 1 },
      { ...RAW_SENSOR, SerialNumber: 2, Online: 0 },
      { ...RAW_SENSOR, SerialNumber: 3, Online: '0' },
    ])
    expect(online!.online).toBe(true)
    expect(offline!.online).toBe(false)
    expect(stringOffline!.online).toBe(false)
  })
})

describe('parseLiveFrameWithSensors', () => {
  const data = JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      properties: { id: 1, current: 13674 },
      geometry: { type: 'Point', coordinates: [101.687271, 3.169954] },
    }],
  })

  it('returns the strikes AND the sensors of one frame', () => {
    const frame = `42["data_petir", {"data": ${JSON.stringify(data)}, "sensor": ${JSON.stringify(JSON.stringify([RAW_SENSOR]))}, "epoch": 1795869860}]`
    const parsed = parseLiveFrameWithSensors(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.features.features).toHaveLength(1)
    expect(parsed!.sensors).toHaveLength(1)
    expect(parsed!.sensors[0]!.code).toBe('AAILD')
  })

  it('keeps the strikes when the sensor field is broken', () => {
    const frame = `42["data_petir", {"data": ${JSON.stringify(data)}, "sensor": "not json"}]`
    const parsed = parseLiveFrameWithSensors(frame)
    expect(parsed!.features.features).toHaveLength(1)
    expect(parsed!.sensors).toEqual([])
    // A frame with no sensor field at all behaves the same.
    const bare = `42["data_petir", {"data": ${JSON.stringify(data)}}]`
    expect(parseLiveFrameWithSensors(bare)!.sensors).toEqual([])
  })

  it('returns null for frames that carry no strike FeatureCollection', () => {
    expect(parseLiveFrameWithSensors('0{"sid":"abc"}')).toBeNull()
    expect(parseLiveFrameWithSensors('42["other_event", {"data": "{}"}]')).toBeNull()
  })
})

describe('sensorMarkers', () => {
  const sensors = [
    SENSOR({ id: 10083, code: 'MDRLD', lat: -7.041423, lon: 113.915803 }),
    SENSOR({ id: 10084, code: 'SRGLD', lat: -6.171296, lon: 106.05143 }),
  ]

  it('uses the catalog coordinates when the ids match', () => {
    const catalog = new Map([
      [10083, { lat: -7.04, lon: 113.91 }],
      [10084, { lat: -6.17, lon: 106.05 }],
    ])
    const markers = sensorMarkers(sensors, catalog)
    expect(markers.map(m => [m.sensor.id, m.lat, m.lon])).toEqual([
      [10083, -7.04, 113.91],
      [10084, -6.17, 106.05],
    ])
  })

  it('falls back to the socket coordinates when there is no catalog entry', () => {
    const markers = sensorMarkers(sensors, new Map([[10083, { lat: -7.04, lon: 113.91 }]]))
    expect(markers[0]!.lat).toBe(-7.04)
    // No entry for 10084: the socket's own Latitude/Longitude are kept.
    expect(markers[1]!.lat).toBe(-6.171296)
    expect(markers[1]!.lon).toBe(106.05143)
    // An empty catalog (failed fetch) leaves every marker on the socket values.
    const none = sensorMarkers(sensors, new Map())
    expect(none.map(m => [m.lat, m.lon])).toEqual(sensors.map(s => [s.lat, s.lon]))
  })

  it('never takes anything but the position from the catalog', () => {
    const catalog = new Map([[10083, { lat: -7.04, lon: 113.91 }]])
    const markers = sensorMarkers([SENSOR({ id: 10083, online: false, strikesPerMinute: 7 })], catalog)
    expect(markers[0]!.sensor.online).toBe(false)
    expect(markers[0]!.sensor.strikesPerMinute).toBe(7)
  })
})

describe('nearestSensor — hit test', () => {
  // A fake projection: 1 degree = 10 px, so the distances are easy to read.
  const project = (lon: number, lat: number) => ({ x: lon * 10, y: lat * 10 })
  const MARKERS: SensorMarker[] = [
    { sensor: SENSOR({ id: 1 }), lat: 0, lon: 0 },
    { sensor: SENSOR({ id: 2 }), lat: 2, lon: 3 },
  ]

  it('returns the nearest marker inside the tolerance', () => {
    expect(nearestSensor({ x: 1, y: 1 }, MARKERS, project)!.sensor.id).toBe(1)
    expect(nearestSensor({ x: 29, y: 19 }, MARKERS, project)!.sensor.id).toBe(2)
  })

  it('returns null when every marker is beyond the tolerance', () => {
    // 12 px from marker 1, and far from marker 2.
    expect(nearestSensor({ x: 12, y: 0 }, MARKERS, project)).toBeNull()
    // Empty list, and a list that projects off-screen.
    expect(nearestSensor({ x: 0, y: 0 }, [], project)).toBeNull()
  })

  it('uses a 10 px tolerance, inclusive at the edge', () => {
    expect(SENSOR_HIT_PX).toBe(10)
    expect(nearestSensor({ x: 10, y: 0 }, MARKERS, project)!.sensor.id).toBe(1)
    expect(nearestSensor({ x: 10.5, y: 0 }, MARKERS, project)).toBeNull()
  })

  it('picks the closest of two markers under the pointer', () => {
    const close: SensorMarker[] = [
      { sensor: SENSOR({ id: 1 }), lat: 0, lon: 0 },
      { sensor: SENSOR({ id: 2 }), lat: 0, lon: 0.5 },
    ]
    expect(nearestSensor({ x: 4, y: 0 }, close, project)!.sensor.id).toBe(2)
    expect(nearestSensor({ x: 1, y: 0 }, close, project)!.sensor.id).toBe(1)
  })

  it('honours a caller-supplied radius', () => {
    // Marker 2 is the closer one here, so it wins inside a wider radius.
    expect(nearestSensor({ x: 40, y: 0 }, MARKERS, project, 40)!.sensor.id).toBe(2)
    // With a radius that only reaches marker 1, marker 1 is the hit.
    expect(nearestSensor({ x: 12, y: 0 }, MARKERS, project, 12)!.sensor.id).toBe(1)
    // The default radius would find neither.
    expect(nearestSensor({ x: 12, y: 0 }, MARKERS, project)).toBeNull()
  })
})

describe('sensorDisplay — hover card rows', () => {
  it('formats every row in the documented order', () => {
    const d = sensorDisplay(SENSOR())
    expect(d.title).toBe('10209 AAILD')
    expect(d.online).toBe(true)
    expect(d.rows).toEqual([
      { label: 'Status', value: 'Online' },
      { label: 'Strikes/Min', value: '143' },
      { label: 'Strikes % Good', value: '100.0' },
      { label: 'Strikes % Correlated', value: '67.9' },
      { label: 'Satellites', value: '12 tracked' },
      { label: 'Last Strikes', value: '28-Nov-2026 20:17:38 WIB' },
      { label: 'Last Connected', value: '28-Nov-2026 09:16:52 WIB' },
    ])
  })

  it('says Offline for an offline sensor', () => {
    const d = sensorDisplay(SENSOR({ online: false }))
    expect(d.online).toBe(false)
    expect(d.rows[0]).toEqual({ label: 'Status', value: 'Offline' })
  })

  it('rounds the percentages to one decimal and leaves the times untouched', () => {
    const d = sensorDisplay(SENSOR({
      strikesGoodPct: 99.999,
      strikesCorrelatedPct: 0,
      captureLastReceived: '28-Nov-2026 20:23:29',
      lastConnected: '28-Nov-2026 09:16:52',
    }))
    expect(d.rows[2]!.value).toBe('100.0')
    expect(d.rows[3]!.value).toBe('0.0')
    // No timezone conversion: the WIB wall clock arrives exactly as sent.
    expect(d.rows[5]!.value).toBe('28-Nov-2026 20:23:29 WIB')
    expect(d.rows[6]!.value).toBe('28-Nov-2026 09:16:52 WIB')
  })

  it('shows an em dash instead of inventing a missing value', () => {
    const d = sensorDisplay(SENSOR({
      strikesPerMinute: Number.NaN,
      strikesGoodPct: Number.NaN,
      strikesCorrelatedPct: Number.NaN,
      satellitesTracked: Number.NaN,
      captureLastReceived: '',
      lastConnected: '',
    }))
    expect(d.rows.slice(1).map(r => r.value)).toEqual([
      '—',
      '—',
      '—',
      '— tracked',
      '—',
      '—',
    ])
  })

  it('does not print WIB twice', () => {
    expect(wibText('28-Nov-2026 20:17:38 WIB')).toBe('28-Nov-2026 20:17:38 WIB')
    expect(wibText(' 28-Nov-2026 20:17:38 ')).toBe('28-Nov-2026 20:17:38 WIB')
  })
})

describe('sensor colours', () => {
  it('is teal when online and grey when offline', () => {
    expect(SENSOR_ONLINE_COLOR).toBe('#2DD4BF')
    expect(SENSOR_OFFLINE_COLOR).toBe('#9CA3AF')
    expect(sensorColor({ online: true })).toBe('#2DD4BF')
    expect(sensorColor({ online: false })).toBe('#9CA3AF')
  })
})
