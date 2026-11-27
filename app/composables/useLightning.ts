// Real-time lightning strikes from the darma-proxy-rust-cloudflare API.
// The endpoint returns ~3 minutes of strikes, refreshed upstream every ~3 min
// and cached by the proxy for 60s, so we poll every 90s and only while the
// layer is switched on.

export interface LightningStrike {
  time_utc: string
  lat: number
  lon: number
  current_ka: number
  polarity: string
  strike_type: string
}

export interface LightningData {
  total: number
  strikes: LightningStrike[]
}

interface LightningEnvelope {
  ok: boolean
  cached: boolean
  cache_age_seconds: number
  pulled_at_utc: string
  data: LightningData
}

const REFRESH_MS = 90_000

// Module-level so every useLightning() caller shares one poll timer.
let timer: ReturnType<typeof setInterval> | null = null
let watching = false

export const useLightning = () => {
  const base = useRuntimeConfig().public.darmaProxyBase as string

  const strikes = useState<LightningStrike[]>('lightning:strikes', () => [])
  const enabled = useState<boolean>('lightning:enabled', () => false)
  const loading = useState<boolean>('lightning:loading', () => false)

  async function fetchLightning() {
    if (!enabled.value) return
    loading.value = true
    try {
      const res = await $fetch<LightningEnvelope>(`${base}/api/lightning`)
      // The layer may have been switched off while the request was in flight.
      if (enabled.value && res?.ok) strikes.value = res.data?.strikes ?? []
    } catch {
      // Keep the previous strikes; the next poll will retry.
    } finally {
      loading.value = false
    }
  }

  function stopAutoRefresh() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh()
    if (!enabled.value) return
    timer = setInterval(() => void fetchLightning(), REFRESH_MS)
  }

  if (!watching) {
    watching = true
    watch(enabled, (on) => {
      if (on) {
        void fetchLightning()
        startAutoRefresh()
      } else {
        stopAutoRefresh()
        strikes.value = []
      }
    })
  }

  return { strikes, enabled, loading, fetchLightning, startAutoRefresh, stopAutoRefresh }
}
