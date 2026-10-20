# BMKG SI-DARMA Radar Proxy — API & Integration Reference

This document is the handoff reference for integrating the **BMKG SI-DARMA Weather Radar** proxy into the `vue-simple-bmkg-radar` frontend.

---

## 1. Backend Proxy Infrastructure

- **Live Deployed Worker**: `https://darma-proxy-rust-cloudflare.ahmadunnail0.workers.dev`
- **Local Dev Worker**: `http://localhost:8787` (from `darma-proxy-rust-cloudflare`)
- **Interactive Documentation**: `{BASE_URL}/docs` (Scalar UI)
- **OpenAPI 3.0 Specification**: `{BASE_URL}/openapi.yaml`
- **CORS**: Fully enabled (`Access-Control-Allow-Origin: *`, preflight `OPTIONS` handled).
- **Image CDN Base**: `https://pub-690fce0c301c483cbbf46234d40798f2.r2.dev` (Cloudflare R2 public bucket)

### Standard Response Envelope
Every successful response returns `200 OK` wrapped in this structure:
```json
{
  "ok": true,
  "cached": true,
  "cache_age_seconds": 45,
  "pulled_at_utc": "2026-10-11T14:00:00Z",
  "data": { ... }
}
```

Errors return `4xx` or `5xx`:
```json
{
  "ok": false,
  "error": "invalid_station",
  "message": "XXX"
}
```

---

## 2. API Endpoints

### 2.1 List Radar Stations
```http
GET /api/stations
```
- **Cache**: 24 hours (86,400s)
- **Returns**: 50 BMKG weather radar stations across Indonesia with latitude, longitude, and station ID.
- **Example Response**:
```json
{
  "ok": true,
  "cached": true,
  "cache_age_seconds": 3200,
  "pulled_at_utc": "2026-10-11T12:00:00Z",
  "data": {
    "stations": [
      { "id": "ACE", "name": "Aceh", "lat": 5.541272, "lon": 95.500186 },
      { "id": "CGK", "name": "Soekarno-Hatta Airport", "lat": -6.12397, "lon": 106.67983 },
      { "id": "JAK", "name": "Jakarta", "lat": -6.17511, "lon": 106.82715 },
      { "id": "SUB", "name": "Surabaya", "lat": -7.37983, "lon": 112.78742 }
    ]
  }
}
```

---

### 2.2 Station Nowcast Radar Frames
```http
GET /api/nowcast/:station_id?product={PRODUCT_CODE}
```
- **Path Parameter**:
  - `station_id` (required): 2-5 letter station ID (e.g. `JAK`, `CGK`, `SUB`, `DPS`).
- **Query Parameter**:
  - `product` (optional): One of the 14 supported nowcast products (e.g. `CMAX`, `CAPPI010`). If omitted, returns all 14 products in a dictionary.
- **Cache**: 5 minutes (300s).
- **Single Product (`?product=CMAX`) Response**:
```json
{
  "ok": true,
  "cached": false,
  "cache_age_seconds": 0,
  "pulled_at_utc": "2026-10-11T14:35:00Z",
  "data": {
    "station": "JAK",
    "product": "CMAX",
    "latest": {
      "url": "https://pub-690fce0c301c483cbbf46234d40798f2.r2.dev/nowcast/Jakarta/CMAX/JAK-20261011-1433.png",
      "time_utc": "2026-10-11T14:33:00Z",
      "time_local": null,
      "forecast_offset_minutes": null
    },
    "last_hour": [
      {
        "url": "https://pub-690fce0c301c483cbbf46234d40798f2.r2.dev/nowcast/Jakarta/CMAX/JAK-20261011-1321.png",
        "time_utc": "2026-10-11T13:21:00Z",
        "time_local": null,
        "forecast_offset_minutes": null
      },
      {
        "url": "https://pub-690fce0c301c483cbbf46234d40798f2.r2.dev/nowcast/Jakarta/CMAX/JAK-20261011-1433.png",
        "time_utc": "2026-10-11T14:33:00Z",
        "time_local": null,
        "forecast_offset_minutes": null
      }
    ]
  }
}
```
- **Ordering**:
  - `last_hour` is strictly sorted **oldest to newest** (chronological for player animations).
  - `latest` is always the most recent observation frame.
- **Image URLs**: Direct links to transparent PNG raster images in R2.

---

### 2.3 Historical Archive Frames
```http
GET /api/archive/:station_id?product={PRODUCT}&start={YYYYMMDDHHMM}&end={YYYYMMDDHHMM}
```
- **Parameters**:
  - `product` (required): Product code (e.g. `CMAX`, `CAPPI010`).
  - `start` (required): 12-digit compact UTC timestamp, within the last 48 hours.
  - `end` (required): 12-digit compact UTC timestamp, within 24 hours after `start`.
- **Response**: Array of `frames` sorted chronologically over that historical window.

---

