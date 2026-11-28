// Tests for useStationCatalog: the example response FROM THE CONTRACT, the 502
// shape, and the fetch-once rule.
//
// The example payload is read out of contracts/stations-catalog.v1.yaml rather
// than copied here, so this test fails if the contract's example changes shape.
//
// The composable only touches three auto-imported globals (useRuntimeConfig,
// useState and $fetch), all stubbed below, so the real composable is exercised
// without Nuxt. No network: $fetch is a fake. The live backend is never called.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { parse as parseYaml } from 'yaml'

const CONTRACT_PATH = fileURLToPath(new URL('../../contracts/stations-catalog.v1.yaml', import.meta.url))

interface ContractStation { id: number, code: string, lat: number, lon: number }
interface ContractExample { ok: boolean, data: { count: number, stations: ContractStation[] } }

function contractExample(): ContractExample {
  const doc = parseYaml(readFileSync(CONTRACT_PATH, 'utf8')) as {
    paths: Record<string, { get: { responses: Record<string, { content: Record<string, { example: ContractExample }> }> } }>
  }
  const example = doc.paths['/api/stations/catalog']?.get.responses['200']?.content['application/json']?.example
  if (!example) throw new Error('contract is missing the 200 example')
  return example
}

const states = new Map<string, Ref<unknown>>()

function useStateStub<T>(key: string, init: () => T): Ref<T> {
  let s = states.get(key) as Ref<T> | undefined
  if (!s) {
    s = ref(init()) as Ref<T>
    states.set(key, s as Ref<unknown>)
  }
  return s
}

const fetchMock = vi.fn()

vi.stubGlobal('useState', useStateStub)
vi.stubGlobal('useRuntimeConfig', () => ({ public: { darmaProxyBase: 'https://proxy.test' } }))
vi.stubGlobal('$fetch', (...args: unknown[]) => fetchMock(...args))

const { catalogIndex, catalogStationsFromPayload, useStationCatalog } = await import('./useStationCatalog')
const { parseLightningSensors, sensorMarkers } = await import('../lib/lightningSensors')

describe('contract example → typed stations', () => {
  it('maps the two example stations MDRLD and SRGLD', async () => {
    const example = contractExample()
    expect(example.data.stations.map(s => s.code)).toEqual(['MDRLD', 'SRGLD'])

    const stations = catalogStationsFromPayload(example.data)
    expect(stations).toEqual([
      { id: 10083, code: 'MDRLD', lat: -7.041423, lon: 113.915803 },
      { id: 10084, code: 'SRGLD', lat: -6.171296, lon: 106.05143 },
    ])
    // Indexed by id, which is what the socket sensors match on.
    expect([...catalogIndex(stations).keys()]).toEqual([10083, 10084])
  })

  it('drops entries it cannot place or identify', () => {
    expect(catalogStationsFromPayload({
      count: 4,
      stations: [
        { id: 1, code: 'A', lat: -7, lon: 113 },
        { id: 'x', code: 'B', lat: -7, lon: 113 },
        { id: 3, code: 'C', lat: 'nope', lon: 113 },
        { id: 4, code: 'D', lat: -7, lon: 400 },
        null,
      ],
    })).toEqual([{ id: 1, code: 'A', lat: -7, lon: 113 }])
    expect(catalogStationsFromPayload(null)).toEqual([])
    expect(catalogStationsFromPayload({})).toEqual([])
  })

  it('feeds marker positions for the socket sensors that match by id', () => {
    const catalog = catalogIndex(catalogStationsFromPayload(contractExample().data))
    const sensors = parseLightningSensors(JSON.stringify([
      // Same serial number as MDRLD in the catalog.
      { SerialNumber: 10083, RealName: 'MDRLD', Latitude: '-7.5', Longitude: '114.5', Online: 1 },
      // Not in the catalog: keeps its socket coordinates.
      { SerialNumber: 10209, RealName: 'AAILD', Latitude: '-3.687151', Longitude: '128.181503', Online: 0 },
    ]))
    const markers = sensorMarkers(sensors, catalog)
    expect(markers.map(m => [m.sensor.id, m.lat, m.lon])).toEqual([
      [10083, -7.041423, 113.915803],
      [10209, -3.687151, 128.181503],
    ])
    // The status still comes from the socket, not from the catalog.
    expect(markers[0]!.sensor.online).toBe(true)
    expect(markers[1]!.sensor.online).toBe(false)
  })
})

