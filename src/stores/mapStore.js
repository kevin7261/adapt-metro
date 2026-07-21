import { defineStore } from 'pinia'
import { assetUrl } from '../lib/assetUrl'
import { loadPersisted } from './persist'
import CITY_ZH from './cityNamesZh.json'
import { RWD_COMPACTS } from '../lib/rwdCompacts'
import {
  metroDisplayName, variantLabel, migrateLayerNames, backfillCityChains,
} from './layerMigrations'

let toastTimer = null

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

      // Which editor tabs are open at the top, in tab order (layer ids plus
      // fixed-panel ids like 'all-gallery'). Kept in sync with the live dockview
      // by EditorArea. `null` = never persisted (legacy session) → open every
      // layer on first load; an array (even empty) restores exactly that set.
      openTabIds: p?.openTabIds ?? null,
      // Id of the active tab to focus on reload (layer id or 'all-gallery').
      activeTabId: p?.activeTabId ?? null,

      // Properties of the last-clicked map feature, per layer id (null = nothing
      // selected). The map tab writes it on click; the Object tab reads it.
      selectedFeatures: {},

      // Flat list — every layer opens as its own editor tab.
      // Populated by the Raw Maps import modal (metro / railway / highway).
      // 舊 session 持久化的「基本」RWD 層（compact==='hc'）與已移除的自創鏈
      // （align/ilp——2026-07 改為只留與論文對應的 8 條＋LLM）一併清掉；
      // backfill 也不會補回。
      layers: backfillCityChains(migrateLayerNames(p?.layers ?? []))
        .filter((l) => !(l.type === 'rwd' && ['hc', 'align', 'ilp'].includes(l.compact))),

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
          || (RWD_COMPACTS.indexOf(a.compact ?? 'rect') - RWD_COMPACTS.indexOf(b.compact ?? 'rect')))
        const rows = []
        if (c.metro) rows.push({ kind: 'layer', layer: c.metro })
        if (c.d3) rows.push({ kind: 'layer', layer: c.d3 })
        // 子群組（Straighten 2 層／RWD Maps 18 層）預設收合——不設值＝collapsed
        // （避免剛匯入的城市把整組 18 層全攤開）。城市群組本身仍預設展開。
        if (c.hc.length) {
          const id = `${c.root.id}:straighten`
          rows.push({ kind: 'group', id, label: 'Straighten', collapsed: state.cityCollapsed[id] ?? true, layers: c.hc })
        }
        if (c.rwd.length) {
          const id = `${c.root.id}:rwd`
          rows.push({ kind: 'group', id, label: 'RWD Maps', collapsed: state.cityCollapsed[id] ?? true, layers: c.rwd })
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

    // 記錄「上面打開的 tab」——由 EditorArea 依 dockview 現況同步（持久化用）。
    setOpenTabs(ids) {
      this.openTabIds = ids
    },
    setActiveTab(id) {
      if (id) this.activeTabId = id
    },

    // 圈層城市群組／子群組收合（key = root layer id 或 `${root}:straighten|rwd`；
    // 持久化於 groupCollapsed）。子群組預設收合、城市群組預設展開，兩者預設不同，
    // 所以由呼叫端傳入「目前顯示的 collapsed 值」取反，才不會因不同預設而點一下沒反應。
    setCityCollapsed(id, collapsed) {
      this.cityCollapsed = { ...this.cityCollapsed, [id]: collapsed }
    },

    // 匯入一個城市＝整組管線圖層（圈層一城一群組）：Raw Maps ×1、Map Adjust
    // ×1、Straighten ×2（原始＋旋轉）、RWD Maps ×18（原始／旋轉 × 9 條鏈：
    // 論文①〜⑧＋LLM 對齊，見 RWD_COMPACTS；各掛在同變體的
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
    // compact = 要重繪的循環結果，抓 9 條鏈（論文①〜⑧＋'llm'，見 RWD_COMPACTS）
    // 的循環結果之一，對應
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
