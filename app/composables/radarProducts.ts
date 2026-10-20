// Catalog of the 14 station products served by `/api/nowcast/:station?product=`
// (see openapi.yaml). All of them are 4084x4084 transparent PNGs with the same
// footprint, so any product can be drawn by the same overlay code.
//
// `summary` is what the product picker shows on hover. The wording is a
// translation of BMKG's own product descriptions (SI-DARMA radar product
// guide); edit it here, nowhere else.

export type RadarProductGroup = 'reflectivity' | 'cappi' | 'rain' | 'forecast'
// Which colour ramp the product's frames use (see RADAR_SCALES).
export type RadarScaleId = 'reflectivity' | 'rain'

export interface RadarProductInfo {
  code: string
  name: string
  group: RadarProductGroup
  unit: string
  scale: RadarScaleId
  summary: string
  // Frames are predictions, not observations: their times are in the future.
  forecast?: boolean
}

const PRODUCTS = [
  {
    code: 'CMAX',
    name: 'Column max reflectivity',
    group: 'reflectivity',
    unit: 'dBZ',
    scale: 'reflectivity',
    summary:
      'Maximum reflectivity (dBZ) found in the column above each point. The higher the dBZ, the heavier the rain.',
  },
  {
    code: 'CMAXHWIND',
    name: 'CMAX + wind',
    group: 'reflectivity',
    unit: 'dBZ + wind',
    scale: 'reflectivity',
    summary:
      'CMAX overlaid with HWIND: wind direction and speed (wind barbs), taken from radial velocity data.',
  },
  {
    code: 'CMAXSSA',
    name: 'CMAX + storm cells',
    group: 'reflectivity',
    unit: 'dBZ + cells',
    scale: 'reflectivity',
    summary:
      'CMAX overlaid with SSA (Storm Structure Analysis): the location and structure of thunderstorms. It does not predict how they will move or develop.',
  },
  {
    code: 'CAPPI005',
    name: 'CAPPI 0.5 km',
    group: 'cappi',
    unit: 'dBZ',
    scale: 'reflectivity',
    summary: 'Reflectivity (dBZ) on a plane at a constant altitude of 0.5 km.',
  },
  {
    code: 'CAPPI005HWIND',
    name: 'CAPPI 0.5 km + wind',
    group: 'cappi',
    unit: 'dBZ + wind',
    scale: 'reflectivity',
    summary:
      'Reflectivity at 0.5 km altitude overlaid with HWIND: wind direction and speed (wind barbs) at that altitude.',
  },
  {
    code: 'CAPPI010',
    name: 'CAPPI 1 km',
    group: 'cappi',
    unit: 'dBZ',
    scale: 'reflectivity',
    summary: 'Reflectivity (dBZ) on a plane at a constant altitude of 1.0 km.',
  },
  {
    code: 'CAPPI010HWIND',
    name: 'CAPPI 1 km + wind',
    group: 'cappi',
    unit: 'dBZ + wind',
    scale: 'reflectivity',
    summary:
      'Reflectivity at 1.0 km altitude overlaid with HWIND: wind direction and speed (wind barbs) at that altitude.',
  },
  {
    code: 'SRI',
    name: 'Surface rainfall intensity',
    group: 'rain',
    unit: 'mm/h',
    scale: 'rain',
    summary: 'Estimated rain intensity (mm/h) at the surface.',
  },
  {
    code: 'PAC01H',
    name: 'Rain, last 1 hour',
    group: 'rain',
    unit: 'mm',
    scale: 'rain',
    summary: 'Estimated accumulated rainfall (mm) over the past 1 hour.',
  },
  {
    code: 'PAC06H',
    name: 'Rain, last 6 hours',
    group: 'rain',
    unit: 'mm',
    scale: 'rain',
    summary: 'Estimated accumulated rainfall (mm) over the past 6 hours.',
  },
  {
    code: 'PAC12H',
    name: 'Rain, last 12 hours',
    group: 'rain',
    unit: 'mm',
    scale: 'rain',
    summary: 'Estimated accumulated rainfall (mm) over the past 12 hours.',
  },
  {
    code: 'PAC24H',
    name: 'Rain, last 24 hours',
    group: 'rain',
    unit: 'mm',
    scale: 'rain',
    summary: 'Estimated accumulated rainfall (mm) over the past 24 hours.',
  },
  {
    code: 'STEPS',
    name: 'Nowcast (STEPS)',
    group: 'forecast',
    unit: 'dBZ',
    scale: 'reflectivity',
    summary:
      'Short-term prediction (nowcasting) of reflectivity 1 to 3 hours ahead, from the Short-Term Ensemble Prediction System (ensemble-max). Times shown are forecast times.',
    forecast: true,
  },
  {
    code: 'QPF',
    name: 'Rain forecast (QPF)',
    group: 'forecast',
    unit: 'mm',
    scale: 'rain',
    summary:
      'Quantitative Precipitation Forecast: the rainfall accumulation (mm) predicted by STEPS. This is a prediction, not an observation.',
    forecast: true,
  },
] as const satisfies readonly RadarProductInfo[]

