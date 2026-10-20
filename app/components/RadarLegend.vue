<script setup lang="ts">
import { computed } from 'vue'
import {
  RADAR_SCALES,
  bandsFor,
  radarProductInfo,
} from '~/composables/radarProducts'

const props = withDefaults(defineProps<{
  code: string
  // Product code + unit above the bar. The picker already shows both.
  showTitle?: boolean
  // The map renders this inside a pointer-events-none wrapper.
  interactive?: boolean
}>(), { showTitle: true, interactive: false })

const info = computed(() => radarProductInfo(props.code))
const scale = computed(() => RADAR_SCALES[info.value.scale])
// Colours grouped into BMKG's five intensity classes. Each group is one
// hover target — 10-12 individual swatches would be far too small to hit.
const bands = computed(() => bandsFor(info.value.scale))
</script>

<template>
  <div class="rounded-2xl border border-border/60 bg-card/80 px-3 py-2 backdrop-blur-xl">
    <div v-if="showTitle" class="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
      <span class="font-mono font-medium text-foreground">{{ info.code }}</span>
      <span class="text-muted-foreground">{{ info.unit }}</span>
    </div>

    <!-- Non-interactive variant (used inside the product menu). -->
    <div
      v-if="!interactive"
      class="flex h-2 overflow-hidden rounded-full ring-1 ring-border/60"
      role="img"
      :aria-label="`${info.code} colour scale, ${scale.low.toLowerCase()} to ${scale.high.toLowerCase()}`"
    >
      <span
        v-for="c in scale.colors"
        :key="c"
        class="h-full flex-1"
        :style="{ backgroundColor: c }"
      />
    </div>

    <!-- Interactive variant: hover a band for what that intensity means. -->
    <div
      v-else
      class="flex h-2.5 w-full cursor-default overflow-hidden rounded-full ring-1 ring-border/60"
      role="group"
      :aria-label="`${info.code} colour scale. Hover a colour for what it means.`"
    >
      <div
        v-for="band in bands"
        :key="band.label"
        class="relative flex h-full min-w-0 flex-1 transition-opacity duration-150 hover:opacity-100"
      >
        <!-- Solid blocks, one per colour, exactly as the product menu draws
             them. The whole band shares the band's tooltip. -->
        <span
          v-for="c in band.colors"
          :key="c"
          class="h-full min-w-0 flex-1"
          :style="{ backgroundColor: c }"
        />
        <span class="absolute inset-0">
          <LegendBandTip :label="band.label" :dbz="band.dbz" :mmh="band.mmh" :note="band.note" />
        </span>
      </div>
    </div>

    <div class="mt-1 flex justify-between text-[10px] text-muted-foreground">
      <span>{{ scale.low }}</span>
      <span>{{ scale.high }}</span>
    </div>
  </div>
</template>