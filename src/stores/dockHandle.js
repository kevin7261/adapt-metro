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

// 四個畫廊 tab（Metro Maps / Map Adjust / Hill Climbing / RWD Maps）——
// 開啟（或聚焦）固定 id 的 panel，規格表驅動。
function openFixedTab({ id, component, title, icon }) {
  const api = dockHandle.api
  if (!api) return
  const existing = api.getPanel(id)
  if (existing) { existing.api.setActive(); return }
  api.addPanel({
    id,
    component,
    title,
    params: { title, icon },
    renderer: 'always',
  })
}
// Metro Maps：every city's thumbnail grid.
export const openGalleryTab = () =>
  openFixedTab({ id: 'metro-gallery', component: 'metro-gallery', title: 'Metro Maps', icon: 'train' })
// Map Adjust：every city's pre-computed views as a card grid (data/metro/views/).
export const openViewGalleryTab = () =>
  openFixedTab({ id: 'map-adjust-gallery', component: 'map-adjust-gallery', title: 'Map Adjust · 視圖畫廊', icon: 'polyline' })
// Hill Climbing：every city's pre-computed HC views as a card grid (data/metro/hcviews/).
export const openHcGalleryTab = () =>
  openFixedTab({ id: 'hill-climb-gallery', component: 'hill-climb-gallery', title: 'Straighten · 視圖畫廊', icon: 'terrain' })
// RWD Maps：every city's pre-computed RWD views as a card grid
// (data/metro/rwdviews/)：4 縮減網格變體 × 縮減網格|RWD 路網.
export const openRwdGalleryTab = () =>
  openFixedTab({ id: 'rwd-gallery', component: 'rwd-gallery', title: 'RWD Maps · 視圖畫廊', icon: 'route' })
