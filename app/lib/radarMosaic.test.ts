import { describe, it, expect } from 'vitest'
import {
  bilinearIndex,
  mosaicIndexEdge,
  echoEdgeAlpha,
  ECHO_EDGE_BAND,
  echoEdgeSample,
  echoSampleAt,
  roundPaletteIndex,
  DIMMED_STRENGTH,
  ECHO_ALPHA_MIN,
  MOSAIC_ALPHA,
  buildPaletteLut,
  createColourIndexer,
  circleWeight,
  mosaicPaletteFor,
  mosaicPixel,
  paletteIndicesFromRgba,
  parseHexColour,
  stationStrength,
  stationWeight,
} from './radarMosaic'

// The reflectivity ramp from radarProducts.ts, weakest to strongest.
const REFLECTIVITY = [
  '#07fef6', '#0096ff', '#0002fe', '#01fe03', '#00c703',
  '#009902', '#fffe00', '#ffc801', '#ff7707', '#fb0103',
]

describe('circleWeight', () => {
  it('is 1 at the centre and everywhere inside the circle, right up to the rim', () => {
    expect(circleWeight(0)).toBe(1)
    expect(circleWeight(0.5)).toBe(1)
    expect(circleWeight(0.999999)).toBe(1)
  })

  it('is 0 at and beyond the rim (hard edge, no falloff)', () => {
    expect(circleWeight(1)).toBe(0)
    expect(circleWeight(1.5)).toBe(0)
    expect(circleWeight(Number.NaN)).toBe(0)
  })
})

describe('stationStrength', () => {
  it('is 1 for an undimmed station and DIMMED_STRENGTH for a dimmed one', () => {
    expect(stationStrength(false)).toBe(1)
    expect(stationStrength(true)).toBe(DIMMED_STRENGTH)
    expect(DIMMED_STRENGTH).toBe(0.55)
  })
})

describe('stationWeight', () => {
  it('scales the circle weight by strength', () => {
    expect(stationWeight(0, 0, 100, false)).toBe(1)
    expect(stationWeight(0, 0, 100, true)).toBeCloseTo(DIMMED_STRENGTH, 6)
  })

  it('uses Euclidean distance, so diagonal offsets sit on the rim at the same radius as axis offsets', () => {
    const axis = stationWeight(90, 0, 100, false)
    const diag = stationWeight(90 / Math.SQRT2, 90 / Math.SQRT2, 100, false)
    expect(diag).toBeCloseTo(axis, 9)
  })

  it('is 0 outside the radius and for a non-positive radius', () => {
    expect(stationWeight(100, 0, 100, false)).toBe(0)
    expect(stationWeight(0, 0, 0, false)).toBe(0)
    expect(stationWeight(0, 0, -5, false)).toBe(0)
  })
})

describe('mosaicPixel (CPU reference of the shader rule)', () => {
  it('returns no echo when no station has an echo here', () => {
    expect(mosaicPixel([])).toEqual({ index: 0, alpha: 0 })
    expect(mosaicPixel([{ index: 0, weight: 1 }, { index: 5, weight: 0 }])).toEqual({ index: 0, alpha: 0 })
  })

  it('takes the strongest weighted echo, not the average: blue and yellow stay blue or yellow', () => {
    // A blue echo (index 3) overlapping a yellow one (index 7) at equal weight.
    const out = mosaicPixel([{ index: 3, weight: 1 }, { index: 7, weight: 1 }])
    expect(out.index).toBe(7)
    expect(out.alpha).toBeCloseTo(MOSAIC_ALPHA, 9)
  })

  it('lets a weak-but-fully-inside echo beat a strong one that is at its rim', () => {
    // Strong index 9 at weight 0.1 scores 0.9; index 4 at weight 1 scores 4.
    const out = mosaicPixel([{ index: 9, weight: 0.1 }, { index: 4, weight: 1 }])
    expect(out.index).toBe(4)
  })

  it('does not dilute a strong echo under overlap (max, not sum)', () => {
    const alone = mosaicPixel([{ index: 9, weight: 1 }])
    const overlapped = mosaicPixel([{ index: 9, weight: 1 }, { index: 2, weight: 1 }])
    expect(overlapped).toEqual(alone)
  })

  it('takes alpha from the strongest weight among echoes, scaled by MOSAIC_ALPHA', () => {
    // scores: 9*0.4 = 3.6 vs 2*0.8 = 1.6, so index 9 is the colour;
    // alpha is the max weight (0.8), not the winner's weight.
    const out = mosaicPixel([{ index: 9, weight: 0.4 }, { index: 2, weight: 0.8 }])
    expect(out.index).toBe(9)
    expect(out.alpha).toBeCloseTo(0.8 * MOSAIC_ALPHA, 9)
  })

  it('ignores stations with no echo at the pixel, even when they have full weight', () => {
    expect(mosaicPixel([{ index: 0, weight: 1 }, { index: 4, weight: 0.5 }])).toEqual({
      index: 4,
      alpha: 0.5 * MOSAIC_ALPHA,
    })
  })

  it('has no alpha step across a station rim that lies over another echo', () => {
    // Station A (index 9) rims out over station B (index 3, full weight).
    // Alpha stays at B's level as A's weight falls; only the colour can change.
    for (let i = 0; i <= 1000; i++) {
      const out = mosaicPixel([{ index: 9, weight: 1 - i / 1000 }, { index: 3, weight: 1 }])
      expect(out.alpha).toBeCloseTo(MOSAIC_ALPHA, 9)
    }
  })
})

