<script setup lang="ts">
import { computed } from 'vue'
import { RADAR_INTENSITY_BANDS, RADAR_PRODUCTS, bandsFor } from '~/composables/radarProducts'

const props = defineProps<{ product: string }>()

// A crop of the real map with one station's reflectivity frame drawn over it
// and its 240 km coverage ring marked. Built from the same map the user sees,
// so the example cannot drift from reality.
const EXAMPLE_FRAME = '/images/radar-frame-example.png'

const current = computed(() => RADAR_PRODUCTS.find(p => p.code === props.product) ?? RADAR_PRODUCTS[0]!)

// The five BMKG intensity classes, each with the exact colour blocks the
// frames are painted with, so the table matches the legend on the map.
const rows = computed(() =>
  RADAR_INTENSITY_BANDS.map((band, i) => {
    const scale = bandsFor(current.value.scale)[i]
    return { ...band, colors: scale?.colors ?? [] }
  }),
)

type ProductItem = (typeof RADAR_PRODUCTS)[number]

const grouped = computed(() => {
  const groups: { label: string, items: ProductItem[] }[] = []
  for (const p of RADAR_PRODUCTS) {
    let g = groups.find(x => x.items.some(i => i.group === p.group))
    if (!g) {
      g = { label: p.group, items: [] }
      groups.push(g)
    }
    g.items.push(p)
  }
  const labels: Record<string, string> = {
    reflectivity: 'Reflectivity (dBZ)',
    cappi: 'Altitude slices (CAPPI)',
    rain: 'Rainfall',
    forecast: 'Forecast',
  }
  return groups.map(g => ({ ...g, label: labels[g.label] ?? g.label }))
})

const groupNames = computed(() => {
  const labels: Record<string, string> = {
    reflectivity: 'Reflectivity — how much energy the rain echoes back',
    cappi: 'Altitude slices — the same echo at one fixed height',
    rain: 'Rainfall — how much water is actually falling',
    forecast: 'Forecast — where the rain is heading',
  }
  return labels
})
</script>

