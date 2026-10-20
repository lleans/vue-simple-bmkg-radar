# Simple BMKG Radar Viewer (Nuxt 4 + Vue 3)

Interactive web client for BMKG SI-DARMA weather radar data across Indonesia, built with Nuxt 4, Vue 3, Google Maps (`vue3-google-map`), Tailwind CSS, and shadcn-vue (`reka-ui`).

## Radar API Backend

This app connects to the Rust Cloudflare Worker proxy (`darma-proxy-rust-cloudflare`):
- **Production API Base**: `https://darma-proxy-rust-cloudflare.ahmadunnail0.workers.dev`
- **Interactive Documentation**: `https://darma-proxy-rust-cloudflare.ahmadunnail0.workers.dev/docs`
- **API & Products Reference**: See [docs/DARMA_RADAR_API.md](docs/DARMA_RADAR_API.md) for full endpoint specifications, catalog of all 14 nowcast products, and integration patterns.

## Setup

Make sure to install dependencies:

```bash
# npm
npm install

# pnpm
pnpm install

# yarn
yarn install

# bun
bun install
```

## Development Server

Start the development server on `http://localhost:3000`:

```bash
# npm
npm run dev

# pnpm
pnpm dev

# yarn
yarn dev

# bun
bun run dev
```

## Production

Build the application for production:

```bash
# npm
npm run build

# pnpm
pnpm build

# yarn
yarn build

# bun
bun run build
```

Locally preview production build:

```bash
# npm
npm run preview

# pnpm
pnpm preview

# yarn
yarn preview

# bun
bun run preview
```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
