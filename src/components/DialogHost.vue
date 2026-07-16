<script setup>
import { ref, computed, watch } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { loadMetroCatalog, continentZh, prettyContinent } from '../stores/metroCatalog'
import { loadHighwayCatalog } from '../stores/highwayCatalog'
import { loadRailwayCatalog } from '../stores/railwayCatalog'
import { openLayerTab } from '../stores/dockHandle'
import { layerData } from '../stores/layerData'
import MIcon from './MIcon.vue'

const store = useMapStore()

const dialog = computed(() => store.ui.dialog)
function close() { store.ui.dialog = null }

/* Import Metro Map */
const catalog = ref(null)       // systems from data/metro/index.json
const catalogError = ref(null)
const selContinent = ref('')
const selCountry = ref('')
const selCity = ref('')

const IMPORT_DIALOGS = ['import-metro', 'import-quick', 'import-stations']
// The three import methods are tabs of one modal (the dialog id = the active tab).
const importTabs = [
  { id: 'import-quick', label: '快速選擇' },
  { id: 'import-stations', label: '依車站數排序' },
  { id: 'import-metro', label: '全球地鐵地圖' },
]

// 匯入 dialog 需要 catalog；新增視圖 dialog 也要（cityParts 的中文名由 catalog 對應——
// 否則城市只顯示英文）。任一開啟且尚未載入就載。
const NEED_CATALOG = [...IMPORT_DIALOGS, 'add-d3', 'add-hillclimb', 'add-rwd']
watch(dialog, (d) => {
  if (!NEED_CATALOG.includes(d) || catalog.value) return
  catalogError.value = null
  loadMetroCatalog()
    .then((systems) => { catalog.value = systems })
    .catch((err) => { catalogError.value = String(err) })
})

// Browse columns keep the English value (for filtering) and show 中文 + English,
// sorted by the English name so the A→Z order is visible.
// Fixed continent order for both Quick Selection and the browse column:
// 亞洲 → 歐洲 → 北美洲 → 南美洲 → 非洲 → 大洋洲.
const CONTINENT_ORDER = ['asia', 'europe', 'north-america', 'south-america', 'africa', 'oceania']
const continentRank = (slug) => {
  const i = CONTINENT_ORDER.indexOf(slug)
  return i === -1 ? CONTINENT_ORDER.length : i
}
// miller browse 的洲別欄／國家欄（metro 與 highway 兩個匯入 modal 共用）。
const continentCols = (list) => [...new Set(list.map((s) => s.continent))]
  .sort((a, b) => continentRank(a) - continentRank(b))
  .map((value) => ({ value, zh: continentZh(value), en: prettyContinent(value) }))
const countryCols = (list, continent) => {
  const seen = new Map()
  for (const s of list) {
    if (s.continent === continent && !seen.has(s.country)) {
      seen.set(s.country, { value: s.country, zh: s.countryZh ?? s.country, en: s.country })
    }
  }
  return [...seen.values()].sort((a, b) => a.en.localeCompare(b.en))
}
// 快速選擇依洲別分組（metro 與 highway 共用；沒對到系統的排最後 zzz）。
const groupQuickByContinent = (list) => {
  const groups = new Map()
  for (const q of list) {
    const cont = q.sys?.continent ?? 'zzz'
    if (!groups.has(cont)) groups.set(cont, [])
    groups.get(cont).push(q)
  }
  return [...groups.entries()]
    .map(([continent, cities]) => ({ continent, label: continentZh(continent), cities }))
    .sort((a, b) => continentRank(a.continent) - continentRank(b.continent))
}
const continents = computed(() => (catalog.value ? continentCols(catalog.value) : []))
const countries = computed(() =>
  (catalog.value && selContinent.value ? countryCols(catalog.value, selContinent.value) : []))
const cities = computed(() => {
  if (!catalog.value || !selCountry.value) return []
  return catalog.value
    .filter((s) => s.continent === selContinent.value && s.country === selCountry.value)
    .map((s) => ({ value: s.city, zh: s.cityZh ?? s.city, en: s.city }))
    .sort((a, b) => a.en.localeCompare(b.en))
})
const selectedSystem = computed(() =>
  catalog.value?.find(
    (s) => s.continent === selContinent.value && s.country === selCountry.value && s.city === selCity.value,
  ) ?? null,
)

watch(selContinent, () => { selCountry.value = ''; selCity.value = '' })
watch(selCountry, () => { selCity.value = '' })

function importSystem(sys) {
  if (!sys) return
  const layer = store.importMetroSystem(sys)
  openLayerTab(layer)
  close()
  store.toast(`已匯入 ${sys.cityZh ?? sys.city} metro map（${sys.line_count} 條線 / ${sys.station_count} 站）`)
}

/* Import Highway Network — highway systems mirror the metro schema (see skill
   highway-osm-fetch). One tabbed modal, 3 tabs like the metro import (dialog id
   = active tab): 快速選擇 / 依交流道數排序 / 全球高速公路地圖. One file per country. */
const HIGHWAY_DIALOGS = ['import-highway-quick', 'import-highway-stations', 'import-highway-map']
const highwayTabs = [
  { id: 'import-highway-quick', label: '快速選擇' },
  { id: 'import-highway-stations', label: '依交流道數排序' },
  { id: 'import-highway-map', label: '全球高速公路地圖' },
]
const highwayCatalog = ref(null)
const highwayError = ref(null)
const highwaySort = ref('desc') // 'desc' 多到少 | 'asc' 少到多（依交流道數）
const hwContinent = ref('')     // 全球高速公路地圖 miller browse
watch(dialog, (d) => {
  if (!HIGHWAY_DIALOGS.includes(d) || highwayCatalog.value) return
  highwayError.value = null
  loadHighwayCatalog()
    .then((systems) => { highwayCatalog.value = systems })
    .catch((err) => { highwayError.value = String(err) })
})
const highwaysByStations = computed(() => {
  if (!highwayCatalog.value) return []
  const dir = highwaySort.value === 'asc' ? 1 : -1
  return [...highwayCatalog.value].sort((a, b) => (a.station_count - b.station_count) * dir)
})
// 中文＋English label for a system: metro-unit (big country) shows 城市·國家,
// country-unit (small country) shows just the country.
const hwZh = (s) => (s.unit === 'metro' ? `${s.cityZh} · ${s.countryZh}` : s.countryZh)
const hwEn = (s) => (s.unit === 'metro' ? `${s.city} · ${s.country}` : s.country)

