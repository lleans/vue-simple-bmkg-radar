// The BMKG lightning SENSOR CATALOG (contract v1), fetched from
// `${base}/api/stations/catalog`. The contract lives in this repo at
// contracts/stations-catalog.v1.yaml and is the source of the shape below.
//
// Why it exists: the socket sensor list (see lib/lightningSensors.ts) carries
// the sensors' OWN Latitude/Longitude strings, and the catalog carries the same
// stations with numeric coordinates. The catalog is only ever used for MARKER
// POSITIONS; status, strikes, satellites and times always come from the socket.
//
// Rules:
//  - the catalog is fetched ONCE when the LIGHTNING layer is switched on (there
//    is no separate sensors switch), and not again until it is switched off and
//    on (fetchOnce() is idempotent, and reset() re-arms it). There is NO
//    polling and no retry loop;
//  - the endpoint is a separate thing from /api/stations (the radar list, whose
//    ids are strings such as JAK/CGK). That list is untouched by this file;
//  - a failure is normal and non-fatal: the request throws, or answers with the
//    contract's 502 shape ({ ok: false, error: 'upstream_unavailable', ... }).
//    Either way the catalog goes empty, `error` is set, and the socket-based
//    sensors keep working from their own coordinates.

export interface StationCatalogEntry {
  /** BMKG sensor serial number — the same value as the socket's SerialNumber. */
  id: number
  code: string
  lat: number
  lon: number
}

interface StationCatalogEnvelope {
  ok: boolean
  cached?: boolean
  cache_age_seconds?: number
  pulled_at_utc?: string
  data?: { count?: number, stations?: unknown }
  error?: string
  message?: string
}

/**
 * Keeps only what the map can use: an integer id and finite coordinates inside
 * the contract's ranges. Shape checking happens here rather than at the call
 * site so a malformed body can never reach the map. Sorted by id, as the
 * contract's `stations` array is.
 */
export function catalogStationsFromPayload(payload: unknown): StationCatalogEntry[] {
  const stations = (payload as { stations?: unknown } | null)?.stations
  if (!Array.isArray(stations)) return []
  const out: StationCatalogEntry[] = []
  for (const entry of stations) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const s = entry as Record<string, unknown>
    const id = Number(s.id)
    const lat = Number(s.lat)
    const lon = Number(s.lon)
    if (!Number.isInteger(id)) continue
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) continue
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) continue
    out.push({ id, code: typeof s.code === 'string' ? s.code.trim() : '', lat, lon })
  }
  out.sort((a, b) => a.id - b.id)
  return out
}

/** The catalog index by id, i.e. the shape sensorMarkers() matches against. */
export function catalogIndex(entries: readonly StationCatalogEntry[]): Map<number, StationCatalogEntry> {
  const map = new Map<number, StationCatalogEntry>()
  for (const e of entries) map.set(e.id, e)
  return map
}

/**
 * The message for a failed catalog request. ofetch throws an Error whose `data`
 * is the parsed body, so the contract's 502 shape
 * ({ ok:false, error:'upstream_unavailable', message:'…' }) is read first: its
 * `message` (or `error`) is far more useful than "502 Bad Gateway". A bare
 * thrown object with the same shape is accepted too.
 */
export function errorMessage(err: unknown): string {
  const body = (err as { data?: unknown } | null)?.data ?? err
  if (typeof body === 'object' && body !== null) {
    const b = body as { message?: unknown, error?: unknown }
    if (typeof b.message === 'string' && b.message.trim()) return b.message.trim()
    if (typeof b.error === 'string' && b.error.trim()) return b.error.trim()
  }
  if (err instanceof Error && err.message.trim()) return err.message.trim()
  if (typeof err === 'string' && err.trim()) return err.trim()
  return 'Sensor catalog fetch failed'
}

// Module-level so every useStationCatalog() caller shares one catalog and one
// fetch flag (the same pattern as useLightning).
let requested = false
let inflight: Promise<void> | null = null

export const useStationCatalog = () => {
  const base = useRuntimeConfig().public.darmaProxyBase as string

  const stations = useState<StationCatalogEntry[]>('stationCatalog:stations', () => [])
  const loading = useState<boolean>('stationCatalog:loading', () => false)
  // Human-readable message for the last failure, or null. No UI reads it yet;
  // it exists so a catalog outage can be reported instead of silently ignored.
  const error = useState<string | null>('stationCatalog:error', () => null)

  /**
   * Fetches the catalog once. A second call while the toggle is still on — or
   * while the first request is in flight — is a no-op, which is what keeps a
   * re-render from turning into a second request. reset() re-arms it.
   */
  async function fetchOnce(): Promise<void> {
    if (requested) return
    requested = true
    const run = (async () => {
      loading.value = true
      try {
        const res = await $fetch<StationCatalogEnvelope>(`${base}/api/stations/catalog`)
        // The contract's success shape. `ok:false` is the 502 shape, which
        // ofetch would normally throw for; handle both the same way.
        if (res?.ok && res.data) {
          stations.value = catalogStationsFromPayload(res.data)
          error.value = null
        } else {
          stations.value = []
          error.value = res?.message ?? res?.error ?? 'Sensor catalog returned no usable data'
          console.warn(`[stations] catalog returned no usable data: ${error.value}`)
        }
      } catch (err) {
        // Includes the 502 (upstream_unavailable) reply and a network failure.
        // ofetch rejects with the parsed body on `data`, so the contract's
        // message is read from there before falling back to the Error text.
        // The socket sensors stay on screen, drawn at their own coordinates.
        stations.value = []
        error.value = errorMessage(err)
        console.warn(`[stations] catalog fetch failed: ${error.value}`)
      } finally {
        loading.value = false
      }
    })()
    inflight = run
    try {
      await run
    } finally {
      if (inflight === run) inflight = null
    }
  }

  /**
   * Re-arms the once-only fetch, called when the lightning layer is switched
   * off. Any catalog data already loaded is KEPT: the layer hides the sensors
   * anyway, and a stale position is better than a flash of socket coordinates
   * while the next fetch is in flight. A pending request is not cancelled.
   */
  function reset(): void {
    requested = false
  }

  return {
    stations,
    loading,
    error,
    fetchOnce,
    reset,
  }
}