describe('mosaicPaletteFor', () => {
  it('maps plain reflectivity and rain products onto their palette', () => {
    expect(mosaicPaletteFor('CMAX', REFLECTIVITY)).toBe(REFLECTIVITY)
    expect(mosaicPaletteFor('CAPPI010', REFLECTIVITY)).toBe(REFLECTIVITY)
    expect(mosaicPaletteFor('STEPS', REFLECTIVITY)).toBe(REFLECTIVITY)
  })

  it('keeps HWIND and SSA products on the Canvas2D path (black barbs and markers are not echo)', () => {
    expect(mosaicPaletteFor('CMAXHWIND', REFLECTIVITY)).toBeNull()
    expect(mosaicPaletteFor('CAPPI005HWIND', REFLECTIVITY)).toBeNull()
    expect(mosaicPaletteFor('CMAXSSA', REFLECTIVITY)).toBeNull()
  })

  it('refuses an empty or oversized palette', () => {
    expect(mosaicPaletteFor('CMAX', [])).toBeNull()
    const huge = Array.from({ length: 256 }, () => '#000000')
    expect(mosaicPaletteFor('CMAX', huge)).toBeNull()
  })
})

describe('parseHexColour', () => {
  it('parses #rrggbb case-insensitively', () => {
    expect(parseHexColour('#07fef6')).toEqual([7, 254, 246])
    expect(parseHexColour('#FB0103')).toEqual([251, 1, 3])
  })

  it('rejects anything else', () => {
    expect(() => parseHexColour('#fff')).toThrow()
    expect(() => parseHexColour('rgb(0,0,0)')).toThrow()
  })
})

describe('buildPaletteLut', () => {
  it('puts palette[k] at texel k + 1 and leaves texel 0 transparent', () => {
    const lut = buildPaletteLut(REFLECTIVITY)
    expect(lut.length).toBe(256 * 4)
    expect([...lut.slice(0, 4)]).toEqual([0, 0, 0, 0])
    // palette[0] = #07fef6 at texel 1
    expect([...lut.slice(4, 8)]).toEqual([7, 254, 246, 255])
    // palette[9] = #fb0103 at texel 10
    const o = 10 * 4
    expect([...lut.slice(o, o + 4)]).toEqual([251, 1, 3, 255])
    // unused texels stay transparent
    expect(lut[11 * 4 + 3]).toBe(0)
  })
})

describe('createColourIndexer', () => {
  const index = createColourIndexer(REFLECTIVITY)

  it('maps each exact palette colour to its own index (palette position + 1)', () => {
    REFLECTIVITY.forEach((hex, k) => {
      const [r, g, b] = parseHexColour(hex)
      expect(index(r, g, b)).toBe(k + 1)
    })
  })

  it('maps a near colour to the nearest palette entry', () => {
    // The PNG has one stray pixel colour (201,0,2); it is nearest to #fb0103.
    expect(index(201, 0, 2)).toBe(REFLECTIVITY.indexOf('#fb0103') + 1)
    // A lossy-WebP colour a few steps off #0096ff.
    expect(index(3, 147, 252)).toBe(REFLECTIVITY.indexOf('#0096ff') + 1)
  })

  it('maps a colour that is far from everything to the nearest entry, never to 0', () => {
    expect(index(0, 0, 0)).toBeGreaterThan(0)
  })
})