// Quick pick — 目前資料範圍＝台灣三都會區（使用者 2026-07：只要台灣，國外不用）。
const QUICK_COUNTRIES = [
  { zh: '台北', en: 'Taipei' }, { zh: '台中', en: 'Taichung' }, { zh: '高雄', en: 'Kaohsiung' },
]
const hwQuick = computed(() => {
  if (!highwayCatalog.value) return []
  const cat = highwayCatalog.value
  return QUICK_COUNTRIES.map((q) => ({
    ...q,
    // match a metro area by city (zh or en); prefix fallback for New York City etc.
    sys: cat.find((s) => s.city === q.en || s.cityZh === q.zh)
      ?? cat.find((s) => (s.city || '').toLowerCase().startsWith(q.en.toLowerCase()))
      ?? null,
  }))
})
const hwQuickByContinent = computed(() => groupQuickByContinent(hwQuick.value))
// 全球高速公路地圖 — miller browse: 洲別 → 國家 (one file per country, no city column).
const hwContinents = computed(() => (highwayCatalog.value ? continentCols(highwayCatalog.value) : []))
// 3-column miller (洲別 → 國家 → 都會區), like the metro import — the unit is
// the metro area, so the country column drills into its cities.
const hwCountry = ref('')
watch(hwContinent, () => { hwCountry.value = '' })
const hwCountryList = computed(() =>
  (highwayCatalog.value && hwContinent.value ? countryCols(highwayCatalog.value, hwContinent.value) : []))
const hwCityList = computed(() => {
  if (!highwayCatalog.value || !hwCountry.value) return []
  return highwayCatalog.value
    .filter((s) => s.continent === hwContinent.value && s.country === hwCountry.value)
    .map((s) => ({ sys: s, zh: s.cityZh ?? s.city, en: s.city }))
    .sort((a, b) => a.en.localeCompare(b.en))
})
function importHighway(sys) {
  if (!sys) return
  const layer = store.importHighwaySystem(sys)
  openLayerTab(layer)
  close()
  store.toast(`已匯入 ${hwZh(sys)} 高速公路網（${sys.line_count} 條 / ${sys.station_count} 交流道）`)
}

/* Import National Railway — railway systems mirror the metro schema (see skill
   railway-osm-fetch). One tabbed modal, 3 tabs; ONE file per COUNTRY (含高鐵),
   national/state railway network (私鐵不算). */
const RAILWAY_DIALOGS = ['import-railway-quick', 'import-railway-stations', 'import-railway-map']
const railwayTabs = [
  { id: 'import-railway-quick', label: '快速選擇' },
  { id: 'import-railway-stations', label: '依車站數排序' },
  { id: 'import-railway-map', label: '全球鐵路地圖' },
]
const railwayCatalog = ref(null)
const railwayError = ref(null)
const railwaySort = ref('desc') // 'desc' 多到少 | 'asc' 少到多（依車站數）
const rwContinent = ref('')
watch(dialog, (d) => {
  if (!RAILWAY_DIALOGS.includes(d) || railwayCatalog.value) return
  railwayError.value = null
  loadRailwayCatalog()
    .then((systems) => { railwayCatalog.value = systems })
    .catch((err) => { railwayError.value = String(err) })
})
const railwaysByStations = computed(() => {
  if (!railwayCatalog.value) return []
  const dir = railwaySort.value === 'asc' ? 1 : -1
  return [...railwayCatalog.value].sort((a, b) => (a.station_count - b.station_count) * dir)
})
const rwZh = (s) => s.countryZh ?? s.country
const rwEn = (s) => s.labelEn ?? s.country
// Quick pick — the target countries (東亞四國先行 + 歐美主要國). Each country now has
// up to TWO systems (高鐵 / 一般國鐵); list every one as its own cell (一國拆兩圖層).
const QUICK_RAIL = ['Taiwan', 'Japan', 'China', 'South Korea', 'France', 'Germany',
  'United Kingdom', 'Italy', 'Spain', 'Switzerland', 'United States', 'Canada']
const rwQuick = computed(() => {
  if (!railwayCatalog.value) return []
  const out = []
  for (const name of QUICK_RAIL) {
    const syss = railwayCatalog.value
      .filter((s) => s.country === name)
      .sort((a, b) => (a.railClass === 'high_speed' ? 0 : 1) - (b.railClass === 'high_speed' ? 0 : 1))
    if (!syss.length) { out.push({ zh: name, en: name, sys: null }); continue }
    for (const sys of syss) out.push({ zh: sys.countryZh, en: sys.labelEn ?? sys.country, sys })
  }
  return out
})
const rwQuickByContinent = computed(() => groupQuickByContinent(rwQuick.value))
// 全球鐵路地圖 — miller browse: 洲別 → 國家 (one file per country, no city column).
const rwContinents = computed(() => (railwayCatalog.value ? continentCols(railwayCatalog.value) : []))
const rwCountryList = computed(() => {
  if (!railwayCatalog.value || !rwContinent.value) return []
  return railwayCatalog.value
    .filter((s) => s.continent === rwContinent.value)
    .map((s) => ({ sys: s, zh: s.countryZh ?? s.country, en: s.country }))
    .sort((a, b) => a.en.localeCompare(b.en))
})
function importRailway(sys) {
  if (!sys) return
  const layer = store.importRailwaySystem(sys)
  openLayerTab(layer)
  close()
  store.toast(`已匯入 ${rwZh(sys)} 國家鐵路網（${sys.line_count} 線 / ${sys.station_count} 站）`)
}

/* Add D3.js view — pick one of the loaded metro map layers as its source */
const metroLayerChoices = computed(() => store.layers.filter((l) => l.type === 'metro'))
function addD3View(src) {
  const d3Layer = store.addD3Layer(src.id)
  if (!d3Layer) return
  openLayerTab(d3Layer)
  close()
  store.toast(`已建立 D3.js 視圖（來源：${src.name}）`)
}

/* Add D3.js view — or import a GeoJSON file as its own data source */
const d3FileInput = ref(null)
async function onD3File(e) {
  const file = e.target.files?.[0]
  e.target.value = '' // allow re-picking the same file
  if (!file) return
  try {
    const data = JSON.parse(await file.text())
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
      throw new Error('不是有效的 GeoJSON FeatureCollection')
    }
    const name = file.name.replace(/\.(geo)?json$/i, '')
    const d3Layer = store.addD3LayerFromData(name, data)
    layerData[d3Layer.id] = data
    openLayerTab(d3Layer)
    close()
    store.toast(`已匯入 ${file.name} 為 D3.js 視圖`)
  } catch (err) {
    store.toast(`匯入失敗：${err.message}`)
  }
}

/* Add Hill Climbing view — pick a Map Adjust view's 格網化後 layout as input.
   每個城市（Map Adjust 圖層）有 2 個可選：原始格網化後 / 旋轉格網化後。 */
