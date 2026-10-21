<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onUnmounted, watch } from 'vue'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Map as MaplibreMap, StyleSpecification } from 'maplibre-gl'
// MapLibre builds its worker URL with a DYNAMIC template literal
// (`new URL(\`./${name}\`, import.meta.url)`), so Vite cannot statically
// analyse it and the worker file is left out of the production bundle.
// Without it the basemap silently fails with "Worker failed to load" and the
// map renders empty. Importing it with ?url makes Vite emit it as an asset,
// and setWorkerUrl points MapLibre at the emitted copy.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { useRadarApi, type RadarFrame, type RadarStation, type RadarTimeseries, type RadarVcut } from '~/composables/useRadarApi'
import { useRadarArchive } from '~/composables/useRadarArchive'
import { radarProductInfo } from '~/composables/radarProducts'
import { useRadarTimeline } from '~/composables/useRadarTimeline'
import { getCachedLocation, lookupUserLocation, inCoverage } from '~/composables/useUserLocation'
import { createBitmapScaler, useRadarCanvasOverlay, BITMAP_DEFAULT_EDGE, type RadarOverlayStation } from '~/composables/useRadarCanvasOverlay'
import { HoverCardRoot, HoverCardContent, HoverCardPortal, HoverCardTrigger } from 'reka-ui'

const {
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
  product,
  setProduct,
  fetchProducts,
  base,
} = useRadarApi()
const archive = useRadarArchive()
const mode = ref<'live' | 'archive'>('live')

// Basemap follows the app theme.
const colorMode = useColorMode()

const mapContainer = ref<HTMLDivElement | null>(null)
const mapReady = ref(false)
const vcutMode = ref(false)
const vcutStart = ref<[number, number] | null>(null)
const vcutEnd = ref<[number, number] | null>(null)
const vcutLoading = ref(false)
const vcutError = ref('')
const vcutResult = ref<RadarVcut | null>(null)
const timeseriesOpen = ref(false)
const timeseriesLoading = ref(false)
const timeseriesError = ref('')
const timeseriesResult = ref<RadarTimeseries | null>(null)
let map: MaplibreMap | null = null

// 'all' shows every station's frame; 'selected' shows only the picked
// station's frame, dimming the rest. Picking happens through the
// dropdown, not by clicking the badges on the map.
const viewMode = ref<'all' | 'selected'>('all')
const selectedStationId = ref<string | null>(null)
// Station whose dot is under the pointer. Drives the image fade and its name tag.
const hoveredId = ref<string | null>(null)
const vcutStartScreen = computed(() => {
  void overlayPos.value
  if (!map || !vcutStart.value) return null
  const p = map.project(vcutStart.value)
  return { x: p.x, y: p.y }
})
const vcutEndScreen = computed(() => {
  void overlayPos.value
  if (!map || !vcutEnd.value) return null
  const p = map.project(vcutEnd.value)
  return { x: p.x, y: p.y }
})

const DEFAULT_VIEW = { center: [118, -2.5] as [number, number], zoom: 4 }
// Zoom for a located visitor: a region with nearby radars, not the country.
const LOCAL_ZOOM = 7

function pickStation(id: string | null) {
  selectedStationId.value = id
  viewMode.value = id ? 'selected' : 'all'
  // Only stations in view are loaded, so bring the picked one into view.
  const s = id ? stations.value.find(x => x.id === id) : null
  if (s && map) {
    map.flyTo({ center: [s.lon, s.lat], zoom: map.getZoom(), essential: true })
  }
}

interface RadarEnvelope<T> {
  ok: boolean
  data: T
  error?: string
  message?: string
}