describe('paletteIndicesFromRgba', () => {
  it('sets transparent and near-transparent pixels to 0 and indexes the rest', () => {
    const index = createColourIndexer(REFLECTIVITY)
    const red = parseHexColour('#fb0103')
    const blue = parseHexColour('#0002fe')
    const rgba = new Uint8ClampedArray([
      ...red, 255, // opaque red -> index 10
      ...blue, ECHO_ALPHA_MIN - 1, // mostly transparent -> 0
      ...blue, ECHO_ALPHA_MIN, // threshold -> index 3
      0, 0, 0, 0, // transparent -> 0
    ])
    expect([...paletteIndicesFromRgba(rgba, index)]).toEqual([
      REFLECTIVITY.indexOf('#fb0103') + 1,
      0,
      REFLECTIVITY.indexOf('#0002fe') + 1,
      0,
    ])
  })
})

describe('interpolated palette index', () => {
  // 2x2 index texture: rows are y, columns are x.
  const grid = [
    [0, 10],
    [20, 30],
  ]
  const texel = (x: number, y: number) => grid[y]![x]!

  it('returns the stored index exactly at texel centres', () => {
    expect(bilinearIndex(texel, 2, 2, 0.25, 0.25)).toBeCloseTo(0, 9)
    expect(bilinearIndex(texel, 2, 2, 0.75, 0.25)).toBeCloseTo(10, 9)
    expect(bilinearIndex(texel, 2, 2, 0.25, 0.75)).toBeCloseTo(20, 9)
    expect(bilinearIndex(texel, 2, 2, 0.75, 0.75)).toBeCloseTo(30, 9)
  })

  it('interpolates the index linearly between texels', () => {
    // Midway between 0 and 10 along x, on the top row.
    expect(bilinearIndex(texel, 2, 2, 0.5, 0.25)).toBeCloseTo(5, 9)
    // Centre of the four texels: the mean of 0, 10, 20, 30.
    expect(bilinearIndex(texel, 2, 2, 0.5, 0.5)).toBeCloseTo(15, 9)
  })

  it('clamps to the edge outside the texture', () => {
    expect(bilinearIndex(texel, 2, 2, 0, 0.25)).toBeCloseTo(0, 9)
    expect(bilinearIndex(texel, 2, 2, 1, 0.25)).toBeCloseTo(10, 9)
  })

  it('rounds half up and clamps to the palette index range', () => {
    expect(roundPaletteIndex(4.49)).toBe(4)
    expect(roundPaletteIndex(4.5)).toBe(5)
    expect(roundPaletteIndex(-0.3)).toBe(0)
    expect(roundPaletteIndex(Number.NaN)).toBe(0)
    expect(roundPaletteIndex(300)).toBe(255)
  })

  it('a no-echo tap never changes the colour: only echo taps are averaged', () => {
    // Taps 4, 0, 8, 8 at the centre of the footprint. The echo taps are 4, 8, 8.
    // Averaging all four would give 5 (and draw cyan-ish steps); echo taps only give 7.
    const s = echoEdgeSample([4, 0, 8, 8], 0.5, 0.5)
    expect(s.index).toBe(7)
    // Same colour whatever value the no-echo tap is paired with its weight.
    expect(echoEdgeSample([4, 0, 8, 8], 0.5, 0.5).index).toBe(s.index)
  })

  it('an all-no-echo neighbourhood gives zero alpha', () => {
    expect(echoEdgeSample([0, 0, 0, 0], 0.3, 0.7)).toEqual({ alpha: 0, index: 0 })
  })

  it('the alpha fades over the edge texel: presence bilinear, half at the midpoint', () => {
    // One echo tap (9) next to clear air, sampled midway: alpha 0.5, colour stays 9.
    expect(echoEdgeSample([9, 0, 0, 0], 0.5, 0)).toEqual({ alpha: 0.5, index: 9 })
    // Fully inside the echo: alpha 1.
    expect(echoEdgeSample([9, 9, 9, 9], 0.2, 0.8).alpha).toBeCloseTo(1, 9)
    // Fully in clear air next to the echo: alpha 0.
    expect(echoEdgeSample([9, 9, 0, 0], 0.5, 1)).toEqual({ alpha: 0, index: 0 })
  })

  it('the colour is always a whole palette index, rounded from the echo taps', () => {
    // Echo 1 (cyan) next to clear air: alpha fades, the colour is exactly 1, never a blend with 0.
    const s = echoEdgeSample([1, 0, 1, 0], 0.5, 0.5)
    expect(s.index).toBe(1)
    expect(Number.isInteger(s.index)).toBe(true)
    // Mixed echo steps: 3 and 9 at equal weight average to 6, a palette step.
    expect(echoEdgeSample([3, 9, 0, 0], 0.5, 0).index).toBe(6)
  })

  it('draws only palette entries and an alpha inside 0..1, for any taps', () => {
    for (let i = 0; i < 200; i++) {
      const taps = [0, 1, 2, 5, 9, 10].map(() => 0) as [number, number, number, number]
      for (let k = 0; k < 4; k++) taps[k] = Math.random() < 0.4 ? 0 : 1 + Math.floor(Math.random() * 9)
      const s = echoEdgeSample(taps, Math.random(), Math.random())
      expect(s.alpha).toBeGreaterThanOrEqual(0)
      expect(s.alpha).toBeLessThanOrEqual(1)
      expect(Number.isInteger(s.index)).toBe(true)
      expect(s.index === 0 || (s.index >= 1 && s.index <= 9)).toBe(true)
    }
  })

  it('the texel-based sample matches the tap-based one at texel centres', () => {
    const grid = [
      [0, 9],
      [9, 9],
    ]
    const texel = (x: number, y: number) => grid[y]![x]!
    // u=0.25 is the centre of texel 0: presence 0, so no echo.
    expect(echoSampleAt(texel, 2, 2, 0.25, 0.25)).toEqual({ alpha: 0, index: 0 })
    // u=0.75, v=0.75 is texel (1,1) which is echo 9 with all four taps in echo: alpha 1.
    expect(echoSampleAt(texel, 2, 2, 0.75, 0.75).alpha).toBeCloseTo(1, 9)
  })
})