const d3LayerChoices = computed(() => store.layers.filter((l) => l.type === 'd3'))
const HC_VARIANTS = [
  { id: 'orig', label: '原始格網化後' },
  { id: 'rot', label: '旋轉格網化後' },
]
// Station/line counts shown per row: the d3 layer's own (file import) or its
// source metro layer's.
function d3Meta(l) {
  const src = l.sourceLayerId ? store.layers.find((s) => s.id === l.sourceLayerId) : l
  return src?.stationCount ? `${src.stationCount} 站 · ${src.lineCount} 線` : ''
}
// 城市中英文標籤——沿來源鏈追到 metro 圖層（d3→metro、hillclimb→d3→metro），中文由
// catalog（含 cityZh/countryZh）以城市名對應。回傳 { zh:'城市·國家', en:'City · Country' }。
function cityParts(l) {
  let cur = l
  const seen = new Set()
  while (cur && cur.type !== 'metro' && cur.sourceLayerId && !seen.has(cur.id)) {
    seen.add(cur.id)
    cur = store.layers.find((s) => s.id === cur.sourceLayerId)
  }
  const city = cur?.city ?? l.name
  const en = cur?.country ? `${city} · ${cur.country}` : city
  const cat = catalog.value?.find((s) => s.city === city)
  const zh = cat ? `${cat.cityZh ?? cat.city} · ${cat.countryZh ?? cat.country}` : ''
  return { zh, en }
}
function addHillClimbView(src, variant) {
  const hcLayer = store.addHillClimbLayer(src.id, variant)
  if (!hcLayer) return
  openLayerTab(hcLayer)
  close()
  const vLabel = HC_VARIANTS.find((v) => v.id === hcLayer.variant)?.label ?? ''
  store.toast(`已建立 Hill Climbing 視圖（來源：${src.name} ${vLabel}）`)
}

/* Add RWD Maps view — source = a Hill Climbing chain's 循環結果 layout
   (端點移動+直線縮減+中位集中+縮減網格循環, straightenCompactLoop),
   redrawn with strict H/V/45° polylines (版面路網畫線規則). */
const hcLayerChoices = computed(() => store.layers.filter((l) => l.type === 'hillclimb'))
// RWD 抓的是循環的 4 個結果（rect/align/ilp/llm 四條鏈的循環，對應 D3Tab 的
// LOOP_KIND）；舊圖層的 'hc'（基本循環）僅作 fallback、不再提供建立。
const RWD_VARIANTS = [
  { id: 'rect', label: '直角爬山循環' },
  { id: 'align', label: '軸對齊循環' },
  { id: 'ilp', label: '整數規劃循環' },
  { id: 'llm', label: 'LLM 對齊循環' },
]
function hcMeta(l) {
  const d3l = store.layers.find((s) => s.id === l.sourceLayerId)
  return d3l ? d3Meta(d3l) : ''
}
function addRwdView(src, compact = 'rect') {
  const rwdLayer = store.addRwdLayer(src.id, compact)
  if (!rwdLayer) return
  openLayerTab(rwdLayer)
  close()
  const vLabel = RWD_VARIANTS.find((v) => v.id === compact)?.label ?? compact
  store.toast(`已建立 RWD Maps 視圖（來源：${src.name} ${vLabel}）`)
}

/* Quick Selection — 常用城市 */
const QUICK_CITIES = [
  // 原城市順序不變；同城市的變體（＋山手／＋環狀／＋地標）緊接 base 放一起。
  { zh: '台北', en: 'Taipei' }, { zh: '台北＋地標', en: 'Taipei + Landmark' },
  { zh: '台中', en: 'Taichung' }, { zh: '高雄', en: 'Kaohsiung' },
  { zh: '東京', en: 'Tokyo' }, { zh: '東京＋山手', en: 'Tokyo + Yamanote' }, { zh: '東京＋地標', en: 'Tokyo + Landmark' },
  { zh: '大阪', en: 'Osaka' }, { zh: '大阪＋環狀', en: 'Osaka + Loop' },
  { zh: '首爾', en: 'Seoul' }, { zh: '首爾＋地標', en: 'Seoul + Landmark' },
  { zh: '北京', en: 'Beijing' },
  { zh: '上海', en: 'Shanghai' }, { zh: '上海＋地標', en: 'Shanghai + Landmark' },
  { zh: '香港', en: 'Hong Kong' }, { zh: '新加坡', en: 'Singapore' },
  { zh: '倫敦', en: 'London' }, { zh: '倫敦＋地標', en: 'London + Landmark' },
  { zh: '巴黎', en: 'Paris' }, { zh: '巴黎＋地標', en: 'Paris + Landmark' },
  { zh: '柏林', en: 'Berlin' }, { zh: '柏林＋地標', en: 'Berlin + Landmark' },
  { zh: '慕尼黑', en: 'Munich' },
  { zh: '維也納', en: 'Vienna' }, { zh: '維也納＋地標', en: 'Vienna + Landmark' },
  { zh: '紐約', en: 'New York' }, { zh: '紐約＋地標', en: 'New York City + Landmark' },
  { zh: '波士頓', en: 'Boston' },
  { zh: '雪梨', en: 'Sydney' }, { zh: '墨西哥城', en: 'Mexico City' },
  { zh: '舊金山', en: 'San Francisco' },
]
const quickCities = computed(() => {
  if (!catalog.value) return []
  return QUICK_CITIES.map((q) => ({
    ...q,
    // 精確比對優先，其次前綴容錯（index 的 "New York City" vs 顯示名 "New York"）
    sys: catalog.value.find((s) => s.city === q.en)
      ?? catalog.value.find((s) => (s.city || '').toLowerCase().startsWith(q.en.toLowerCase()))
      ?? null,
  }))
})
// 快選依洲別分組（洲別依中文名排序，各洲內維持原順序）。
const quickByContinent = computed(() => groupQuickByContinent(quickCities.value))

/* 依車站數排序 */
const stationSort = ref('desc') // 'desc' 多到少 | 'asc' 少到多
const byStations = computed(() => {
  if (!catalog.value) return []
  const dir = stationSort.value === 'asc' ? 1 : -1
  return [...catalog.value].sort((a, b) => (a.station_count - b.station_count) * dir)
})

/* Add Data */
const sources = [
  { id: 'vector', label: 'Vector Layer', icon: 'data_object' },
  { id: 'raster', label: 'Raster Layer', icon: 'terrain' },
  { id: 'xyz', label: 'XYZ Tiles', icon: 'grid_view' },
  { id: 'wms', label: 'WMS / WMTS', icon: 'dns' },
  { id: 'wfs', label: 'WFS', icon: 'dns' },
  { id: 'geoparquet', label: 'GeoParquet', icon: 'folder_zip' },
  { id: 'pmtiles', label: 'PMTiles', icon: 'stacks' },
]
const activeSource = ref('vector')

