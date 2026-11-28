// Draws station radar frames onto a single <canvas> instead of one <img>
// per station.
//
// Why: every frame is a 4084x4084 PNG. The browser decodes an <img> at its
// full intrinsic size — 4084 * 4084 * 4 bytes = 64 MB of RGBA per frame —
// and CSS width/height only shrinks it at paint time. A regional view loads
// 10-17 frames, so the tab holds 512 MB+ of decoded bitmaps, which is what
// pins the GPU process and WindowServer at high CPU.
//
// Drawing the same image into a canvas of roughly the size we actually paint
// costs ~0 ms and uses ~1 MB instead of ~64 MB. Measured on this project:
// drawImage into 512x512 = 0 ms, full <img> decode = 44 ms / 64 MB.
//
// Two paths, chosen per canvas:
//   - WebGL2 mosaic (radarMosaicGl.ts, preferred): one shader pass over all
//     stations with a max blend, so overlapping echoes do not wash out. It
//     reads frame pixels back (getImageData), so it needs a CORS-enabled frame.
//   - Canvas2D (the original path): one drawImage per station with 'lighten'.
//     It never reads pixels back, so it works with tainted (no-CORS) frames.
//
// CORS, as measured: the proxied `url` (served via wsrv.nl) answers with
// access-control-allow-origin: *. The upstream `url_original` allows only
// localhost:3000, and at full resolution `url` is the upstream bucket itself,
// which also allows only localhost:3000. A frame that cannot be read is drawn
// with Canvas2D for as long as it stays in view.
//
// The WebGL context and the 2D context cannot share one canvas. When the mosaic
// is active, the Canvas2D fallback lives on a sibling canvas, created only when
// it is first needed (context lost, a tainted frame, or no WebGL2).

import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { Ref } from 'vue'
import type { RadarFrame } from './useRadarApi'
import { stationStrength } from '~/lib/radarMosaic'
import { RadarMosaicGl, type MosaicDisc } from '~/lib/radarMosaicGl'

// Default backing-bitmap edge per station, in device pixels. The map raises
// this via setTargetEdge when frames are drawn much larger than this (close
// zoom), and lowers it when the visible set is wide.
export const BITMAP_DEFAULT_EDGE = 1024
// Never downscale below this; below ~512 the frames look visibly soft.
const BITMAP_MIN_EDGE = 512
// Repaint throttled to ~30fps: the timeline ticks at ~0.7fps, so this is
// ample and keeps rapid pans/zooms cheap.
const REPAINT_MIN_INTERVAL_MS = 33

export interface RadarOverlayStation {
  id: string
  // Screen position of the frame's centre, and its on-screen diameter.
  x: number
  y: number
  size: number
  // 0.9 for the picked station, 0.35 dimmed for the others (Canvas2D path).
  opacity: number
  // True when the view has a selected station and this one is not it.
  dimmed: boolean
}

export interface RadarOverlayMosaic {
  // Palette the current product's frames are drawn with, or null to keep
  // the product on the Canvas2D overlay (see mosaicPaletteFor).
  palette: () => readonly string[] | null
  // Common backing edge, in pixels, that every frame layer is resampled to.
  edge: () => number
}

