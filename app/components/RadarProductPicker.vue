<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronUp, Layers } from '@lucide/vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  RADAR_PRODUCTS,
  RADAR_PRODUCT_GROUPS,
  RADAR_REFLECTIVITY_CLASSES,
  radarProductInfo,
  type RadarProductCode,
} from '~/composables/radarProducts'

const props = defineProps<{ modelValue: RadarProductCode }>()
const emit = defineEmits<{ 'update:modelValue': [code: RadarProductCode] }>()

const open = ref(false)
// Item under the pointer / keyboard highlight. The panel explains this one,
// and falls back to the selected product when nothing is highlighted.
const highlighted = ref<string | null>(null)

const groups = computed(() =>
  RADAR_PRODUCT_GROUPS.map(g => ({
    ...g,
    items: RADAR_PRODUCTS.filter(p => p.group === g.id),
  })),
)

const current = computed(() => radarProductInfo(props.modelValue))
const shown = computed(() => radarProductInfo(highlighted.value ?? props.modelValue))

function onOpenChange(value: boolean) {
  open.value = value
  if (!value) highlighted.value = null
}

function onSelect(code: unknown) {
  emit('update:modelValue', String(code) as RadarProductCode)
}
</script>

<template>
  <DropdownMenu :open="open" @update:open="onOpenChange">
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        aria-label="Radar product"
        class="flex h-8 items-center gap-2 rounded-full border border-border/60 bg-card/80 px-3 text-xs font-medium shadow-lg backdrop-blur-xl transition-colors hover:bg-card"
      >
        <Layers class="size-3.5 shrink-0 text-foreground/60" />
        <span class="font-mono">{{ current.code }}</span>
        <ChevronUp
          class="size-3 shrink-0 text-foreground/60 transition-transform duration-200 ease-(--ease-entrance)"
          :class="open ? '' : 'rotate-180'"
        />
      </button>
    </DropdownMenuTrigger>

    <DropdownMenuContent
      side="top"
      align="start"
      :side-offset="8"
      class="flex max-h-[min(32rem,var(--reka-dropdown-menu-content-available-height))] w-[min(22rem,calc(100vw-1.5rem))] flex-col rounded-2xl border-border/60 bg-popover/95 p-0 shadow-2xl backdrop-blur-xl sm:w-[34rem] sm:flex-row"
    >
      <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
        <DropdownMenuRadioGroup :model-value="modelValue" @update:model-value="onSelect">
          <template v-for="(g, gi) in groups" :key="g.id">
            <DropdownMenuLabel
              class="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
              :class="gi === 0 ? 'pt-1' : ''"
            >
              {{ g.label }}
            </DropdownMenuLabel>
            <DropdownMenuRadioItem
              v-for="p in g.items"
              :key="p.code"
              :value="p.code"
              class="rounded-lg py-1 pl-7 pr-2 text-xs"
              @focus="highlighted = p.code"
            >
              <span class="w-[6.5rem] shrink-0 font-mono font-medium">{{ p.code }}</span>
              <span class="truncate text-[11px] text-muted-foreground">{{ p.name }}</span>
            </DropdownMenuRadioItem>
          </template>
        </DropdownMenuRadioGroup>
      </div>

      <!-- Explains whichever product is highlighted. -->
      <aside
        class="shrink-0 border-t border-border/60 p-3 sm:w-60 sm:border-l sm:border-t-0"
        aria-live="polite"
      >
        <div class="flex items-start justify-between gap-2">
          <p class="text-sm font-medium leading-snug">{{ shown.name }}</p>
          <span class="shrink-0 rounded-full border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {{ shown.unit }}
          </span>
        </div>
        <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">{{ shown.summary }}</p>

        <RadarLegend :code="shown.code" :show-title="false" class="mt-3" />

        <!-- BMKG's classification, for the products measured in dBZ. -->
        <table
          v-if="shown.scale === 'reflectivity'"
          class="mt-3 w-full text-[10px] leading-4 text-muted-foreground max-sm:hidden"
        >
          <thead>
            <tr class="text-left">
              <th class="pb-0.5 font-medium">Rain</th>
              <th class="pb-0.5 font-medium">dBZ</th>
              <th class="pb-0.5 text-right font-medium">mm/h</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in RADAR_REFLECTIVITY_CLASSES" :key="c.label" class="border-t border-border/40">
              <td class="py-0.5 text-foreground/80">{{ c.label }}</td>
              <td class="py-0.5 tabular-nums">{{ c.dbz }}</td>
              <td class="py-0.5 text-right tabular-nums">{{ c.mmh }}</td>
            </tr>
          </tbody>
        </table>
      </aside>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
