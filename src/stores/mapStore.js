import { defineStore } from 'pinia'
import { assetUrl } from '../lib/assetUrl'
import { loadPersisted } from './persist'
import CITY_ZH from './cityNamesZh.json'

let toastTimer = null

// Display name for a metro system = Chinese 城市・國名 (from cityNamesZh.json,
// keyed by the geojson file stem; 中點分隔，與 Info tab 城市標題一致)。
// Falls back to the id if a city is missing.
function metroDisplayName(id) {
  const zh = CITY_ZH[id]
  return zh ? `${zh.city}・${zh.country}` : id
}
// Straighten (hillclimb) layers carry which grid-post variant they optimized.
const variantLabel = (v) => (v === 'rot' ? '旋轉' : '原始')

// One-time migration for sessions saved before layer names dropped their type
// prefixes (d3- / hc-d3- / rwd-hc-d3-). Recompute each derived layer's name
// from its source chain — exactly what the add* actions now do — so the result
// matches new layers and is idempotent (running it again is a no-op). Imported
// D3 views (no source) and metro layers keep their own names.
// Recover the metro geojson stem from a legacy prefixed name
// ("rwd-hc-d3-am-mex-mexico-city-orig" → "am-mex-mexico-city"), so a derived
// layer can still be renamed even if its source metro layer was removed.
function legacyMetroId(name) {
  if (typeof name !== 'string') return null
  const stem = name.replace(/^(rwd-)?(hc-)?(d3-)?/, '').replace(/-(orig|rot)$/, '')
  return CITY_ZH[stem] ? stem : null
}

function migrateLayerNames(layers) {
  const byId = new Map(layers.map((l) => [l.id, l]))
  // Backfill Chinese city/country on metro layers imported before this field.
  for (const l of layers) {
    if (l.type === 'metro' && CITY_ZH[l.id]) {
      l.countryZh ??= CITY_ZH[l.id].country
      l.cityZh ??= CITY_ZH[l.id].city
    }
  }
  const nameOf = (l) => {
    if (!l) return undefined
    if (l.type === 'metro') return metroDisplayName(l.id)
    const src = l.sourceLayerId ? byId.get(l.sourceLayerId) : null
    // Prefer the source chain; fall back to parsing the old prefixed name.
    const base = src ? nameOf(src) : (legacyMetroId(l.name) ? metroDisplayName(legacyMetroId(l.name)) : null)
    if (base == null) return l.name // imported view or unknown → keep as-is
    if (l.type === 'hillclimb') return `${base}（${variantLabel(l.variant)}）`
    return base // d3 / rwd
  }
  for (const l of layers) l.name = nameOf(l)
  return layers
}