/* Settings */
const accents = ['blue', 'violet', 'emerald', 'rose', 'amber']
const accentColors = {
  blue: '#2563eb', violet: '#7c3aed', emerald: '#16a34a', rose: '#e11d48', amber: '#f97316',
}

const shortcuts = [
  ['⌘K', 'Command palette'],
  ['?', 'Keyboard shortcuts'],
  ['⌘N', 'New project'],
  ['⌘S', 'Save project'],
  ['⇧⌘S', 'Save project as…'],
  ['N', 'North up'],
  ['U', 'Top-down view'],
  ['R', 'Reset view'],
  ['+ / −', 'Zoom in / out'],
]
</script>

<template>
  <div v-if="dialog" class="dialog-overlay" @mousedown.self="close">
    <!-- Import Metro Map: one modal, three tabs (Quick / Sort / Global) -->
    <div v-if="IMPORT_DIALOGS.includes(dialog)" class="dialog import-modal">
      <div class="dialog-header">
        <h2 class="dialog-title">匯入地鐵地圖</h2>
        <button class="btn-icon" @click="close"><MIcon name="close" :size="15" /></button>
      </div>
      <div class="dialog-tabs" role="tablist">
        <button
          v-for="t in importTabs"
          :key="t.id"
          class="dialog-tab"
          :class="{ active: dialog === t.id }"
          role="tab"
          :aria-selected="dialog === t.id"
          @click="store.ui.dialog = t.id"
        >{{ t.label }}</button>
      </div>

      <div class="dialog-body" :class="{ 'stations-body': dialog === 'import-stations' || dialog === 'import-quick' }">
        <div v-if="catalogError" class="import-status error">載入城市清單失敗：{{ catalogError }}</div>
        <div v-else-if="!catalog" class="import-status">載入全球地鐵城市清單…</div>

        <template v-else>
          <!-- Quick Selection：依洲別分組，每組一排 3 個 -->
          <div v-if="dialog === 'import-quick'" class="quick-groups">
            <div v-for="g in quickByContinent" :key="g.continent" class="quick-group">
              <div class="quick-group-title">{{ g.label }}</div>
              <div class="quick-grid">
                <button
                  v-for="q in g.cities"
                  :key="q.en"
                  class="quick-cell"
                  :disabled="!q.sys"
                  :title="q.sys ? '' : '資料集中找不到此城市'"
                  @click="importSystem(q.sys)"
                >
                  <span class="quick-zh">{{ q.zh }}<template v-if="q.sys?.countryZh"> · {{ q.sys.countryZh }}</template></span>
                  <span class="quick-en">{{ q.en }}<template v-if="q.sys?.country"> · {{ q.sys.country }}</template></span>
                  <span class="quick-meta">{{ q.sys ? `${q.sys.station_count} 站 · ${q.sys.line_count} 線` : '—' }}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Sort by Station Count -->
          <template v-else-if="dialog === 'import-stations'">
            <div class="sort-bar">
              <div class="sort-toggle">
                <button class="sort-btn" :class="{ active: stationSort === 'desc' }" @click="stationSort = 'desc'">多到少</button>
                <button class="sort-btn" :class="{ active: stationSort === 'asc' }" @click="stationSort = 'asc'">少到多</button>
              </div>
              <span class="sort-meta">{{ byStations.length }} 個系統</span>
            </div>
            <div class="quick-grid">
              <button
                v-for="(s, i) in byStations"
                :key="s.file"
                class="quick-cell"
                @click="importSystem(s)"
              >
                <span class="quick-rank">#{{ i + 1 }}</span>
                <span class="quick-zh">{{ s.cityZh ?? s.city }} · {{ s.countryZh ?? s.country }}</span>
                <span class="quick-en">{{ s.city }} · {{ s.country }}</span>
                <span class="quick-meta">{{ s.station_count }} 站 · {{ s.line_count }} 線</span>
              </button>
            </div>
          </template>

          <!-- Global Metro Map -->
          <template v-else-if="dialog === 'import-metro'">
            <div class="miller">
              <div class="miller-col">
                <div class="miller-head">洲別</div>
                <div class="miller-list">
                  <button
                    v-for="c in continents"
                    :key="c.value"
                    class="miller-item"
                    :class="{ active: selContinent === c.value }"
                    @click="selContinent = c.value"
                  >{{ c.zh }} <span class="miller-en">{{ c.en }}</span></button>
                </div>
              </div>
              <div class="miller-col">
                <div class="miller-head">國家</div>
                <div class="miller-list">
                  <div v-if="!selContinent" class="miller-empty">← 先選洲別</div>
                  <button
                    v-for="c in countries"
                    :key="c.value"
                    class="miller-item"
                    :class="{ active: selCountry === c.value }"
                    @click="selCountry = c.value"
                  >{{ c.zh }} <span class="miller-en">{{ c.en }}</span></button>
                </div>
              </div>
              <div class="miller-col">
                <div class="miller-head">城市</div>
                <div class="miller-list">
                  <div v-if="!selCountry" class="miller-empty">← 先選國家</div>
                  <button
                    v-for="c in cities"
                    :key="c.value"
                    class="miller-item"
                    :class="{ active: selCity === c.value }"
                    @click="selCity = c.value"
                  >{{ c.zh }} <span class="miller-en">{{ c.en }}</span></button>
                </div>
              </div>
            </div>

            <div class="import-preview" :class="{ placeholder: !selectedSystem }">
              <MIcon name="train" :size="14" />
              <span v-if="selectedSystem">
                {{ selectedSystem.cityZh ?? selectedSystem.city }} — {{ selectedSystem.line_count }} 條線 ·
                {{ selectedSystem.station_count }} 站
                <template v-if="selectedSystem.operator">（{{ selectedSystem.operator }}）</template>
              </span>
              <span v-else>選擇一個城市以匯入其 metro map</span>
            </div>
          </template>
        </template>
      </div>

      <div v-if="dialog === 'import-metro'" class="dialog-footer">
        <button class="btn-outline" @click="close">取消</button>
        <button class="btn-primary" :disabled="!selectedSystem" @click="importSystem(selectedSystem)">確定</button>
      </div>
    </div>

    <!-- Import Highway Network: one tabbed modal, 3 tabs like the metro import -->
    <div v-else-if="HIGHWAY_DIALOGS.includes(dialog)" class="dialog import-modal">
      <div class="dialog-header">
        <h2 class="dialog-title">匯入高速公路網</h2>
        <button class="btn-icon" @click="close"><MIcon name="close" :size="15" /></button>
      </div>
      <div class="dialog-tabs" role="tablist">
        <button
          v-for="t in highwayTabs"
          :key="t.id"
          class="dialog-tab"
          :class="{ active: dialog === t.id }"
          role="tab"
          :aria-selected="dialog === t.id"
          @click="store.ui.dialog = t.id"
        >{{ t.label }}</button>
      </div>

      <div class="dialog-body" :class="{ 'stations-body': dialog === 'import-highway-stations' || dialog === 'import-highway-quick' }">
        <div v-if="highwayError" class="import-status error">載入高速公路清單失敗：{{ highwayError }}</div>
        <div v-else-if="!highwayCatalog" class="import-status">載入高速公路系統清單…</div>
        <div v-else-if="!highwayCatalog.length" class="import-status">
          尚無高速公路資料 — 先執行 <code>npm run highway:all</code>（或 <code>highway:fetch twn</code> 試抓一國）
        </div>

        <template v-else>
          <!-- 快速選擇：依洲別分組，每組一排 -->
          <div v-if="dialog === 'import-highway-quick'" class="quick-groups">
            <div v-for="g in hwQuickByContinent" :key="g.continent" class="quick-group">
              <div class="quick-group-title">{{ g.label }}</div>
              <div class="quick-grid">
                <button
                  v-for="q in g.cities"
                  :key="q.en"
                  class="quick-cell"
                  :disabled="!q.sys"
                  :title="q.sys ? '' : '資料集中還沒有此國家（先抓取）'"
                  @click="importHighway(q.sys)"
                >
                  <span class="quick-zh">{{ q.zh }}</span>
                  <span class="quick-en">{{ q.en }}</span>
                  <span class="quick-meta">{{ q.sys ? `${q.sys.station_count} 交流道 · ${q.sys.line_count} 條` : '—' }}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- 依交流道數排序 -->
          <template v-else-if="dialog === 'import-highway-stations'">
            <div class="sort-bar">
              <div class="sort-toggle">
                <button class="sort-btn" :class="{ active: highwaySort === 'desc' }" @click="highwaySort = 'desc'">交流道多到少</button>
                <button class="sort-btn" :class="{ active: highwaySort === 'asc' }" @click="highwaySort = 'asc'">少到多</button>
              </div>
              <span class="sort-meta">{{ highwaysByStations.length }} 個國家／地區</span>
            </div>
            <div class="quick-grid">
              <button
                v-for="(s, i) in highwaysByStations"
                :key="s.file"
                class="quick-cell"
                @click="importHighway(s)"
              >
                <span class="quick-rank">#{{ i + 1 }}</span>
                <span class="quick-zh">{{ hwZh(s) }}</span>
                <span class="quick-en">{{ hwEn(s) }}</span>
                <span class="quick-meta">{{ s.station_count }} 交流道 · {{ s.line_count }} 條</span>
              </button>
            </div>
          </template>

          <!-- 全球高速公路地圖：洲別 → 國家 → 都會區 -->
          <template v-else-if="dialog === 'import-highway-map'">
            <div class="miller">
              <div class="miller-col">
                <div class="miller-head">洲別</div>
                <div class="miller-list">
                  <button
                    v-for="c in hwContinents"
                    :key="c.value"
                    class="miller-item"
                    :class="{ active: hwContinent === c.value }"
                    @click="hwContinent = c.value"
                  >{{ c.zh }} <span class="miller-en">{{ c.en }}</span></button>
                </div>
              </div>
              <div class="miller-col">
                <div class="miller-head">國家</div>
                <div class="miller-list">
                  <div v-if="!hwContinent" class="miller-empty">← 先選洲別</div>
                  <button
                    v-for="c in hwCountryList"
                    :key="c.value"
                    class="miller-item"
                    :class="{ active: hwCountry === c.value }"
                    @click="hwCountry = c.value"
                  >{{ c.zh }} <span class="miller-en">{{ c.en }}</span></button>
                </div>
              </div>
              <div class="miller-col">
                <div class="miller-head">都會區</div>
                <div class="miller-list">
                  <div v-if="!hwCountry" class="miller-empty">← 先選國家</div>
                  <button
                    v-for="c in hwCityList"
                    :key="c.sys.file"
                    class="miller-item"
                    @click="importHighway(c.sys)"
                  >{{ c.zh }} <span class="miller-en">{{ c.en }}</span>
                    <span class="miller-meta">{{ c.sys.station_count }} 交流道</span></button>
                </div>
              </div>
            </div>
          </template>
        </template>
      </div>
    </div>

    <!-- Import National Railway: one tabbed modal, 3 tabs (one file per country) -->
    <div v-else-if="RAILWAY_DIALOGS.includes(dialog)" class="dialog import-modal">
      <div class="dialog-header">
        <h2 class="dialog-title">匯入國家鐵路網</h2>
        <button class="btn-icon" @click="close"><MIcon name="close" :size="15" /></button>
      </div>
      <div class="dialog-tabs" role="tablist">
        <button
          v-for="t in railwayTabs"
          :key="t.id"
          class="dialog-tab"
          :class="{ active: dialog === t.id }"
          role="tab"
          :aria-selected="dialog === t.id"
          @click="store.ui.dialog = t.id"
        >{{ t.label }}</button>
      </div>

      <div class="dialog-body" :class="{ 'stations-body': dialog === 'import-railway-stations' || dialog === 'import-railway-quick' }">
        <div v-if="railwayError" class="import-status error">載入鐵路清單失敗：{{ railwayError }}</div>
        <div v-else-if="!railwayCatalog" class="import-status">載入國家鐵路系統清單…</div>
        <div v-else-if="!railwayCatalog.length" class="import-status">
          尚無鐵路資料 — 先執行 <code>npm run railway:all</code>（或 <code>railway:fetch twn</code> 試抓一國）
        </div>

        <template v-else>
          <!-- 快速選擇：依洲別分組，每組一排 -->
          <div v-if="dialog === 'import-railway-quick'" class="quick-groups">
            <div v-for="g in rwQuickByContinent" :key="g.continent" class="quick-group">
              <div class="quick-group-title">{{ g.label }}</div>
              <div class="quick-grid">
                <button
                  v-for="q in g.cities"
                  :key="q.en"
                  class="quick-cell"
                  :disabled="!q.sys"
                  :title="q.sys ? '' : '資料集中還沒有此國家（先抓取）'"
                  @click="importRailway(q.sys)"
                >
                  <span class="quick-zh">{{ q.zh }}</span>
                  <span class="quick-en">{{ q.en }}</span>
                  <span class="quick-meta">{{ q.sys ? `${q.sys.station_count} 站 · ${q.sys.line_count} 線` : '—' }}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- 依車站數排序 -->
          <template v-else-if="dialog === 'import-railway-stations'">
            <div class="sort-bar">
              <div class="sort-toggle">
                <button class="sort-btn" :class="{ active: railwaySort === 'desc' }" @click="railwaySort = 'desc'">車站多到少</button>
                <button class="sort-btn" :class="{ active: railwaySort === 'asc' }" @click="railwaySort = 'asc'">少到多</button>
              </div>
              <span class="sort-meta">{{ railwaysByStations.length }} 個系統（高鐵／一般國鐵分開）</span>
            </div>
            <div class="quick-grid">
              <button
                v-for="(s, i) in railwaysByStations"
                :key="s.file"
                class="quick-cell"
                @click="importRailway(s)"
              >
                <span class="quick-rank">#{{ i + 1 }}</span>
                <span class="quick-zh">{{ rwZh(s) }}</span>
                <span class="quick-en">{{ rwEn(s) }}</span>
                <span class="quick-meta">{{ s.station_count }} 站 · {{ s.line_count }} 線</span>
              </button>
            </div>
          </template>

          <!-- 全球鐵路地圖：洲別 → 國家 -->
          <template v-else-if="dialog === 'import-railway-map'">
            <div class="miller">
              <div class="miller-col">
                <div class="miller-head">洲別</div>
                <div class="miller-list">
                  <button
                    v-for="c in rwContinents"
                    :key="c.value"
                    class="miller-item"
                    :class="{ active: rwContinent === c.value }"
                    @click="rwContinent = c.value"
                  >{{ c.zh }} <span class="miller-en">{{ c.en }}</span></button>
                </div>
              </div>
              <div class="miller-col">
                <div class="miller-head">國家</div>
                <div class="miller-list">
                  <div v-if="!rwContinent" class="miller-empty">← 先選洲別</div>
                  <button
                    v-for="c in rwCountryList"
                    :key="c.sys.file"
                    class="miller-item"
                    @click="importRailway(c.sys)"
                  >{{ c.zh }} <span class="miller-en">{{ c.en }}</span>
                    <span class="miller-meta">{{ c.sys.station_count }} 站</span></button>
                </div>
              </div>
            </div>
          </template>
        </template>
      </div>
    </div>

    <!-- Add D3.js view: pick a loaded metro map layer (fixed once chosen) -->
    <div v-else-if="dialog === 'add-d3'" class="dialog add-d3">
      <div class="dialog-header">
        <h2 class="dialog-title">新增 Map Adjust 視圖</h2>
        <button class="btn-icon" @click="close"><MIcon name="close" :size="15" /></button>
      </div>
      <div class="dialog-body">
        <div v-if="!metroLayerChoices.length" class="import-status">
          Metro Maps group 還沒有圖層 — 先用 + 匯入一個 metro map，或直接匯入 GeoJSON 檔案
        </div>
        <template v-else>
          <p class="add-d3-hint">選擇一個 metro map 圖層作為 D3.js 視圖的資料來源（建立後不可更改）：</p>
          <div class="hc-city-list">
            <div v-for="l in metroLayerChoices" :key="l.id" class="hc-city-row">
              <div class="hc-city-name">
                <span class="hc-city-zh">{{ cityParts(l).zh || cityParts(l).en }}</span>
                <span v-if="cityParts(l).zh" class="hc-city-en">{{ cityParts(l).en }}</span>
              </div>
              <span class="hc-city-meta">{{ l.stationCount }} 站 · {{ l.lineCount }} 線</span>
              <button class="hc-variant-btn" @click="addD3View(l)">建立</button>
            </div>
          </div>
        </template>

        <div class="menu-sep" />
        <button class="station-row d3-file-row" @click="d3FileInput?.click()">
          <MIcon name="upload" :size="14" />
          <span class="station-city">匯入 GeoJSON 檔案…</span>
          <span class="station-count">.geojson / .json</span>
        </button>
        <input
          ref="d3FileInput"
          type="file"
          accept=".geojson,.json,application/geo+json,application/json"
          hidden
          @change="onD3File"
        />
      </div>
    </div>

    <!-- Add Hill Climbing view: pick a Map Adjust layer's 格網化後 variant (2 per city) -->
    <div v-else-if="dialog === 'add-hillclimb'" class="dialog add-d3">
      <div class="dialog-header">
        <h2 class="dialog-title">新增 Straighten 視圖</h2>
        <button class="btn-icon" @click="close"><MIcon name="close" :size="15" /></button>
      </div>
      <div class="dialog-body">
        <div v-if="!d3LayerChoices.length" class="import-status">
          Map Adjust group 還沒有圖層 — 先在 Map Adjust 用 + 新增一個 D3.js 視圖
        </div>
        <template v-else>
          <p class="add-d3-hint">
            選擇 Map Adjust 視圖的「格網化後」佈局作為爬山法最佳化的輸入
            （每個城市 2 個：原始／旋轉，建立後不可更改）：
          </p>
          <!-- 同一城市同一排：城市名 + 原始/旋轉兩個變體並排 -->
          <div class="hc-city-list">
            <div v-for="l in d3LayerChoices" :key="l.id" class="hc-city-row">
              <div class="hc-city-name">
                <span class="hc-city-zh">{{ cityParts(l).zh || cityParts(l).en }}</span>
                <span v-if="cityParts(l).zh" class="hc-city-en">{{ cityParts(l).en }}</span>
              </div>
              <span class="hc-city-meta">{{ d3Meta(l) }}</span>
              <button
                v-for="v in HC_VARIANTS"
                :key="`${l.id}-${v.id}`"
                class="hc-variant-btn"
                @click="addHillClimbView(l, v.id)"
              >{{ v.label }}</button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Add RWD Maps view: pick a Hill Climbing layer + one of the 4 循環結果 as input -->
    <div v-else-if="dialog === 'add-rwd'" class="dialog add-d3">
      <div class="dialog-header">
        <h2 class="dialog-title">新增 RWD Maps 視圖</h2>
        <button class="btn-icon" @click="close"><MIcon name="close" :size="15" /></button>
      </div>
      <div class="dialog-body">
        <div v-if="!hcLayerChoices.length" class="import-status">
          Hill Climbing group 還沒有圖層 — 先在 Hill Climbing 用 + 建立一個視圖
        </div>
        <template v-else>
          <p class="add-d3-hint">
            選擇 Hill Climbing 視圖與循環結果（端點移動+直線縮減+中位集中+縮減網格循環
            的 4 條鏈）——該佈局將以 H/V/45° 折線重繪（版面路網畫線規則，建立後不可更改）：
          </p>
          <div class="hc-city-list">
            <div v-for="l in hcLayerChoices" :key="l.id" class="hc-city-row">
              <div class="hc-city-name">
                <span class="hc-city-zh">{{ cityParts(l).zh || cityParts(l).en }}</span>
                <span v-if="cityParts(l).zh" class="hc-city-en">{{ cityParts(l).en }}</span>
              </div>
              <span class="hc-city-meta">{{ hcMeta(l) }}</span>
              <button
                v-for="v in RWD_VARIANTS"
                :key="`${l.id}-${v.id}`"
                class="hc-variant-btn"
                @click="addRwdView(l, v.id)"
              >{{ v.label }}</button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Add Data -->
    <div v-else-if="dialog === 'add-data'" class="dialog add-data">
      <div class="dialog-header">
        <h2 class="dialog-title">新增資料</h2>
        <button class="btn-icon" @click="close"><MIcon name="close" :size="15" /></button>
      </div>
      <div class="add-data-body">
        <nav class="source-list">
          <button
            v-for="s in sources"
            :key="s.id"
            class="menu-item"
            :class="{ open: activeSource === s.id }"
            @click="activeSource = s.id"
          >
            <MIcon :name="s.icon" :size="14" /> {{ s.label }}
          </button>
        </nav>
        <div class="source-form">
          <div class="drop-zone">
            <MIcon name="upload" :size="20" />
            <p>Drag &amp; drop a file here<br /><span class="muted">GeoJSON, Shapefile, GeoPackage, FlatGeobuf, KML, GPX…</span></p>
            <button class="btn-outline" @click="store.fake('Browse file')">Browse…</button>
          </div>
          <label class="field-label" style="margin-top: 14px">Or load from URL</label>
          <input class="input" placeholder="https://example.com/data.geojson" />
          <label class="field-label" style="margin-top: 12px">Layer name</label>
          <input class="input" placeholder="new_layer" />
        </div>
      </div>
      <div class="dialog-footer">
        <button class="btn-outline" @click="close">Cancel</button>
        <button class="btn-primary" @click="store.fake('Add layer'); close()">Add</button>
      </div>
    </div>

    <!-- New project -->
    <div v-else-if="dialog === 'new-project'" class="dialog">
      <div class="dialog-header">
        <h2 class="dialog-title">新增專案</h2>
        <button class="btn-icon" @click="close"><MIcon name="close" :size="15" /></button>
      </div>
      <div class="dialog-body">
        <p>Start a new project? Unsaved changes to the current project will be lost.</p>
      </div>
      <div class="dialog-footer">
        <button class="btn-outline" @click="close">Cancel</button>
        <button class="btn-primary" @click="store.fake('New project'); close()">Create</button>
      </div>
    </div>

    <!-- Settings -->
    <div v-else-if="dialog === 'settings'" class="dialog">
      <div class="dialog-header">
        <h2 class="dialog-title">設定</h2>
        <button class="btn-icon" @click="close"><MIcon name="close" :size="15" /></button>
      </div>
      <div class="dialog-body">
        <div class="settings-section">Appearance</div>
        <div class="settings-row">
          <span>Theme</span>
          <select class="select settings-select" :value="store.dark ? 'dark' : 'light'"
            @change="store.dark = $event.target.value === 'dark'">
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
        <div class="settings-row">
          <span>Accent color</span>
          <div class="swatches">
            <button
              v-for="a in accents"
              :key="a"
              class="swatch"
              :class="{ active: store.accent === a }"
              :style="{ background: accentColors[a] }"
              :title="a"
              @click="store.accent = a"
            />
          </div>
        </div>
        <div class="settings-section">Layout</div>
        <label class="settings-row check">
          <span>Layers panel</span>
          <input v-model="store.ui.layerPanelOpen" type="checkbox" />
        </label>
        <label class="settings-row check">
          <span>Attribute table（作用中圖層）</span>
          <input
            type="checkbox"
            :checked="!!store.ui.attributeTableOpen[store.selectedLayerId]"
            @change="store.toggleAttributeTable(store.selectedLayerId)"
          />
        </label>
      </div>
      <div class="dialog-footer">
        <button class="btn-primary" @click="close">Done</button>
      </div>
    </div>

    <!-- Keyboard shortcuts -->
    <div v-else-if="dialog === 'shortcuts'" class="dialog">
      <div class="dialog-header">
        <h2 class="dialog-title">鍵盤快捷鍵</h2>
        <button class="btn-icon" @click="close"><MIcon name="close" :size="15" /></button>
      </div>
      <div class="dialog-body">
        <div v-for="[key, label] in shortcuts" :key="key" class="shortcut-row">
          <span>{{ label }}</span>
          <kbd>{{ key }}</kbd>
        </div>
      </div>
    </div>

    <!-- About -->
    <div v-else-if="dialog === 'about'" class="dialog about">
      <div class="dialog-header">
        <h2 class="dialog-title">關於</h2>
        <button class="btn-icon" @click="close"><MIcon name="close" :size="15" /></button>
      </div>
      <div class="dialog-body about-body">
        <MIcon name="map" :size="40" class="about-logo" />
        <h3>Adapt-Metro</h3>
        <p class="muted">UI prototype v0.1.0 — layout inspired by GeoLibre</p>
        <p class="muted">Vue 3 · Vite · MapLibre GL JS</p>
        <div class="about-links">
          <button class="btn-outline" @click="store.fake('Website')"><MIcon name="language" :size="13" /> Website</button>
          <button class="btn-outline" @click="store.fake('GitHub')"><MIcon name="code" :size="13" /> GitHub</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Import Metro Map: one tabbed modal. Fixed width so switching tabs (grid /
   list / miller columns) doesn't resize the dialog. */