export type RadarProductCode = (typeof PRODUCTS)[number]['code']

export const RADAR_PRODUCTS: readonly RadarProductInfo[] = PRODUCTS

export const RADAR_PRODUCT_GROUPS: readonly { id: RadarProductGroup, label: string }[] = [
  { id: 'reflectivity', label: 'Reflectivity' },
  { id: 'cappi', label: 'Altitude slice (CAPPI)' },
  { id: 'rain', label: 'Rainfall' },
  { id: 'forecast', label: 'Forecast' },
]

export const radarProductInfo = (code: string): RadarProductInfo =>
  RADAR_PRODUCTS.find(p => p.code === code) ?? RADAR_PRODUCTS[0]!

// BMKG's rain-intensity classification for reflectivity products.
export const RADAR_REFLECTIVITY_CLASSES: readonly { label: string, dbz: string, mmh: string }[] = [
  { label: 'Very light', dbz: '0–20', mmh: '< 1' },
  { label: 'Light', dbz: '20–35', mmh: '1–5' },
  { label: 'Moderate', dbz: '35–45', mmh: '5–10' },
  { label: 'Heavy', dbz: '45–55', mmh: '10–20' },
  { label: 'Very heavy', dbz: '> 55', mmh: '> 20' },
]

// Colours measured from real frames (every pixel colour in the busiest frames
// of each product), listed weakest to strongest. Frames are drawn with exactly
// these colours, so the legend matches the map. The order follows the usual
// radar convention; no numeric thresholds are attached to individual colours
// because the API does not publish them.
// BMKG's rain-intensity classes. Reflectivity products are quoted in dBZ with
// the equivalent rain rate; rain-rate products (SRI, PAC*) are already mm/h.
// Semantic accent colours for status UI, taken from the ends of the
// reflectivity ramp so the chips sit in the same palette as the legend
// instead of introducing unrelated reds/greens.
export const RADAR_STATUS_COLORS = {
  // strongest echo colour = worst case
  severe: '#fb0103',
  // mid-ramp amber = warning
  warning: '#ffc801',
  ok: '#00c703',
} as const

export const RADAR_INTENSITY_BANDS = [
  { label: 'Very light', dbz: '0–20 dBZ', mmh: '< 1 mm/h', note: 'Drizzle. Roads stay wet for a moment.' },
  { label: 'Light', dbz: '20–35 dBZ', mmh: '1–5 mm/h', note: 'Steady rain. No disruption expected.' },
  { label: 'Moderate', dbz: '35–45 dBZ', mmh: '5–10 mm/h', note: 'Heavy enough to reduce visibility.' },
  { label: 'Heavy', dbz: '45–55 dBZ', mmh: '10–20 mm/h', note: 'Rain, possibly thunderstorms. Watch for local flooding.' },
  { label: 'Very heavy', dbz: '> 55 dBZ', mmh: '> 20 mm/h', note: 'Torrential rain. Expect flash floods and travel disruption.' },
] as const

export interface RadarScaleBand {
  label: string
  dbz: string
  mmh: string
  note: string
  colors: string[]
}

/**
 * Group an ordered colour list into the 5 intensity bands above.
 *
 * The API publishes the frame colours but no per-colour dBZ value, so pairing
 * each band to BMKG's documented class boundaries is an approximation of the
 * ordered ramp — not a measured per-colour mapping. Colours are distributed
 * evenly so each band covers a contiguous, visually similar slice.
 */
export function bandsFor(scale: RadarScaleId): RadarScaleBand[] {
  const colors = [...RADAR_SCALES[scale].colors]
  const n = RADAR_INTENSITY_BANDS.length
  const size = colors.length / n
  return RADAR_INTENSITY_BANDS.map((band, i) => ({
    label: band.label,
    dbz: band.dbz,
    mmh: band.mmh,
    note: band.note,
    colors: colors.slice(Math.floor(i * size), Math.floor((i + 1) * size)),
  })).filter(b => b.colors.length > 0)
}

export const RADAR_SCALES: Record<RadarScaleId, { low: string, high: string, colors: readonly string[] }> = {
  reflectivity: {
    low: 'Weaker',
    high: 'Stronger',
    colors: [
      '#07fef6', '#0096ff', '#0002fe', '#01fe03', '#00c703',
      '#009902', '#fffe00', '#ffc801', '#ff7707', '#fb0103',
    ],
  },
  rain: {
    low: 'Lighter',
    high: 'Heavier',
    colors: [
      '#0000c7', '#0079ff', '#32c8ff', '#78ebff', '#ffffff', '#fff7c0',
      '#ffe500', '#ff7300', '#ff3f00', '#c80000', '#960000', '#6e0000',
    ],
  },
}
