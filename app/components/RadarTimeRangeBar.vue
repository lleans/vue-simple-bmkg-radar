<script setup lang="ts">
import { computed } from 'vue'
import { useRadarArchive, type RangeOption } from '~/composables/useRadarArchive'

const props = defineProps<{
  mode: 'live' | 'archive'
}>()
const emit = defineEmits<{ 'update:mode': [value: 'live' | 'archive'] }>()

const archive = useRadarArchive()

const ranges: { value: RangeOption, label: string, hours: number }[] = [
  { value: '1h', label: '1 h', hours: 1 },
  { value: '6h', label: '6 h', hours: 6 },
  { value: '24h', label: '24 h', hours: 24 },
]

const startUtcMs = computed(() => {
  const end = parseCompact(archive.endUtc.value) ?? new Date()
  const opt = ranges.find(r => r.value === archive.range.value)
  const hours = opt?.hours ?? 1
  return end.getTime() - hours * 3_600_000
})

const startLabel = computed(() => formatLocal(startUtcMs.value, { hour: '2-digit', minute: '2-digit' }))
const endLabel = computed(() => formatLocal(parseCompact(archive.endUtc.value)?.getTime() ?? Date.now(), { hour: '2-digit', minute: '2-digit' }))

const agoLabel = computed(() => {
  const minutes = Math.max(0, Math.round((Date.now() - startUtcMs.value) / 60_000))
  if (minutes < 60) return `${minutes} min ago`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `${h} h ago`
  return `${h} h ${m} min ago`
})

function parseCompact(s: string | null): Date | null {
  if (!s || s.length < 12) return null
  const y = +s.slice(0, 4), m = +s.slice(4, 6) - 1, d = +s.slice(6, 8)
  const h = +s.slice(8, 10), n = +s.slice(10, 12)
  const dt = new Date(Date.UTC(y, m, d, h, n))
  return Number.isNaN(dt.getTime()) ? null : dt
}

function formatLocal(ms: number, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', { ...opts, hour12: false }).format(new Date(ms))
}

const dateInput = computed({
  get: () => {
    const d = new Date(startUtcMs.value)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  },
  set: (value: string) => {
    if (!value) return
    const d = new Date(`${value}T00:00:00Z`)
    if (Number.isNaN(d.getTime())) return
    const opt = ranges.find(r => r.value === archive.range.value)
    const hours = opt?.hours ?? 1
    const end = new Date(d.getTime() + hours * 3_600_000)
    const endRef = parseCompact(archive.endUtc.value)?.getTime() ?? Date.now()
    archive.shift(Math.round((end.getTime() - endRef) / 60_000))
  },
})
</script>

<template>
  <div class="flex min-w-0 items-center gap-1 rounded-full border border-border/60 bg-card/80 p-1 text-[10px] sm:gap-1.5 sm:text-[11px]">
    <div class="flex shrink-0 overflow-hidden rounded-full">
      <button
        type="button"
        class="px-2 py-0.5 transition-colors sm:px-2.5 sm:py-1"
        :class="props.mode === 'live' ? 'bg-foreground/90 text-background' : 'text-foreground/70 hover:bg-foreground/10'"
        @click="emit('update:mode', 'live')"
      >Live</button>
      <button
        type="button"
        class="px-2 py-0.5 transition-colors sm:px-2.5 sm:py-1"
        :class="props.mode === 'archive' ? 'bg-foreground/90 text-background' : 'text-foreground/70 hover:bg-foreground/10'"
        @click="emit('update:mode', 'archive')"
      >Archive</button>
    </div>

    <template v-if="props.mode === 'archive'">
      <input
        v-model="dateInput"
        type="date"
        aria-label="Archive start date"
        class="shrink-0 rounded-full border border-border/60 bg-background/40 px-1.5 py-0.5 text-[10px] outline-none focus:border-foreground/40 sm:px-2 sm:py-1 sm:text-[11px]"
      />
      <div class="flex shrink-0 overflow-hidden rounded-full">
        <button
          v-for="r in ranges"
          :key="r.value"
          type="button"
          class="px-2 py-0.5 transition-colors sm:px-2.5 sm:py-1"
          :class="archive.range.value === r.value ? 'bg-foreground/90 text-background' : 'text-foreground/70 hover:bg-foreground/10'"
          @click="archive.setRange(r.value)"
        >{{ r.label }}</button>
      </div>
      <span class="hidden truncate text-[10px] text-foreground/70 sm:inline">{{ agoLabel }}</span>
      <div class="flex shrink-0 items-center gap-0.5">
        <button type="button" aria-label="Step 1 hour earlier" class="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] hover:bg-foreground/10" @click="archive.shift(-60)">−1h</button>
        <button type="button" aria-label="Step 1 hour later" class="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] hover:bg-foreground/10" @click="archive.shift(60)">+1h</button>
        <button type="button" aria-label="Jump to most recent frame" class="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] hover:bg-foreground/10" @click="archive.goToNow()">Now</button>
      </div>
    </template>
  </div>
</template>
