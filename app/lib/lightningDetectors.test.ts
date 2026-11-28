// Tests for the detector lists on a strike: parsing the two parallel lists,
// selecting the sensors a hovered strike links to, and the animation maths.
import { describe, expect, it } from 'vitest'
import {
  DETECTOR_DASH_SPEED_PX_PER_S,
  DETECTOR_DASH,
  SENSOR_PULSE_CYCLE_MS,
  dashOffsetPx,
  detectorTargets,
  parseDetectorList,
  pulsePhase,
  pulseRing,
  sensorsVisible,
} from './lightningDetectors'
import { parseLightningSensors, type LightningSensor } from './lightningSensors'
import { strikeDisplay } from './lightningLive'

// A real socket frame property pair, from the captured frame.
const IDS = '10150,10149,10148,10084'
const CODES = 'YOGLD,SMGLD,CLPLD,SRGLD'

const SENSOR = (over: Partial<LightningSensor> = {}): LightningSensor => ({
  id: 10084,
  code: 'SRGLD',
  lat: -6.171296,
  lon: 106.05143,
  online: true,
  strikesPerMinute: 12,
  strikesGoodPct: 100,
  strikesCorrelatedPct: 50,
  satellitesTracked: 10,
  captureLastReceived: '28-Nov-2026 20:17:38',
  lastConnected: '28-Nov-2026 09:16:52',
  ...over,
})

describe('parseDetectorList', () => {
  it('lines the ids and the codes up by index', () => {
    const { detectors, dropped } = parseDetectorList(IDS, CODES)
    expect(detectors).toEqual([
      { id: 10150, code: 'YOGLD' },
      { id: 10149, code: 'SMGLD' },
      { id: 10148, code: 'CLPLD' },
      { id: 10084, code: 'SRGLD' },
    ])
    expect(dropped).toBe(0)
  })

  it('tolerates spaces around the entries', () => {
    expect(parseDetectorList(' 10150 , 10084 ', 'YOGLD, SRGLD').detectors).toEqual([
      { id: 10150, code: 'YOGLD' },
      { id: 10084, code: 'SRGLD' },
    ])
  })

  it('drops and reports a pair when the lists are different lengths', () => {
    // One code short: the 4th id has no code, so it cannot be paired.
    const a = parseDetectorList(IDS, 'YOGLD,SMGLD,CLPLD')
    expect(a.detectors).toHaveLength(3)
    expect(a.dropped).toBe(1)
    // One id short: the 4th code has no id, i.e. a code that belongs nowhere.
    const b = parseDetectorList('10150,10149,10148', CODES)
    expect(b.detectors).toHaveLength(3)
    expect(b.dropped).toBe(1)
  })

  it('drops a pair whose id is not a number', () => {
    const { detectors, dropped } = parseDetectorList('10150,nope,10148', 'YOGLD,SMGLD,CLPLD')
    expect(detectors.map(d => d.id)).toEqual([10150, 10148])
    expect(dropped).toBe(1)
  })

  it('drops a pair whose code is not a station code', () => {
    const { detectors, dropped } = parseDetectorList('10150,10149', 'YOGLD,sr-gld')
    expect(detectors.map(d => d.id)).toEqual([10150])
    expect(dropped).toBe(1)
    // A blank code is allowed for a real id (the card falls back to the id).
    expect(parseDetectorList('10150', '').detectors).toEqual([{ id: 10150, code: '' }])
  })

  it('collapses a repeated id, since one sensor draws one line', () => {
    const { detectors, dropped } = parseDetectorList('10150,10150', 'YOGLD,YOGLD')
    expect(detectors).toEqual([{ id: 10150, code: 'YOGLD' }])
    expect(dropped).toBe(1)
  })

  it('returns an empty list for a missing or empty field', () => {
    expect(parseDetectorList(undefined, undefined).detectors).toEqual([])
    expect(parseDetectorList('', '').detectors).toEqual([])
    expect(parseDetectorList(null, null).detectors).toEqual([])
    expect(parseDetectorList('10150', undefined).detectors).toEqual([])
  })
})