.import-modal { width: min(960px, calc(100vw - 32px)); }
.dialog-tabs {
  display: flex;
  gap: 2px;
  padding: 0 16px;
  border-bottom: 1px solid hsl(var(--border));
}
.dialog-tab {
  padding: 8px 12px;
  font-size: 13px;
  color: hsl(var(--muted-foreground));
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  white-space: nowrap;
}
.dialog-tab:hover { color: hsl(var(--foreground)); }
.dialog-tab.active {
  color: hsl(var(--primary));
  font-weight: 600;
  border-bottom-color: hsl(var(--primary));
}
.add-d3 { width: min(820px, calc(100vw - 32px)); }
/* Add Straighten：同一城市一排，原始/旋轉兩個變體並排 */
.hc-city-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 52vh;
  overflow-y: auto;
  padding: 2px;
}
.hc-city-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
}
/* 城市名中英文分兩排 */
.hc-city-name { display: flex; flex-direction: column; gap: 1px; }
.hc-city-zh { font-weight: 600; font-size: 13px; white-space: nowrap; }
.hc-city-en { font-size: 11px; color: hsl(var(--muted-foreground)); white-space: nowrap; }
.hc-city-meta { font-size: 11px; color: hsl(var(--muted-foreground)); margin-right: auto; white-space: nowrap; }
.hc-variant-btn {
  padding: 5px 12px;
  font-size: 12px;
  border: 1px solid hsl(var(--primary) / 0.5);
  border-radius: calc(var(--radius) - 2px);
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.1);
  white-space: nowrap;
}
.hc-variant-btn:hover { background: hsl(var(--primary) / 0.2); }
.add-d3-hint { font-size: 12.5px; color: hsl(var(--muted-foreground)); margin: 0 0 10px; }
.d3-file-row { width: 100%; margin-top: 8px; color: hsl(var(--primary)); }

