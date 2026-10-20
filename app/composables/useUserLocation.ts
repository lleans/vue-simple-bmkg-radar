// Approximate visitor location from their IP, called straight from the
// browser (no backend). Used once so the map opens on the visitor's region
// and only the radars around them are fetched, instead of the whole country.
//
// Privacy: the lookup sends the visitor's IP to a third-party geolocation
// service. The result is cached in localStorage for 24h, so repeat visits
// don't call it again.

export interface UserLocation {
  lat: number
  lon: number
  city?: string
  country?: string
}

const CACHE_KEY = 'radar:user-location:v1'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

// Rough box around the radar network (Indonesia plus a margin). Outside it a
// regional view would contain no radar at all, so the country view is used.
const COVERAGE = { minLat: -14, maxLat: 9, minLon: 92, maxLon: 144 }

export function inCoverage(loc: { lat: number; lon: number }): boolean {
  return (
    loc.lat >= COVERAGE.minLat && loc.lat <= COVERAGE.maxLat &&
    loc.lon >= COVERAGE.minLon && loc.lon <= COVERAGE.maxLon
  )
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

const toLocation = (
  lat: unknown,
  lon: unknown,
  city: unknown,
  country: unknown,
): UserLocation | null => {
  const la = num(lat)
  const lo = num(lon)
  if (la === null || lo === null || Math.abs(la) > 90 || Math.abs(lo) > 180) return null
  return {
    lat: la,
    lon: lo,
    city: typeof city === 'string' ? city : undefined,
    country: typeof country === 'string' ? country : undefined,
  }
}

interface Provider {
  name: string
  url: string
  parse: (j: Record<string, unknown>) => UserLocation | null
}

// Tried in order. All are keyless and send CORS headers (checked from a
// browser on localhost:3000).
const PROVIDERS: Provider[] = [
  {
    name: 'ipwho.is',
    url: 'https://ipwho.is/?fields=success,latitude,longitude,city,country_code',
    parse: j => (j.success === false ? null : toLocation(j.latitude, j.longitude, j.city, j.country_code)),
  },
  {
    name: 'ipapi.co',
    url: 'https://ipapi.co/json/',
    parse: j => (j.error ? null : toLocation(j.latitude, j.longitude, j.city, j.country_code)),
  },
  {
    name: 'geojs',
    url: 'https://get.geojs.io/v1/ip/geo.json',
    parse: j => toLocation(j.latitude, j.longitude, j.city, j.country_code),
  },
]

export function getCachedLocation(): UserLocation | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { ts?: number; loc?: UserLocation }
    if (!v?.loc || typeof v.ts !== 'number' || Date.now() - v.ts > CACHE_TTL_MS) return null
    return v.loc
  } catch {
    return null
  }
}

function cacheLocation(loc: UserLocation) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), loc }))
  } catch {
    // storage unavailable (private mode, quota): just look up again next time
  }
}

// Looks the visitor up, trying each provider until one answers. The whole
// attempt is bounded by `budgetMs`, so a slow provider can't hold the map up.
export async function lookupUserLocation(budgetMs = 3000): Promise<UserLocation | null> {
  const deadline = Date.now() + budgetMs
  for (const p of PROVIDERS) {
    const left = deadline - Date.now()
    if (left <= 0) break
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), left)
    try {
      const res = await fetch(p.url, { signal: ctrl.signal, referrerPolicy: 'no-referrer' })
      if (!res.ok) continue
      const loc = p.parse((await res.json()) as Record<string, unknown>)
      if (loc) {
        cacheLocation(loc)
        return loc
      }
    } catch {
      // timeout or network error: try the next provider
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}
