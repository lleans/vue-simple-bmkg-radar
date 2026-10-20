// Drives the time-lapse animation. Ticks every `tickMs`, holds on the
// latest frame for `holdMs`.
//
// The animation freezes on its current frame while the user interacts and
// resumes shortly after they stop:
//  - hold() is called by the map for drags, zooms, wheel, touch and keys
//    (and by page scroll below), and every call restarts the idle timer;
//  - it also stays frozen for prefers-reduced-motion and hidden tabs.
//
// `speed` is a multiplier: 0.5 = half speed (slower), 2 = double speed.
// Default is 1x = 1500ms per frame.

import type { RadarFrame } from './useRadarApi'

// Resume this long after the last interaction.
const INTERACTION_IDLE_MS = 1200
// Scroll events stream continuously, so a shorter idle is enough.
const SCROLL_IDLE_MS = 400

export const useRadarTimeline = (frames: Ref<RadarFrame[]>) => {
  const idx = ref(0)
  const playing = ref(true)
  const prefersReduced = ref(false)
  const interacting = ref(false)
  const speed = ref(1)
  const baseTickMs = 1500
  const baseHoldMs = 2400

  const tickMs = computed(() => Math.round(baseTickMs / speed.value))
  const holdMs = computed(() => Math.round(baseHoldMs / speed.value))

  let timer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const onReduceMotionChange = (e: MediaQueryListEvent) => {
    prefersReduced.value = e.matches
  }

  // Freeze the animation now; it resumes `idleMs` after the last call.
  const hold = (idleMs = INTERACTION_IDLE_MS) => {
    interacting.value = true
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      interacting.value = false
    }, idleMs)
  }

  const onWindowScroll = () => hold(SCROLL_IDLE_MS)

  const isHidden = ref(false)
  const onVisibilityChange = () => {
    isHidden.value = typeof document !== 'undefined' && document.hidden
  }

  const canPlay = computed(
    () =>
      playing.value &&
      !prefersReduced.value &&
      !interacting.value &&
      !isHidden.value &&
      frames.value.length > 0,
  )

  const scheduleNext = () => {
    if (!canPlay.value) return
    // Replace any pending tick. Several callers (frames watcher, canPlay
    // watcher, play) each re-schedule; without clearing first, parallel
    // chains advance idx faster than the tick rate and it races past the end.
    if (timer) clearTimeout(timer)
    // Always clamp against the CURRENT length at fire time, not the length
    // when this timer was created. The frame list grows as stations finish
    // loading (and changes wholesale on a product switch), so an index that
    // was valid when the timer was scheduled can be stale by the time it
    // fires. Without this the playhead walked past the end and the UI showed
    // "12 / 11" with an empty currentFrame.
    const wait = idx.value >= frames.value.length - 1 ? holdMs.value : tickMs.value
    timer = setTimeout(() => {
      const last = frames.value.length - 1
      idx.value = idx.value >= last ? 0 : idx.value + 1
      scheduleNext()
    }, wait)
  }

  watch(frames, (f) => {
    if (!f?.length) return
    // Wrap rather than clamp when the new list is shorter: clamping leaves the
    // playhead parked on the last frame instead of restarting the cycle.
    if (idx.value > f.length - 1) idx.value = 0
    if (canPlay.value) scheduleNext()
  })

  // Re-evaluate scheduling whenever any condition flips
  watch(canPlay, (ok) => {
    if (timer) { clearTimeout(timer); timer = null }
    if (ok) scheduleNext()
  })

  const play = () => { playing.value = true }
  const pause = () => { playing.value = false }
  const seek = (i: number) => {
    if (frames.value.length === 0) return
    idx.value = Math.max(0, Math.min(frames.value.length - 1, i))
  }
  const setSpeed = (s: number) => {
    speed.value = Math.max(0.25, Math.min(4, s))
  }

  // Guard the index: a stale idx (frames shrank since it was set) must not
  // read past the end, which is what produced the empty "--:--" timestamp.
  const currentFrame = computed(() => {
    const f = frames.value[idx.value]
    return f ?? null
  })

  onMounted(() => {
    if (typeof window !== 'undefined') {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
      prefersReduced.value = mq.matches
      mq.addEventListener('change', onReduceMotionChange)
      window.addEventListener('scroll', onWindowScroll, { passive: true })
      document.addEventListener('visibilitychange', onVisibilityChange)
      if (canPlay.value) scheduleNext()
    }
  })

  onUnmounted(() => {
    if (timer) clearTimeout(timer)
    if (idleTimer) clearTimeout(idleTimer)
    if (typeof window !== 'undefined') {
      window
        .matchMedia('(prefers-reduced-motion: reduce)')
        .removeEventListener('change', onReduceMotionChange)
      window.removeEventListener('scroll', onWindowScroll)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  })

  return { idx, playing, interacting, speed, currentFrame, play, pause, seek, setSpeed, hold }
}
