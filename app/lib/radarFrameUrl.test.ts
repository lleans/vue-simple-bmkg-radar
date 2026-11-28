import { describe, it, expect } from 'vitest'
import { CORS_FRAME_HOST, corsReadableFrameUrl, withCorsReadableFrame } from './radarFrameUrl'

const BUCKET = 'https://darma-bucket-proxy.lleans.dev/nowcast/Surabaya/CMAX/SBY-20261128-0635.png'

describe('corsReadableFrameUrl', () => {
  it('routes a bucket URL through wsrv as PNG with no resize parameter', () => {
    const out = corsReadableFrameUrl(BUCKET)
    const u = new URL(out)
    expect(u.hostname).toBe(CORS_FRAME_HOST)
    expect(u.searchParams.get('url')).toBe(BUCKET)
    expect(u.searchParams.get('output')).toBe('png')
    expect(u.searchParams.has('w')).toBe(false)
  })

  it('leaves a URL that is already on wsrv unchanged', () => {
    const wsrv = 'https://wsrv.nl/?url=https%3A%2F%2Fx%2Fa.png&w=1024&output=webp&n=-1'
    expect(corsReadableFrameUrl(wsrv)).toBe(wsrv)
  })

  it('returns an unparseable URL unchanged', () => {
    expect(corsReadableFrameUrl('not a url')).toBe('not a url')
  })
})

describe('withCorsReadableFrame', () => {
  it('keeps the bucket URL as url_original so a failed load can still fall back', () => {
    const f = withCorsReadableFrame({ url: BUCKET, time_utc: 't', forecast_offset_minutes: null })
    expect(f.url_original).toBe(BUCKET)
    expect(new URL(f.url).hostname).toBe(CORS_FRAME_HOST)
    expect(f.time_utc).toBe('t')
  })

  it('keeps an existing url_original', () => {
    const f = withCorsReadableFrame({ url: BUCKET, url_original: 'orig' })
    expect(f.url_original).toBe('orig')
  })

  it('returns a frame already on wsrv as the same object', () => {
    const f = { url: 'https://wsrv.nl/?url=x&output=webp&n=-1', url_original: 'orig' }
    expect(withCorsReadableFrame(f)).toBe(f)
  })
})
