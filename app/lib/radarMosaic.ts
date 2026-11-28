// Pure logic behind the WebGL2 radar mosaic. No DOM and no GL calls here, so
// it is unit-tested in radarMosaic.test.ts. The fragment shader in
// radarMosaicGl.ts implements the same rule as `mosaicPixel` below; if one
// changes, change the other.
//
// Blend rule ("max"): for each output pixel, over the stations whose
// frame has an echo here (index > 0):
//   score_i = paletteIndex_i * weight_i
//   winner  = argmax_i score_i          (the strongest weighted echo)
//   colour  = palette[winner]           (a real palette colour, never a blend)
//   alpha   = max_i weight_i * MOSAIC_ALPHA
// Max keeps overlapping echoes from diluting each other. Each station's weight
// is a hard 1 inside its frame circle and 0 outside, so a station's rim is a
// hard edge. The colour changes where two echoes' weighted strengths are equal.

/** Upper bound on stations per draw: the shader's uniform array length. */
export const MOSAIC_MAX_STATIONS = 64

/** Strength for a station that is not dimmed; multiplies its weight. */
export const FULL_STRENGTH = 1
/** Strength for a dimmed station (the view has a selected station and this is not it). */
export const DIMMED_STRENGTH = 0.55

/** Layer opacity. Matches the Canvas2D overlay's 0.9 for the undimmed stations. */
export const MOSAIC_ALPHA = 0.9

/** Source pixels with alpha below this are no echo. */
export const ECHO_ALPHA_MIN = 128

/**
 * Edge, in pixels, of the palette-index texture each frame is resampled to.
 * A number caps it (linear filtering interpolates the index, so a smaller
 * texture keeps the look); null keeps the bitmap's own target edge.
 */
export const MOSAIC_INDEX_EDGE: number | null = 1024

/** The index texture edge to use: the bitmap's target edge, capped at `cap` when set. */
export function mosaicIndexEdge(targetEdge: number, cap: number | null = MOSAIC_INDEX_EDGE): number {
  if (!(targetEdge > 0)) return targetEdge
  if (cap === null || !(cap > 0)) return targetEdge
  return Math.min(targetEdge, cap)
}

/**
 * Half-width of the band, centred on presence 0.5, over which the echo edge
 * alpha ramps from 0 to 1. Presence is the bilinear average of echo texels, so
 * it crosses 0.5 along the interpolated contour of the echo. A ramp of 0.05
 * presence covers 5% of one texel, which at close zoom (a texel is several
 * screen pixels) is well under one screen pixel: the edge is sharp, and it
 * still follows the bilinear contour, so the stair steps of a nearest-texel
 * mask do not come back. A band of 0 would be a hard cut and would alias on
 * diagonal edges; a much wider band is the blur we are removing.
 */
export const ECHO_EDGE_BAND = 0.025

/** Palette index 0 is reserved for "no echo"; palette entry k is index k + 1. */
export const MAX_PALETTE_ENTRIES = 255

/**
 * Station weight at normalised distance `d` from a station centre
 * (0 = centre, 1 = rim): 1 inside the circle, 0 at and beyond the rim.
 */
export function circleWeight(d: number): number {
  return d < 1 ? 1 : 0
}

export function stationStrength(dimmed: boolean): number {
  return dimmed ? DIMMED_STRENGTH : FULL_STRENGTH
}

/**
 * Weight of one station at a pixel that is (dx, dy) from its centre, with the
 * station's frame radius `radius` (same units as dx/dy).
 */
export function stationWeight(dx: number, dy: number, radius: number, dimmed: boolean): number {
  if (!(radius > 0)) return 0
  return circleWeight(Math.hypot(dx, dy) / radius) * stationStrength(dimmed)
}

export interface MosaicSample {
  /** Palette index of this station's frame at the pixel (0 = no echo). */
  index: number
  /** Circle weight times strength, from stationWeight. */
  weight: number
  /** Echo presence at the pixel, 0..1 (echoEdgeSample alpha). Defaults to 1. */
  presence?: number
}

export interface MosaicPixel {
  /** Palette index to draw (0 = nothing). */
  index: number
  /** Output alpha, 0..MOSAIC_ALPHA. */
  alpha: number
}

