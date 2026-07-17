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
  if (zh) return `${zh.city}・${zh.country}`
  // 圖層顯示名一定要中文（使用者規則）：合併系統（-jr／-lm）若漏建中文名，退回 base
  // 城市中文名＋後綴，**絕不**顯示英文 slug。（現行 234 系統皆有中文名，此為未來防呆。）
  const m = /^(.+)-(jr|lm)$/.exec(id)
  const b = m && CITY_ZH[m[1]]
  if (b) return `${b.city}${m[2] === 'lm' ? '＋地標' : '＋線'}・${b.country}`
  return id
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
  // 2026-07: the Railways / Highways groups were folded into Raw Maps (one
  // group, one import modal with 3 big tabs) — remap layers persisted under
  // the retired group ids.
  for (const l of layers) {
    if (l.groupId === 'railway-maps' || l.groupId === 'highway-maps') l.groupId = 'metro-maps'
  }
  // Backfill Chinese city/country on metro layers imported before this field.
  for (const l of layers) {
    if (l.type === 'metro' && CITY_ZH[l.id]) {
      l.countryZh ??= CITY_ZH[l.id].country
      l.cityZh ??= CITY_ZH[l.id].city
    }
  }
  const nameOf = (l) => {
    if (!l) return undefined
    // Railway/highway networks load as type 'metro' but their id (rw-/hw-…) is not
    // in cityNamesZh — keep the country/city name set at import (國名, e.g. 台灣),
    // never the raw slug.
    if (l.railway) return l.countryZh ?? l.name
    if (l.highway) return l.cityZh ?? l.countryZh ?? l.name
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

// 一城的標準 RWD 組：5 條循環鏈（基本 hc／直角爬山／軸對齊／整數規劃／LLM 對齊）。
const RWD_COMPACTS = ['hc', 'rect', 'align', 'ilp', 'llm']

// 2026-07 補齊變體：一城的標準組是 Straighten ×2（原始＋旋轉）＋ RWD ×10
// （原始／旋轉 × RWD_COMPACTS，各掛同變體 Straighten）。舊 session 只存了部分
// ——載入時回填缺的層（與 importCityChain 的 ensure 邏輯一致；沒建過 Map Adjust
// 的城市不強加）。Idempotent：齊了就什麼都不做。
function backfillCityChains(layers) {
  const nextId = (prefix) => {
    let n = 1
    while (layers.some((l) => l.id === `${prefix}-${n}`)) n++
    return `${prefix}-${n}`
  }
  for (const metro of [...layers]) {
    if (metro.type !== 'metro' || metro.railway || metro.highway) continue
    const d3 = layers.find((l) => l.type === 'd3' && l.sourceLayerId === metro.id)
    if (!d3) continue
    const hcOf = {}
    for (const v of ['orig', 'rot']) {
      let hc = layers.find((l) => l.type === 'hillclimb' && l.sourceLayerId === d3.id && l.variant === v)
      if (!hc) {
        hc = {
          id: nextId('hc-view'), name: `${d3.name}（${variantLabel(v)}）`, type: 'hillclimb',
          groupId: 'hillclimb', sourceLayerId: d3.id, variant: v, visible: true, opacity: 1,
        }
        layers.push(hc)
      }
      hcOf[v] = hc
    }
    for (const v of ['orig', 'rot']) for (const c of RWD_COMPACTS) {
      if (!layers.some((l) => l.type === 'rwd' && l.sourceLayerId === hcOf[v].id && l.compact === c)) {
        layers.push({
          id: nextId('rwd-view'), name: hcOf[v].name, type: 'rwd',
          groupId: 'rwd', sourceLayerId: hcOf[v].id, compact: c, visible: true, opacity: 1,
        })
      }
    }
  }
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
      // Populated by the Raw Maps import modal (metro / railway / highway).
      layers: backfillCityChains(migrateLayerNames(p?.layers ?? [])),

      // 2026-07 圈層改版：群組＝城市（由 layerTree 依來源鏈動態算出），這裡只存
      // 各城市群組的收合狀態（rootLayerId -> bool；沿用 groupCollapsed 持久化欄位）。
      cityCollapsed: p?.groupCollapsed ?? {},
    }
  },

  getters: {
    selectedLayer(state) {
      return state.layers.find((l) => l.id === state.selectedLayerId) ?? null
    },
    // Panel rows: one group per CITY (root raw-map layer). Each city's rows are
    // ordered Raw Maps → Map Adjust → [Straighten 子群組] → [RWD Maps 子群組]；
    // Straighten（原始/旋轉 2 層）與 RWD Maps（原始/旋轉 × 5 鏈＝10 層）收成可
    // 收合的子群組（子群組多、直接攤開太長）。每筆 row 是 { kind:'layer', layer }
    // 或 { kind:'group', id, label, collapsed, layers:[] }。A derived layer joins
    // its source chain's root; a broken chain (source removed) roots itself.
    layerTree(state) {
      const byId = new Map(state.layers.map((l) => [l.id, l]))
      const rootOf = (l) => {
        let cur = l
        const seen = new Set()
        while (cur.sourceLayerId && byId.has(cur.sourceLayerId) && !seen.has(cur.id)) {
          seen.add(cur.id)
          cur = byId.get(cur.sourceLayerId)
        }
        return cur
      }
      // 一個 rwd 層的變體＝其來源 Straighten 層的變體（orig/rot）。
      const rwdVariant = (rwd) => byId.get(rwd.sourceLayerId)?.variant ?? 'orig'
      const vRank = (v) => (v === 'rot' ? 1 : 0)

      const cities = new Map()
      for (const l of state.layers) {
        const root = rootOf(l)
        let c = cities.get(root.id)
        if (!c) { c = { root, metro: null, d3: null, hc: [], rwd: [] }; cities.set(root.id, c) }
        if (l.type === 'd3') c.d3 = l
        else if (l.type === 'hillclimb') c.hc.push(l)
        else if (l.type === 'rwd') c.rwd.push(l)
        else c.metro = l
      }

      const out = []
      for (const c of cities.values()) {
        c.hc.sort((a, b) => vRank(a.variant) - vRank(b.variant))
        c.rwd.sort((a, b) =>
          (vRank(rwdVariant(a)) - vRank(rwdVariant(b)))
          || (RWD_COMPACTS.indexOf(a.compact ?? 'hc') - RWD_COMPACTS.indexOf(b.compact ?? 'hc')))
        const rows = []
        if (c.metro) rows.push({ kind: 'layer', layer: c.metro })
        if (c.d3) rows.push({ kind: 'layer', layer: c.d3 })
        if (c.hc.length) {
          const id = `${c.root.id}:straighten`
          rows.push({ kind: 'group', id, label: 'Straighten', collapsed: !!state.cityCollapsed[id], layers: c.hc })
        }
        if (c.rwd.length) {
          const id = `${c.root.id}:rwd`
          rows.push({ kind: 'group', id, label: 'RWD Maps', collapsed: !!state.cityCollapsed[id], layers: c.rwd })
        }
        out.push({ group: { id: c.root.id, label: c.root.name, collapsed: !!state.cityCollapsed[c.root.id] }, rows })
      }
      return out
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

    // 圈層城市群組收合（key = root layer id；持久化於 groupCollapsed）。
    toggleCityCollapsed(rootId) {
      this.cityCollapsed = { ...this.cityCollapsed, [rootId]: !this.cityCollapsed[rootId] }
    },

    // 匯入一個城市＝整組管線圖層（圈層一城一群組）：Raw Maps ×1、Map Adjust
    // ×1、Straighten ×2（原始＋旋轉）、RWD Maps ×10（原始／旋轉 × 5 條鏈：基本
    // Hill Climbing 循環／直角爬山／軸對齊／整數規劃／LLM 對齊；各掛在同變體的
    // Straighten 上）。variant/compact 指定「要開啟」的 Straighten 與 RWD；已存
    // 在的層直接重用，只補缺的。回傳 { metro, d3, hc, rwd }（hc/rwd = variant/
    // compact 指定的那個）。
    importCityChain(sys, { variant = 'orig', compact = 'rect' } = {}) {
      const metro = this.importMetroSystem(sys)
      let d3 = this.layers.find((l) => l.type === 'd3' && l.sourceLayerId === metro.id)
      if (!d3) d3 = this.addD3Layer(metro.id)
      const ensureHc = (v) =>
        this.layers.find((l) => l.type === 'hillclimb' && l.sourceLayerId === d3.id && l.variant === v)
        ?? this.addHillClimbLayer(d3.id, v)
      const ensureRwd = (hcLayer, c) =>
        this.layers.find((l) => l.type === 'rwd' && l.sourceLayerId === hcLayer.id && l.compact === c)
        ?? this.addRwdLayer(hcLayer.id, c)
      const hcByVariant = { orig: ensureHc('orig'), rot: ensureHc('rot') }
      for (const v of ['orig', 'rot']) for (const c of RWD_COMPACTS) ensureRwd(hcByVariant[v], c)
      const hc = hcByVariant[variant] ?? hcByVariant.orig
      const rwd = ensureRwd(hc, compact)
      this.selectedLayerId = metro.id
      return { metro, d3, hc, rwd }
    },

    // metro / highway 匯入的共用本體：查同 id 舊層或建新層、選取、回傳。
    // extra = 兩者相異的欄位（id/name/groupId/file/城市中文名…）。
    _importSystem(sys, extra) {
      let layer = this.layers.find((l) => l.id === extra.id)
      if (!layer) {
        layer = {
          type: 'metro',
          continent: sys.continent,
          country: sys.country,
          visible: true,
          opacity: 1,
          strokeWidth: 2.5,
          radius: 4,
          symbology: 'categorized',
          lineCount: sys.line_count ?? 0,
          stationCount: sys.station_count ?? 0,
          featureCount: (sys.line_count ?? 0) + (sys.station_count ?? 0),
          ...extra,
        }
        this.layers.push(layer)
      }
      this.selectedLayerId = layer.id
      return layer
    },

    // sys = an entry of data/metro/index.json `systems`
    // (file, continent, country, city, line_count, station_count, …)
    importMetroSystem(sys) {
      // 'systems/asia/taiwan/asia-taiwan-taipei.geojson' → 'asia-taiwan-taipei'
      const id = sys.file.split('/').pop().replace(/\.geojson$/, '')
      return this._importSystem(sys, {
        id,
        // Display name = Chinese 國名－城市名 (falls back to the id).
        name: metroDisplayName(id),
        groupId: 'metro-maps',
        file: assetUrl(`data/metro/${sys.file}`),
        city: sys.city,
        countryZh: CITY_ZH[id]?.country ?? sys.country,
        cityZh: CITY_ZH[id]?.city ?? sys.city,
      })
    },

    // sys = an entry of data/highway/index.json `systems` (one per country).
    // Highway networks mirror the metro GeoJSON schema, so they load as type
    // 'metro' and reuse the same map/D3 renderers; the `highway` flag only
    // drives the row icon. Labels come from the catalog entry (city = country).
    importHighwaySystem(sys) {
      const slug = sys.file.split('/').pop().replace(/\.geojson$/, '')
      return this._importSystem(sys, {
        id: `hw-${slug}`,
        name: sys.cityZh ?? sys.city ?? sys.country ?? slug,
        highway: true,
        groupId: 'metro-maps',
        file: assetUrl(`data/highway/${sys.file}`),
        city: sys.city ?? sys.country,
        countryZh: sys.countryZh ?? sys.country,
        cityZh: sys.cityZh ?? sys.city ?? sys.country,
      })
    },

    // sys = an entry of data/railway/index.json `systems` (one per country).
    // National railway networks mirror the metro GeoJSON schema, so they load as
    // type 'metro' and reuse the same renderers; the `railway` flag only drives the
    // row icon. Labels come from the catalog entry (city = country).
    importRailwaySystem(sys) {
      const slug = sys.file.split('/').pop().replace(/\.geojson$/, '')
      return this._importSystem(sys, {
        id: `rw-${slug}`,
        name: sys.countryZh ?? sys.country ?? slug,
        railway: true,
        groupId: 'metro-maps',
        file: assetUrl(`data/railway/${sys.file}`),
        city: sys.city ?? sys.country,
        countryZh: sys.countryZh ?? sys.country,
        cityZh: sys.cityZh ?? sys.country,
      })
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
