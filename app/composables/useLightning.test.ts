// Tests the REST error path of useLightning WITHOUT Nuxt.
//
// The composable only touches four auto-imported globals: useRuntimeConfig,
// useState, watch and $fetch. All four are stubbed here before the module is
// imported, so the real composable (not a copy) is exercised: restError is set
// on a failure, cleared on the next success, and the merge counts are logged.
//
// The composable keeps its refs AND its socket in module scope (one instance
// per page), and registers its `enabled` watch only once. The tests therefore
// share those refs too: re-creating them between tests would leave the
// module-level watch callback writing into refs no test can reach. Each test
// starts from the layer's OFF branch instead (resetLayer), which stops the
// poller and drops both source lists and every derived ref.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'

const states = new Map<string, Ref<unknown>>()

function useStateStub<T>(key: string, init: () => T): Ref<T> {
  const existing = states.get(key) as Ref<T> | undefined
  if (existing) return existing
  // `ref()` wraps its input in UnwrapRef<T>, which the stub does not need to
  // model: it hands back the same ref on every call, as useState does.
  const created = ref(init()) as unknown as Ref<T>
  states.set(key, created as Ref<unknown>)
  return created
}

const fetchMock = vi.fn()

vi.stubGlobal('useState', useStateStub)
vi.stubGlobal('useRuntimeConfig', () => ({ public: { darmaProxyBase: 'https://proxy.test' } }))
vi.stubGlobal('$fetch', (...args: unknown[]) => fetchMock(...args))
// A minimal WebSocket: the composable only assigns handlers and closes it.
class FakeSocket {
  static last: FakeSocket | null = null
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  constructor(public url: string) { FakeSocket.last = this }
  close() { this.closed = true }
  /** Simulates the relay pushing one frame. */
  push(data: string) { this.onmessage?.({ data }) }
}
vi.stubGlobal('WebSocket', FakeSocket)

// The composable registers a watch on `enabled` when first called. Running the
// callbacks on demand keeps this test free of Vue's scheduler while still
// letting a test drive the toggle (which is what opens the socket). Vue passes
// the new value as the first argument, so the stub reads it off the source: a
// callback called with no argument would take the layer's OFF branch.
const watchers: { run: () => void }[] = []
vi.stubGlobal('watch', (source: unknown, cb: (value: unknown) => void) => {
  watchers.push({
    run: () => {
      const v = (source as { value?: unknown })?.value
      cb(v)
    },
  })
  return () => {}
})
function flushWatchers() {
  for (const w of watchers) w.run()
}

/**
 * Puts the composable back to "layer off, nothing loaded": the same OFF branch
 * the toggle takes in the app, so the poller stops and reset() drops the REST
 * list, the socket window, the merged list, the sensors and restError.
 */
function resetLayer() {
  const l = useLightning()
  l.enabled.value = false
  flushWatchers()
  l.sensorsLayerOn.value = false
}

const { useLightning } = await import('./useLightning')

const envelope = (strikes: unknown[]) => ({
  ok: true,
  cached: false,
  cache_age_seconds: 0,
  pulled_at_utc: '2026-11-28T12:44:20Z',
  data: { total: strikes.length, strikes },
})

const REST_STRIKE = {
  time_utc: '2026-11-28T12:44:20Z',
  lat: -6.1806,
  lon: 106.8117,
  current_ka: 18.844,
  polarity: '-',
  strike_type: 'CG',
}

describe('useLightning — restError visibility', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(envelope([]))
    resetLayer()
  })

  it('is null before anything failed', () => {
    const { restError, enabled } = useLightning()
    enabled.value = true
    expect(restError.value).toBeNull()
  })

  it('records the error message when the REST fetch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { restError, enabled, fetchLightning } = useLightning()
    enabled.value = true
    fetchMock.mockRejectedValueOnce(new Error('502 Bad Gateway'))
    await fetchLightning()
    expect(restError.value).toBe('502 Bad Gateway')
    // The failure is logged too, message included.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('502 Bad Gateway')
    expect(String(warn.mock.calls[0]![0])).toContain('REST lightning fetch failed')
    warn.mockRestore()
  })

  it('clears restError on the next successful fetch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { restError, enabled, fetchLightning } = useLightning()
    enabled.value = true
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    await fetchLightning()
    expect(restError.value).toBe('network down')
    fetchMock.mockResolvedValueOnce(envelope([REST_STRIKE]))
    await fetchLightning()
    expect(restError.value).toBeNull()
    warn.mockRestore()
    info.mockRestore()
  })

  it('keeps the previous strikes when a fetch fails', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { strikes, enabled, fetchLightning } = useLightning()
    enabled.value = true
    fetchMock.mockResolvedValueOnce(envelope([REST_STRIKE]))
    await fetchLightning()
    expect(strikes.value).toHaveLength(1)
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    await fetchLightning()
    expect(strikes.value).toHaveLength(1)
    info.mockRestore()
    warn.mockRestore()
  })

  it('treats an ok:false envelope as a failure too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { restError, enabled, fetchLightning } = useLightning()
    enabled.value = true
    fetchMock.mockResolvedValueOnce({ ok: false, data: null })
    await fetchLightning()
    expect(restError.value).toBe('REST lightning returned no usable data')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('logs the REST and socket counts after each merge', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { enabled, fetchLightning } = useLightning()
    enabled.value = true
    fetchMock.mockResolvedValueOnce(envelope([REST_STRIKE]))
    await fetchLightning()
    expect(info).toHaveBeenCalled()
    const line = String(info.mock.calls.at(-1)![0])
    expect(line).toContain('REST 1')
    expect(line).toContain('socket 0')
    info.mockRestore()
  })

  it('does not fetch while the layer is off', async () => {
    const { enabled, restError, fetchLightning } = useLightning()
    enabled.value = false
    await fetchLightning()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(restError.value).toBeNull()
  })
})