function formatUtcMinute(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}`
}

function vcutStationFor(start: [number, number], end: [number, number]) {
  const midpoint: [number, number] = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]
  let nearest: RadarStation | null = null
  let distance = Infinity
  for (const station of stations.value) {
    const d = (station.lon - midpoint[0]) ** 2 * Math.cos(midpoint[1] * Math.PI / 180) ** 2 + (station.lat - midpoint[1]) ** 2
    if (d < distance) { distance = d; nearest = station }
  }
  return nearest
}

function startVcut() {
  vcutMode.value = true
  vcutStart.value = null
  vcutEnd.value = null
  vcutError.value = ''
  vcutResult.value = null
  timeseriesOpen.value = false
  timeseriesResult.value = null
}

function cancelVcut() {
  vcutMode.value = false
  vcutStart.value = null
  vcutEnd.value = null
  if (map) map.getCanvas().style.cursor = ''
}

// Dismissing the result must also clear the drawn line and its endpoint
// markers, not just hide the panel.
function closeVcutResult() {
  vcutResult.value = null
  vcutError.value = ''
  vcutStart.value = null
  vcutEnd.value = null
}

async function requestVcut(start: [number, number], end: [number, number]) {
  const station = vcutStationFor(start, end)
  if (!station) { vcutError.value = 'Radar station list is not ready.'; vcutMode.value = false; return }
  const latestTime = productsByStation.value[station.id]?.latest?.time_utc
  const date = latestTime ? new Date(latestTime) : new Date(Date.now() - 5 * 60_000)
  date.setUTCSeconds(0, 0)
  vcutLoading.value = true
  vcutError.value = ''
  vcutResult.value = null
  vcutMode.value = false
  try {
    const params = new URLSearchParams({
      start_lat: String(start[1]), start_lon: String(start[0]),
      stop_lat: String(end[1]), stop_lon: String(end[0]),
      datetime: formatUtcMinute(date),
    })
    const res = await $fetch<RadarEnvelope<RadarVcut>>(`${base}/api/vcut/${station.id}?${params}`)
    if (!res.ok) throw new Error(res.message ?? res.error ?? 'Could not generate vertical cut.')
    if (!res.data?.image_url || /\/nodata\.png(?:$|\?)/i.test(res.data.image_url)) {
      throw new Error('No vertical-cut data is available for that time. Try a different line or a more recent observation.')
    }
    vcutResult.value = res.data
  } catch (e) {
    // Surface a short, user-readable message; the raw URL/status stays in
    // the console for debugging.
    console.warn('[radar] vcut failed', e)
    vcutError.value = friendlyVcutError(e)
  } finally {
    vcutLoading.value = false
  }
}

function friendlyVcutError(e: unknown): string {
  // Surface a short, user-readable reason. We strip the verbose fetch wrapper
  // ("[GET] \"...\" <no response> Failed to fetch") but keep any upstream
  // message so a 400 from the proxy still tells the user why.
  const raw = (e instanceof Error ? e.message : String(e)) || ''
  const cleaned = raw
    .replace(/^\[GET\]\s*"?[^"]*"?\s*/i, '')
    .replace(/\s*<no response>\s*$/i, '')
    .trim()
  if (/Failed to fetch|NetworkError/i.test(raw)) return 'Could not reach the radar proxy. Check your connection and try again.'
  if (cleaned) return cleaned.length > 200 ? cleaned.slice(0, 200) + '…' : cleaned
  return 'Could not generate vertical cut. Please try again.'
}

async function requestTimeseries(lngLat: { lat: number, lng: number }) {
  if (!selectedStationId.value) {
    timeseriesError.value = 'Select a radar station first.'
    timeseriesOpen.value = true
    return
  }
  timeseriesOpen.value = true
  timeseriesLoading.value = true
  timeseriesError.value = ''
  timeseriesResult.value = null
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const params = new URLSearchParams({ lat: String(lngLat.lat), lon: String(lngLat.lng), date })
  try {
    const res = await $fetch<RadarEnvelope<RadarTimeseries>>(`${base}/api/timeseries/${selectedStationId.value}?${params}`)
    if (!res.ok) throw new Error(res.message ?? res.error ?? 'Could not load point forecast.')
    timeseriesResult.value = res.data
  } catch (e) {
    timeseriesError.value = e instanceof Error ? e.message : 'Could not load point forecast.'
  } finally {
    timeseriesLoading.value = false
  }
}

function handleMapClick(e: maplibregl.MapMouseEvent) {
  if (vcutMode.value) {
    const point: [number, number] = [e.lngLat.lng, e.lngLat.lat]
    if (!vcutStart.value) {
      vcutStart.value = point
      map?.getCanvas().style.setProperty('cursor', 'crosshair')
    } else {
      vcutEnd.value = point
      map?.getCanvas().style.setProperty('cursor', '')
      void requestVcut(vcutStart.value, point)
    }
    return
  }
  if (e.originalEvent.altKey) void requestTimeseries(e.lngLat)
}

function handleMapMove() {
  if (vcutMode.value && map) map.getCanvas().style.cursor = 'crosshair'
}

// Client-side image cache with request de-duplication.
//
// Why this exists: without it the timeline advancing and Vue's re-render
// would each fire a fresh network request for the SAME frame URL, which
// hammered the bucket with duplicate requests and broke it.
//
// Guarantees:
//  - A URL is fetched at most once. Re-requesting an in-flight URL returns
//    the same <img> element and never re-issues the network request.
//  - A URL that already failed is not retried (backed off into a small map).
//  - LRU eviction keeps decoded bitmaps bounded.

interface CacheEntry {
  img: HTMLImageElement
  // Downscaled canvas holding the same pixels. This is what gets drawn; the
  // 64 MB source decode is released as soon as it exists.
  bitmap: CanvasImageSource | null
  done: boolean
  failed: boolean
  lastUsed: number
}

// Draws each frame once into a ~1024px canvas and drops the full-size
// decode. See useRadarCanvasOverlay.ts for the measurements behind this.
const bitmapScaler = createBitmapScaler()

const imageCache = new Map<string, CacheEntry>()
// Bumped whenever an image finishes loading (or fails) so Vue re-renders the
// overlays with the now-cached <img>. Without this the template would keep
// seeing `undefined` and never show the radar.
const imageEpoch = ref(0)
function bumpEpoch() {
  imageEpoch.value++
}
// Number of image requests in flight (raw network, not the in-memory cache).
// The chip in the legend reads this together with `productsLoading` from the
// API composable so the user always sees a real loading state.
const imagesInFlight = ref(0)
function incInflight() { imagesInFlight.value++ }
function decInflight() { imagesInFlight.value = Math.max(0, imagesInFlight.value - 1) }
// Entries kept after use. One product is at most ~50 stations x 11 frames
// = 550 URLs, so 600 means each frame is requested once per session.
const MAX_CACHED = 600
// Frames pre-loaded ahead of the playhead (also protected from eviction).
const WARM_AHEAD = 2
// Cache of URLs that failed, so we don't retry a broken frame every tick.
const FAILED_URLS = new Map<string, number>()
const failedImageStations = ref<Record<string, true>>({})
// A failed frame is retried only after this long (frames can appear later).
const FAIL_RETRY_MS = 5 * 60 * 1000

function noteImageFailure(url: string) {
  FAILED_URLS.set(url, Date.now())
  // Frame URLs include the station code in the filename (e.g. SBY-...).
  const filename = url.split('/').pop()?.split('-')[0]
  const stationId = filename?.match(/^[A-Z0-9]{2,5}$/)?.[0]
  if (stationId) failedImageStations.value = { ...failedImageStations.value, [stationId]: true }
}

function clearImageFailure(url: string) {
  FAILED_URLS.delete(url)
  const filename = url.split('/').pop()?.split('-')[0]
  const stationId = filename?.match(/^[A-Z0-9]{2,5}$/)?.[0]
  if (stationId && failedImageStations.value[stationId]) {
    failedImageStations.value = { ...failedImageStations.value }
    delete failedImageStations.value[stationId]
  }
}

function touch(url: string) {
  const e = imageCache.get(url)
  if (e) e.lastUsed = Date.now()
}

// Bounded-concurrency loader. Creating ~150 Image objects at once (50
// stations x 3 warm frames) slammed the bucket with parallel requests and
// tripped its limits. We cap how many can be in flight at once; the rest
// queue and start as earlier ones settle.
//
// One entry per URL, created on first request and mutated in place. A
// repeat request for a URL that is queued or in flight returns that same
// entry, so the network sees exactly one request per URL.
const MAX_INFLIGHT = 6
const queue: string[] = []
let inFlight = 0

// Radar frames come from darma-bucket-proxy.lleans.dev, where Cloudflare
// Hotlink Protection answers 403 (error 1011) to any request carrying a
// Referer outside *.lleans.dev. Browsers send one by default (localhost in
// dev), so every radar image request must go out with `no-referrer`.
// This is deliberately per-request, not a page-wide <meta name="referrer">,
// because the OSM tile servers expect a Referer.
//
// Radar images are also always requested in plain (no-CORS) mode, never with
// `crossorigin`. A <img> doesn't need CORS to display, and mixing modes for
// one URL breaks: the cached no-CORS copy has no CORS headers, so a later
// CORS-mode request for the same URL fails.
function startLoad(url: string, entry: CacheEntry) {
  const img = new Image()
  img.decoding = 'async'
  img.referrerPolicy = 'no-referrer'
  entry.img = img
  inFlight++
  // Only a URL that actually starts going over the wire is counted, and its
  // matching decrement lives in the same settled done() below.
  incInflight()

  // `done()` must run exactly once per load. Clearing `img.src` below to
  // release the decoded bitmap fires `onerror` again, so a settled guard is
  // required here — without it the queue counters drift and `pumpQueue`
  // spins, which showed up as periodic CPU spikes.
  let settled = false
  let attempt = 1
  const MAX_IMAGE_ATTEMPTS = 3
  const done = () => {
    if (settled) return
    settled = true
    inFlight--
    decInflight()
    evictIfNeeded()
    bumpEpoch()
    pumpQueue()
  }
  const attachHandlers = () => {
    img.onload = () => {
    // Draw down to ~1024px immediately, then release the 4084x4084 decode
    // (64 MB) so it is not held for the life of the tab. Frames whose
    // bitmap already exists (cached) skip this entirely.
    entry.bitmap = bitmapScaler.scale(url, img)
    entry.done = true
    if (entry.bitmap) clearImageFailure(url)
    // Detach the <img> so the browser can reclaim the full-size decode.
    // Using removeAttribute (rather than `src = ''`) avoids kicking off a
    // spurious request against the page URL.
    img.removeAttribute('src')
    img.onload = null
    img.onerror = null
    done()
  }
    img.onerror = () => {
      if (attempt < MAX_IMAGE_ATTEMPTS && imageCache.get(url) === entry) {
        // Retry after a short backoff. CORS/proxy deploy blips can cause
        // transient image errors; do not mark the station failed until all
        // three attempts actually fail.
        const delay = 350 * 2 ** (attempt - 1)
        attempt++
        setTimeout(() => {
          if (settled || imageCache.get(url) !== entry) return
          img.src = url
        }, delay)
        return
      }
      entry.failed = true
      entry.done = true
      noteImageFailure(url)
      bitmapScaler.dispose(url)
      done()
    }
  }
  attachHandlers()
  img.src = url
}

// Kick the queue: start any queued URL whose entry still exists.
function pumpQueue() {
  while (inFlight < MAX_INFLIGHT && queue.length > 0) {
    const url = queue.shift()
    if (!url) break
    const entry = imageCache.get(url)
    if (!entry || entry.done || entry.failed) continue
    startLoad(url, entry)
  }
}

/**
 * Returns the cached entry for `url`, creating and queueing it on first
 * request. Never issues a duplicate network request for the same URL.
 */
function loadImage(url: string): CacheEntry | null {
  // Don't retry known-bad URLs until the retry window elapses.
  const failAt = FAILED_URLS.get(url)
  if (failAt !== undefined) {
    if (Date.now() - failAt < FAIL_RETRY_MS) return null
    FAILED_URLS.delete(url)
  }

  const existing = imageCache.get(url)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing
  }
  // Queued, not yet requested. The in-flight counter is incremented in
  // startLoad(), next to its matching decrement, so the two can never drift
  // when an entry is evicted or dropped while still queued.
  const entry: CacheEntry = {
    img: new Image(),
    bitmap: null,
    done: false,
    failed: false,
    lastUsed: Date.now(),
  }
  imageCache.set(url, entry)
  queue.push(url)
  pumpQueue()
  return entry
}

// URLs on screen or about to be: the playhead frame plus WARM_AHEAD, for every
// station in view. These are never evicted. The old LRU only counted loadImage()
// calls, so the frame being displayed looked "old", got evicted, its <img>
// vanished from the map and the frame was requested again.
function protectedUrls(): Set<string> {
  const keep = new Set<string>()
  for (const id of visibleIds.value) {
    const p = productsByStation.value[id]
    const n = p?.last_hour.length ?? 0
    for (let off = 0; n > 0 && off <= WARM_AHEAD; off++) {
      const url = p!.last_hour[(frameIdx.value + off) % n]?.url
      if (url) keep.add(url)
    }
  }
  return keep
}

function evictIfNeeded() {
  if (imageCache.size <= MAX_CACHED) return
  const keep = protectedUrls()
  const victims = [...imageCache.entries()]
    .filter(([url, e]) => e.done && !keep.has(url))
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  const excess = imageCache.size - MAX_CACHED
  for (let i = 0; i < excess && i < victims.length; i++) {
    const victim = victims[i]
    if (victim) {
      imageCache.delete(victim[0])
      bitmapScaler.dispose(victim[0])
    }
  }
}

// Drop any cached element for a URL so a fresh fetch happens next time
// (used after the 5-minute refresh so new frames replace old ones).
function invalidateUrl(url: string) {
  imageCache.delete(url)
}

function cacheStats() {
  let inFlight = 0
  let done = 0
  for (const e of imageCache.values()) {
    if (!e.done) inFlight++
    else done++
  }
  return { total: imageCache.size, inFlight, done, failed: FAILED_URLS.size }
}

// Real-world footprint of a station frame: a 4084 px square centred on the
// radar, edge to edge = 2 x this radius. The handoff doc says "~240 km", but
// BMKG's own app puts the tips of the long rays in SBY's 03:18Z frame
// (1,967 px from the image centre) 241-243 km from the radar, which gives
// 0.123 km/px, i.e. ~250 km to the image edge.
const STATION_RADIUS_KM = 250
// Keep tiny circles visible when zoomed far out.
const MIN_FRAME_PX = 44
// Kilometres per degree of longitude at the equator (WGS84 / EPSG:3857 sphere).
const KM_PER_DEG_LON_EQUATOR = 111.32

// Diameter of the radar footprint in screen px, measured with MapLibre's own
// projection (so it follows whatever zoom / tile size / projection the map
// uses) between the points one radius west and east of the station.
function frameSizePx(mapRef: MaplibreMap, lon: number, lat: number): number {
  const dLon = STATION_RADIUS_KM / (KM_PER_DEG_LON_EQUATOR * Math.cos((lat * Math.PI) / 180))
  const west = mapRef.project([lon - dLon, lat])
  const east = mapRef.project([lon + dLon, lat])
  return Math.max(MIN_FRAME_PX, Math.abs(east.x - west.x))
}

const overlayPos = ref<Record<string, { x: number; y: number; size: number }>>({})
const viewportSize = ref({ w: 0, h: 0 })

// Assigned once the overlay canvas is created. refreshProjections() runs on
// every map move, so the radar repaint has to happen there too.
let repaintOverlay: () => void = () => {}

function refreshProjections() {
  if (!map) return
  const canvas = map.getCanvas()
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  viewportSize.value = { w, h }
  const next: Record<string, { x: number; y: number; size: number }> = {}
  for (const s of stations.value) {
    // MapLibre's own projection: exactly where the basemap draws this coordinate.
    const p = map.project([s.lon, s.lat])
    next[s.id] = { x: p.x, y: p.y, size: frameSizePx(map, s.lon, s.lat) }
  }
  overlayPos.value = next
  // Repaint in the same frame the positions changed, so the radar tracks
  // the map exactly instead of trailing it while the basemap slides.
  repaintOverlay()
}

let raf = 0
function rafRefresh() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(refreshProjections)
}

// Only stations near the viewport are fetched, rendered and cached; the rest
// are never requested. Opening on the visitor's region therefore loads a
// handful of radars instead of all 50.
const VIEW_MARGIN_PX = 120 // pre-load a little past the edge so short pans feel instant
// How much of a station's footprint (in CSS px) must land on screen before we
// fetch its 11 frames. A frame is ~500 km across, so a neighbour whose circle
// only grazes the edge costs a full set of downloads for a sliver.
//
// This is an absolute area, NOT a fraction of the frame: a fraction inverts
// exactly when you zoom in, because the frame grows with the map while the
// viewport does not. (A frame-fraction test made every station disappear at
// close zoom.) 4000 px ~= a 63 px edge — enough to see the echo arrive, far
// less than the ~500 px slivers worth skipping.
const MIN_VISIBLE_AREA_PX = 4000
const visibleIds = shallowRef<Set<string>>(new Set())
// False until the start view is decided, so the default country view can't
// trigger a whole-country load before we know where the visitor is.
let viewReady = false

function sameSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

function updateVisible() {
  if (!viewReady) return
  const { w, h } = viewportSize.value
  if (!w || !h) return
  const next = new Set<string>()
  for (const s of stations.value) {
    const p = overlayPos.value[s.id]
    if (!p) continue
    const r = p.size / 2 + VIEW_MARGIN_PX
    if (p.x + r < 0 || p.x - r > w || p.y + r < 0 || p.y - r > h) continue
    // Overlap test passed; now require a useful amount of footprint.
    const half = Math.max(1, p.size / 2)
    const overlapW = Math.min(p.x + half, w) - Math.max(p.x - half, 0)
    const overlapH = Math.min(p.y + half, h) - Math.max(p.y - half, 0)
    if (overlapW * overlapH >= MIN_VISIBLE_AREA_PX) next.add(s.id)
  }
  if (!sameSet(visibleIds.value, next)) visibleIds.value = next
}

const visibleStations = computed(() => stations.value.filter(s => visibleIds.value.has(s.id)))

// Recompute which stations are in view. This also decides what gets fetched,
// so it is debounced: a pan fires `move` continuously and re-testing every
// frame would thrash the fetch queue.
let visibleTimer: ReturnType<typeof setTimeout> | null = null
function scheduleVisibleUpdate(delay = 100) {
  if (visibleTimer) clearTimeout(visibleTimer)
  visibleTimer = setTimeout(() => {
    visibleTimer = null
    refreshProjections()
    updateVisible()
  }, delay)
}

// Fetch the stations in view that don't have the current product yet.
function loadVisible() {
  const ids = [...visibleIds.value]
  if (ids.length) fetchProducts(ids, 6)
}
watch(visibleIds, loadVisible)
watch(product, loadVisible)

let resizeObserver: ResizeObserver | null = null
function setupResizeObserver() {
  if (typeof ResizeObserver === 'undefined' || !mapContainer.value) return
  resizeObserver = new ResizeObserver((entries) => {
    // Fire a map resize + projection refresh on any layout change
    map?.resize()
    refreshProjections()
    scheduleVisibleUpdate()
  })
  resizeObserver.observe(mapContainer.value)
}

const LIVE_WINDOW_MS = 60 * 60 * 1000
const LIVE_STEP_MS = 5 * 60 * 1000

function frameTime(frame: RadarFrame): number | null {
  const t = Date.parse(frame.time_utc)
  return Number.isFinite(t) ? t : null
}

// Live feeds do NOT share frame cadence: SMG can report every 10 min, JAK
// every 8 min, and SBY can vary 5–7 min. Build one common one-hour, 5-min
// playback clock; each station selects its newest actual frame at or before
// each clock tick. This merges the uneven upstream scans instead of using the
// same array index across stations (the source of mismatched/blank moments).
const liveWindowEnd = ref(0)
const liveWindowCaptured = ref(false)
watch(productsByStation, (products) => {
  // Capture the live window once, when the first viewport feed arrives. Do not
  // move the timeline as the user pans into a station with a slightly newer
  // scan; stations align to this stable one-hour clock and hold their last
  // available frame between their own scans.
  if (liveWindowCaptured.value) return
  let newest = 0
  for (const p of Object.values(products)) {
    for (const f of p?.last_hour ?? []) {
      const t = frameTime(f)
      if (t && t > newest) newest = t
    }
  }
  if (newest) {
    liveWindowEnd.value = Math.floor(newest / LIVE_STEP_MS) * LIVE_STEP_MS
    liveWindowCaptured.value = true
  }
}, { immediate: true })
watch(mode, (next) => {
  if (next === 'live') liveWindowCaptured.value = false
})

const liveFramesRef = computed<RadarFrame[]>(() => {
  if (!liveWindowEnd.value) return []
  const frames: RadarFrame[] = []
  for (let t = liveWindowEnd.value - LIVE_WINDOW_MS; t <= liveWindowEnd.value; t += LIVE_STEP_MS) {
    frames.push({ url: '', time_utc: new Date(t).toISOString(), forecast_offset_minutes: null })
  }
  return frames
})

// The timeline runs off either the live one-hour feed or the archive window
// picked via RadarTimeRangeBar. In archive mode the picker's frames are used
// directly, so warm-ahead / cache / image dedup logic stays the same.
const framesRef = computed<RadarFrame[]>(() =>
  mode.value === 'archive' ? archive.frames.value : liveFramesRef.value,
)

const { idx: frameIdx, playing, currentFrame, play, pause, seek, speed, setSpeed, hold } =
  useRadarTimeline(framesRef)

// Mode change re-keys the timeline so the playhead jumps to the first
// frame of the new source. Switching to archive uses the picked station
// (or the first one in the live data) as the anchor.
watch(mode, (next) => {
  if (next === 'archive') {
    const id = selectedStationId.value ?? Object.keys(productsByStation.value)[0] ?? null
    if (id) void archive.setStation(id)
  } else {
    archive.clear()
  }
  seek(0)
})
// Product / station changes refetch the picked archive window.
watch([() => product.value, () => selectedStationId.value], ([, station]) => {
  if (mode.value === 'archive' && station) void archive.setStation(station)
})

// Any interaction with the map (drag, zoom, wheel, touch, keys) freezes the
// animation on its current frame until the user stops.
let userMoved = false
function onMapInteract() {
  userMoved = true
  hold()
}

// The wheel should scroll the page while the pointer sits on a station dot,
// but zoom the map everywhere else. MapLibre only lets us toggle the whole
// handler, so we flip it on enter/leave of a dot.
// `hoverTick` is a no-op dependency used to trigger an overlay repaint when
// only the hover state changes (the dimmed frame of the hovered station).
const hoverTick = ref(0)
function setDotHover(id: string | null) {
  hoveredId.value = id
  hoverTick.value++
  // The wheel must zoom the MAP everywhere, including over a station dot or
  // its label. MapLibre binds its wheel handler to the canvas container,
  // which the overlays sit above, so a wheel there never reaches it.
  // onOverlayWheel forwards the event to that container; toggling
  // scroll-zoom off instead made the whole page scroll.
  map?.scrollZoom.enable()
}

// The station dot and its hover label are rendered ABOVE the MapLibre
// container (they are siblings of it, not children), so a wheel over them
// never reaches MapLibre's scroll-zoom handler. The event bubbles to the
// page instead and scrolls the whole viewport.
//
// Forward the wheel to the map canvas so the map zooms, and stop the page
// from scrolling.
function onOverlayWheel(e: WheelEvent) {
  e.preventDefault()
  e.stopPropagation()
  // MapLibre binds its wheel handler to the canvas CONTAINER (not the canvas
  // element), so the event has to be dispatched there. Dispatching on the
  // canvas would not reach it, because events do not propagate downward.
  const target = map?.getCanvasContainer() ?? map?.getCanvas()
  if (!target) return
  target.dispatchEvent(new WheelEvent('wheel', {
    deltaY: e.deltaY,
    deltaX: e.deltaX,
    clientX: e.clientX,
    clientY: e.clientY,
    bubbles: true,
    cancelable: true,
  }))
}

// Speed cycle: 0.5x -> 1x -> 2x -> 0.5x ...
const SPEEDS = [0.5, 1, 2]
function cycleSpeed() {
  const i = SPEEDS.indexOf(speed.value)
  setSpeed(SPEEDS[(i + 1) % SPEEDS.length] ?? 1)
}
const speedLabel = computed(() => `${speed.value}x`)

// Pre-load the playhead frame and the next WARM_AHEAD for the animated
// stations in view. Re-run only when the visible set or the per-station
// product data changes; the playhead itself moves through frames that are
// already rendered, so no re-warming is needed on every frame change.
const stationFrameCache = computed(() => {
  const result = new Map<string, RadarFrame[]>()
  for (const [id, productData] of Object.entries(productsByStation.value)) {
    if (!productData?.last_hour.length) continue
    // De-dupe/sort once when API data changes, not on every playback tick.
    const unique = new Map<number, RadarFrame>()
    for (const f of productData.last_hour) {
      const t = frameTime(f)
      if (f.url && t !== null) unique.set(t, f)
    }
    result.set(id, [...unique.values()].sort((a, b) => frameTime(a)! - frameTime(b)!))
  }
  return result
})

function stationFrames(stationId: string): RadarFrame[] {
  return stationFrameCache.value.get(stationId) ?? []
}

function stationFrameAt(stationId: string, targetTime: number): RadarFrame | null {
  const frames = stationFrames(stationId)
  if (!frames.length) return null
  // Newest observation at or before this shared tick.
  let chosen: RadarFrame | null = null
  for (const f of frames) {
    if (frameTime(f)! <= targetTime) chosen = f
    else break
  }
  // Before the station's earliest scan there is nothing to show yet, so hold
  // its earliest frame rather than an empty circle.
  //
  // Deliberately NO staleness cutoff: measured feeds scan every ~10 min, so a
  // station 16-19 min behind the freshest scan is simply the slowest scanner
  // on screen, not missing data. Rejecting those produced blank outlines on
  // perfectly healthy stations.
  return chosen ?? frames[0] ?? null
}

function liveTickTime(index: number): number {
  return liveWindowEnd.value - LIVE_WINDOW_MS + index * LIVE_STEP_MS
}

function targetFrameFor(stationId: string, index: number): RadarFrame | null {
  if (mode.value === 'archive') {
    const anchor = selectedStationId.value ?? archive.stationId.value
    if (stationId !== anchor) return null
    return archive.frames.value[index] ?? null
  }
  return stationFrameAt(stationId, liveTickTime(index))
}

function warmVisible() {
  for (const id of visibleIds.value) {
    for (let off = 0; off <= WARM_AHEAD; off++) {
      const f = targetFrameFor(id, frameIdx.value + off)
      if (f?.url) loadImage(f.url)
    }
  }
}
watch([visibleIds, productsByStation, frameIdx, mode, () => archive.frames.value], warmVisible)

// Every visible station participates in the shared playback clock. Each one
// holds its latest upstream observation at-or-before that 5-minute tick; feeds
// with 5/8/10-minute or irregular cadence therefore stay in sync without
// dropping stations or blanking between scans.
function frameFor(stationId: string): string | null {
  const target = targetFrameFor(stationId, frameIdx.value)
  if (!target?.url) return null
  const ready = (url: string) => {
    const entry = imageCache.get(url)
    return !!entry && entry.done && !entry.failed && !!entry.bitmap
  }
  if (ready(target.url)) return target.url

  // Never blank the radar while its next frame is downloading (or after an
  // individual frame 404s). Hold the most recent decoded image at/before the
  // target timestamp; station feeds have uneven 5/8/10-minute scan cadences.
  if (mode.value === 'live') {
    const targetTime = liveTickTime(frameIdx.value)
    const frames = stationFrames(stationId)
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i]!
      const t = frameTime(f)
      if (t !== null && t <= targetTime && ready(f.url)) return f.url
    }
  } else {
    for (let i = frameIdx.value - 1; i >= 0; i--) {
      const f = archive.frames.value[i]
      if (f?.url && ready(f.url)) return f.url
    }
  }
  // First load: return the target so the request can start; the station gets
  // its dashed outline until a drawable bitmap is ready.
  return target.url
}

// The template renders straight from the deduped cache rather than binding
// :src directly, so a re-render for the same frame never issues a request.
// With the canvas overlay this now only decides whether a station has a
// drawable frame at all (the pixels are drawn by the overlay layer).
const imgSrc = (stationId: string): string | undefined => {
  // Track cache completion so this recomputes when an image lands.
  void imageEpoch.value
  const url = frameFor(stationId)
  if (!url) return undefined
  const entry = imageCache.get(url)
  // Only render once the bytes are in hand, so we never emit a <img>
  // that would fire its own network request.
  if (!entry || entry.failed || !entry.done || !entry.bitmap) return undefined
  return url
}

function stationFrameReady(stationId: string): boolean {
  void imageEpoch.value
  const url = frameFor(stationId)
  if (!url) return false
  const entry = imageCache.get(url)
  return !!entry && entry.done && !entry.failed && !!entry.bitmap
}

// A station has NO DATA when its feed offers no real observation for the
// current tick — the upstream returns a 1x1 "nodata" placeholder, or the
// feed is stale (hours/days old). This is different from "still loading":
// a station whose image is on its way is LOADING, not empty.
function stationHasNoData(stationId: string): boolean {
  const target = targetFrameFor(stationId, frameIdx.value)
  if (!target?.url) return true
  if (/\/nodata\.png(?:$|\?)/i.test(target.url)) return true
  // The feed's newest observation is far older than the playback window.
  const frames = stationFrames(stationId)
  if (!frames.length) return true
  const newest = frameTime(frames[frames.length - 1]!)
  const targetTime = mode.value === 'archive'
    ? Date.parse(target.time_utc)
    : liveTickTime(frameIdx.value)
  if (!newest || !Number.isFinite(targetTime)) return true
  return targetTime - newest > LIVE_WINDOW_MS
}

// Canvas overlay: one <canvas> for all station frames, instead of one
// <img> per station. This is what keeps the decoded-bitmap memory bounded.
const overlayCanvas = ref<HTMLCanvasElement | null>(null)

const overlayStations = computed<RadarOverlayStation[]>(() =>
  visibleStations.value.map((s) => {
    const p = posOf(s.id)
    const dimmed = viewMode.value === 'selected' && s.id !== selectedStationId.value
    const size = (dimmed ? p.size * 0.55 : p.size) || frameSize.value
    return { id: s.id, x: p.x, y: p.y, size, opacity: dimmed ? 0.35 : 0.9 }
  }),
)

const overlay = useRadarCanvasOverlay(
  overlayCanvas,
  () => overlayStations.value,
  id => imgSrc(id) ?? null,
  (url) => imageCache.get(url)?.bitmap ?? null,
  url => !!imageCache.get(url)?.bitmap,
)

// Let the projection refresh drive the repaint, so panning/zooming moves the
// radar with the basemap in the same frame. Map movement uses the unthrottled
// path; a 30fps cap would make the radar trail a 60fps pan.
repaintOverlay = overlay.scheduleImmediate

// Resolution: the backing bitmap should match how large the frames are
// actually DRAWN, so key it to on-screen size — not to how many stations
// there are. A station-count rule inverts exactly when you zoom in: at close
// zoom there may be 6 stations but each frame is tens of thousands of pixels
// wide, and a 1024px bitmap would be upscaled ~50x and look like mush.
//
// budget() keeps total decoded pixels bounded: the largest frame gets what it
// needs, and the remainder share what is left.
function targetEdgeFor(stations: { size: number }[]): number {
  if (!stations.length) return BITMAP_DEFAULT_EDGE
  const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
  const biggest = stations.reduce((m, s) => Math.max(m, s.size * dpr), 0)
  // Total backing pixels we are willing to hold across the visible frames.
  const budget = 6 * 1024 * 1024
  const share = budget / stations.length
  const cap = Math.sqrt(share)
  // Never upscale past the 4084px source, and never drop below the floor.
  return Math.min(biggest, 4084, Math.max(BITMAP_DEFAULT_EDGE, cap))
}

watch([visibleIds, viewportSize], () => {
  const wanted = targetEdgeFor(overlayStations.value)
  if (bitmapScaler.setTargetEdge(wanted)) {
    // Resolution changed: drop the cached frames so they are re-scaled at
    // the new size on the next load, then repaint.
    for (const url of [...imageCache.keys()]) {
      imageCache.delete(url)
      bitmapScaler.dispose(url)
    }
    FAILED_URLS.clear()
    warmVisible()
  }
}, { deep: false })

// Repaint when anything the overlay draws from changes.
watch([frameIdx, visibleIds, productsByStation, imageEpoch, viewMode, selectedStationId, hoverTick], () => {
  overlay.schedule()
})

const isMobile = ref(false)
function syncIsMobile() {
  if (typeof window === 'undefined') return
  isMobile.value = window.innerWidth < 640
}
const frameSize = computed(() => (isMobile.value ? 96 : 160))

// Basemap: OpenFreeMap — keyless vector tiles (OpenMapTiles schema derived
// from OpenStreetMap data). Vector rather than raster so the map can be
// RECOLOURED per theme: roads, land and water are separate features, so the
// dark style paints them dark instead of dimming a light raster.
//
// These are real style URLs with their own glyphs/sprite/attribution, so we
// fetch them wholesale rather than hand-rolling a style.
const BASEMAP_STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
} as const

type BasemapThemeName = keyof typeof BASEMAP_STYLES

function basemapThemeName(): BasemapThemeName {
  const pref = colorMode.value
  if (pref === 'dark') return 'dark'
  if (pref === 'light') return 'light'
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

// Style URLs are versioned by path, so MapLibre would treat a theme swap as a
// new style and tear down the canvas. Cache each theme's parsed style once
// and swap via setStyle, which preserves the map instance and our overlay.
const styleCache = new Map<BasemapThemeName, Promise<StyleSpecification>>()

function loadStyle(name: BasemapThemeName) {
  let cached = styleCache.get(name)
  if (!cached) {
    cached = fetch(BASEMAP_STYLES[name]).then((r) => r.json())
    styleCache.set(name, cached)
  }
  return cached
}

let styleToken = 0

function applyBasemapTheme() {
  if (!map) return
  const token = ++styleToken
  void loadStyle(basemapThemeName()).then((spec) => {
    // A newer theme was applied while this style was in flight.
    if (!map || token !== styleToken) return
    // No `diff: true`: MapLibre's diff mode silently no-ops when it cannot
    // reconcile two styles (observed as the sprite disappearing and the map
    // staying on the previous theme). A full setStyle is correct and cheap
    // here - the map instance and our overlay canvas both survive it.
    map.setStyle(spec)
    map.setPitch(0)
    map.setBearing(0)
  })
}

// Re-apply when the preference changes.
watch(() => colorMode.value, () => applyBasemapTheme())

// 'system' resolves against the OS setting, which can change while the tab is
// open.
if (typeof window !== 'undefined') {
  const schemeMq = window.matchMedia('(prefers-color-scheme: dark)')
  const onSchemeChange = () => applyBasemapTheme()
  schemeMq.addEventListener('change', onSchemeChange)
  onUnmounted(() => schemeMq.removeEventListener('change', onSchemeChange))
}

// The vector tileset ends at zoom 14. MapLibre renders deeper zooms by
// stretching the deepest tile it has, which is what produced the blocky
// close-up. Cap the map at the real maxzoom instead of overzooming; when the
// style is swapped the map may already sit above this, so clamp it back.
const BASEMAP_MAX_ZOOM = 14

function initMap(center: [number, number], zoom: number) {
  if (!mapContainer.value || map) return
  // Point MapLibre at the worker Vite emitted, otherwise the basemap tiles
  // never load (the worker 404s and the map renders empty).
  maplibregl.setWorkerUrl(maplibreWorkerUrl)
  map = new maplibregl.Map({
    container: mapContainer.value,
    // Vector tiles (OpenFreeMap, keyless). The worker must not be
    // pre-bundled by Vite: MapLibre builds it with
    // `new URL('maplibre-gl-worker.mjs', import.meta.url)`, which does not
    // resolve from the pre-bundled deps cache — hence the optimizeDeps.exclude
    // in nuxt.config.ts.
    style: BASEMAP_STYLES[basemapThemeName()],
    center,
    zoom,
    minZoom: 0,
    maxZoom: BASEMAP_MAX_ZOOM,
    // Stay flat: a weather overlay has no business being tilted in 3D.
    pitch: 0,
    bearing: 0,
    maxPitch: 0,
    attributionControl: false,
  })
  // The style itself declares attribution (OpenStreetMap / OpenMapTiles /
  // OpenFreeMap), and MapLibre renders it automatically — so no manual
  // AttributionControl here, or the credit would appear twice.
  // Map zooms on the wheel as usual. It is switched off dynamically while the
  // pointer is over a station dot (see setDotHover) so the wheel scrolls the
  // page instead of zooming the map from that spot.
  map.scrollZoom.enable()

  // Lock to 2D. MapLibre maps right-drag to pitch/tilt, which makes the map
  // rotate into 3D; a weather overlay should stay flat. Also clear anything
  // already applied via setStyle/presets.
  map.touchPitch.disable()
  map.dragRotate.disable()
  map.touchZoomRotate.disableRotation()
  map.setPitch(0)
  map.setBearing(0)
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
  // No +/- buttons: the wheel zooms, pinch works, and the UI is cleaner.
  // Keep double-click zoom, which is the remaining pointer affordance.
  map.on('load', () => {
    mapReady.value = true
    applyBasemapTheme()
    // Force a resize in case the container was 0-height at construction
    // time (MapLibre sets h:0 initially, then resizes to its container).
    requestAnimationFrame(() => map?.resize())
    refreshProjections()
  })
  map.on('move', rafRefresh)
  map.on('zoom', rafRefresh)
  map.on('resize', rafRefresh)
  // Re-evaluate which stations are in view once a move settles.
  // Track the visible set *during* the pan as well as at the end. Without the
  // `move` case a station kept rendering after it scrolled off-screen and only
  // corrected itself on release, which read as the radar lagging behind.
  map.on('move', () => scheduleVisibleUpdate())
  map.on('moveend', () => scheduleVisibleUpdate(0))
  map.on('resize', () => scheduleVisibleUpdate(0))
  // Animated moves (zoom buttons, flyTo) fire `move` continuously.
  map.on('move', () => hold())
  map.on('click', handleMapClick)
  map.on('mousemove', handleMapMove)
  const container = map.getContainer()
  for (const ev of ['pointerdown', 'wheel', 'touchstart', 'keydown'] as const) {
    container.addEventListener(ev, onMapInteract, { passive: true, capture: true })
  }
}

onMounted(async () => {
  syncIsMobile()
  window.addEventListener('resize', syncIsMobile, { passive: true })
  setupResizeObserver()

  // A visitor we already know (cached lookup) gets their region immediately.
  const cached = getCachedLocation()
  const known = cached && inCoverage(cached) ? cached : null
  initMap(
    known ? [known.lon, known.lat] : DEFAULT_VIEW.center,
    known ? LOCAL_ZOOM : DEFAULT_VIEW.zoom,
  )

  // Stations and, on a first visit, the IP lookup run in parallel.
  const [, located] = await Promise.all([
    fetchStations(),
    cached ? Promise.resolve(cached) : lookupUserLocation(),
  ])
  // First visit: the map opened on the country view while we looked them up.
  // Move to their region now, unless they have already started panning.
  if (!cached && located && inCoverage(located) && !userMoved) {
    map?.jumpTo({ center: [located.lon, located.lat], zoom: LOCAL_ZOOM })
  }

  // Nothing was fetched before this point, so the first load is only what is in view.
  viewReady = true
  refreshProjections()
  updateVisible()
})

onUnmounted(() => {
  cancelAnimationFrame(raf)
  if (visibleTimer) clearTimeout(visibleTimer)
  resizeObserver?.disconnect()
  resizeObserver = null
  map?.remove()
  map = null
  imageCache.clear()
  bitmapScaler.clear()
})

function handleSeek(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value, 10)
  if (!Number.isNaN(v)) seek(v)
}

function posOf(stationId: string): { x: number; y: number; size: number } {
  return overlayPos.value[stationId] ?? { x: -9999, y: -9999, size: 0 }
}

const totalFrames = computed(() => framesRef.value.length)
// Clamped so the counter can never read e.g. "12 / 11" if the playhead is
// briefly ahead of the (still loading) frame list.
const playheadLabel = computed(() => Math.min(frameIdx.value + 1, totalFrames.value))
const isForecast = computed(() => !!radarProductInfo(product.value).forecast)
// Aggregate in-flight network activity so the chip stays alive for both
// station nowcast and radar image loads (and any future fetches).
// NOTE: `archive.loading` is a Ref, so it must be unwrapped with .value —
// treating the ref object itself as truthy pinned the chip to "1" forever.
// How many stations in view actually have data, and a name lookup for the
// failure list in the status indicator.
const succeededStationCount = computed(
  () => visibleIds.value.size - Object.keys(failedNow).filter(id => visibleIds.value.has(id)).length,
)
const stationNames = computed(() => {
  const out: Record<string, string> = {}
  for (const st of stations.value) out[st.id] = st.name
  return out
})

// Manual retry: clear the failure list AND the longer-lived backoff, then
// re-request everything in view. Without clearing failedStations the requests
// would be skipped for the backoff window and nothing would happen.
function retryFailedStations() {
  clearStationFailures()
  // Clear failed image URL backoff and cache entries, then queue the active
  // visible frames again. This makes the single retry button recover image
  // loads too, not just the station JSON.
  FAILED_URLS.clear()
  for (const id of visibleIds.value) forceFetchProduct(id)
  for (const id of visibleIds.value) {
    for (let off = 0; off <= WARM_AHEAD; off++) {
      const f = targetFrameFor(id, frameIdx.value + off)
      if (!f?.url) continue
      imageCache.delete(f.url)
      bitmapScaler.dispose(f.url)
      loadImage(f.url)
    }
  }
}

const inFlightTotal = computed(
  () => (productsLoading.value ?? 0) + imagesInFlight.value + (archive.loading.value ? 1 : 0),
)
const currentTimeLabel = computed(() => {
  const f = currentFrame.value
  if (!f?.time_utc) return '--:--'
  const d = new Date(f.time_utc)
  // Use the user's local timezone rather than hardcoding WITA.
  // Falls back to Asia/Makassar (WITA) if Intl is unavailable.
  let tz: string | undefined
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    tz = 'Asia/Makassar'
  }
  return d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  })
})

// Abbreviated timezone label, e.g. "WITA", "WIB", "PST"
const tzAbbrev = computed(() => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date())
    const part = parts.find(p => p.type === 'timeZoneName')
    return part?.value ?? 'local'
  } catch {
    return 'WITA'
  }
})
</script>

<template>
  <div class="relative h-full w-full overflow-hidden">
    <!-- Map fills the card. The wrapper is positioned so MapLibre's
         own `.maplibregl-map { position: relative }` stylesheet (which
         is loaded after Tailwind) doesn't shrink the map to 0 height
         when there's no explicit container size. -->
    <div
      ref="mapContainer"
      class="map-container-pin absolute inset-0"
    />

    <!-- Top edge fade — keeps UI pills readable over bright map tiles -->
    <div
      class="pointer-events-none absolute inset-x-0 top-0 z-[2] h-24"
      style="background: linear-gradient(to bottom, oklab(0 0 0 / 0.4), transparent);"
    />
    <!-- Bottom edge fade — keeps scrubber readable -->
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-36"
      style="background: linear-gradient(to top, oklab(0 0 0 / 0.55), transparent);"
    />

    <div class="pointer-events-none absolute inset-0 z-[4]">
      <svg class="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
        <line v-if="vcutStartScreen && vcutEndScreen" :x1="vcutStartScreen.x" :y1="vcutStartScreen.y" :x2="vcutEndScreen.x" :y2="vcutEndScreen.y" stroke="#f43f5e" stroke-width="3" stroke-dasharray="8 6" vector-effect="non-scaling-stroke" />
      </svg>
      <span v-if="vcutStartScreen" class="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-rose-500 shadow-lg" :style="{ left: `${vcutStartScreen.x}px`, top: `${vcutStartScreen.y}px` }" />
      <span v-if="vcutEndScreen" class="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-rose-500 shadow-lg" :style="{ left: `${vcutEndScreen.x}px`, top: `${vcutEndScreen.y}px` }" />
    </div>

    <Transition name="pill">
      <div
        v-if="stationsLoading"
        class="absolute inset-x-0 top-0 z-10 flex justify-center pt-4"
      >
        <div class="rounded-full border border-border/60 bg-card/80 px-3 py-1 text-xs text-foreground/80 backdrop-blur-md">
          Loading stations…
        </div>
      </div>
    </Transition>
    <Transition name="pill">
      <div
        v-if="stationsError"
        class="absolute inset-x-0 top-0 z-10 flex justify-center pt-4"
      >
        <div class="rounded-full border border-destructive/40 bg-card/90 px-3 py-1 text-xs text-destructive backdrop-blur-md">
          {{ stationsError }}
        </div>
      </div>
    </Transition>

    <!-- Product + station pickers. They live inside the card (bottom-left,
         above the scrubber), so they scroll away with the map instead of
         following the viewport. -->
    <div class="absolute bottom-[4.25rem] left-3 z-10 flex items-center gap-2 sm:bottom-[5.25rem] sm:left-4">
      <RadarProductPicker :model-value="product" @update:model-value="setProduct" />
      <RadarStationPicker :stations="stations" :model-value="selectedStationId" @update:model-value="pickStation" />
    </div>

    <!-- Status chip + colour key, bottom-right above the scrubber. The chip
         sits on the legend's left in the same row; both disappear entirely
         when there is nothing to report. -->
    <div class="pointer-events-none absolute bottom-[6.75rem] right-3 z-10 flex items-end gap-2 sm:bottom-[5.25rem] sm:right-4">
      <RadarStatusIndicator
        :loading="productsLoading > 0 || imagesInFlight > 0"
        :count="inFlightTotal"
        :failed="Object.keys(failedNow)"
        :succeeded="succeededStationCount"
        :names="stationNames"
        :in-flight-stations="loadingStations"
        @retry="retryFailedStations"
      />
      <!-- The legend is opaque to the pointer so the map's "grab" cursor does
           not show over it — it reads as UI, not a draggable surface. Drags
           must start somewhere else on the map. -->
      <RadarLegend :code="product" interactive class="pointer-events-auto w-40 sm:w-52" />
    </div>

    <!-- Combined action + player row: keep animation controls visible beside VCUT/nowcast. -->
    <div class="absolute inset-x-3 bottom-3 z-10 flex min-w-0 items-center gap-2 rounded-2xl border border-border/60 bg-card/80 px-3 py-2 pe-14 shadow-2xl backdrop-blur-xl sm:inset-x-4 sm:bottom-4 sm:gap-3 sm:px-4 sm:py-2.5 sm:pe-16">
      <HoverCardRoot :open-delay="200" :close-delay="120">
        <HoverCardTrigger as-child>
          <button type="button" aria-label="Map tools: vertical cut and point nowcast" :aria-pressed="vcutMode" class="flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-[10px] font-medium transition-colors sm:h-8 sm:gap-1.5 sm:px-2.5 sm:text-[11px]" :class="vcutMode ? 'border-primary bg-primary text-primary-foreground' : 'border-border/60 text-foreground/75 hover:bg-foreground/10'" @click="vcutMode ? cancelVcut() : startVcut()">
            <svg viewBox="0 0 16 16" class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13L14 3M3 3h.01M13 13h.01" stroke-linecap="round" /></svg>
            <span>VCUT</span>
          </button>
        </HoverCardTrigger>
        <HoverCardContent side="top" :side-offset="8" align="start" :collision-padding="12" class="z-40 w-72 max-w-[calc(100vw-1.5rem)] rounded-2xl border border-border/60 bg-popover/95 p-3 text-popover-foreground shadow-2xl backdrop-blur-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2">
          <p class="text-xs font-medium">VCUT — vertical cross-section</p>
          <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">Click this, then tap two points on the map. The radar makes a vertical slice between them (dBZ vs. height) for the latest frame.</p>
          <p class="mt-2 text-xs font-medium">Point nowcast</p>
          <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground"><kbd class="rounded border border-border/60 bg-background/40 px-1 py-px font-mono text-[10px]">Alt</kbd> + click any spot on the map to see that point's reflectivity over the last 24 hours (the chosen station).</p>
        </HoverCardContent>
      </HoverCardRoot>
      <RadarTimeRangeBar v-model:mode="mode" />
      <button class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/90 text-background transition-transform hover:scale-105 sm:h-8 sm:w-8" :aria-label="playing ? 'Pause' : 'Play'" @click="playing ? pause() : play()">
        <svg v-if="playing" viewBox="0 0 16 16" class="h-3 w-3 fill-current sm:h-3.5 sm:w-3.5"><rect x="3" y="2.5" width="3" height="11" rx="0.5" /><rect x="10" y="2.5" width="3" height="11" rx="0.5" /></svg>
        <svg v-else viewBox="0 0 16 16" class="h-3 w-3 fill-current sm:h-3.5 sm:w-3.5"><path d="M4 2.5L13 8L4 13.5V2.5Z" /></svg>
      </button>
      <span class="hidden w-12 shrink-0 text-center font-mono text-[11px] tabular-nums text-foreground/70 sm:inline">{{ currentTimeLabel }} {{ tzAbbrev }}</span>
      <input type="range" name="radar-frame" aria-label="Radar frame" min="0" :max="Math.max(0, totalFrames - 1)" :value="frameIdx" @input="handleSeek" class="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-foreground/15 accent-foreground" />
      <span class="hidden w-16 shrink-0 text-right text-[11px] tabular-nums text-foreground/60 sm:inline">{{ playheadLabel }} / {{ totalFrames }}</span>
      <span v-if="isForecast" class="shrink-0 rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground/70">Forecast</span>
      <button type="button" class="shrink-0 rounded-full border border-border/60 px-2 py-1 text-[11px] font-medium tabular-nums text-foreground/75 transition-colors hover:bg-foreground/10 hover:text-foreground" aria-label="Animation speed" @click="cycleSpeed">{{ speedLabel }}</button>
    </div>

    <Transition name="pill">
      <div v-if="vcutLoading" class="pointer-events-auto absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2">
        <div class="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/95 px-4 py-3 text-sm shadow-2xl shadow-black/30 backdrop-blur-xl" role="status" aria-live="polite">
          <span class="inline-block size-4 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground" aria-hidden="true" />
          <span>Generating vertical cut…</span>
        </div>
      </div>
    </Transition>
    <Transition name="pill">
      <div v-if="vcutError" class="pointer-events-auto absolute left-1/2 top-1/2 z-30 w-[min(22rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2">
        <div class="flex items-start gap-3 rounded-2xl border border-destructive/50 bg-card/95 p-4 text-sm shadow-2xl shadow-black/40 backdrop-blur-xl" role="alert">
          <svg viewBox="0 0 20 20" class="mt-0.5 size-4 shrink-0 fill-destructive" aria-hidden="true">
            <path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm-.75-11.5a.75.75 0 0 1 1.5 0v4.25a.75.75 0 0 1-1.5 0V6.5zm.75 7.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
          </svg>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium text-foreground">Couldn't generate the vertical cut</p>
            <p class="mt-1 text-xs leading-relaxed text-muted-foreground">{{ vcutError }}</p>
            <div class="mt-3 flex items-center gap-2">
              <button type="button" class="rounded-full border border-border/60 bg-foreground/5 px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-foreground/10" @click="vcutStart && vcutEnd && void requestVcut(vcutStart, vcutEnd); vcutError = ''">Try again</button>
              <button type="button" class="rounded-full px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-foreground/5" @click="closeVcutResult">Dismiss</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
    <Transition name="pill">
      <div v-if="vcutResult" class="pointer-events-auto absolute left-3 right-3 top-3 z-30 sm:left-1/2 sm:right-auto sm:w-[min(46rem,calc(100%-2rem))] sm:-translate-x-1/2 sm:top-16">
        <div class="overflow-hidden rounded-2xl border border-border/60 bg-card/95 shadow-2xl shadow-black/40 ring-1 ring-black/5 backdrop-blur-xl">
          <div class="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-2.5 text-xs">
            <span class="truncate font-medium">Vertical cross-section · {{ vcutResult.station }} · {{ new Date(vcutResult.datetime_utc).toLocaleString() }}</span>
            <button type="button" aria-label="Close vertical cross-section" class="shrink-0 rounded-full px-2 py-0.5 text-muted-foreground hover:bg-foreground/10" @click="closeVcutResult">×</button>
          </div>
          <div class="max-h-[55vh] overflow-y-auto bg-background/40 p-2 sm:p-3">
            <img :src="vcutResult.image_url" alt="Vertical radar cross-section in dBZ" referrerpolicy="no-referrer" class="block w-full rounded-lg object-contain" />
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="pill">
      <div v-if="timeseriesOpen" class="absolute left-3 right-3 top-16 z-30 mx-auto max-w-lg rounded-2xl border border-border/60 bg-card/95 p-3 shadow-2xl backdrop-blur-xl sm:left-1/2 sm:right-auto sm:w-[min(32rem,calc(100%-2rem))] sm:-translate-x-1/2">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm font-medium">Point radar time series</p>
            <p class="mt-0.5 text-[11px] text-muted-foreground">Alt-click a location on the map. Select a station first.</p>
          </div>
          <button type="button" aria-label="Close point nowcast" class="rounded-full px-2 py-0.5 text-muted-foreground hover:bg-foreground/10" @click="timeseriesOpen = false">×</button>
        </div>
        <p v-if="timeseriesLoading" class="py-5 text-center text-xs text-muted-foreground">Loading point data…</p>
        <p v-else-if="timeseriesError" class="py-5 text-center text-xs text-destructive">{{ timeseriesError }}</p>
        <div v-else-if="timeseriesResult" class="mt-3">
          <p class="mb-2 text-[11px] text-muted-foreground">{{ timeseriesResult.station }} · {{ timeseriesResult.date_utc }} · {{ timeseriesResult.units }}</p>
          <div v-if="timeseriesResult.series.length" class="max-h-56 overflow-y-auto">
            <div class="flex h-40 items-end gap-1 border-b border-l border-border/60 px-2 pb-1">
              <div v-for="(p, i) in timeseriesResult.series" :key="`${p.label}-${i}`" class="group relative flex h-full min-w-0 flex-1 flex-col justify-end" :title="`${p.label}: ${p.value} ${timeseriesResult.units}`">
                <div class="w-full rounded-t-sm opacity-85 transition-opacity group-hover:opacity-100" :style="{ height: `${Math.max(2, Math.min(100, p.value / Math.max(1, ...timeseriesResult.series.map(x => x.value)) * 100))}%`, backgroundColor: p.color || 'var(--primary)' }" />
                <span v-if="i % Math.max(1, Math.ceil(timeseriesResult.series.length / 8)) === 0" class="absolute -bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-[9px] text-muted-foreground">{{ p.label }}</span>
              </div>
            </div>
            <div class="mt-6 flex flex-wrap gap-1.5">
              <span v-for="(p, i) in timeseriesResult.series" :key="`v-${p.label}-${i}`" class="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">{{ p.label }} · {{ p.value }} {{ timeseriesResult.units }}</span>
            </div>
          </div>
          <p v-else class="py-5 text-center text-xs text-muted-foreground">No point data is available for today.</p>
        </div>
      </div>
    </Transition>

    <Transition name="pill">
      <div v-if="vcutMode" class="pointer-events-none absolute inset-x-3 top-3 z-20 flex justify-center sm:inset-x-4 sm:top-4">
        <div class="rounded-full border border-border/60 bg-card/90 px-3 py-1.5 text-center text-xs shadow-lg backdrop-blur-md">
          {{ vcutStart ? 'Tap the second point to finish the vertical cut' : 'Tap the first point of the vertical cut' }}
          <button type="button" class="pointer-events-auto ml-2 rounded-full px-1 text-muted-foreground hover:bg-foreground/10" @click="cancelVcut">Cancel</button>
        </div>
      </div>
    </Transition>

    <!-- Station radar frames are drawn here, on one canvas, rather than as
         one <img> per station. A 4084x4084 frame decoded into an <img> costs
         64 MB of resident bitmap; drawn into this canvas it costs ~1 MB. -->
    <canvas
      ref="overlayCanvas"
      class="pointer-events-none absolute inset-0 z-[1] h-full w-full"
      aria-hidden="true"
    />

    <!-- Station overlays: positioned by overlayPos, sized 160px.
         Click a station to enter "selected" view; click again to clear. -->
    <!-- Station badges — visual only; selection happens via the dropdown
         above, not by clicking the badges. pointer-events:none keeps
         the map panning through them. -->
    <div class="pointer-events-none absolute inset-0 z-[1]">
      <div
        v-for="s in visibleStations"
        :key="s.id"
        class="absolute will-change-transform"
        :style="{
          transform: `translate3d(${posOf(s.id).x}px, ${posOf(s.id).y}px, 0) translate(-50%, -50%)`,
          width: `${
            (viewMode === 'selected' && s.id !== selectedStationId
              ? posOf(s.id).size * 0.55
              : posOf(s.id).size) || frameSize
          }px`,
          height: `${
            (viewMode === 'selected' && s.id !== selectedStationId
              ? posOf(s.id).size * 0.55
              : posOf(s.id).size) || frameSize
          }px`,
          opacity: viewMode === 'selected' && s.id !== selectedStationId ? 0.35 : 1,
        }"
      >
        <div class="relative h-full w-full">
          <!-- Loading state: a dashed outline shows the extent of the frame
               that is still being fetched. It disappears once the frame is
               decoded, leaving just the dot. -->
          <div
            v-if="!stationFrameReady(s.id) && !stationHasNoData(s.id)"
            class="absolute inset-0 rounded-full border border-dashed border-foreground/30"
          />
          <!-- Hit area for hover. It is taller than the dot so the pointer can
               travel up onto the name tag below without dropping the hover. -->
          <div
            class="pointer-events-auto absolute left-1/2 top-1/2 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
            @mouseenter="setDotHover(s.id)"
            @mouseleave="setDotHover(null)"
            @wheel="onOverlayWheel"
          >
            <span
              class="h-1.5 w-1.5 rounded-full sm:h-2 sm:w-2"
              :class="stationHasNoData(s.id)
                ? 'bg-yellow-400'
                : 'bg-foreground shadow-[0_0_6px_2px_oklab(1_0_0/0.55)]'"
            />
          </div>
          <!-- Name tag above the dot while hovered. The wrapper keeps the
               pointer-events so the hover survives moving onto the label;
               the visible pill itself stays non-interactive. It fades in
               from below. -->
          <Transition name="tag">
            <div
              v-if="hoveredId === s.id"
              class="pointer-events-auto absolute left-1/2 top-1/2 z-10 -translate-x-1/2 select-none"
              style="margin-top: -34px;"
              @mouseenter="setDotHover(s.id)"
              @mouseleave="setDotHover(null)"
              @wheel="onOverlayWheel"
            >
              <div class="pointer-events-none flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border/60 bg-card/90 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-lg backdrop-blur-md">
                <span class="font-mono">{{ s.id }}</span>
                <span class="text-foreground/60">· {{ s.name }}</span>
                <span
                  v-if="stationHasNoData(s.id)"
                  class="rounded-full bg-amber-400/15 px-1.5 py-px text-[10px] font-medium text-amber-500"
                >No data</span>
              </div>
            </div>
          </Transition>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* Force the map's outer container to be absolutely positioned so the
   `.maplibregl-map { position: relative }` rule from maplibre-gl.css
   (loaded after Tailwind) doesn't strip our layout. Specificity bump
   via `.map-container-pin.map-container-pin` is the most reliable way
   to override without `!important`. */
.map-container-pin.map-container-pin {
  position: absolute !important;
  inset: 0;
  width: 100%;
  height: 100%;
}
.map-container-pin .maplibregl-map {
  width: 100%;
  height: 100%;
}

.pill-enter-active,
.pill-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}
.pill-enter-from,
.pill-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* Station name tag: rises from below while fading in, sinks away on leave. */
.tag-enter-active {
  transition: opacity 220ms cubic-bezier(0.16, 1, 0.3, 1), transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}
.tag-leave-active {
  transition: opacity 120ms cubic-bezier(0.4, 0, 1, 1), transform 120ms cubic-bezier(0.4, 0, 1, 1);
}
.tag-enter-from,
.tag-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