export const useRadarCanvasOverlay = (
  canvasRef: Ref<HTMLCanvasElement | null>,
  getStations: () => RadarOverlayStation[],
  resolveFrame: (stationId: string) => string | null,
  resolveBitmap: (url: string) => CanvasImageSource | null,
  mosaic: RadarOverlayMosaic,
) => {
  const ready = ref(false)
  const size = shallowRef({ w: 0, h: 0 })

  // The WebGL mosaic, when the browser gives us WebGL2 on the main canvas.
  let gl: RadarMosaicGl | null = null
  // The 2D context and the canvas it draws on. Without a mosaic that is the
  // main canvas; with one it is a sibling canvas created on first need.
  let ctx: CanvasRenderingContext2D | null = null
  let ctxEl: HTMLCanvasElement | null = null
  let sibling: HTMLCanvasElement | null = null
  let dpr = 1
  let pending = false
  let lastPaint = 0
  let raf = 0

  function measure() {
    const el = canvasRef.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    if (w === size.value.w && h === size.value.h) return
    // Cap DPR: at 3x a 1200px-wide overlay is already well past what we draw.
    dpr = Math.min(2, window.devicePixelRatio || 1)
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
    if (sibling) {
      sibling.width = el.width
      sibling.height = el.height
    }
    size.value = { w, h }
    schedule()
  }

  /** Make `show` the visible surface; the other overlay canvas is hidden. */
  function showSurface(show: HTMLCanvasElement) {
    const main = canvasRef.value
    if (main) main.style.visibility = main === show ? '' : 'hidden'
    if (sibling) sibling.style.visibility = sibling === show ? '' : 'hidden'
  }

  /** The 2D context, creating the sibling canvas for it if the main canvas is taken by WebGL. */
  function context2d(): CanvasRenderingContext2D | null {
    if (ctx) return ctx
    const main = canvasRef.value
    if (!main?.parentElement) return null
    const el = document.createElement('canvas')
    // Same class and inline style, so it sits exactly where the main canvas does.
    el.className = main.className
    el.setAttribute('style', main.getAttribute('style') ?? '')
    el.setAttribute('aria-hidden', 'true')
    el.width = main.width
    el.height = main.height
    main.after(el)
    sibling = el
    ctxEl = el
    ctx = el.getContext('2d')
    return ctx
  }

  /**
   * Draw the frames with the WebGL mosaic. Returns false when the mosaic
   * cannot draw this paint, and the caller falls back to Canvas2D.
   */
  function paintGl(stations: RadarOverlayStation[]): boolean {
    const el = canvasRef.value
    const palette = mosaic.palette()
    if (!gl || !gl.usable || !el || !palette) return false
    const discs: MosaicDisc[] = []
    for (const s of stations) {
      const url = resolveFrame(s.id)
      if (!url) continue
      const bmp = resolveBitmap(url)
      if (!bmp) continue
      if (!(s.size > 0)) continue
      discs.push({
        url,
        bitmap: bmp,
        cx: s.x * dpr,
        cy: s.y * dpr,
        radius: (s.size / 2) * dpr,
        strength: stationStrength(s.dimmed),
      })
    }
    return gl.draw(discs, palette, mosaic.edge())
  }

  function paint() {
    pending = false
    const el = canvasRef.value
    if (!el) return
    const stations = getStations()
    if (paintGl(stations)) {
      showSurface(el)
      lastPaint = performance.now()
      return
    }
    const c = context2d()
    if (!c || !ctxEl) return
    showSurface(ctxEl)
    paint2d(c, stations)
    lastPaint = performance.now()
  }

  function paint2d(c: CanvasRenderingContext2D, stations: RadarOverlayStation[]) {
    const el = ctxEl!
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.clearRect(0, 0, el.width, el.height)
    // 'lighten' takes max per channel per pixel where two stations overlap:
    // whichever station read the higher reflectivity at this point wins, which
    // matches CMAX semantics and avoids the additive brightening/wash-out that
    // 'screen' gave in overlap regions. Set once for the whole batch — in
    // Safari / WebKit, switching composite operations or clipping per station
    // inside the loop forces offscreen GPU render-pass breaks.
    c.globalCompositeOperation = 'lighten'

    for (const s of stations) {
      const url = resolveFrame(s.id)
      if (!url) continue
      const bmp = resolveBitmap(url)
      if (!bmp) continue
      const size = s.size
      if (!(size > 0)) continue
      c.globalAlpha = s.opacity
      // The bitmap is already circular-clipped during downscaling, so we draw directly
      c.drawImage(bmp, s.x - size / 2, s.y - size / 2, size, size)
    }

    c.globalAlpha = 1
    c.globalCompositeOperation = 'source-over'
  }

  /**
   * Repaint on the next animation frame, throttled to ~30fps. Used for data
   * changes (a frame landed, the product switched) where the exact moment does
   * not matter.
   */
  function schedule() {
    if (pending) return
    const wait = REPAINT_MIN_INTERVAL_MS - (performance.now() - lastPaint)
    if (wait > 0) {
      pending = true
      raf = requestAnimationFrame(() => {
        if (performance.now() - lastPaint < REPAINT_MIN_INTERVAL_MS) {
          raf = requestAnimationFrame(() => paint())
        } else {
          paint()
        }
      })
      return
    }
    pending = true
    raf = requestAnimationFrame(paint)
  }

  let observer: ResizeObserver | null = null

  onMounted(() => {
    const el = canvasRef.value
    if (el) {
      gl = RadarMosaicGl.create(el, () => schedule())
      // A canvas that took WebGL cannot also give a 2D context; that context is
      // then made on a sibling canvas by context2d().
      if (!gl) ctx = el.getContext('2d')
      if (ctx) ctxEl = el
    }
    ready.value = !!gl || !!ctx
    measure()
    observer = new ResizeObserver(measure)
    if (el) observer.observe(el)
    schedule()
  })

  onBeforeUnmount(() => {
    if (raf) cancelAnimationFrame(raf)
    observer?.disconnect()
    observer = null
    gl?.dispose()
    gl = null
    sibling?.remove()
    sibling = null
    ctx = null
    ctxEl = null
  })

  /**
   * Repaint on the very next frame with no throttle. Used while the map is
   * moving: a pan redraws at 60fps, so throttling the overlay would make the
   * radar visibly trail the basemap. Costs one clear + one composite per
   * visible station, which is cheap compared with the compositing it replaces.
   */
  function scheduleImmediate() {
    if (raf) cancelAnimationFrame(raf)
    pending = false
    raf = requestAnimationFrame(paint)
  }

  /**
   * Paint synchronously, now. Used from MapLibre's 'render' event so the radar
   * is drawn in the same frame as the basemap. Cancels any pending paint.
   */
  function paintNow() {
    if (raf) cancelAnimationFrame(raf)
    pending = false
    paint()
  }

  return { ready, size, schedule, scheduleImmediate, paintNow, measure }
}