describe('useStationCatalog', () => {
  beforeEach(() => {
    states.clear()
    fetchMock.mockReset()
    // The fetch-once flag is module-level, so each test re-arms it.
    useStationCatalog().reset()
  })

  it('fetches the contract endpoint once and exposes the stations', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const example = contractExample()
    fetchMock.mockResolvedValueOnce(example)
    const { stations, loading, error, fetchOnce } = useStationCatalog()

    expect(loading.value).toBe(false)
    await fetchOnce()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://proxy.test/api/stations/catalog')
    expect(stations.value.map(s => s.code)).toEqual(['MDRLD', 'SRGLD'])
    expect(error.value).toBeNull()
    expect(loading.value).toBe(false)
    warn.mockRestore()
  })

  it('does not fetch again until the toggle is switched off and on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue(contractExample())
    const { fetchOnce, reset } = useStationCatalog()

    await fetchOnce()
    await fetchOnce()
    await Promise.all([fetchOnce(), fetchOnce()])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Toggle off, then on again: exactly one more request.
    reset()
    await fetchOnce()
    await fetchOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('collapses concurrent calls into one request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue(contractExample())
    const { fetchOnce } = useStationCatalog()
    await Promise.all([fetchOnce(), fetchOnce(), fetchOnce()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('treats the 502 upstream_unavailable shape as a normal failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The contract's 502 body: ofetch rejects with the parsed body on `data`,
    // and a stubbed $fetch may also just resolve it. Both are covered.
    const body = {
      ok: false,
      error: 'upstream_unavailable',
      message: 'BMKG page returned no usable sensor list',
    }
    fetchMock.mockRejectedValueOnce(body)
    const { stations, loading, error, fetchOnce } = useStationCatalog()
    await fetchOnce()

    expect(stations.value).toEqual([])
    expect(error.value).toBe('BMKG page returned no usable sensor list')
    expect(loading.value).toBe(false)

    // The ok:false body arriving as a resolved value reads the same way.
    const api = useStationCatalog()
    api.reset()
    fetchMock.mockResolvedValueOnce(body)
    await api.fetchOnce()
    expect(api.stations.value).toEqual([])
    expect(api.error.value).toBe('BMKG page returned no usable sensor list')
    warn.mockRestore()
  })

  it('records a network failure and leaves the socket sensors alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new Error('502 Bad Gateway'))
    const { stations, error, fetchOnce } = useStationCatalog()
    await fetchOnce()

    expect(stations.value).toEqual([])
    expect(error.value).toBe('502 Bad Gateway')

    // With an empty catalog every sensor is drawn at its socket coordinates.
    const sensors = parseLightningSensors(JSON.stringify([
      { SerialNumber: 10209, RealName: 'AAILD', Latitude: '-3.687151', Longitude: '128.181503', Online: 1 },
    ]))
    const markers = sensorMarkers(sensors, catalogIndex(stations.value))
    expect(markers[0]!.lat).toBe(-3.687151)
    expect(markers[0]!.lon).toBe(128.181503)
    warn.mockRestore()
  })

  it('re-arms after a failure only when the toggle goes off and on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    const { error, fetchOnce, reset } = useStationCatalog()
    await fetchOnce()
    expect(error.value).toBe('boom')
    // Still inside the same "on" period: no retry, no poll.
    await fetchOnce()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    reset()
    fetchMock.mockResolvedValueOnce(contractExample())
    await fetchOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(error.value).toBeNull()
    warn.mockRestore()
  })
})
