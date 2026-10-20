<script setup lang="ts">
import { computed } from 'vue'
import { RotateCw, X } from '@lucide/vue'
import { HoverCardContent, HoverCardPortal, HoverCardRoot, HoverCardTrigger } from 'reka-ui'
import { RADAR_STATUS_COLORS } from '~/composables/radarProducts'

const emit = defineEmits<{ retry: [] }>()

const props = defineProps<{
  // Requests currently in flight (station data + radar frames).
  loading: boolean
  // Number of those in-flight requests.
  count: number
  // Stations that failed on the last fetch cycle.
  failed: string[]
  // How many stations loaded successfully on the last cycle.
  succeeded: number
  // Station names for the hover list, keyed by id.
  names?: Record<string, string>
  // Stations currently being fetched (for the loading hover list).
  inFlightStations?: string[]
}>()

const failedCount = computed(() => props.failed.length)

// Only two states: something is wrong, or work is in flight. Success shows
// nothing at all — the map itself is the confirmation.
const state = computed<'loading' | 'failed' | 'idle'>(() => {
  if (failedCount.value > 0) return 'failed'
  if (props.loading || props.count > 0) return 'loading'
  return 'idle'
})

const label = computed(() => String(props.count))

const ariaLabel = computed(() => {
  if (state.value === 'loading') return `${props.count} request${props.count === 1 ? '' : 's'} in progress`
  return `${failedCount.value} radar${failedCount.value === 1 ? '' : 's'} failed to load`
})

const nameOf = (id: string) => props.names?.[id] ?? 'Unknown'
const failedList = computed(() => props.failed.map(id => `${id} · ${nameOf(id)}`))
const loadingList = computed(() => (props.inFlightStations ?? []).map(id => `${id} · ${nameOf(id)}`))

// One shared popover body, so loading and failure read identically.
const panelTitle = computed(() =>
  state.value === 'loading' ? 'Loading in progress' : `${failedCount.value} failed to load`,
)
const panelNote = computed(() =>
  state.value === 'loading'
    ? 'Only real network requests are counted — cache hits are silent.'
    : 'No data is available for these right now.',
)
const panelItems = computed(() =>
  state.value === 'loading' ? loadingList.value : failedList.value,
)
const panelEmpty = computed(() =>
  state.value === 'loading' ? 'Downloading radar frames…' : 'No station names available.',
)
</script>

<template>
  <div v-if="state !== 'idle'" class="pointer-events-auto flex items-center gap-1.5">
    <HoverCardRoot :open-delay="140" :close-delay="120">
      <HoverCardTrigger as-child>
        <div
          class="flex w-fit cursor-default items-center gap-1.5 rounded-full border border-border/60 bg-card/90 py-1 pl-1.5 pr-2 text-[10px] font-medium text-foreground/80 shadow-md backdrop-blur-xl"
          :style="{ '--sev': RADAR_STATUS_COLORS.severe }"
          :role="state === 'failed' ? 'alert' : 'status'"
          :aria-label="ariaLabel"
        >
          <template v-if="state === 'loading'">
            <span class="inline-block size-3 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground" aria-hidden="true" />
            <span class="tabular-nums">{{ label }}</span>
          </template>
          <template v-else>
            <span class="flex size-3 items-center justify-center rounded-full border-2" :style="{ borderColor: 'var(--sev)', color: 'var(--sev)' }">
              <X class="size-2" :stroke-width="3.5" />
            </span>
            <span class="tabular-nums">{{ failedCount }}</span>
          </template>
        </div>
      </HoverCardTrigger>
      <HoverCardPortal>
        <HoverCardContent
          side="left"
          :side-offset="8"
          align="end"
          :collision-padding="12"
          class="z-50 w-64 max-w-[calc(100vw-1.5rem)] rounded-2xl border border-border/60 bg-popover/95 p-3 text-popover-foreground shadow-2xl backdrop-blur-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <p class="text-xs font-medium">{{ panelTitle }}</p>
          <p class="mt-0.5 text-[11px] text-muted-foreground">{{ panelNote }}</p>
          <ul v-if="panelItems.length" class="mt-2 max-h-48 overflow-y-auto rounded-md border border-border/40 bg-background/30 p-1.5 text-[11px]">
            <li v-for="s in panelItems" :key="s" class="py-0.5">{{ s }}</li>
          </ul>
          <p v-else class="mt-2 text-[11px] text-muted-foreground">{{ panelEmpty }}</p>
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCardRoot>

    <!-- A real button beside (not inside) the HoverCard trigger. It retries
         both failed station metadata and the failed frame URLs. -->
    <button
      v-if="state === 'failed'"
      type="button"
      aria-label="Retry failed radars"
      class="inline-flex size-5 items-center justify-center rounded-full border border-border/60 bg-card/90 text-foreground/70 shadow-sm transition-colors hover:bg-foreground/10 hover:text-foreground"
      @click="emit('retry')"
    >
      <RotateCw class="size-3" :stroke-width="2.5" />
    </button>
  </div>
</template>

<style scoped>
div[role='status'],
div[role='alert'] {
  transition: opacity 400ms ease, transform 400ms ease;
}
</style>