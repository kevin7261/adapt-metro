// Plain (non-reactive) handle to the live Dockview API.
// Kept outside Pinia/Vue reactivity on purpose (same reason as mapHandle).
export const dockHandle = { api: null }

// Open the tab for a layer, or focus it if it is already open.
export function openLayerTab(layer) {
  const api = dockHandle.api
  if (!api || !layer) return
  const existing = api.getPanel(layer.id)
  if (existing) {
    existing.api.setActive()
    return
  }
  api.addPanel({
    id: layer.id,
    // Hill Climbing views reuse the D3 tab (same renderer, different view tabs).
    component: layer.type === 'd3' || layer.type === 'hillclimb' ? 'd3-tab' : 'layer-tab',
    title: layer.name,
    // `title` in params too, so the custom tab (DockTab) can read it directly.
    params: { layerId: layer.id, title: layer.name },
    // Keep hidden tabs mounted so each tab's map keeps its view state.
    renderer: 'always',
  })
}

// Open (or focus) the Metro Maps gallery tab — a grid of every city's thumbnail.
export function openGalleryTab() {
  const api = dockHandle.api
  if (!api) return
  const existing = api.getPanel('metro-gallery')
  if (existing) { existing.api.setActive(); return }
  api.addPanel({
    id: 'metro-gallery',
    component: 'metro-gallery',
    title: 'Metro Maps',
    params: { title: 'Metro Maps' },
    renderer: 'always',
  })
}