/** CPU reference for the shader's per-pixel rule. */
export function mosaicPixel(samples: readonly MosaicSample[]): MosaicPixel {
  let bestScore = 0
  let bestIndex = 0
  let maxWeight = 0
  for (const s of samples) {
    if (s.index <= 0 || !(s.weight > 0)) continue
    const alphaS = s.weight * (s.presence ?? 1)
    if (alphaS > maxWeight) maxWeight = alphaS
    const score = s.index * s.weight
    if (score > bestScore) {
      bestScore = score
      bestIndex = s.index
    }
  }
  if (bestIndex === 0) return { index: 0, alpha: 0 }
  return { index: bestIndex, alpha: maxWeight * MOSAIC_ALPHA }
}

/** Parse '#rrggbb' into [r, g, b]. Throws on anything else. */
export function parseHexColour(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`radarMosaic: not a #rrggbb colour: ${hex}`)
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * The palette a product's frames are mapped onto, or null when the product
 * cannot go through the mosaic.
 *
 * CMAX+wind (HWIND) and CMAX+storm cells (SSA) draw black barbs, labels and
 * red markers on top of the reflectivity colours. Those are not echoes, and
 * nearest-colour mapping would turn them into green or red echo, so these
 * products stay on the Canvas2D overlay.
 */
export function mosaicPaletteFor(code: string, colours: readonly string[]): readonly string[] | null {
  if (code.includes('HWIND') || code.includes('SSA')) return null
  if (colours.length === 0 || colours.length > MAX_PALETTE_ENTRIES) return null
  return colours
}

/**
 * 256x1 RGBA lookup: texel k is the colour of palette index k. Index 0 is
 * fully transparent; index k + 1 is palette[k], opaque.
 */
export function buildPaletteLut(colours: readonly string[]): Uint8Array {
  if (colours.length > MAX_PALETTE_ENTRIES) {
    throw new Error(`radarMosaic: palette has ${colours.length} entries, max ${MAX_PALETTE_ENTRIES}`)
  }
  const lut = new Uint8Array(256 * 4)
  colours.forEach((hex, i) => {
    const [r, g, b] = parseHexColour(hex)
    const o = (i + 1) * 4
    lut[o] = r
    lut[o + 1] = g
    lut[o + 2] = b
    lut[o + 3] = 255
  })
  return lut
}

export type ColourIndexer = (r: number, g: number, b: number) => number

/**
 * Nearest-colour indexer over the palette (squared RGB distance). Results are
 * cached per unique colour in a Map, because a frame has a few distinct
 * colours but up to ~1M pixels. Returns palette index + 1.
 */
export function createColourIndexer(colours: readonly string[]): ColourIndexer {
  const entries = colours.map(parseHexColour)
  const cache = new Map<number, number>()
  const MAX_CACHE = 200_000
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < entries.length; i++) {
      const [pr, pg, pb] = entries[i]!
      const dr = r - pr
      const dg = g - pg
      const db = b - pb
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    const index = best + 1
    if (cache.size >= MAX_CACHE) cache.clear()
    cache.set(key, index)
    return index
  }
}

/**
 * Round an interpolated palette index to the nearest palette entry index.
 * Half rounds up, matching the shader's floor(x + 0.5). Clamped to 0..255.
 */
export function roundPaletteIndex(value: number): number {
  if (!(value > 0)) return 0
  return Math.min(MAX_PALETTE_ENTRIES, Math.floor(value + 0.5))
}

/**
 * Bilinear value of an R8 index texture at normalised (u, v), the way GL
 * linear filtering samples it: texel centres sit at (i + 0.5) / size, and
 * coordinates clamp to the edge. `texel(x, y)` returns the stored index.
 */
