<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

const GAP_PX = 24
const MAX_RADIUS = 36

const scrollY = ref(0)
const maxScroll = ref(400)
const minScale = ref(1)
const radius = ref(0)

const progress = computed(() =>
  Math.min(1, Math.max(0, scrollY.value / maxScroll.value)),
)
const scale = computed(() => 1 - progress.value * (1 - minScale.value))

const trackStyle = computed(() => ({
  height: `calc(100vh + ${maxScroll.value}px)`,
}))

const cardStyle = computed(() => ({
  transform: `scale(${scale.value})`,
  // Rounded clip driven by the scroll progress, so the corners tighten
  // as the card shrinks.
  borderRadius: `${radius.value}px`,
  // clip-path clips the whole subtree, including the WebGL map canvas,
  // which `corner-shape` on its own does not clip.
  clipPath: `inset(0 round ${radius.value}px)`,
  borderColor: `color-mix(in oklab, var(--border) ${progress.value * 100}%, transparent)`,
}))

let frame = 0
const onScroll = () => {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    scrollY.value = window.scrollY
    radius.value = progress.value * MAX_RADIUS
  })
}

const sync = () => {
  maxScroll.value = Math.round(Math.min(700, Math.max(300, window.innerHeight * 0.6)))
  minScale.value = Math.max(0.5, (window.innerHeight - GAP_PX * 2) / window.innerHeight)
}

onMounted(() => {
  sync()
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', sync, { passive: true })
})
onUnmounted(() => {
  if (frame) cancelAnimationFrame(frame)
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', sync)
})
</script>

<template>
  <div class="relative" :style="trackStyle">
    <div class="sticky top-0 h-screen w-full">
      <div
        class="card-squircle h-screen w-full overflow-hidden border-2 will-change-transform"
        :style="cardStyle"
      >
        <slot />
      </div>
    </div>
  </div>
</template>

<style>
/* Base rounded corner; the scroll-driven clip-path above overrides it. */
.card-squircle {
  border-radius: 28px;
}
</style>