/**
 * Downscale a decoded radar PNG into a small bitmap once, and hand back the
 * bitmap. The 64 MB source <img> is released as soon as it has been drawn,
 * so only the small bitmap stays resident.
 *
 * Keyed by URL so a frame is scaled at most once per session.
 */
export const createBitmapScaler = (maxEdge = BITMAP_DEFAULT_EDGE) => {
  const bitmaps = new Map<string, CanvasImageSource>()
  let targetEdge = maxEdge

  // Small shared canvas reused for every scale operation.
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas unavailable')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Raise the backing resolution when few stations are on screen at high
  // zoom, and drop it again otherwise. Existing bitmaps are left alone;
  // only frames loaded from here on use the new size.
  const setTargetEdge = (edge: number) => {
    const next = Math.max(BITMAP_MIN_EDGE, Math.min(4096, Math.round(edge)))
    if (next === targetEdge) return false
    targetEdge = next
    return true
  }

  const scale = (url: string, img: HTMLImageElement): CanvasImageSource | null => {
    const existing = bitmaps.get(url)
    if (existing) return existing

    const iw = img.naturalWidth
    const ih = img.naturalHeight
    // 1x1 placeholder frames (the upstream "nodata" image) carry no radar,
    // so keep them out of the bitmap cache entirely.
    if (!iw || !ih) return null
    if (iw <= 1 && ih <= 1) return null

    // Only shrink. A source already at or below the cap is used as-is.
    const ratio = Math.min(1, targetEdge / Math.max(iw, ih))
    const w = Math.max(1, Math.round(iw * ratio))
    const h = Math.max(1, Math.round(ih * ratio))

    canvas.width = w
    canvas.height = h
    ctx.clearRect(0, 0, w, h)
    // Pre-clip the circular radar footprint ONCE during downscaling.
    // This allows the 60fps paint() loop to draw directly without per-frame
    // ctx.clip() calls that cause major frame drops on WebKit / Safari.
    ctx.save()
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(img, 0, 0, w, h)
    ctx.restore()

    // Hand back a dedicated canvas holding the downscaled pixels, so the
    // shared scratch canvas can be reused immediately. drawImage accepts an
    // HTMLCanvasElement directly, so no async createImageBitmap is needed
    // (and it would not help: the pixels are already downscaled by now).
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    out.getContext('2d')?.drawImage(canvas, 0, 0)
    bitmaps.set(url, out)
    return out
  }

  const get = (url: string) => bitmaps.get(url) ?? null

  const dispose = (url: string) => {
    bitmaps.delete(url)
  }

  const clear = () => {
    for (const url of bitmaps.keys()) dispose(url)
  }

  return { scale, get, dispose, clear, setTargetEdge, edge: () => targetEdge, size: () => bitmaps.size }
}

export type RadarFrameSource = (stationId: string) => RadarFrame | null