import { describe, it, expect } from 'vitest'
import { geoDistanceKm, groupStationsByRange, STATION_RADIUS_KM } from './geo'

const s = (id: string, lat: number, lon: number) => ({ id, name: id, lat, lon })

describe('geoDistanceKm', () => {
  it('matches a known separation (~111 km per degree of latitude)', () => {
    expect(geoDistanceKm(0, 0, 0, 1)).toBeGreaterThan(110)
    expect(geoDistanceKm(0, 0, 0, 1)).toBeLessThan(112)
  })

  it('shrinks a degree of longitude by cos(lat) away from the equator', () => {
    // 1 deg of longitude at 60N is ~111.2 * cos(60) = ~55.6 km. A missing
    // cos(lat) term or swapped lat/lon arguments would give ~111 km.
    expect(geoDistanceKm(0, 60, 1, 60)).toBeGreaterThan(55)
    expect(geoDistanceKm(0, 60, 1, 60)).toBeLessThan(56)
  })
})

describe('groupStationsByRange', () => {
  it('null anchor → everything in other, none in range, original order', () => {
    const list = [s('A', -7, 112), s('B', 0, 100)]
    const r = groupStationsByRange(list, null)
    expect(r.inRange).toEqual([])
    expect(r.other.map(x => x.id)).toEqual(['A', 'B'])
  })

  it('splits by 250 km and sorts in-range nearest-first with distKm', () => {
    const anchor = { lat: -7.25, lon: 112.75 } // ~Surabaya
    const near = s('SBY', -7.2, 112.7)
    const mid = s('SMG', -6.98, 110.7)         // within range (~228 km), farther
    const far = s('ACE', 5.5, 95.3)            // far out of range (~2400 km)
    const farther = s('JAK', -6.2, 106.8)      // out of range (~667 km), nearer than ACE
    // Out-of-range stations are given in descending-distance order so a
    // stray distance sort would visibly reorder `other`.
    const r = groupStationsByRange([far, mid, farther, near], anchor)
    expect(r.inRange.map(x => x.id)).toEqual(['SBY', 'SMG'])
    expect(r.inRange[0]!.distKm).toBeLessThan(r.inRange[1]!.distKm)
    expect(r.inRange[0]!.distKm).toBeCloseTo(geoDistanceKm(anchor.lon, anchor.lat, near.lon, near.lat))
    expect(r.other.map(x => x.id)).toEqual(['ACE', 'JAK'])
  })

  it('pins the boundary at STATION_RADIUS_KM (inclusive side)', () => {
    // On the same meridian, distance = R * dLat, so dLat is (km * 180 / (pi * R)) degrees.
    const latAtKm = (km: number) => km * 180 / (Math.PI * 6371)
    const inside = s('IN', latAtKm(STATION_RADIUS_KM - 1), 0)  // ~249 km
    const outside = s('OUT', latAtKm(STATION_RADIUS_KM + 1), 0) // ~251 km
    const r = groupStationsByRange([outside, inside], { lat: 0, lon: 0 })
    expect(r.inRange.map(x => x.id)).toEqual(['IN'])
    expect(r.other.map(x => x.id)).toEqual(['OUT'])
  })

  it('point with nothing in range → empty inRange, all in other', () => {
    const r = groupStationsByRange([s('ACE', 5.5, 95.3)], { lat: -40, lon: 150 })
    expect(r.inRange).toEqual([])
    expect(r.other.map(x => x.id)).toEqual(['ACE'])
  })

  it('empty input → both empty', () => {
    const r = groupStationsByRange([], { lat: 0, lon: 0 })
    expect(r.inRange).toEqual([])
    expect(r.other).toEqual([])
  })
})