/* 依車站數排序 */
.stations-body { display: flex; flex-direction: column; min-height: 0; }
.sort-bar { display: flex; align-items: center; margin-bottom: 10px; flex-shrink: 0; }
/* segmented group button：與 gallery 一致——多到少／少到多 併成一組 */
.sort-toggle {
  display: inline-flex;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 3px);
  overflow: hidden;
}
.sort-btn {
  padding: 3px 12px;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
  border-right: 1px solid hsl(var(--border));
}
.sort-btn:last-child { border-right: none; }
.sort-btn.active { background: hsl(var(--primary) / 0.12); color: hsl(var(--primary)); }
.sort-meta { margin-left: auto; font-size: 11.5px; color: hsl(var(--muted-foreground)); }
/* Quick Selection：依洲別分組，各組九宮格一排 5 個 */
.quick-groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 56vh;
  overflow-y: auto;
  padding: 2px;
}
.quick-group-title {
  font-size: 12px;
  font-weight: 700;
  color: hsl(var(--primary));
  padding: 2px 2px 6px;
  border-bottom: 1px solid hsl(var(--border));
  margin-bottom: 8px;
}
.quick-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
@media (max-width: 640px) { .quick-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.quick-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 12px 6px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--muted) / 0.25);
  text-align: center;
  transition: border-color 0.12s, background 0.12s, transform 0.1s;
}
.quick-cell:hover:not(:disabled) {
  border-color: hsl(var(--primary) / 0.6);
  background: hsl(var(--primary) / 0.08);
  transform: translateY(-1px);
}
.quick-cell:disabled { opacity: 0.4; cursor: default; }
.quick-rank { font-size: 10.5px; font-weight: 700; color: hsl(var(--primary)); }
.quick-zh { font-size: 14px; font-weight: 600; white-space: nowrap; }
.quick-en { font-size: 11px; color: hsl(var(--muted-foreground)); white-space: nowrap; }
.quick-meta { font-size: 10.5px; color: hsl(var(--muted-foreground) / 0.85); margin-top: 2px; }
.station-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  width: 100%;
  padding: 5px 8px;
  border-radius: calc(var(--radius) - 4px);
  font-size: 12.5px;
  text-align: left;
}
.station-row:hover:not(:disabled) { background: hsl(var(--accent) / 0.6); }
.station-row:disabled { opacity: 0.4; cursor: default; }
.station-city { font-weight: 500; white-space: nowrap; }
.station-count {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
  font-variant-numeric: tabular-nums;
}
.import-status {
  padding: 18px 0;
  text-align: center;
  color: hsl(var(--muted-foreground));
  font-size: 13px;
}
.import-status.error { color: hsl(var(--destructive)); }

