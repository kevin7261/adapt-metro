// Persist the layer session to localStorage so layers (and their settings)
// survive a page reload. localStorage — not cookies — because the payload can
// exceed a cookie's ~4 KB limit, and it never needs to travel to a server.
//
// Metro layers re-fetch their GeoJSON from `file`, so only the descriptor is
// stored. A D3 view imported from a local file keeps its data only in memory,
// so that GeoJSON is stored too (dropped first if the quota is hit).
import { layerData } from './layerData'

const KEY = 'adapt-metro:session:v1'

export function loadPersisted() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function buildSnapshot(store) {
  const d3Data = {}
  for (const l of store.layers) {
    // file-imported D3 view: data lives only in layerData, not re-fetchable
    if (l.type === 'd3' && !l.sourceLayerId && !l.file && layerData[l.id]) {
      d3Data[l.id] = layerData[l.id]
    }
  }
  return {
    version: 1,
    layers: store.layers,
    selectedLayerId: store.selectedLayerId,
    groupCollapsed: Object.fromEntries(store.groups.map((g) => [g.id, g.collapsed])),
    attributeTableOpen: store.ui.attributeTableOpen,
    layerPanelOpen: store.ui.layerPanelOpen,
    layerPanelWidth: store.layerPanelWidth,
    attributeTableHeight: store.attributeTableHeight,
    dark: store.dark,
    accent: store.accent,
    d3Data,
  }
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

// Re-seed layerData for file-imported D3 views before their tabs open.
export function restoreLayerData() {
  const snap = loadPersisted()
  if (!snap?.d3Data) return
  for (const [id, data] of Object.entries(snap.d3Data)) layerData[id] = data
}
