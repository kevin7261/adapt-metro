// Persist the layer session to localStorage so layers (and their settings)
// survive a page reload. localStorage — not cookies — because the payload can
// exceed a cookie's ~4 KB limit, and it never needs to travel to a server.
//
// Metro layers re-fetch their GeoJSON from `file`, so only the descriptor is
// stored. A D3 view imported from a local file keeps its data only in memory,
// so that GeoJSON is stored too (dropped first if the quota is hit).
import { layerData } from './layerData.js'

const KEY = 'adapt-metro:session:v1'

export function loadPersisted() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function buildSnapshot(store) {
  const d3Data = {}
  for (const l of store.layers) {
    // file-imported D3 view: data lives only in layerData, not re-fetchable
    if (l.type === 'd3' && !l.sourceLayerId && !l.file && layerData[l.id]) {
      d3Data[l.id] = layerData[l.id]
    }
    // 專案另存：所有已載入的 metro／衍生源也一併帶上（匯入可離線回復）
    if (l.type === 'metro' && layerData[l.id]) {
      d3Data[l.id] = layerData[l.id]
    }
  }
  return {
    version: 1,
    layers: store.layers,
    selectedLayerId: store.selectedLayerId,
    openTabIds: store.openTabIds,
    activeTabId: store.activeTabId,
    dockLayout: store.dockLayout,
    groupCollapsed: store.cityCollapsed,
    attributeTableOpen: store.ui.attributeTableOpen,
    layerPanelOpen: store.ui.layerPanelOpen,
    layerPanelWidth: store.layerPanelWidth,
    attributeTableHeight: store.attributeTableHeight,
    dark: store.dark,
    accent: store.accent,
    d3Data,
  }
}

/** 專案匯入：覆寫 session 並重植 layerData */
export function applySnapshot(store, snap) {
  if (!snap) return
  if (Array.isArray(snap.layers)) store.layers = snap.layers
  store.selectedLayerId = snap.selectedLayerId ?? null
  store.openTabIds = snap.openTabIds ?? []
  store.activeTabId = snap.activeTabId ?? null
  store.dockLayout = snap.dockLayout ?? null
  store.cityCollapsed = snap.groupCollapsed ?? {}
  store.ui.attributeTableOpen = snap.attributeTableOpen ?? {}
  if (snap.layerPanelOpen != null) store.ui.layerPanelOpen = snap.layerPanelOpen
  if (snap.layerPanelWidth != null) store.layerPanelWidth = snap.layerPanelWidth
  if (snap.attributeTableHeight != null) store.attributeTableHeight = snap.attributeTableHeight
  if (snap.dark != null) store.dark = snap.dark
  if (snap.accent != null) store.accent = snap.accent
  for (const [id, data] of Object.entries(snap.d3Data ?? {})) layerData[id] = data
  savePersisted(store)
}

function write(snap) {
  localStorage.setItem(KEY, JSON.stringify(snap))
}

function savePersisted(store) {
  const snap = buildSnapshot(store)
  try {
    write(snap)
  } catch {
    // Quota exceeded (large imported GeoJSON) — persist everything except the
    // heavy D3 data so the layer list and settings still survive.
    try { write({ ...snap, d3Data: {} }) } catch { /* give up silently */ }
  }
}

let timer = null
export function schedulePersist(store) {
  clearTimeout(timer)
  timer = setTimeout(() => savePersisted(store), 300)
}

/** 立刻寫入（beforeunload／頁面隱藏時用，避免 300ms debounce 來不及）。 */
export function flushPersist(store) {
  clearTimeout(timer)
  timer = null
  try { savePersisted(store) } catch { /* ignore */ }
}

// Re-seed layerData for file-imported D3 views before their tabs open.
export function restoreLayerData() {
  const snap = loadPersisted()
  if (!snap?.d3Data) return
  for (const [id, data] of Object.entries(snap.d3Data)) layerData[id] = data
}