<template>
  <section class="relative border-t border-border/50 bg-background">
    <div class="mx-auto max-w-6xl px-6 py-20 sm:py-28">
      <!-- Intro -->
      <div class="max-w-3xl">
        <p class="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          About this map
        </p>
        <h1 class="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Live weather radar for Indonesia
        </h1>
        <p class="mt-4 text-base leading-relaxed text-muted-foreground">
          Every circle on the map is a single BMKG radar station. The coloured blob inside it is
          the echo that station measured on its last scan — the more energy the raindrops sent
          back, the brighter the colour. Overlay the circles and you get a live picture of
          where it is raining across the archipelago.
        </p>
      </div>

      <!-- One station on the real map, with its coverage ring. -->
      <figure class="mt-12 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center">
        <div class="relative overflow-hidden rounded-2xl border border-border/60 bg-muted/30">
          <img
            :src="EXAMPLE_FRAME"
            alt="A close-up of the radar map over Central Java: one station's circular reflectivity frame in blue and green over the real basemap, with its 240 km coverage circle marked."
            class="block w-full"
            loading="lazy"
            decoding="async"
          >
        </div>
        <div>
          <h3 class="text-lg font-semibold tracking-tight text-foreground">
            What one station looks like
          </h3>
          <p class="mt-2 text-sm leading-relaxed text-muted-foreground">
            Each circle is a single radar. The dashed ring marks the edge of its coverage —
            about 240 km from the mast at the centre. Everything inside that ring is what
            this one station could see on its last sweep; everything outside it, it could not.
          </p>
          <p class="mt-3 text-sm leading-relaxed text-muted-foreground">
            The colour is how hard the rain is coming back. Pale blue is barely anything.
            Green is a proper shower. Yellow and orange mean it is pouring, and a dark red
            core is a storm cell. No colour at all simply means no rain was detected here.
          </p>
          <p class="mt-3 text-sm leading-relaxed text-muted-foreground">
            Because no radar can see past its own ring, neighbouring stations overlap to close
            the gaps. Near the edges of the network, where coverage runs out, there are places
            this map genuinely cannot tell you about.
          </p>
        </div>
      </figure>

      <!-- How a frame is found -->
      <div class="mt-16">
        <h3 class="text-xl font-semibold tracking-tight text-foreground">
          How each frame is found
        </h3>
        <p class="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Nothing is drawn from guesswork. Every pixel on screen comes from a file the
          upstream service already published.
        </p>

        <ol class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <li
            v-for="(step, i) in [
              { t: 'A radar scans the sky', d: 'BMKG runs 46 radar sites nationwide, each sweeping a rotating beam every 5–10 minutes. C-band radars reach 150–250 km; X-band radars are shorter but see smaller droplets better.' },
              { t: 'Doppler shift becomes colour', d: 'The frequency shift of the returning echo gives the size and speed of the raindrops. Reflectivity (dBZ) is the standard measure of that energy, and the agency paints it into the colour scale you see here.' },
              { t: 'SI-DARMA gathers the sites', d: 'BMKG’s SI-DARMA system pulls every site’s volume scans into one archive, turns them into products (reflectivity, rain rate, accumulations, nowcasts) and republishes them as PNG.' },
              { t: 'This page fetches the PNG', d: 'Each frame is a 4084×4084 image covering roughly 500 km across. The app asks for the product and time it needs, then places the image over that station’s position.' },
            ]"
            :key="i"
            class="rounded-2xl border border-border/60 bg-card/60 p-5"
          >
            <div class="flex size-7 items-center justify-center rounded-full bg-foreground/10 font-mono text-xs font-semibold text-foreground">
              {{ i + 1 }}
            </div>
            <h4 class="mt-3 text-sm font-semibold text-foreground">
              {{ step.t }}
            </h4>
            <p class="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              {{ step.d }}
            </p>
          </li>
        </ol>
      </div>

      <!-- Reading the colours -->
      <div class="mt-16 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div>
          <h3 class="text-xl font-semibold tracking-tight text-foreground">
            Reading the colours
          </h3>
          <p class="mt-2 text-sm leading-relaxed text-muted-foreground">
            The scale runs from 5 to 75 dBZ. The higher the value, the heavier the rain.
            These are the official BMKG intensity classes, shown with the exact colours used
            on the map.
          </p>
          <p class="mt-3 text-sm leading-relaxed text-muted-foreground">
            Hover any colour on the legend in the bottom-right corner for its class.
          </p>
        </div>

        <div class="overflow-hidden rounded-2xl border border-border/60 bg-card/60">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-border/50 text-[11px] uppercase tracking-wider text-muted-foreground">
                <th class="px-4 py-3 font-medium">
                  Rain
                </th>
                <th class="px-4 py-3 font-medium">
                  dBZ
                </th>
                <th class="px-4 py-3 font-medium">
                  mm/h
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in rows"
                :key="row.label"
                class="border-b border-border/30 last:border-0"
              >
                <td class="px-4 py-3">
                  <div class="flex items-center gap-2.5">
                    <span class="flex h-5 overflow-hidden rounded-full ring-1 ring-border/60">
                      <span
                        v-for="c in row.colors"
                        :key="c"
                        class="h-full w-3"
                        :style="{ backgroundColor: c }"
                      />
                    </span>
                    <span class="font-medium text-foreground">{{ row.label }}</span>
                  </div>
                </td>
                <td class="px-4 py-3 font-mono text-xs tabular-nums text-muted-foreground">
                  {{ row.dbz }}
                </td>
                <td class="px-4 py-3 font-mono text-xs tabular-nums text-muted-foreground">
                  {{ row.mmh }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Products -->
      <div class="mt-16">
        <h3 class="text-xl font-semibold tracking-tight text-foreground">
          The products
        </h3>
        <p class="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The same radar data can be presented in different ways. Pick one from the
          <span class="font-mono text-foreground">Product</span> menu at the bottom of the map.
          The current one is highlighted below.
        </p>

        <div class="mt-8 grid gap-4 md:grid-cols-2">
          <div
            v-for="g in grouped"
            :key="g.label"
            class="rounded-2xl border border-border/60 bg-card/60 p-5"
          >
            <h4 class="text-sm font-semibold text-foreground">
              {{ g.label }}
            </h4>
            <p class="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {{ groupNames[g.items[0]!.group] }}
            </p>
            <ul class="mt-4 space-y-1.5">
              <li
                v-for="p in g.items"
                :key="p.code"
                class="flex items-start gap-2.5 text-[13px]"
                :class="p.code === current.code ? 'text-foreground' : 'text-muted-foreground'"
              >
                <span
                  class="mt-[3px] font-mono text-[11px] tabular-nums"
                  :class="p.code === current.code
                    ? 'rounded bg-foreground/10 px-1.5 py-0.5 font-semibold text-foreground'
                    : 'w-[4.5rem] shrink-0'"
                >{{ p.code }}</span>
                <span class="leading-relaxed">{{ p.summary }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Using the map -->
      <div class="mt-16">
        <h3 class="text-xl font-semibold tracking-tight text-foreground">
          Using the map
        </h3>
        <div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div
            v-for="tip in [
              { t: 'Play the last hour', d: 'The scrubber runs the previous hour frame by frame. Stations scan on their own schedules, so each one is matched to the closest observation in time.' },
              { t: 'Go back further', d: 'Switch to Archive and pick a date and a window. The archive covers the last 48 hours, so yesterday’s rain is still there.' },
              { t: 'Slicing the atmosphere', d: 'Turn on VCUT, then tap two points. You get a vertical cross-section of the storm between them — height against reflectivity.' },
              { t: 'Rain at a point', d: 'Alt-click any spot on the map to see that exact location’s reflectivity through the day, for the selected station.' },
            ]"
            :key="tip.t"
            class="rounded-2xl border border-border/60 bg-card/60 p-5"
          >
            <h4 class="text-sm font-semibold text-foreground">
              {{ tip.t }}
            </h4>
            <p class="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              {{ tip.d }}
            </p>
          </div>
        </div>
      </div>

      <!-- Attribution -->
      <div class="mt-16 rounded-2xl border border-border/60 bg-card/60 p-5">
        <p class="text-[13px] leading-relaxed text-muted-foreground">
          Radar imagery and product descriptions are the work of
          <a
            href="https://www.bmkg.go.id/cuaca/radar/Indonesia"
            target="_blank"
            rel="noreferrer"
            class="font-medium text-foreground underline underline-offset-4 hover:text-foreground/80"
          >BMKG</a>
          and its SI-DARMA radar integration system. Basemap tiles are
          <a
            href="https://openfreemap.org/"
            target="_blank"
            rel="noreferrer"
            class="font-medium text-foreground underline underline-offset-4 hover:text-foreground/80"
          >OpenFreeMap</a>
          with data from
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
            class="font-medium text-foreground underline underline-offset-4 hover:text-foreground/80"
          >OpenStreetMap</a>
          contributors.
        </p>
      </div>
    </div>
  </section>
</template>
