<script setup lang="ts">
import { computed } from 'vue'
import { Check, ChevronUp, MapPin } from '@lucide/vue'
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxLabel,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from 'reka-ui'
import type { RadarStation } from '~/composables/useRadarApi'
import { groupStationsByRange, type GeoPoint } from '~/lib/geo'

const props = withDefaults(defineProps<{
  stations: RadarStation[]
  // null = all stations
  modelValue: string | null
  // When set, options are grouped into "In range" / "Other stations".
  // null = flat list.
  anchor?: GeoPoint | null
}>(), {
  anchor: null,
})
const emit = defineEmits<{ 'update:modelValue': [id: string | null] }>()

// Combobox values can't be null, so "all stations" gets a sentinel.
const ALL = '__all'

const value = computed(() => props.modelValue ?? ALL)

const grouped = computed(() => groupStationsByRange(props.stations, props.anchor ?? null))

const labelOf = (v: unknown) => {
  if (v === ALL || v == null) return 'All stations'
  const s = props.stations.find(x => x.id === v)
  return s ? `${s.id} · ${s.name}` : String(v)
}

function onUpdate(v: unknown) {
  emit('update:modelValue', v === ALL ? null : String(v))
}

// Select the text on focus so typing replaces the current label.
function selectAll(e: FocusEvent) {
  (e.target as HTMLInputElement).select()
}

const itemClass =
  'relative flex cursor-default select-none items-center gap-2 rounded-lg py-1.5 pl-7 pr-2 text-xs outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground'
const labelClass =
  'px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground'
</script>

<template>
  <ComboboxRoot
    :model-value="value"
    open-on-focus
    open-on-click
    @update:model-value="onUpdate"
  >
    <ComboboxAnchor
      class="flex h-8 w-44 items-center gap-2 rounded-full border border-border/60 bg-card/95 pl-3 pr-2 text-xs shadow-lg transition-colors focus-within:bg-card hover:bg-card sm:w-56 sm:bg-card/80 sm:backdrop-blur-xl"
    >
      <MapPin class="size-3.5 shrink-0 text-foreground/60" />
      <ComboboxInput
        :display-value="labelOf"
        placeholder="Search station…"
        id="radar-station"
        name="radar-station"
        autocomplete="off"
        aria-label="Radar station"
        class="min-w-0 flex-1 truncate bg-transparent font-medium outline-none placeholder:text-foreground/50"
        @focus="selectAll"
      />
      <ComboboxTrigger aria-label="Show stations" class="shrink-0 rounded-full p-0.5 text-foreground/60 hover:text-foreground">
        <ChevronUp class="size-3" />
      </ComboboxTrigger>
    </ComboboxAnchor>

    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        side="top"
        align="start"
        :side-offset="8"
        class="z-50 w-(--reka-combobox-trigger-width) min-w-56 overflow-hidden rounded-2xl border border-border/60 bg-popover/95 text-popover-foreground shadow-2xl backdrop-blur-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=top]:slide-in-from-bottom-2"
      >
        <ComboboxViewport class="max-h-[min(18rem,var(--reka-combobox-content-available-height))] overflow-y-auto p-1.5">
          <ComboboxEmpty class="px-2.5 py-4 text-center text-xs text-muted-foreground">
            No station matches
          </ComboboxEmpty>
          <ComboboxItem :value="ALL" text-value="All stations" :class="itemClass">
            <ComboboxItemIndicator class="absolute left-2">
              <Check class="size-3.5" />
            </ComboboxItemIndicator>
            <span class="font-medium">All stations</span>
          </ComboboxItem>
          <template v-if="anchor">
            <ComboboxGroup v-if="grouped.inRange.length">
              <ComboboxLabel :class="labelClass">In range</ComboboxLabel>
              <ComboboxItem
                v-for="s in grouped.inRange"
                :key="s.id"
                :value="s.id"
                :text-value="`${s.id} ${s.name}`"
                :class="itemClass"
              >
                <ComboboxItemIndicator class="absolute left-2">
                  <Check class="size-3.5" />
                </ComboboxItemIndicator>
                <span class="w-10 shrink-0 font-mono font-medium">{{ s.id }}</span>
                <span class="truncate text-[11px] text-muted-foreground">{{ s.name }}</span>
                <span class="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">{{ Math.round(s.distKm) }} km</span>
              </ComboboxItem>
            </ComboboxGroup>
            <ComboboxGroup v-if="grouped.other.length">
              <ComboboxLabel :class="labelClass">Other stations</ComboboxLabel>
              <ComboboxItem
                v-for="s in grouped.other"
                :key="s.id"
                :value="s.id"
                :text-value="`${s.id} ${s.name}`"
                :class="itemClass"
              >
                <ComboboxItemIndicator class="absolute left-2">
                  <Check class="size-3.5" />
                </ComboboxItemIndicator>
                <span class="w-10 shrink-0 font-mono font-medium">{{ s.id }}</span>
                <span class="truncate text-[11px] text-muted-foreground">{{ s.name }}</span>
              </ComboboxItem>
            </ComboboxGroup>
          </template>
          <template v-else>
            <ComboboxItem
              v-for="s in stations"
              :key="s.id"
              :value="s.id"
              :text-value="`${s.id} ${s.name}`"
              :class="itemClass"
            >
              <ComboboxItemIndicator class="absolute left-2">
                <Check class="size-3.5" />
              </ComboboxItemIndicator>
              <span class="w-10 shrink-0 font-mono font-medium">{{ s.id }}</span>
              <span class="truncate text-[11px] text-muted-foreground">{{ s.name }}</span>
            </ComboboxItem>
          </template>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
