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

const cardStyle = computed(() => {
  const p = progress.value
  const rad = radius.value
  const sc = scale.value

  // When at top (normal map view):
  // Do NOT apply clipPath and transform: scale(1) to the entire viewport.
  // In Safari (WebKit), dynamic clipPath on an ancestor of WebGL and 2D canvas
  // forces software masking and texture invalidation, dropping frame rates.
  if (p === 0 || rad === 0) {
    return {
      borderColor: 'transparent',
    }
  }

  return {
    transform: `scale(${sc})`,
    borderRadius: `${rad}px`,
    clipPath: `inset(0 round ${rad}px)`,
    borderColor: `color-mix(in oklab, var(--border) ${p * 100}%, transparent)`,
  }
})

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
