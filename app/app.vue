<script setup lang="ts">
// Reka applies `padding-right` / `overflow: hidden` to body when modals/dropdowns
// open. On this page, the toggle button is `position: fixed` and anchored to the
// viewport's right edge — so the body padding shift makes it appear to move 10px.
// We disable that lock globally; the trade-off is a brief scrollbar flash on
// mobile / when a real modal is used, but our modals use DialogRoot which manages
// its own scroll, so the global lock isn't needed.
import { ConfigProvider } from 'reka-ui'
import { useRadarApi } from '~/composables/useRadarApi'

// The about section highlights the product currently selected on the map.
const { product: currentProduct } = useRadarApi()
</script>

<template>
  <ConfigProvider :scroll-body="false">
    <div class="min-h-screen bg-background text-foreground">
      <NuxtLayout>
        <ClientOnly>
          <RadarScrollStage>
            <RadarMap />
          </RadarScrollStage>
        </ClientOnly>
        <RadarAboutSection :product="currentProduct" />
      </NuxtLayout>
    </div>
  </ConfigProvider>
</template>

<style>
/* Belt-and-braces: if any Reka primitive still applies body lock, neutralize it
   so the fixed-position toggle button never shifts. */
body[data-scroll-locked] {
  padding-right: 0 !important;
  margin-right: 0 !important;
  overflow: visible !important;
  pointer-events: auto !important;
}
</style>