// --- The sensor list on the socket frames ---------------------------------
//
// The frame carries `sensor`, a JSON STRING of an array, next to the strike
// FeatureCollection. These tests drive the REAL socket handlers (via the fake
// WebSocket) so the parse, the replacement-per-frame and the clear-on-drop
// rules are covered, not a copy of them.

const SENSORS = JSON.stringify([
  { SerialNumber: 10209, RealName: 'AAILD', Latitude: '-3.687151', Longitude: '128.181503', Online: 1, StrikesPerMinute: 143, StrikesGoodPct: 100, StrikesCorrelatedPct: 67.851321, SatellitesTracked: 12, CaptureLastReceived: '28-Nov-2026 20:17:38', LastConnected: '28-Nov-2026 09:16:52' },
  { SerialNumber: 10083, RealName: 'MDRLD', Latitude: '-7.041423', Longitude: '113.915803', Online: 0, StrikesPerMinute: 0, StrikesGoodPct: 0, StrikesCorrelatedPct: 0, SatellitesTracked: 3, CaptureLastReceived: '28-Nov-2026 20:23:29', LastConnected: '28-Nov-2026 09:16:52' },
])

function frame(sensor: string | null): string {
  const data = JSON.stringify({
    type: 'FeatureCollection',
    features: [{ properties: { id: 1, current: 1000 }, geometry: { type: 'Point', coordinates: [106.8, -6.18] } }],
  })
  const payload = sensor === null ? { data } : { data, sensor, epoch: 1795869860 }
  return `42["data_petir", ${JSON.stringify(payload)}]`
}

describe('useLightning — the socket sensor list', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(envelope([]))
    FakeSocket.last = null
    // The composable's state is module-level: start each test from a closed
    // socket by re-running the layer's off branch.
    resetLayer()
  })

  it('parses the sensors out of each frame, and keeps them apart from strikes', () => {
    const { sensors, strikes, enabled, sensorsLayerOn } = useLightning()
    sensorsLayerOn.value = true
    enabled.value = true
    flushWatchers()
    const ws = FakeSocket.last!
    ws.onopen?.()
    ws.push(frame(SENSORS))

    expect(sensors.value.map(s => s.id)).toEqual([10083, 10209])
    expect(sensors.value.find(s => s.id === 10209)!.strikesPerMinute).toBe(143)
    // The strike list is unchanged by the sensor field: one strike, no sensor.
    expect(strikes.value).toHaveLength(1)
    expect(strikes.value[0]!.current_ka).toBe(1)
  })

  it('replaces the whole list on every frame', () => {
    const { sensors, enabled, sensorsLayerOn } = useLightning()
    sensorsLayerOn.value = true
    enabled.value = true
    flushWatchers()
    const ws = FakeSocket.last!
    ws.onopen?.()
    ws.push(frame(SENSORS))
    expect(sensors.value).toHaveLength(2)
    // The next frame carries one sensor only: the list follows it exactly.
    ws.push(frame(JSON.stringify([{ SerialNumber: 10150, RealName: 'YOGLD', Latitude: '-7.5', Longitude: '110.3', Online: 1 }])))
    expect(sensors.value.map(s => s.id)).toEqual([10150])
  })

  it('clears the sensors when the socket drops, and the strikes stay on REST', () => {
    const { sensors, strikes, enabled, sensorsLayerOn } = useLightning()
    sensorsLayerOn.value = true
    enabled.value = true
    flushWatchers()
    const ws = FakeSocket.last!
    ws.onopen?.()
    ws.push(frame(SENSORS))
    expect(sensors.value).toHaveLength(2)
    ws.onclose?.()
    expect(sensors.value).toEqual([])
    // The socket strikes are dropped on close as before, so the strike rule is
    // untouched: it is the same teardown path.
    expect(strikes.value).toHaveLength(0)
  })

  it('keeps a broken sensor field from costing the frame its strikes', () => {
    const { sensors, strikes, enabled, sensorsLayerOn } = useLightning()
    sensorsLayerOn.value = true
    enabled.value = true
    flushWatchers()
    const ws = FakeSocket.last!
    ws.onopen?.()
    ws.push(frame('not json'))
    expect(sensors.value).toEqual([])
    expect(strikes.value).toHaveLength(1)
  })

  it('does not parse sensors while the sensor layer is off', () => {
    const { sensors, enabled, sensorsLayerOn } = useLightning()
    sensorsLayerOn.value = false
    enabled.value = true
    flushWatchers()
    const ws = FakeSocket.last!
    ws.onopen?.()
    ws.push(frame(SENSORS))
    expect(sensors.value).toEqual([])
  })
})
