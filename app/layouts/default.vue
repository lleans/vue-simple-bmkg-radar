<script setup lang="ts">
import ModeToggle from '~/components/ModeToggle.vue';

</script>

<template>
    <div class="bg-slate-200 dark:bg-slate-900 dark:text-slate-300 .${color}-mode">
        <slot />
        <ModeToggle class="absolute bottom-0 right-0" />
    </div>
</template>
