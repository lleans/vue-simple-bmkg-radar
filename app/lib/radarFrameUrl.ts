// Routes a frame URL through the CORS-enabled wsrv.nl proxy when the proxy
// hands back the upstream bucket URL directly.
//
// Why: at full resolution (zoom 8 and above) the proxy returns the bucket URL
// itself. The bucket allows only localhost:3000 in access-control-allow-origin,
// so the WebGL mosaic cannot read those pixels and falls back to Canvas2D.
// The lower resolutions already come through wsrv with access-control-allow-origin: *.
//
// output=png keeps the palette pixels exact. The default webp output is lossy,
// and the mosaic maps colours to the legend. wsrv returns the full 4084 px
// frame when no `w` is given.

export const CORS_FRAME_HOST = 'wsrv.nl'

export interface RoutableFrame {
  url: string
  url_original?: string
}

export function corsReadableFrameUrl(url: string): string {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return url
  }
  if (host === CORS_FRAME_HOST) return url
  return `https://${CORS_FRAME_HOST}/?url=${encodeURIComponent(url)}&output=png&n=-1`
}

/**
 * The frame with its url routed through wsrv. The original URL is kept as
 * url_original, so a failed wsrv load still falls back to the bucket.
 * Frames already on wsrv are returned unchanged.
 */
export function withCorsReadableFrame<T extends RoutableFrame>(frame: T): T {
  if (!frame.url) return frame
  const routed = corsReadableFrameUrl(frame.url)
  if (routed === frame.url) return frame
  return { ...frame, url: routed, url_original: frame.url_original ?? frame.url }
}
