// Wraps the darma-proxy-rust-cloudflare API. Responses are the standard
// envelope: { ok, cached, cache_age_seconds, pulled_at_utc, data }.
// Worker already caches via the Cloudflare Cache API; we just avoid
// re-fetching during a 30s animation cycle.

import type { RadarProductCode } from './radarProducts'
import { withRetry } from './useRadarFetch'

export interface RadarStation {
  id: string
  name: string
  lat: number
  lon: number
}

export interface RadarFrame {
  url: string
  time_utc: string
  forecast_offset_minutes: number | null
}

export interface RadarProduct {
  station: string
  product: string
  latest: RadarFrame
  last_hour: RadarFrame[]
}

export interface RadarTimeseriesPoint {
  label: string
  value: number
  color: string | null
}

export interface RadarTimeseries {
  station: string
  lat: number
  lon: number
  date_utc: string
  units: string
  series: RadarTimeseriesPoint[]
}

export interface RadarVcut {
  station: string
  start_lat: number
  start_lon: number
  stop_lat: number
  stop_lon: number
  datetime_utc: string
  product: string
  image_url: string
}

interface Envelope<T> {
  ok: boolean
  cached?: boolean
  data: T
  error?: string
  message?: string
}

/** Return a copy of `record` without `key` (used to clear failures). */
function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

export const useRadarApi = () => {
  const config = useRuntimeConfig()
  const base = config.public.darmaProxyBase as string

  const stations = useState<RadarStation[]>('radar:stations', () => [])
  const productsByStation = useState<Record<string, RadarProduct>>(
    'radar:products',
    () => ({}),
  )
  const failedStations = useState<Record<string, true>>(
    'radar:failed',
    () => ({}),
  )
  // Stations that failed on the most recent fetch cycle. Unlike
  // `failedStations` (a longer-lived backoff list), this is what the
  // red cross indicator reports, and it is cleared as soon as a station
  // succeeds.
  const failedNow = useState<Record<string, true>>('radar:failedNow', () => ({}))
  const stationsError = useState<string | null>('radar:stationsError', () => null)
  const stationsLoading = useState<boolean>('radar:stationsLoading', () => false)
  const product = useState<RadarProductCode>('radar:product', () => 'CMAX')
  // productLoading: how many station products are still in flight
  const productsLoading = useState<number>('radar:productsLoading', () => 0)
  // Stations currently waiting on a nowcast response (excludes cache hits).
  // The loading chip in the legend surfaces this list on hover.
  const loadingStations = useState<string[]>('radar:loadingStations', () => [])

  const fetchStations = async () => {
    stationsLoading.value = true
    stationsError.value = null
    try {
      const res = await $fetch<Envelope<{ stations: RadarStation[] }>>(
        `${base}/api/stations`,
      )
      if (res.ok) stations.value = res.data.stations
      else stationsError.value = res.message ?? res.error ?? 'unknown error'
    } catch (e) {
      stationsError.value = e instanceof Error ? e.message : 'network error'
    } finally {
      stationsLoading.value = false
    }
  }

  // One request per station+product at a time: the viewport can change faster
  // than the API answers, so callers may ask for the same station again.
  const inflight = new Map<string, Promise<RadarProduct | null>>()

  const fetchProduct = (stationId: string): Promise<RadarProduct | null> => {
    const code = product.value
    const cached = productsByStation.value[stationId]
    if (cached && cached.product === code) return Promise.resolve(cached)
    if (failedStations.value[stationId]) return Promise.resolve(null)
    const key = `${stationId}:${code}`
    const running = inflight.get(key)
    if (running) return running

    const request = (async () => {
      productsLoading.value++
      loadingStations.value = [...loadingStations.value, stationId]
      try {
        // Transient failures (no CORS header from a mid-deploy instance) are
        // retried; a real API answer is returned as-is.
        const res = await withRetry(() =>
          $fetch<Envelope<RadarProduct>>(`${base}/api/nowcast/${stationId}?product=${code}`),
        )
        // The product may have been switched while in flight: drop the
        // stale answer instead of mixing products on the map.
        if (product.value !== code) return null
        if (res.ok) {
          productsByStation.value = { ...productsByStation.value, [stationId]: res.data }
          failedStations.value = omit(failedStations.value, stationId)
          failedNow.value = omit(failedNow.value, stationId)
          return res.data
        }
        failedStations.value = { ...failedStations.value, [stationId]: true }
        failedNow.value = { ...failedNow.value, [stationId]: true }
      } catch {
        if (product.value === code) {
          failedStations.value = { ...failedStations.value, [stationId]: true }
          failedNow.value = { ...failedNow.value, [stationId]: true }
        }
      } finally {
        productsLoading.value = Math.max(0, productsLoading.value - 1)
        loadingStations.value = loadingStations.value.filter(s => s !== stationId)
      }
      return null
    })().finally(() => inflight.delete(key))

    inflight.set(key, request)
    return request
  }

  // Manual retry support. `failedStations` is a backoff list that makes a
  // station un-fetchable for a while, so a retry has to clear it before the
  // request would actually go out.
  const clearStationFailures = () => {
    failedStations.value = {}
    failedNow.value = {}
  }
  const forceFetchProduct = (stationId: string) => {
    failedStations.value = omit(failedStations.value, stationId)
    failedNow.value = omit(failedNow.value, stationId)
    void fetchProduct(stationId)
  }

  // Fetch the given stations only (the ones in view), with bounded concurrency.
  const fetchProducts = async (ids: string[], concurrency = 6) => {
    let cursor = 0
    const worker = async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++]
        if (id) await fetchProduct(id)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker))
  }

  // Switching product drops the old product's data. Whoever is showing the map
  // reloads what is in view (it watches `product`), so we never fetch all 50.
  const setProduct = (code: RadarProductCode) => {
    if (product.value === code) return
    product.value = code
    productsByStation.value = {}
    failedStations.value = {}
    failedNow.value = {}
  }

  return {
    base,
    product,
    setProduct,
    stations,
    stationsError,
    stationsLoading,
    productsByStation,
    productsLoading,
    loadingStations,
    failedNow,
    clearStationFailures,
    forceFetchProduct,
    fetchStations,
    fetchProduct,
    fetchProducts,
  }
}
