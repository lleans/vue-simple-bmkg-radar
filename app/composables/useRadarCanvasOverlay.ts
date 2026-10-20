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
// Cross-origin note: the bucket sends no Access-Control-Allow-Origin, so the
// canvas is tainted and getImageData/toBlob throw. That is fine here — we
// only draw into it and let the compositor display it, which never reads
// pixels back. Do not add getImageData/toBlob to this file.

import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { RadarFrame } from './useRadarApi'

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
  // 1 for the picked station, 0.55 dimmed for the others.
  opacity: number
}

export const useRadarCanvasOverlay = (
  canvasRef: Ref<HTMLCanvasElement | null>,
  getStations: () => RadarOverlayStation[],
  resolveFrame: (stationId: string) => string | null,
  resolveBitmap: (url: string) => CanvasImageSource | null,
  isLoaded: (url: string) => boolean,
) => {
  const ready = ref(false)
  const size = shallowRef({ w: 0, h: 0 })

  let ctx: CanvasRenderingContext2D | null = null
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
    size.value = { w, h }
    schedule()
  }

  function paint() {
    pending = false
    const el = canvasRef.value
    if (!el || !ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, el.width, el.height)

    for (const s of getStations()) {
      const url = resolveFrame(s.id)
      if (!url) continue
      const bmp = resolveBitmap(url)
      if (!bmp) continue
      const size = s.size
      if (!(size > 0)) continue
      ctx.save()
      ctx.globalAlpha = s.opacity
      ctx.globalCompositeOperation = 'screen'
      ctx.beginPath()
      ctx.arc(s.x, s.y, size / 2, 0, Math.PI * 2)
      ctx.clip()
      ctx.drawImage(bmp, s.x - size / 2, s.y - size / 2, size, size)
      ctx.restore()
    }
    lastPaint = performance.now()
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
    ctx = canvasRef.value?.getContext('2d') ?? null
    ready.value = !!ctx
    measure()
    observer = new ResizeObserver(measure)
    if (canvasRef.value) observer.observe(canvasRef.value)
    schedule()
  })

  onBeforeUnmount(() => {
    if (raf) cancelAnimationFrame(raf)
    observer?.disconnect()
    observer = null
    ctx = null
  })

  /**
   * Repaint on the very next frame with no throttle. Used while the map is
   * moving: a pan redraws at 60fps, so throttling the overlay would make the
   * radar visibly trail the basemap. Costs one clearRect + one drawImage per
   * visible station, which is cheap compared with the compositing it replaces.
   */
  function scheduleImmediate() {
    if (raf) cancelAnimationFrame(raf)
    pending = false
    raf = requestAnimationFrame(paint)
  }

  return { ready, size, schedule, scheduleImmediate, measure }
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
    ctx.drawImage(img, 0, 0, w, h)

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

  return { scale, get, dispose, clear, setTargetEdge, size: () => bitmaps.size }
}

export type RadarFrameSource = (stationId: string) => RadarFrame | null