// Wraps `/api/archive/{station}?product=...&start=YYYYMMDDHHmm&end=...`.
// Frames come back ordered oldest -> newest and share the live `RadarFrame`
// shape, so the existing timeline + image cache keep working.

import type { Ref } from 'vue'
import type { RadarFrame } from './useRadarApi'
import { useRadarApi } from './useRadarApi'
import { withRetry } from './useRadarFetch'

interface ArchiveEnvelope {
  ok: boolean
  data?: { station: string, product: string, start_utc: string, end_utc: string, frames: RadarFrame[] }
  error?: string
  message?: string
}

export type RangeOption = '1h' | '6h' | '24h'

const RANGE_HOURS: Record<RangeOption, number> = { '1h': 1, '6h': 6, '24h': 24 }

export const useRadarArchive = () => {
  const { base, product: productRef, stations } = useRadarApi()

  const stationId = useState<string | null>('radar:archive:station', () => null)
  const range = useState<RangeOption>('radar:archive:range', () => '1h')
  // `now` is captured each time the user changes the range so the window
  // stays anchored to the latest frame we asked for. We keep the same
  // endUtc across re-picks for stability.
  const endUtc = useState<string | null>('radar:archive:endUtc', () => null)
  const frames = useState<RadarFrame[]>('radar:archive:frames', () => [])
  const loading = useState<boolean>('radar:archive:loading', () => false)
  const error = useState<string | null>('radar:archive:error', () => null)
  const lastFetchKey = useState<string | null>('radar:archive:key', () => null)

  let inflight: AbortController | null = null
  let latestToken = 0

  // Window bounds: archive is the most recent `range` hours ending at
  // `endUtc` (or "now" if not set). Clamp the start to the proxy's 48h
  // rule — anything earlier returns 400 and we don't want to retry.
  function windowFor(option: RangeOption, endsAt: Date): { start: Date, end: Date } {
    const end = new Date(endsAt)
    end.setUTCSeconds(0, 0)
    const start = new Date(end.getTime() - RANGE_HOURS[option] * 3_600_000)
    const earliest = new Date(Date.now() - 48 * 3_600_000)
    if (start < earliest) start.setTime(earliest.getTime())
    return { start, end }
  }

  function compact(date: Date): string {
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}`
  }

  function parseUtcMinute(s: string | null): Date | null {
    if (!s || s.length < 12) return null
    const y = +s.slice(0, 4)
    const m = +s.slice(4, 6) - 1
    const d = +s.slice(6, 8)
    const h = +s.slice(8, 10)
    const n = +s.slice(10, 12)
    const date = new Date(Date.UTC(y, m, d, h, n))
    return Number.isNaN(date.getTime()) ? null : date
  }

  async function setStation(id: string | null) {
    stationId.value = id
    if (id) await fetch()
  }

  async function setRange(option: RangeOption) {
    range.value = option
    await fetch()
  }

  async function shift(minutes: number) {
    const endsAt = parseUtcMinute(endUtc.value) ?? new Date()
    endsAt.setUTCMinutes(endsAt.getUTCMinutes() + minutes)
    endUtc.value = compact(endsAt)
    await fetch()
  }

  async function goToNow() {
    endUtc.value = null
    await fetch()
  }

  async function fetch() {
    if (!stationId.value) return
    inflight?.abort()
    const ac = new AbortController()
    inflight = ac
    // Every call gets a token; only the newest one may write state. Without
    // it, the aborted request's catch block could clear the frames that the
    // newer request had already stored.
    const token = ++latestToken
    const station = stationId.value
    const code = productRef.value
    const endsAt = parseUtcMinute(endUtc.value) ?? new Date()
    const { start, end } = windowFor(range.value, endsAt)
    const startCompact = compact(start)
    const endCompact = compact(end)
    const key = `${station}:${code}:${startCompact}:${endCompact}`
    if (key === lastFetchKey.value && frames.value.length) return
    loading.value = true
    error.value = null
    try {
      const params = new URLSearchParams({ product: code, start: startCompact, end: endCompact })
      const res = await withRetry(
        () => $fetch<ArchiveEnvelope>(`${base}/api/archive/${station}?${params}`, { signal: ac.signal }),
        { signal: ac.signal },
      )
      // A newer request superseded this one: drop the result entirely.
      if (token !== latestToken) return
      if (!res.ok) throw new Error(res.message ?? res.error ?? 'archive request failed')
      const data = res.data
      endUtc.value = (data?.end_utc ?? end.toISOString()).replace(/[-:]/g, '').slice(0, 12)
      frames.value = data?.frames ?? []
      lastFetchKey.value = key
    } catch (e) {
      // A superseded request must never touch state, otherwise its catch
      // would clear frames the newer request already stored.
      if (token !== latestToken) return
      error.value = e instanceof Error ? e.message : 'archive request failed'
      frames.value = []
    } finally {
      if (token === latestToken) loading.value = false
      if (inflight === ac) inflight = null
    }
  }

  function clear() {
    inflight?.abort()
    frames.value = []
    endUtc.value = null
    lastFetchKey.value = null
    error.value = null
  }

  return {
    stationId: stationId as Ref<string | null>,
    range: range as Ref<RangeOption>,
    endUtc: endUtc as Ref<string | null>,
    frames: frames as Ref<RadarFrame[]>,
    loading: loading as Ref<boolean>,
    error: error as Ref<string | null>,
    stations,
    setStation,
    setRange,
    shift,
    goToNow,
    fetch,
    clear,
  }
}
