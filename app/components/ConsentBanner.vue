<script setup lang="ts">
import { ref } from 'vue'
import { hasGeolocationConsent, promptGeolocationConsent } from '~/composables/useUserLocation'

const dismissed = ref(!hasGeolocationConsent())

function onAccept() {
  promptGeolocationConsent()
  dismissed.value = true
}

function onSkip() {
  // Explicitly remember the skip so we don't ask again
  try { localStorage.setItem('radar:geolocation-consent:v1', 'false') } catch { /* noop */ }
  dismissed.value = true
}
</script>

<template>
  <!--
    Small floating pill — visible but unobtrusive.
    Sits top-right so it doesn't compete with map controls (bottom-left)
    or the animation player (bottom-center).
    Can be dismissed without any side effects.
  -->
  <div
    v-if="!dismissed"
    class="fixed inset-x-0 top-0 z-50 flex justify-end px-4 pt-3 sm:px-6"
  >
    <div
      class="w-72 rounded-2xl border border-border/60 bg-card/90 p-3.5 text-sm text-foreground shadow-xl shadow-black/20 backdrop-blur-md"
    >
      <div class="flex items-start gap-2.5">
        <!-- Icon -->
        <div class="mt-0.5 shrink-0 rounded-full bg-primary/10 p-1 text-primary">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
        </div>
        <!-- Text -->
        <div class="min-w-0">
          <p class="font-medium text-foreground">
            Enable approximate location?
          </p>
          <p class="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            We look up your region from your IP so the map opens on your area.
            Your IP is sent to a third-party service.
          </p>
        </div>
        <!-- Close button -->
        <button
          class="-me-1.5 -my-1.5 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="onSkip"
          aria-label="Close"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <!-- Actions -->
      <div class="mt-2.5 flex items-center gap-2">
        <button
          class="rounded-lg bg-foreground px-3 py-1.5 text-[11px] font-medium text-background transition-colors hover:bg-foreground/90"
          @click="onAccept"
        >
          Allow
        </button>
        <button
          class="rounded-lg border border-border/50 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="onSkip"
        >
          Not now
        </button>
      </div>
    </div>
  </div>
</template>
