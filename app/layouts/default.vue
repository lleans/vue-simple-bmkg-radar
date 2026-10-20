<script setup lang="ts">
import ModeToggle from '~/components/ModeToggle.vue';
</script>

<template>
    <div class="min-h-screen bg-background text-foreground">
        <slot />
        <!--
            Anchor at viewport edge, not layout edge. `right` is measured
            from the viewport on a `position: fixed` element, so this stays
            put whether or not Reka's body scroll lock adds padding-right
            to the document. The `!important` overrides any inherited
            transform/position context from a transformed ancestor.
        -->
        <div
            class="theme-toggle-pin"
            style="position: fixed; right: 16px; bottom: 16px; z-index: 50;"
        >
            <ModeToggle />
        </div>
    </div>
</template>

<style scoped>
.theme-toggle-pin {
    /* Anchor at the actual viewport right edge, ignoring body padding
       that Reka's dropdown/modal scroll-lock adds. */
    position: fixed !important;
    inset-inline-end: 16px !important;
    inset-block-end: 16px !important;
    z-index: 50;
    /* Counter the body padding-right that Reka adds by offsetting the
       button inward by exactly the scrollbar width (provided by Reka's
       CSS var). If the body has no padding, the var is 0 and the
       button stays at right:16px. If the body has 10px of padding
       (scrollbar present), we offset the button 10px back to the right
       to stay glued to the viewport edge. */
    margin-right: var(--scrollbar-width, 0px);
}
</style>
