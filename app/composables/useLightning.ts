// Real-time lightning strikes, merged from two feeds of the darma-proxy.
//
// Primary (realtime): a WebSocket relay at `${base}/api/lightning/live`. On
// connect it sends the latest rolling window of strikes immediately, then a
// new window about every 5 s. Each frame is a rolling window, so every
// received frame REPLACES the previous socket strikes — never appends, and a
// strike keeps its FIRST arrival time for as long as later frames re-send it
// (see updateSocketWindow).
//
// Full detail (REST): `${base}/api/lightning` (~3 minutes of strikes,
// refreshed upstream every ~3 min and cached by the proxy for 300 s). Fetched
// ONCE when the layer is switched on, then every 5 minutes (REST_REFRESH_MS).
// It is the only source of polarity, strike_type and kA, and it is also the
// fallback while the socket is down — on the same 5 minute schedule.
//
// The two are merged by mergeLightning() in lib/lightningLive.ts, which also
// owns the arrival-time rule, the match window and the ampere-to-kA
// conversion, so the rules stay pure and testable.

import {
  EMPTY_SOCKET_WINDOW,
  SOCKET_DISPLAY_WINDOW_MS,
  createRestPoller,
  expireSocketWindow,
  liveSocketUrl,
  mergeLightning,
  nextReconnectDelayMs,
  parseLiveFramePacket,
  restErrorMessage,
  shouldUseRestFallback,
  strikesFromFeatures,
  updateSocketWindow,
  type LightningStrike,
  type LiveSocketState,
  type MergeStats,
  type SocketWindow,
} from '../lib/lightningLive'
import { parseLightningSensors, type LightningSensor } from '../lib/lightningSensors'

export type { LightningStrike, MergeStats, LightningSensor }

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

// The REST poll schedule lives in lib/lightningLive.ts (createRestPoller), so
// the 5 minute rule and the fetch-on-enable are unit-tested without Nuxt.

// Module-level so every useLightning() caller shares one poll timer, one
// socket, and one pair of source lists.
let restPoller: ReturnType<typeof createRestPoller> | null = null
let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let watching = false
// The two source lists, kept apart so a socket frame never discards the REST
// details and a REST poll never discards the realtime push. `socketWindow`
// holds the current rolling window plus the keys that already aged out, so a
// strike the feed keeps re-sending cannot be shown twice.
let restStrikes: LightningStrike[] = []
let socketWindow: SocketWindow = EMPTY_SOCKET_WINDOW
// Re-merges on a timer while socket strikes are on screen, so the 3-minute
// display window still expires when no new frame arrives.
let mergeTimer: ReturnType<typeof setInterval> | null = null
// Live socket state, see LiveSocketState.
let connected = false
let hasData = false
let failures = 0
// True while the last transition left the socket unable to feed the UI. Used
// to refresh REST once per outage rather than once per failed reconnect try.
let restingOnRest = false