/* 洲別 | 國家 | 城市 — three side-by-side list columns */
.miller {
  display: flex;
  height: 300px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  overflow: hidden;
}
.miller-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.miller-col + .miller-col { border-left: 1px solid hsl(var(--border)); }
.miller-head {
  padding: 7px 10px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: hsl(var(--muted-foreground));
  background: hsl(var(--muted) / 0.4);
  border-bottom: 1px solid hsl(var(--border));
  flex-shrink: 0;
}
.miller-list { flex: 1; overflow-y: auto; padding: 4px; }
.miller-item {
  display: block;
  width: 100%;
  padding: 5px 8px;
  border-radius: calc(var(--radius) - 4px);
  font-size: 12.5px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.miller-item .miller-en { color: hsl(var(--muted-foreground)); font-size: 11px; }
.miller-item .miller-meta { float: right; color: hsl(var(--muted-foreground)); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.miller-item.active .miller-en { color: hsl(var(--primary) / 0.7); }
.miller-item:hover { background: hsl(var(--accent) / 0.6); }
.miller-item.active {
  background: hsl(var(--primary) / 0.14);
  color: hsl(var(--primary));
  font-weight: 500;
}
.miller-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
  text-align: center;
}

.import-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--muted) / 0.4);
  font-size: 12.5px;
  color: hsl(var(--foreground));
}
.import-preview.placeholder { color: hsl(var(--muted-foreground)); }
.btn-primary:disabled { opacity: 0.5; cursor: default; }