describe('mosaicIndexEdge', () => {
  it('keeps the target edge when no cap is set', () => {
    expect(mosaicIndexEdge(1800, null)).toBe(1800)
  })

  it('caps the edge at the given size', () => {
    expect(mosaicIndexEdge(1800, 1024)).toBe(1024)
    expect(mosaicIndexEdge(4084, 1024)).toBe(1024)
  })

  it('never upsamples past the target edge', () => {
    expect(mosaicIndexEdge(512, 1024)).toBe(512)
  })

  it('returns a non-positive target unchanged', () => {
    expect(mosaicIndexEdge(0, 1024)).toBe(0)
  })
})

describe('echo edge alpha (sharp threshold on presence)', () => {
  it('is 0 below the band and 1 above it', () => {
    expect(echoEdgeAlpha(0.4)).toBe(0)
    expect(echoEdgeAlpha(0)).toBe(0)
    expect(echoEdgeAlpha(0.6)).toBe(1)
    expect(echoEdgeAlpha(1)).toBe(1)
  })

  it('ramps across a band of 0.05 around 0.5, so the edge is one screen pixel wide, not one texel', () => {
    expect(ECHO_EDGE_BAND).toBe(0.025)
    expect(echoEdgeAlpha(0.5 - ECHO_EDGE_BAND)).toBeCloseTo(0, 9)
    expect(echoEdgeAlpha(0.5 + ECHO_EDGE_BAND)).toBeCloseTo(1, 9)
    expect(echoEdgeAlpha(0.5)).toBeCloseTo(0.5, 9)
    // Monotonic across the band.
    let prev = -1
    for (let p = 0.45; p <= 0.55; p += 0.001) {
      const a = echoEdgeAlpha(p)
      expect(a).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = a
    }
  })

  it('a wider band is a blur: the same presence gives an intermediate alpha', () => {
    expect(echoEdgeAlpha(0.6, 0.25)).toBeLessThan(1)
    expect(echoEdgeAlpha(0.6, 0.25)).toBeGreaterThan(0)
  })

  it('the sample alpha follows the threshold, and the colour is unchanged by it', () => {
    // One echo tap at 9 next to clear air, sampled 0.2 across: presence 0.8, alpha 1.
    const near = echoEdgeSample([9, 0, 0, 0], 0.2, 0)
    expect(near.alpha).toBe(1)
    expect(near.index).toBe(9)
    // Sampled 0.9 across: presence 0.1, alpha 0, colour not used.
    expect(echoEdgeSample([9, 0, 0, 0], 0.9, 0).alpha).toBe(0)
    // Colour from echo taps only, whatever the alpha band is.
    expect(echoEdgeSample([4, 0, 8, 8], 0.5, 0.5).index).toBe(7)
  })
})
