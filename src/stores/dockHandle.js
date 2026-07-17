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

// 視圖畫廊 tab——開啟（或聚焦）固定 id 的 panel。
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
// 視圖畫廊（2026-07 併四為一）：every city × 所有地圖（Raw Maps 縮圖 / Map
// Adjust / Straighten / RWD Maps 預算視圖），上方勾選要顯示的種類。
export const openAllGalleryTab = () =>
  openFixedTab({ id: 'all-gallery', component: 'all-gallery', title: '視圖畫廊', icon: 'grid_view' })
