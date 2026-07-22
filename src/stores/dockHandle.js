// Plain (non-reactive) handle to the live Dockview API.
// Kept outside Pinia/Vue reactivity on purpose (same reason as mapHandle).
export const dockHandle = { api: null }

// Open the tab for a layer, or focus it if it is already open.
// `inactive: true` = 只掛 tab 標籤、不立刻 mount 內容（reload 還原一堆 tab 時用，
// 避免每個 LayerTab／D3Tab 同時建 MapLibre／跑整條繪圖管線把啟動拖死）。
// 預設 renderer＝onlyWhenVisible：非作用中 tab 卸載 DOM，切過去才 mount。
export function openLayerTab(layer, { inactive = false } = {}) {
  const api = dockHandle.api
  if (!api || !layer) return
  const existing = api.getPanel(layer.id)
  if (existing) {
    if (!inactive) existing.api.setActive()
    return
  }
  api.addPanel({
    id: layer.id,
    // Hill Climbing / RWD views reuse the D3 tab (same renderer, different view tabs).
    component: ['d3', 'hillclimb', 'rwd'].includes(layer.type) ? 'd3-tab' : 'layer-tab',
    title: layer.name,
    // `title` in params too, so the custom tab (DockTab) can read it directly.
    params: { layerId: layer.id, title: layer.name },
    inactive,
  })
}

// 視圖畫廊 tab——開啟（或聚焦）固定 id 的 panel。
function openFixedTab({ id, component, title, icon }, { inactive = false } = {}) {
  const api = dockHandle.api
  if (!api) return
  const existing = api.getPanel(id)
  if (existing) {
    if (!inactive) existing.api.setActive()
    return
  }
  api.addPanel({
    id,
    component,
    title,
    params: { title, icon },
    inactive,
  })
}
// 視圖畫廊（2026-07 併四為一）：every city × 所有地圖（Raw Maps 縮圖 / Map
// Adjust / Straighten / RWD Maps 預算視圖），上方勾選要顯示的種類。
export const openAllGalleryTab = (opts) =>
  openFixedTab({ id: 'all-gallery', component: 'all-gallery', title: '視圖畫廊', icon: 'grid_view' }, opts)

// 依持久化的 tab id 還原一個 tab：固定面板（視圖畫廊）或某圖層。找不到對應圖層
// 就略過（例如該圖層已被刪除）。
export function reopenTabById(id, layers, opts) {
  if (id === 'all-gallery') { openAllGalleryTab(opts); return }
  const layer = layers.find((l) => l.id === id)
  if (layer) openLayerTab(layer, opts)
}