### 2.4 National Mosaic Radar (WMS)
```http
GET /api/mosaic?product={PRODUCT}
```
- **Products**: `CMAX`, `PAC24H`, `SRI`, `30DBZ_DURATION`, `30DBZ_TREND`.
- **Response**:
```json
{
  "ok": true,
  "data": {
    "product": "CMAX",
    "wms_base_url": "https://api.bmkg.go.id/sidarma-mobile/geoserver/wms",
    "latest": {
      "layer": "sidarma_mosaic_cmax:Indonesia_202610111400",
      "style": "CMAX_dBZ",
      "time_utc": "2026-10-11T14:00:00Z"
    },
    "history": [
      {
        "layer": "sidarma_mosaic_cmax:Indonesia_202610111355",
        "style": "CMAX_dBZ",
        "time_utc": "2026-10-11T13:55:00Z"
      }
    ]
  }
}
```

---

### 2.5 Point Timeseries
```http
GET /api/timeseries/:station_id?lat={LAT}&lon={LON}&date={YYYYMMDD}
```
- **Parameters**: `lat`, `lon` (coordinates), `date` (`YYYYMMDD` UTC date string within 48h).
- **Response**: Reflectivity readings at that lat/lon over the day:
```json
{
  "ok": true,
  "data": {
    "station": "JAK",
    "lat": -6.2,
    "lon": 106.8,
    "date_utc": "2026-10-11",
    "units": "dBZ",
    "series": [
      { "label": "00:09", "value": 14.5, "color": "#00E000" },
      { "label": "00:17", "value": 35.0, "color": "#FFFF00" }
    ]
  }
}
```

---

### 2.6 Vertical Cross-Section (VCUT)
```http
GET /api/vcut/:station_id?start_lat={LAT}&start_lon={LON}&stop_lat={LAT}&stop_lon={LON}&datetime={YYYYMMDDHHMM}
```
- **Response**: PNG cross-section diagram slicing through the atmosphere between two points.

---

## 3. Product Catalog Guide

### Station Products (14)
1. **`CMAX` (Recommended Default)**: Column Maximum Reflectivity (dBZ). Best general-purpose convective rain and storm indicator.
2. **`CMAXHWIND`**: CMAX + horizontal Doppler wind vectors.
3. **`CMAXSSA`**: CMAX + Storm Structure Analysis (storm cell centroid markers and hail probability).
4. **`CAPPI005`**: Constant Altitude Plan Position Indicator at 500m altitude.
5. **`CAPPI005HWIND`**: CAPPI 500m + wind vectors.
6. **`CAPPI010`**: Constant Altitude Plan Position Indicator at 1000m altitude.
7. **`CAPPI010HWIND`**: CAPPI 1000m + wind vectors.
8. **`SRI`**: Surface Rain Intensity in mm/hr (Marshall-Palmer Z-R conversion).
9. **`PAC01H`**: 1-hour accumulated precipitation in mm.
10. **`PAC06H`**: 6-hour accumulated precipitation in mm.
11. **`PAC12H`**: 12-hour accumulated precipitation in mm.
12. **`PAC24H`**: 24-hour accumulated precipitation in mm.
13. **`STEPS`**: Short-Term Ensemble Prediction System. Forecast frames with `forecast_offset_minutes` (e.g. `+16min`, `+32min`).
14. **`QPF`**: Quantitative Precipitation Forecast accumulation.

### Reflectivity (dBZ) Color Interpretation
- **< 15 dBZ**: Very light / no rain (blue / light blue)
- **15 - 30 dBZ**: Light rain (cyan / light green)
- **30 - 45 dBZ**: Moderate rain (green / yellow)
- **45 - 55 dBZ**: Heavy rain / thunderstorm (orange / red)
- **> 55 dBZ**: Severe storm / hail risk (purple / white)

---

## 4. Frontend Integration Blueprint (Vue 3 / Nuxt 4)

### 4.1 GroundOverlay on Google Maps (`vue3-google-map`)
Each station's radar coverage is a circle with a radius of approximately **240 km** (~2.16° lat/lon).

```ts
// Calculate bounding box for Google Maps GroundOverlay
export function computeStationBounds(lat: number, lon: number, radiusKm = 240) {
  const latDelta = radiusKm / 111.0
  const lonDelta = radiusKm / (111.0 * Math.cos(lat * (Math.PI / 180)))
  return {
    north: lat + latDelta,
    south: lat - latDelta,
    east: lon + lonDelta,
    west: lon - lonDelta,
  }
}
```

### 4.2 Smooth Animation Loop
To prevent flickering when cycling frames in `data.last_hour`:
1. **Preload Images**:
```ts
const preloadedImages = new Map<string, HTMLImageElement>()

function preloadFrames(frames: Array<{ url: string }>) {
  for (const frame of frames) {
    if (!preloadedImages.has(frame.url)) {
      const img = new Image()
      img.src = frame.url
      preloadedImages.set(frame.url, img)
    }
  }
}
```
2. **Loop Controller**:
- Cycle through frames every ~600ms.
- Hold the final (`latest`) frame for ~1800ms before looping.
- Link scrubber slider to the frame index.