describe('detectorTargets — the hover line selection', () => {
  // Two of the four detectors are in the socket sensor frame.
  const sensors = [
    { sensor: SENSOR({ id: 10150, code: 'YOGLD' }), lat: -7.5, lon: 110.3 },
    { sensor: SENSOR({ id: 10084, code: 'SRGLD' }), lat: -6.171296, lon: 106.05143 },
  ]
  const strike = { detectors: parseDetectorList(IDS, CODES).detectors }

  it('links only to sensors it can place, in the strike list order', () => {
    const targets = detectorTargets(strike, sensors)
    expect(targets).toEqual([
      { id: 10150, code: 'YOGLD', lat: -7.5, lon: 110.3 },
      { id: 10084, code: 'SRGLD', lat: -6.171296, lon: 106.05143 },
    ])
  })

  it('falls back to the catalog for a detector that is not in the frame', () => {
    const catalog = new Map([
      [10149, { lat: -7.0, lon: 110.0 }],
      [10148, { lat: -6.9, lon: 107.6 }],
    ])
    const targets = detectorTargets(strike, sensors, catalog)
    expect(targets.map(t => [t.id, t.lat, t.lon])).toEqual([
      [10150, -7.5, 110.3],
      [10149, -7.0, 110.0],
      [10148, -6.9, 107.6],
      [10084, -6.171296, 106.05143],
    ])
  })

  it('prefers the sensor position (which already prefers the catalog)', () => {
    const catalog = new Map([[10084, { lat: -6.2, lon: 106.1 }]])
    const moved = [{ sensor: SENSOR({ id: 10084, code: 'SRGLD' }), lat: -6.2, lon: 106.1 }]
    expect(detectorTargets(strike, moved, catalog)).toEqual([
      { id: 10084, code: 'SRGLD', lat: -6.2, lon: 106.1 },
    ])
  })

  it('draws no lines for a strike with no detector list', () => {
    // Every REST strike looks like this, and so does a socket strike whose
    // properties carried no detector lists.
    expect(detectorTargets({}, sensors)).toEqual([])
    expect(detectorTargets({ detectors: [] }, sensors)).toEqual([])
  })

  it('skips a detector that can be placed by neither source', () => {
    const partial = { detectors: parseDetectorList('10150,99999', 'YOGLD,NOWHERE').detectors }
    expect(detectorTargets(partial, sensors).map(t => t.id)).toEqual([10150])
  })

  it('keeps the socket code when the strike list had none', () => {
    const blank = { detectors: parseDetectorList('10084', '').detectors }
    expect(detectorTargets(blank, sensors)[0]!.code).toBe('SRGLD')
  })
})

describe('sensorsVisible — the sensors follow the lightning toggle', () => {
  it('is on exactly while the lightning layer is on', () => {
    expect(sensorsVisible(false)).toBe(false)
    expect(sensorsVisible(true)).toBe(true)
  })
})

describe('animation maths', () => {
  it('moves the dashes slowly and wraps within one dash period', () => {
    // The dash period is the on + off length.
    const period = DETECTOR_DASH[0] + DETECTOR_DASH[1]
    expect(dashOffsetPx(0)).toBe(0)
    expect(dashOffsetPx(1000)).toBeCloseTo(DETECTOR_DASH_SPEED_PX_PER_S, 10)
    // A full period later the offset is back to 0 (the pattern repeats).
    const perPeriodMs = (period / DETECTOR_DASH_SPEED_PX_PER_S) * 1000
    expect(dashOffsetPx(perPeriodMs)).toBeCloseTo(0, 10)
    expect(dashOffsetPx(perPeriodMs + 1000)).toBeCloseTo(DETECTOR_DASH_SPEED_PX_PER_S, 10)
    // It never grows without bound.
    expect(dashOffsetPx(10_000_000)).toBeLessThan(period)
  })

  it('runs the sensor pulse in a repeating cycle', () => {
    expect(pulsePhase(0)).toBe(0)
    expect(pulsePhase(SENSOR_PULSE_CYCLE_MS / 2)).toBeCloseTo(0.5, 10)
    expect(pulsePhase(SENSOR_PULSE_CYCLE_MS)).toBe(0)
    expect(pulsePhase(SENSOR_PULSE_CYCLE_MS * 3.25)).toBeCloseTo(0.25, 10)
  })

  it('grows the pulse ring while fading it', () => {
    const birth = pulseRing(0)
    const mid = pulseRing(0.5)
    const end = pulseRing(1)
    expect(birth.alpha).toBeGreaterThan(mid.alpha)
    expect(mid.alpha).toBeGreaterThan(end.alpha)
    expect(end.alpha).toBe(0)
    expect(birth.radius).toBeLessThan(mid.radius)
    expect(mid.radius).toBeLessThan(end.radius)
    // It starts outside the sensor's own ring (3.5 px).
    expect(birth.radius).toBeGreaterThan(3.5)
  })
})

describe('the card still shows what it should for a sensor', () => {
  it('is unaffected by the detector list on the strike', () => {
    const card = strikeDisplay({
      time_utc: '2026-11-28T12:44:20Z',
      lat: 0,
      lon: 0,
      current_ka: 1,
      detectors: parseDetectorList(IDS, CODES).detectors,
    })
    expect(card.currentText).toBe('1.0 kA')
  })
})

// Keep the unused-import guard honest: the sensor parser is part of this file's
// story (a sensor is what a detector line points at).
describe('sensor parsing feeds the detector positions', () => {
  it('places a detector target from a parsed sensor', () => {
    const sensors = parseLightningSensors(JSON.stringify([
      { SerialNumber: 10084, RealName: 'SRGLD', Latitude: '-6.171296', Longitude: '106.05143', Online: 1 },
    ]))
    expect(sensors[0]!.lat).toBe(-6.171296)
    expect(sensors[0]!.code).toBe('SRGLD')
  })
})