export const useLightning = () => {
  const base = useRuntimeConfig().public.darmaProxyBase as string

  // The merged list the map draws: REST strikes with full details, plus the
  // socket strikes that no REST strike covered.
  const strikes = useState<LightningStrike[]>('lightning:strikes', () => [])
  const enabled = useState<boolean>('lightning:enabled', () => false)
  const loading = useState<boolean>('lightning:loading', () => false)
  // The last REST failure, as a human-readable string, or null when the last
  // fetch succeeded. A failed poll used to be invisible: the map simply kept
  // the previous strikes with no sign that the feed had stopped answering.
  const restError = useState<string | null>('lightning:restError', () => null)
  // The current socket window, mirrored so callers (the sound cue) can react
  // to NEW realtime strikes only, without REST polls looking like new strikes.
  const socketStrikes = useState<LightningStrike[]>('lightning:socketStrikes', () => [])
  // The BMKG lightning SENSORS carried by the same socket frames (the frame's
  // `sensor` field, parsed by lib/lightningSensors.ts). A SEPARATE list: it
  // never feeds the strike list, and nothing in the strike logic reads it. It
  // is REPLACED whole on every frame, because each frame carries the full
  // sensor set, and it is cleared when the socket drops, exactly like the
  // socket strikes.
  const sensors = useState<LightningSensor[]>('lightning:sensors', () => [])
  // True while the sensor layer is switched on. Frames are only parsed for
  // their sensor list when it is, so a visitor who never turns the layer on
  // pays nothing for it. The map keeps it in step with the LIGHTNING toggle:
  // there is no separate sensors switch.
  const sensorsLayerOn = useState<boolean>('lightning:sensorsLayerOn', () => false)
  // Counters for the last merge (window drops, REST matches, duplicates).
  // No UI reads these; they exist so the merge can be inspected and reported.
  const mergeStats = useState<MergeStats | null>('lightning:mergeStats', () => null)

  function liveState(): LiveSocketState {
    return { connected, hasData, failures }
  }

  /** Re-merges both source lists into the drawn list. */
  function rebuild() {
    const result = mergeLightning(restStrikes, socketWindow.strikes)
    strikes.value = result.strikes
    mergeStats.value = result.stats
    socketStrikes.value = socketWindow.strikes
    // One line per merge so the two sources can be compared at a glance in the
    // browser console: a mismatch (socketTotal below restTotal) means the
    // realtime feed is behind or has dropped out.
    console.info(
      `[lightning] merged ${result.stats.merged} strikes — REST ${result.stats.restTotal}, socket ${result.stats.socketTotal}`,
    )
  }

  async function fetchLightning() {
    if (!enabled.value) return
    loading.value = true
    try {
      const res = await $fetch<LightningEnvelope>(`${base}/api/lightning`)
      // The layer may have been switched off while the request was in flight.
      if (enabled.value && res?.ok) {
        restStrikes = res.data?.strikes ?? []
        // The feed answered again: the previous failure is over.
        restError.value = null
        rebuild()
      } else if (enabled.value) {
        // A 200 that carries no usable payload is a failure too.
        restError.value = 'REST lightning returned no usable data'
        console.warn('[lightning] REST lightning returned no usable data')
      }
    } catch (err) {
      // Keep the previous strikes, but say so: the next poll will retry.
      const message = restErrorMessage(err)
      restError.value = message
      console.warn(`[lightning] REST lightning fetch failed: ${message}`)
    } finally {
      loading.value = false
    }
  }

  function applyLiveFrame(raw: string) {
    const packet = parseLiveFramePacket(raw)
    if (!packet) return
    const fc = packet.features
    // A successful message resets the consecutive-failure count.
    failures = 0
    hasData = true
    // The socket is feeding again: the next outage must refresh REST once more.
    restingOnRest = false
    // The arrival time is the moment WE received this frame. The feed's own
    // timestamps are ignored (they are dated days to years in the future).
    const arrivedMs = Date.now()
    // The sensor list rides in the same frame, on its own path: replaced here
    // and read by nobody in the merge below.
    if (sensorsLayerOn.value) sensors.value = parseLightningSensors(packet.sensor)
    // Rolling window: keep only strikes that this newest frame still carries
    // AND that are inside the display window; each keeps its first-seen stamp.
    socketWindow = updateSocketWindow(
      socketWindow,
      strikesFromFeatures(fc, arrivedMs),
      arrivedMs,
    )
    rebuild()
  }

  function openSocket() {
    if (typeof WebSocket === 'undefined') return // SSR or no WS support: REST only.
    const ws = new WebSocket(liveSocketUrl(base))
    socket = ws
    ws.onopen = () => {
      connected = true
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') applyLiveFrame(ev.data)
    }
    // The browser always fires onclose after onerror, so the teardown,
    // fallback and reconnect live there.
    ws.onclose = () => {
      socket = null
      connected = false
      // No frame has arrived on the NEXT connection yet, so the socket is not
      // feeding until it does (a reconnect can open and then die).
      hasData = false
      // The socket's strikes are stale now; drop them instead of drawing a
      // frozen window, and fall back to the REST list alone.
      socketWindow = EMPTY_SOCKET_WINDOW
      // The sensors are a live-only readout: a stale one would keep claiming a
      // station is online while the feed is down.
      sensors.value = []
      rebuild()
      if (!enabled.value) return
      // The socket stopped feeding. The REST poller is already running on its
      // 5 minute schedule; refresh once here so the map does not sit on a
      // stale window while it reconnects. This is a single refresh on a state
      // transition, NOT a second poller — the reconnect loop can run for
      // minutes, and `restingOnRest` makes sure it happens once per outage.
      if (shouldUseRestFallback(liveState()) && !restingOnRest) {
        restingOnRest = true
        void fetchLightning()
      }
      // Back off based on how many failures are already in a row, then
      // count this one (first retry waits 1 s, capped at 30 s).
      scheduleReconnect()
      failures++
    }
  }

  function scheduleReconnect() {
    if (!enabled.value || socket || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openSocket()
    }, nextReconnectDelayMs(failures))
  }

  // Drops the socket and any pending reconnect. The layer toggle-off, the
  // unmount (via stopAutoRefresh) and startAutoRefresh's re-start all route
  // through here.
  function clearSocket() {
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
      socket = null
    }
    connected = false
    hasData = false
    restingOnRest = false
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function stopAutoRefresh() {
    if (restPoller) restPoller.stop()
    if (mergeTimer) {
      clearInterval(mergeTimer)
      mergeTimer = null
    }
    clearSocket()
    // A sensor readout from a closed socket is stale too.
    sensors.value = []
  }

  function startAutoRefresh() {
    stopAutoRefresh()
    if (!enabled.value) return
    // REST: one fetch now, then every 5 minutes (the proxy caches it for 300 s,
    // so a shorter interval only re-reads the same payload). The poller also
    // serves as the socket-down fallback, on that same schedule.
    restPoller = createRestPoller(() => void fetchLightning())
    restPoller.start()
    // Open the live connection now; socket frames keep arriving on their own.
    openSocket()
    // Expire socket strikes on time even if the next frame never arrives.
    mergeTimer = setInterval(() => {
      socketWindow = expireSocketWindow(socketWindow, Date.now())
      rebuild()
    }, SOCKET_DISPLAY_WINDOW_MS / 6)
  }

  // Drops both source lists and the merged list, without touching the
  // `enabled` preference. Called when the layer is switched off.
  function reset() {
    restStrikes = []
    socketWindow = EMPTY_SOCKET_WINDOW
    strikes.value = []
    socketStrikes.value = []
    sensors.value = []
    mergeStats.value = null
    restError.value = null
  }

  if (!watching) {
    watching = true
    watch(enabled, (on) => {
      if (on) {
        // startAutoRefresh() fetches REST once up front, so no separate call.
        startAutoRefresh()
      } else {
        stopAutoRefresh()
        reset()
      }
    })
  }

  return {
    strikes,
    socketStrikes,
    sensors,
    sensorsLayerOn,
    enabled,
    loading,
    restError,
    mergeStats,
    fetchLightning,
    startAutoRefresh,
    stopAutoRefresh,
    reset,
  }
}
