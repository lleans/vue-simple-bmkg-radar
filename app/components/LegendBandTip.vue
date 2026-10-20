<script setup lang="ts">
import { HoverCardContent, HoverCardPortal, HoverCardRoot, HoverCardTrigger } from 'reka-ui'

defineProps<{
  label: string
  dbz: string
  mmh: string
  note: string
}>()
</script>

<template>
  <HoverCardRoot :open-delay="140" :close-delay="80">
    <!-- The band is already the hover target; the trigger is a full-cover
         invisible layer so it catches the pointer. -->
    <HoverCardTrigger as-child>
      <span class="absolute inset-0" />
    </HoverCardTrigger>
    <HoverCardPortal>
      <HoverCardContent
        side="top"
        :side-offset="8"
        align="center"
        :collision-padding="12"
        class="z-50 w-56 rounded-xl border border-border/60 bg-popover/95 p-2.5 text-popover-foreground shadow-2xl backdrop-blur-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=top]:slide-in-from-bottom-2 data-[side=bottom]:slide-in-from-top-2"
      >
        <div class="flex items-baseline justify-between gap-2">
          <p class="text-xs font-semibold">{{ label }}</p>
          <span class="font-mono text-[10px] tabular-nums text-muted-foreground">{{ dbz }}</span>
        </div>
        <p class="mt-0.5 text-[11px] font-medium tabular-nums">{{ mmh }}</p>
        <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">{{ note }}</p>
      </HoverCardContent>
    </HoverCardPortal>
  </HoverCardRoot>
</template>