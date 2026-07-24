import { ref, onMounted, onBeforeUnmount } from 'vue'

/** Reactive `window.matchMedia(query).matches` — UI RWD only, no algorithm side effects. */
export function useMediaQuery(query) {
  const initial =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  const matches = ref(initial)
  let mql = null
  function sync() { matches.value = !!mql?.matches }
  onMounted(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    mql = window.matchMedia(query)
    sync()
    mql.addEventListener('change', sync)
  })
  onBeforeUnmount(() => {
    mql?.removeEventListener('change', sync)
    mql = null
  })
  return matches
}
