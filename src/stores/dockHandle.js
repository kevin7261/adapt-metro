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
    // Hill Climbing / RWD views reuse the D3 tab (same renderer, different view tabs).
    component: ['d3', 'hillclimb', 'rwd'].includes(layer.type) ? 'd3-tab' : 'layer-tab',
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
    params: { title: 'Metro Maps', icon: 'train' },
    renderer: 'always',
  })
}

// Open (or focus) the Map Adjust gallery tab — every city's 8 pre-computed
// views as a 3×3 九宮格 card grid (data/metro/views/).
export function openViewGalleryTab() {
  const api = dockHandle.api
  if (!api) return
  const existing = api.getPanel('map-adjust-gallery')
  if (existing) { existing.api.setActive(); return }
  api.addPanel({
    id: 'map-adjust-gallery',
    component: 'map-adjust-gallery',
    title: 'Map Adjust · 8 視圖',
    params: { title: 'Map Adjust · 8 視圖', icon: 'polyline' },
    renderer: 'always',
  })
}

// Open (or focus) the Hill Climbing gallery tab — every city's 6 pre-computed
// HC views as a 2×3 card grid (data/metro/hcviews/).
export function openHcGalleryTab() {
  const api = dockHandle.api
  if (!api) return
  const existing = api.getPanel('hill-climb-gallery')
  if (existing) { existing.api.setActive(); return }
  api.addPanel({
    id: 'hill-climb-gallery',
    component: 'hill-climb-gallery',
    title: 'Straighten · 6 視圖',
    params: { title: 'Straighten · 6 視圖', icon: 'terrain' },
    renderer: 'always',
  })
}

// Open (or focus) the RWD Maps gallery tab — every city's 8 pre-computed RWD
// views as a 4×2 card grid (data/metro/rwdviews/): 4 縮減網格變體 × 縮減網格|RWD 路網.
export function openRwdGalleryTab() {
  const api = dockHandle.api
  if (!api) return
  const existing = api.getPanel('rwd-gallery')
  if (existing) { existing.api.setActive(); return }
  api.addPanel({
    id: 'rwd-gallery',
    component: 'rwd-gallery',
    title: 'RWD Maps · 8 視圖',
    params: { title: 'RWD Maps · 8 視圖', icon: 'route' },
    renderer: 'always',
  })
}
