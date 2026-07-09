// Plain (non-reactive) handle to the live MapLibre instance.
// Kept outside Pinia/Vue reactivity on purpose: wrapping a MapLibre
// map in a reactive proxy breaks its internals.
export const mapHandle = { map: null }