export function bilinearIndex(
  texel: (x: number, y: number) => number,
  width: number,
  height: number,
  u: number,
  v: number,
): number {
  const x = u * width - 0.5
  const y = v * height - 0.5
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const cx = (n: number) => Math.min(width - 1, Math.max(0, n))
  const cy = (n: number) => Math.min(height - 1, Math.max(0, n))
  const xa = cx(x0)
  const xb = cx(x0 + 1)
  const ya = cy(y0)
  const yb = cy(y0 + 1)
  const top = texel(xa, ya) + (texel(xb, ya) - texel(xa, ya)) * fx
  const bottom = texel(xa, yb) + (texel(xb, yb) - texel(xa, yb)) * fx
  return top + (bottom - top) * fy
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Edge alpha from bilinear echo presence (0..1): 0 below 0.5 - band, 1 above
 * 0.5 + band, smoothstep in between. The colour is not touched by this.
 */
export function echoEdgeAlpha(presence: number, band: number = ECHO_EDGE_BAND): number {
  return smoothstep(0.5 - band, 0.5 + band, presence)
}

/** One echo sample at a pixel: alpha from echo presence, colour from the echo taps only. */
export interface EchoSample {
  /** Bilinear average of the presence mask (1 where the texel has echo, else 0). 0 = clear air. */
  alpha: number
  /** Palette index: the presence-weighted average over the echo taps, rounded. 0 if alpha is 0. */
  index: number
}

/**
 * Edge alpha and echo colour from the four taps of one bilinear footprint.
 * taps = [a, b, c, d] at (x0,y0), (x1,y0), (x0,y1), (x1,y1); each is a palette
 * index 0..255, where 0 means no echo. fx, fy are the bilinear fractions.
 *
 * alpha is the bilinear average of presence, so the outer edge fades over one
 * texel with no colour involved. The colour is the same weighting restricted to
 * the echo taps, so a no-echo tap never pulls the colour toward zero, and the
 * result is rounded to a palette entry. Colours are never blended.
 */
export function echoEdgeSample(
  taps: readonly [number, number, number, number],
  fx: number,
  fy: number,
): EchoSample {
  const [a, b, c, d] = taps
  const wa = (1 - fx) * (1 - fy)
  const wb = fx * (1 - fy)
  const wc = (1 - fx) * fy
  const wd = fx * fy
  // Presence: an index of 0 is no echo; any echo index is at least 1.
  const ka = a >= 0.5 ? wa : 0
  const kb = b >= 0.5 ? wb : 0
  const kc = c >= 0.5 ? wc : 0
  const kd = d >= 0.5 ? wd : 0
  // The colour uses the raw presence (exactly as before); only the alpha curve is sharpened.
  const presence = ka + kb + kc + kd
  if (!(presence > 0)) return { alpha: 0, index: 0 }
  const alpha = echoEdgeAlpha(presence)
  const weighted = ka * a + kb * b + kc * c + kd * d
  return { alpha, index: roundPaletteIndex(weighted / presence) }
}

/**
 * echoEdgeSample at normalised (u, v) of a width x height index texture, with
 * GL-style texel centres and edge clamping (the same geometry as bilinearIndex).
 */
export function echoSampleAt(
  texel: (x: number, y: number) => number,
  width: number,
  height: number,
  u: number,
  v: number,
): EchoSample {
  const x = u * width - 0.5
  const y = v * height - 0.5
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const cx = (n: number) => Math.min(width - 1, Math.max(0, n))
  const cy = (n: number) => Math.min(height - 1, Math.max(0, n))
  const xa = cx(x0)
  const xb = cx(x0 + 1)
  const ya = cy(y0)
  const yb = cy(y0 + 1)
  return echoEdgeSample(
    [texel(xa, ya), texel(xb, ya), texel(xa, yb), texel(xb, yb)],
    x - x0,
    y - y0,
  )
}

/**
 * Convert RGBA pixels to palette indices, one byte per pixel. Pixels with
 * alpha below ECHO_ALPHA_MIN become 0 (no echo); the rest take the index of
 * their nearest palette colour.
 *
 * `rgba` is 4 bytes per pixel, row-major, top row first.
 */
export function paletteIndicesFromRgba(rgba: Uint8ClampedArray | Uint8Array, indexer: ColourIndexer): Uint8Array {
  const count = rgba.length >> 2
  const out = new Uint8Array(count)
  for (let p = 0, o = 0; p < count; p++, o += 4) {
    if (rgba[o + 3]! < ECHO_ALPHA_MIN) continue
    out[p] = indexer(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!)
  }
  return out
}
