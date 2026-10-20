# BMKG Radar Viewer

Live radar map for Indonesia, showing BMKG SI-DARMA weather radar stations and their reflectivity frames in one view.

**Live:** https://darma-radar.lleans.dev/

Built with Nuxt 4, Vue 3, MapLibre GL, Tailwind CSS v4, and shadcn-vue (`reka-ui`). It is a fully static site: the browser renders the map and calls the radar API directly, with no server of its own.

## Features

- Live radar frames for every station, played back on a shared 5-minute timeline
- Product picker for the 14 nowcast products, with BMKG intensity classes in the legend
- Per-station status (loading, data, no data) and a retry for failed stations
- VCUT vertical cross-section
- Archive playback for past frames
- Basemap from OpenFreeMap (OpenStreetMap data), with light and dark themes

## Data sources

- **Radar API:** `https://darma-proxy.lleans.dev`, a proxy in front of BMKG's SI-DARMA radar data. The API reference is in [docs/DARMA_RADAR_API.md](docs/DARMA_RADAR_API.md).
- **Radar frame images:** `https://darma-bucket-proxy.lleans.dev`
- **Basemap:** OpenFreeMap vector styles, with OpenStreetMap attribution
- **Radar data:** BMKG. BMKG's radar page requires BMKG to be credited as the source for any reuse of radar products.

## Requirements

- Node.js 22 or newer
- npm (the repo uses `package-lock.json`)

## Local development

```bash
npm install
npm run dev
```

The dev server starts on `http://localhost:3000` by default. To use another port:

```bash
npm run dev -- --port 3001
```

Nuxt DevTools is enabled in development only. Press `Shift + Option + D` in the browser to open it.

## Build

```bash
npm run build
```

`build` runs `nuxt generate`. The output is a static site in `.output/public/`, about 3 MB. To preview it locally:

```bash
npx serve .output/public
```

## Deployment (Cloudflare Pages)

The site deploys to Cloudflare Pages from the `main` branch. These settings match the Pages project and `wrangler.toml`:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `.output/public` |
| Root directory | `/` |
| Deploy command | *(none)* |
| Environment variable | `NODE_VERSION` = `22` |

No runtime secrets or bindings are needed. The API base URL is set in `nuxt.config.ts`.

`wrangler.toml` sets the output directory and the Node version, so keep those values in the file rather than only in the dashboard.

## Project structure

```
app/
  app.vue                  root component, mounts the layout and map
  components/RadarMap.vue  map, station overlays, timeline, and playback
  components/Radar*.vue    legend, product and station pickers, status chip, About section
  composables/             radar API, archive, timeline, canvas overlay, product catalog
  assets/css/main.css      Tailwind v4 entry and theme tokens
docs/DARMA_RADAR_API.md    radar API reference
public/images/             static images used by the About section
```

## Notes

- The app is static, so the browser calls the radar API directly. The API responds with `Access-Control-Allow-Origin: *`, which allows that.
- The radar information shown here is for monitoring. For official forecasts and warnings, use BMKG.