export const useMapStore = defineStore('map', {
  // Hydrate from the persisted session (localStorage) so layers survive reloads.
  // Group labels stay code-defined; only their collapsed state is restored.
  state: () => {
    const p = loadPersisted()
    return {
      dark: p?.dark ?? true,
      accent: p?.accent ?? 'blue',
      projectName: 'adapt-metro.geolibre.json',

      ui: {
        layerPanelOpen: p?.layerPanelOpen ?? true,
        // Attribute table open/closed is independent per layer (layerId -> bool);
        // each layer tab controls its own.
        attributeTableOpen: p?.attributeTableOpen ?? {},
        commandPalette: false,
        dialog: null, // 'import-metro' | 'add-data' | 'settings' | 'about' | 'shortcuts' | 'new-project'
        toast: null,
      },

      layerPanelWidth: p?.layerPanelWidth ?? 300,
      attributeTableHeight: p?.attributeTableHeight ?? 260,

      // Layer of the active editor tab (mirrors the dockview active panel).
      selectedLayerId: p?.selectedLayerId ?? null,

      // Properties of the last-clicked map feature, per layer id (null = nothing
      // selected). The map tab writes it on click; the Object tab reads it.
      selectedFeatures: {},

      // Flat list — every layer opens as its own editor tab.
      // Populated by importing metro systems (Import Metro Map).
      layers: migrateLayerNames(p?.layers ?? []),

      // Layer groups (GeoLibre model: flat layers carry a groupId). One group per
      // kind of layer: imported metro maps, D3.js views over a metro layer, and
      // hill-climbing optimizations over a Map Adjust view's gridded layout.
      groups: [
        { id: 'metro-maps', label: 'Metro Maps', collapsed: p?.groupCollapsed?.['metro-maps'] ?? false },
        { id: 'highway-maps', label: 'Highways', collapsed: p?.groupCollapsed?.['highway-maps'] ?? false },
        { id: 'd3', label: 'Map Adjust', collapsed: p?.groupCollapsed?.['d3'] ?? false },
        { id: 'hillclimb', label: 'Straighten', collapsed: p?.groupCollapsed?.['hillclimb'] ?? false },
        { id: 'rwd', label: 'RWD Maps', collapsed: p?.groupCollapsed?.['rwd'] ?? false },
      ],
    }
  },

  getters: {
    selectedLayer(state) {
      return state.layers.find((l) => l.id === state.selectedLayerId) ?? null
    },
    // Panel rows: each group with its member layers (groups always shown).
    layerTree(state) {
      return state.groups.map((group) => ({
        group,
        children: state.layers.filter((l) => l.groupId === group.id),
      }))
    },
  },

  actions: {
    toast(message) {
      this.ui.toast = message
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => { this.ui.toast = null }, 2600)
    },
    // Toggle (or force) a single layer's attribute table — independent per layer.
    toggleAttributeTable(layerId, force) {
      if (!layerId) return
      const open = force === undefined ? !this.ui.attributeTableOpen[layerId] : force
      this.ui.attributeTableOpen = { ...this.ui.attributeTableOpen, [layerId]: open }
    },
    fake(name) {
      this.toast(`「${name}」為 UI 原型 — 功能尚未實作`)
    },

    // props = the clicked feature's properties object, or null to clear.
    setSelectedFeature(layerId, props) {
      this.selectedFeatures[layerId] = props ?? null
    },

    // sys = an entry of data/metro/index.json `systems`
    // (file, continent, country, city, line_count, station_count, …)
    importMetroSystem(sys) {
      // 'systems/asia/taiwan/asia-taiwan-taipei.geojson' → 'asia-taiwan-taipei'
      const id = sys.file.split('/').pop().replace(/\.geojson$/, '')
      let layer = this.layers.find((l) => l.id === id)
      if (!layer) {
        layer = {
          id,
          // Display name = Chinese 國名－城市名 (falls back to the id).
          name: metroDisplayName(id),
          type: 'metro',
          groupId: 'metro-maps',
          file: assetUrl(`data/metro/${sys.file}`),
          continent: sys.continent,
          country: sys.country,
          city: sys.city,
          countryZh: CITY_ZH[id]?.country ?? sys.country,
          cityZh: CITY_ZH[id]?.city ?? sys.city,
          visible: true,
          opacity: 1,
          strokeWidth: 2.5,
          radius: 4,
          symbology: 'categorized',
          lineCount: sys.line_count ?? 0,
          stationCount: sys.station_count ?? 0,
          featureCount: (sys.line_count ?? 0) + (sys.station_count ?? 0),
        }
        this.layers.push(layer)
      }
      this.selectedLayerId = layer.id
      return layer
    },

    // sys = an entry of data/highway/index.json `systems` (one per country).
    // Highway networks mirror the metro GeoJSON schema, so they load as type
    // 'metro' and reuse the same map/D3 renderers; the `highway` flag only
    // drives the row icon. Labels come from the catalog entry (city = country).
    importHighwaySystem(sys) {
      const slug = sys.file.split('/').pop().replace(/\.geojson$/, '')
      const id = `hw-${slug}`
      let layer = this.layers.find((l) => l.id === id)
      if (!layer) {
        const label = sys.cityZh ?? sys.city ?? sys.country ?? slug
        layer = {
          id,
          name: label,
          type: 'metro',
          highway: true,
          groupId: 'highway-maps',
          file: assetUrl(`data/highway/${sys.file}`),
          continent: sys.continent,
          country: sys.country,
          city: sys.city ?? sys.country,
          countryZh: sys.countryZh ?? sys.country,
          cityZh: sys.cityZh ?? sys.city ?? sys.country,
          visible: true,
          opacity: 1,
          strokeWidth: 2.5,
          radius: 4,
          symbology: 'categorized',
          lineCount: sys.line_count ?? 0,
          stationCount: sys.station_count ?? 0,
          featureCount: (sys.line_count ?? 0) + (sys.station_count ?? 0),
        }
        this.layers.push(layer)
      }
      this.selectedLayerId = layer.id
      return layer
    },

    // Add a D3.js view layer — its tab renders a metro layer with d3 instead of
    // MapLibre. The source metro layer is chosen at creation and never changes.
    addD3Layer(sourceLayerId) {
      const src = this.layers.find((l) => l.id === sourceLayerId)
      if (!src) return null
      let n = 1
      while (this.layers.some((l) => l.id === `d3-view-${n}`)) n++
      const layer = {
        id: `d3-view-${n}`,
        // Layer names carry no type prefix — the group (Map Adjust / Straighten
        // / RWD Maps) already tells the type; only the source + variant matter.
        name: src.name,
        type: 'd3',
        groupId: 'd3',
        sourceLayerId,
        visible: true,
        opacity: 1,
      }
      this.layers.push(layer)
      this.selectedLayerId = layer.id
      return layer
    },

    // Add a D3.js view from an imported GeoJSON file. The data is the layer's
    // own (caller stores it in layerData under the new id). If the file carries
    // metro_system metadata the layer behaves like a metro layer in the panels.
    addD3LayerFromData(name, data) {
      let n = 1
      while (this.layers.some((l) => l.id === `d3-view-${n}`)) n++
      const sys = data?.metro_system
      const stationCount = (data?.features ?? [])
        .filter((f) => f.geometry?.type === 'Point').length
      const routeIds = new Set()
      for (const f of data?.features ?? []) {
        if (f.geometry?.type === 'Point') continue
        for (const r of f.properties?.routes ?? [f.properties]) {
          if (r?.route_id) routeIds.add(r.route_id)
        }
      }
      const layer = {
        id: `d3-view-${n}`,
        name,
        type: 'd3',
        groupId: 'd3',
        sourceLayerId: null,
        metroLike: !!sys,
        city: sys?.city,
        country: sys?.country,
        continent: sys?.continent,
        visible: true,
        opacity: 1,
        strokeWidth: 2.5,
        radius: 4,
        lineCount: routeIds.size,
        stationCount,
        featureCount: (data?.features ?? []).length,
      }
      this.layers.push(layer)
      this.selectedLayerId = layer.id
      return layer
    },

    // Add a Hill Climbing view (Stott et al. 2011 多準則爬山) — optimizes a Map
    // Adjust view's post-gridding layout. Source = a d3 layer + which grid-post
    // variant ('orig' 原始格網化後 | 'rot' 旋轉格網化後); both fixed at creation.
    addHillClimbLayer(d3LayerId, variant) {
      const src = this.layers.find((l) => l.id === d3LayerId)
      if (!src) return null
      const v = variant === 'rot' ? 'rot' : 'orig'
      let n = 1
      while (this.layers.some((l) => l.id === `hc-view-${n}`)) n++
      const layer = {
        id: `hc-view-${n}`,
        name: `${src.name}（${variantLabel(v)}）`,
        type: 'hillclimb',
        groupId: 'hillclimb',
        sourceLayerId: d3LayerId,
        variant: v,
        visible: true,
        opacity: 1,
      }
      this.layers.push(layer)
      this.selectedLayerId = layer.id
      return layer
    },

    // Add an RWD Maps view (版面路網) — draws a Hill Climbing chain's 循環結果
    // layout (straightenCompactLoop) with strict H/V/45° polylines
    // (see skill route-rwd-draw).
    // compact = 要重繪的循環結果，抓循環的 4 個結果之一（'rect' 直角爬山循環 /
    // 'align' 軸對齊循環 / 'ilp' 整數規劃循環 / 'llm' LLM 對齊循環），對應
    // D3Tab 的 LOOP_KIND；舊圖層的 'hc'（基本循環）僅作 fallback。
    addRwdLayer(hcLayerId, compact = 'rect') {
      const src = this.layers.find((l) => l.id === hcLayerId)
      if (!src) return null
      let n = 1
      while (this.layers.some((l) => l.id === `rwd-view-${n}`)) n++
      const layer = {
        id: `rwd-view-${n}`,
        name: src.name,
        type: 'rwd',
        groupId: 'rwd',
        sourceLayerId: hcLayerId,
        compact,
        visible: true,
        opacity: 1,
      }
      this.layers.push(layer)
      this.selectedLayerId = layer.id
      return layer
    },

    // Drop a layer from the list and clear any state keyed to it. Callers are
    // responsible for closing its editor tab and freeing its loaded GeoJSON.
    removeLayer(id) {
      const i = this.layers.findIndex((l) => l.id === id)
      if (i === -1) return
      this.layers.splice(i, 1)
      delete this.selectedFeatures[id]
      delete this.ui.attributeTableOpen[id]
      if (this.selectedLayerId === id) {
        this.selectedLayerId = this.layers[0]?.id ?? null
      }
    },
  },
})
