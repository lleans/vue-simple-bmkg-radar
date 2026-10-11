<script setup>
import { GoogleMap, Marker } from 'vue3-google-map'
import { ref, onMounted, onUnmounted } from 'vue'

const apiKey = useRuntimeConfig().public.googleMapsApiKey

const center = { lat: 40.689247, lng: -74.044502 }

// Dynamic padding and border based on scroll
const paddingX = ref(16)
const paddingY = ref(8)
const borderWidth = ref(1)

const handleScroll = () => {
    const scrollPosition = window.scrollY
    const maxScroll = 400 // Distance to scroll before reaching maximum padding

    if (scrollPosition >= maxScroll) {
        paddingX.value = 100
        paddingY.value = 50
        borderWidth.value = 3
    } else {
        // Interpolate horizontal padding between 16 and 100
        paddingX.value = Math.min(100, 16 + (scrollPosition / maxScroll) * 84)
        // Interpolate vertical padding between 8 and 50
        paddingY.value = Math.min(50, 8 + (scrollPosition / maxScroll) * 42)
        // Interpolate border between 1 and 3
        borderWidth.value = Math.min(3, 1 + (scrollPosition / maxScroll) * 2)
    }
}

onMounted(() => {
    window.addEventListener('scroll', handleScroll)
})

onUnmounted(() => {
    window.removeEventListener('scroll', handleScroll)
})
</script>

<template>
    <div :style="{ paddingLeft: `${paddingX}px`, paddingRight: `${paddingX}px`, paddingTop: `${paddingY}px`, paddingBottom: `${paddingY}px` }"
        class="h-[100vh]">
        <GoogleMap :api-key="apiKey"
            class="w-full h-full overflow-hidden border-slate-500 dark:border-slate-300 rounded-3xl"
            :style="{ borderWidth: `${borderWidth}px` }" :center="center" :zoom="15">
            <Marker :options="{ position: center }" />
        </GoogleMap>
    </div>
</template>
