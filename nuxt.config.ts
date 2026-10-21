import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  app: {
    head: {
      title: 'BMKG Radar Viewer — Live Weather Radar Indonesia',
      htmlAttrs: {
        lang: 'id',
      },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Live weather radar viewer for BMKG SI-DARMA Indonesia radar stations with real-time reflectivity, station coverage, and nowcast frames.' },
        { name: 'theme-color', content: '#020617' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
      ],
    },
  },
  // Dev-only. Nuxt DevTools adds a client-side overlay and bundle weight,
  // which must not ship to a static deploy.
  //
  // `import.meta.dev` is the Vite/Nuxt flag and is resolved correctly by both
  // `nuxt dev` and `nuxt generate`. Do NOT use process.env.NODE_ENV here: it
  // is unset in both modes, so that check is always true and would enable
  // devtools in production too.
  devtools: { enabled: import.meta.dev },
  // Pin the Nitro preset. Cloudflare sets CF_PAGES in its build, which makes
  // Nitro auto-select `cloudflare-pages-static` and write to `dist/` instead
  // of `.output/public/`. The output directory must not depend on the host.
  nitro: { preset: 'static' },
  css: ['~/assets/css/main.css'],
  vite: {
    plugins: [
      tailwindcss()
    ],
    // EXCLUDE maplibre-gl from Vite pre-bundling: it constructs its
    // worker URL as `new URL('./maplibre-gl-worker.mjs', import.meta.url)`.
    // Pre-bundling moves the entry into node_modules/.cache/vite/... where
    // the sibling worker file does not exist, so the Web Worker fails to
    // load ("Worker failed to load") and the map renders black.
    optimizeDeps: {
      exclude: ['maplibre-gl']
    },
    ssr: {
      noExternal: ['maplibre-gl']
    }
  },
  runtimeConfig: {
    public: {
      // The BMKG proxy that serves station metadata and frame URLs. It sends
      // `access-control-allow-origin: *`, so a static deploy can call it
      // from any origin without a CORS proxy.
      darmaProxyBase: 'https://darma-proxy.lleans.dev'
    }
  },
  colorMode: {
    classSuffix: ''
  },
  shadcn: {
    prefix: '',
    componentDir: '@/components/ui'
  },
  modules: [
    '@nuxt/eslint',
    '@nuxt/hints',
    '@nuxtjs/color-mode',
    '@nuxt/fonts',
    '@nuxt/icon',
    '@nuxt/devtools',
    'shadcn-nuxt'
  ]
})
