// Plain (non-reactive) handle to the live Dockview API.
// Kept outside Pinia/Vue reactivity on purpose (same reason as mapHandle).
export const dockHandle = { api: null }

// Open the tab for a layer, or focus it if it is already open.
// `inactive: true` = 只掛 tab 標籤、不立刻 mount 內容（reload 還原一堆 tab 時用，
// 避免每個 LayerTab／D3Tab 同時建 MapLibre／跑整條繪圖管線把啟動拖死）。
// `beside` = 已開的 panel id：新 tab 掛進同一 group（direction:within）。
// 注意：連續 inactive addPanel 若沒指定 position，dockview 的 activeGroup 為空
// 會每個 tab 另開一組 → 刷新後疊在一起的 tab 變左右分裂。
export function openLayerTab(layer, { inactive = false, beside = null } = {}) {
  const api = dockHandle.api
  if (!api || !layer) return
  const existing = api.getPanel(layer.id)
  if (existing) {
    if (!inactive) existing.api.setActive()
    return
  }
  const opts = {
    id: layer.id,
    // Hill Climbing / RWD views reuse the D3 tab (same renderer, different view tabs).
    component: ['d3', 'hillclimb', 'rwd'].includes(layer.type) ? 'd3-tab' : 'layer-tab',
    title: layer.name,
    // `title` in params too, so the custom tab (DockTab) can read it directly.
    params: { layerId: layer.id, title: layer.name },
    inactive,
  }
  if (beside) opts.position = { referencePanel: beside, direction: 'within' }
  api.addPanel(opts)
}

// 視圖畫廊 tab——開啟（或聚焦）固定 id 的 panel。
function openFixedTab({ id, component, title, icon }, { inactive = false, beside = null } = {}) {
  const api = dockHandle.api
  if (!api) return
  const existing = api.getPanel(id)
  if (existing) {
    if (!inactive) existing.api.setActive()
    return
  }
  const opts = {
    id,
    component,
    title,
    params: { title, icon },
    inactive,
  }
  if (beside) opts.position = { referencePanel: beside, direction: 'within' }
  api.addPanel(opts)
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

/** 還原時可接受的 panel id（現有圖層＋視圖畫廊）。 */
export function allowedDockPanelIds(layers) {
  const ok = new Set((layers ?? []).map((l) => l.id))
  ok.add('all-gallery')
  return ok
}

/**
 * 過濾 dockview toJSON 版面：丟掉已刪圖層的 panel。若有缺漏（grid 節點仍指
 * 向已刪 id）則回 null，改走 openTabIds 疊回同一 group。
 */
export function sanitizeDockLayout(layout, layers) {
  if (!layout?.panels || typeof layout.panels !== 'object') return null
  const ok = allowedDockPanelIds(layers)
  const ids = Object.keys(layout.panels)
  if (!ids.length) return null
  const kept = {}
  for (const id of ids) {
    if (ok.has(id)) kept[id] = layout.panels[id]
  }
  if (!Object.keys(kept).length) return null
  // 任一面板被濾掉 → grid 樹可能殘留空 group／壞 reference，不硬從 JSON 還原。
  if (Object.keys(kept).length !== ids.length) return null
  return { ...layout, panels: kept }
}
