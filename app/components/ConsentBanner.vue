<script setup lang="ts">
import { ref } from 'vue'
import { hasGeolocationConsent, promptGeolocationConsent } from '~/composables/useUserLocation'

const dismissed = ref(!hasGeolocationConsent())

function onAccept() {
  promptGeolocationConsent()
  dismissed.value = true
}

function onDismiss() {
  dismissed.value = true
}
</script>

<template>
  <div
    v-if="!dismissed"
    class="fixed inset-x-0 top-0 z-50 flex justify-center pt-4 px-4"
  >
    <div
      class="w-full max-w-md rounded-2xl border border-border/60 bg-card/95 p-4 text-sm text-foreground shadow-2xl shadow-black/30 backdrop-blur-xl"
    >
      <div class="flex items-start gap-3">
        <div class="flex-1">
          <p class="font-semibold text-foreground">
            Enable your approximate location?
          </p>
          <p class="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            We look up your region from your IP so the map opens on your area.
            Your IP is sent to a third-party geolocation service. You can change
            this later in browser settings.
          </p>
        </div>
        <button
          class="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="onDismiss"
          aria-label="Dismiss"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="mt-3 flex justify-end gap-2">
        <button
          class="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          @click="onDismiss"
        >
          Skip
        </button>
        <button
          class="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90"
          @click="onAccept"
        >
          Allow
        </button>
      </div>
    </div>
  </div>
</template>
