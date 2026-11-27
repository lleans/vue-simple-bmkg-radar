// Radar coverage radius of a BMKG station, in km.
export const STATION_RADIUS_KM = 250

export interface GeoPoint {
  lat: number
  lon: number
}

// Haversine distance in km between two [lon, lat] points
export function geoDistanceKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Split stations by whether the anchor falls within their radar coverage.
// `inRange` is annotated with `distKm` and sorted nearest-first; `other`
// keeps the original input order. A null anchor puts everything in `other`.
export function groupStationsByRange<T extends GeoPoint>(
  stations: readonly T[],
  anchor: GeoPoint | null,
): { inRange: Array<T & { distKm: number }>; other: T[] } {
  if (!anchor) return { inRange: [], other: [...stations] }

  const inRange: Array<T & { distKm: number }> = []
  const other: T[] = []
  for (const station of stations) {
    const distKm = geoDistanceKm(anchor.lon, anchor.lat, station.lon, station.lat)
    if (distKm <= STATION_RADIUS_KM) inRange.push({ ...station, distKm })
    else other.push(station)
  }
  inRange.sort((a, b) => a.distKm - b.distKm)
  return { inRange, other }
}