.add-data { width: min(680px, calc(100vw - 32px)); }
.add-data-body {
  display: flex;
  min-height: 300px;
  border-top: 1px solid hsl(var(--border));
}
.source-list {
  width: 180px;
  flex-shrink: 0;
  border-right: 1px solid hsl(var(--border));
  padding: 8px;
  overflow-y: auto;
}
.source-form { flex: 1; padding: 16px; }
.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  border: 1.5px dashed hsl(var(--border));
  border-radius: var(--radius);
  padding: 22px;
  text-align: center;
  font-size: 13px;
  color: hsl(var(--foreground));
}
.drop-zone:hover { border-color: hsl(var(--primary)); }
.muted { color: hsl(var(--muted-foreground)); font-size: 12px; }

.settings-section {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: hsl(var(--muted-foreground));
  margin: 14px 0 6px;
}
.settings-section:first-child { margin-top: 0; }
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 13px;
}
.settings-row.check { cursor: pointer; }
.settings-select { width: 220px; }
.swatches { display: flex; gap: 8px; }
.swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
}
.swatch.active {
  border-color: hsl(var(--foreground));
  box-shadow: 0 0 0 2px hsl(var(--background)) inset;
}

.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 0;
  border-bottom: 1px solid hsl(var(--border) / 0.6);
  font-size: 13px;
}
.shortcut-row:last-child { border-bottom: none; }
kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: 4px;
  padding: 2px 7px;
  background: hsl(var(--muted) / 0.5);
}

.about-body { text-align: center; padding-bottom: 24px; }
.about-body h3 { margin: 10px 0 4px; }
.about-body p { margin: 2px 0; }
.about-logo { color: hsl(var(--primary)); }
.about-links {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 14px;
}
</style>
