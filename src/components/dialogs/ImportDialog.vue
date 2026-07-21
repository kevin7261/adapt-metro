<script setup>
import { ref, computed, watch } from 'vue'
import { useMapStore } from '../../stores/mapStore'
import {
  continentCols, countryCols, groupQuickByContinent, continentRank,
} from '../../stores/metroCatalog'
import { loadHighwayCatalog } from '../../stores/highwayCatalog'
import { loadRailwayCatalog } from '../../stores/railwayCatalog'
import { openLayerTab } from '../../stores/dockHandle'
import { QUICK_CITIES, matchQuickSystem } from '../../lib/quickCities'
import { IMPORT_DIALOGS, useDialogCatalog } from './useDialogCatalog'
import CityIndexList from '../CityIndexList.vue'
import MIcon from '../MIcon.vue'

const props = defineProps({
  dialog: { type: String, required: true },
})
const emit = defineEmits(['close'])

const store = useMapStore()
const { catalog, catalogError } = useDialogCatalog()

const selContinent = ref('')
const selCountry = ref('')
const selCity = ref('')

// The three import methods are tabs of one modal (the dialog id = the active tab).
const importTabs = [
  { id: 'import-quick', label: '快速選擇' },
  { id: 'import-stations', label: '依車站數排序' },
  { id: 'import-metro', label: '全球地鐵地圖' },
]

// Browse columns keep the English value (for filtering) and show 中文 + English,
// sorted by the English name so the A→Z order is visible. Continent order /
// miller helpers live in metroCatalog.js（metro／highway／railway 共用）。
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
  // 匯入一城＝整組管線圖層（圈層一城一群組：Raw / Map Adjust / Straighten / RWD）
  const { metro } = store.importCityChain(sys)
  openLayerTab(metro)
  emit('close')
  store.toast(`已匯入 ${sys.cityZh ?? sys.city} 整組圖層（${sys.line_count} 條線 / ${sys.station_count} 站）`)
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
watch(() => props.dialog, (d) => {
  if (!HIGHWAY_DIALOGS.includes(d) || highwayCatalog.value) return
  highwayError.value = null
  loadHighwayCatalog()
    .then((systems) => { highwayCatalog.value = systems })
    .catch((err) => { highwayError.value = String(err) })
}, { immediate: true })
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
  emit('close')
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
watch(() => props.dialog, (d) => {
  if (!RAILWAY_DIALOGS.includes(d) || railwayCatalog.value) return
  railwayError.value = null
  loadRailwayCatalog()
    .then((systems) => { railwayCatalog.value = systems })
    .catch((err) => { railwayError.value = String(err) })
}, { immediate: true })
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
    // hsr row first — but only within the same company (日本拆六社: keep each JR
    // company's 高鐵/一般國鐵 rows adjacent instead of all-hsr-then-all-rail).
    const hsrRank = (s) => (s.railClass === 'high_speed' ? 0 : 1)
    const syss = railwayCatalog.value
      .filter((s) => s.country === name)
      .sort((a, b) => ((a.company ?? '') === (b.company ?? '') ? hsrRank(a) - hsrRank(b) : 0))
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
  emit('close')
  store.toast(`已匯入 ${rwZh(sys)} 國家鐵路網（${sys.line_count} 線 / ${sys.station_count} 站）`)
}

/* 三個匯入來源同一個 modal，但入口是圈層上方的三顆按鈕（城市／鐵路／高速
   公路）——modal 不再分上層大 tab，標題跟著來源變；每個來源保留原本的子 tab
   （dialog id 仍＝作用中的子 tab）。 */
const IMPORT_GROUPS = [
  { id: 'metro', label: '選擇地鐵', dialogs: IMPORT_DIALOGS, tabs: importTabs },
  { id: 'railway', label: '選擇鐵路', dialogs: RAILWAY_DIALOGS, tabs: railwayTabs },
  { id: 'highway', label: '選擇高速公路', dialogs: HIGHWAY_DIALOGS, tabs: highwayTabs },
]
const activeImportGroup = computed(() => IMPORT_GROUPS.find((g) => g.dialogs.includes(props.dialog)))

/* Quick Selection — 常用城市（清單見 lib/quickCities，與視圖畫廊共用同一份） */
const quickCities = computed(() => {
  if (!catalog.value) return []
  return QUICK_CITIES.map((q) => ({ ...q, sys: matchQuickSystem(catalog.value, q.en) }))
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

/* ---- 共用「城市索引清單」（CityIndexList）的 items 與標籤／metric ----
   使用者：加入 modal 的「快速選擇」「依車站數」要跟視圖畫廊右側 list 一樣。
   快速選擇＝洲別→國家→城市可收合分組；依數量＝平面清單＋頂端 sort icon。 */
// 地鐵快選：與視圖畫廊完全同一份（QUICK_CITIES→系統，依洲別 stable 排序使同洲相鄰）。
const metroQuickItems = computed(() =>
  QUICK_CITIES.map((q) => matchQuickSystem(catalog.value ?? [], q.en)).filter(Boolean)
    .sort((a, b) => continentRank(a.continent) - continentRank(b.continent)))
const metroMetric = (t) => `${t.line_count ?? 0} 線 · ${t.station_count ?? 0} 站`

// 高速公路：country-unit（metro-unit 顯示城市·國家）。metric＝條數／交流道數。
const hwQuickItems = computed(() =>
  (highwayCatalog.value ?? []).filter((s) => QUICK_COUNTRIES.some((q) => s.city === q.en || s.cityZh === q.zh))
    .slice().sort((a, b) => continentRank(a.continent) - continentRank(b.continent)))
const hwPrimaryZh = (s) => (s.unit === 'metro' ? (s.cityZh ?? s.city) : (s.countryZh ?? s.country))
const hwPrimaryEn = (s) => (s.unit === 'metro' ? s.city : s.country)
const hwMetric = (s) => `${s.line_count ?? 0} 條 · ${s.station_count ?? 0} 交流道`

// 國家鐵路：一國最多兩系統（高鐵／一般國鐵），以 labelEn 區分（英文副名）。
const railQuickItems = computed(() => {
  const cat = railwayCatalog.value ?? []
  const wanted = new Set(QUICK_RAIL)
  return cat.filter((s) => wanted.has(s.country))
    .slice().sort((a, b) => continentRank(a.continent) - continentRank(b.continent))
})
const railPrimaryZh = (s) => `${s.countryZh ?? s.country}${s.railClass === 'high_speed' ? ' 高鐵' : ' 國鐵'}`
const railPrimaryEn = (s) => s.labelEn ?? s.country
const railMetric = (s) => `${s.line_count ?? 0} 線 · ${s.station_count ?? 0} 站`

// 全球地圖 tab：整份 catalog 也用同一份分組清單（洲別→國家→城市，取代 miller 三欄）。
// 依洲別→國家→城市排序，使分組連續。
const bySort = (a, b) =>
  continentRank(a.continent) - continentRank(b.continent)
  || String(a.country ?? '').localeCompare(String(b.country ?? ''))
  || String(a.city ?? '').localeCompare(String(b.city ?? ''))
const metroAllItems = computed(() => [...(catalog.value ?? [])].sort(bySort))
const hwAllItems = computed(() => [...(highwayCatalog.value ?? [])].sort(bySort))
const railAllItems = computed(() => [...(railwayCatalog.value ?? [])].sort(bySort))
</script>

<template>
  <!-- Raw Maps import: 入口＝圈層上方三顆按鈕（城市／鐵路／高速公路），
       modal 只留該來源的子 tab（dialog id = the active sub-tab） -->
  <div class="dialog import-modal">
    <div class="dialog-header">
      <h2 class="dialog-title">{{ activeImportGroup.label }}</h2>
      <button class="btn-icon" @click="emit('close')"><MIcon name="close" :size="15" /></button>
    </div>
    <div class="dialog-tabs" role="tablist">
      <button
        v-for="t in activeImportGroup.tabs"
        :key="t.id"
        class="dialog-tab"
        :class="{ active: dialog === t.id }"
        role="tab"
        :aria-selected="dialog === t.id"
        @click="store.ui.dialog = t.id"
      >{{ t.label }}</button>
    </div>

    <div v-if="IMPORT_DIALOGS.includes(dialog)" class="dialog-body" :class="{ 'stations-body': dialog === 'import-stations' || dialog === 'import-quick' }">
      <div v-if="catalogError" class="import-status error">載入城市清單失敗：{{ catalogError }}</div>
      <div v-else-if="!catalog" class="import-status">載入全球地鐵城市清單…</div>

      <template v-else>
        <!-- 快速選擇：洲別→國家→城市可收合分組（跟視圖畫廊右側 list 一樣） -->
        <CityIndexList
          v-if="dialog === 'import-quick'"
          class="import-list"
          :items="metroQuickItems"
          grouped
          :metric-of="metroMetric"
          @pick="importSystem"
        />

        <!-- 依車站數排序：平面清單＋頂端 sort icon -->
        <CityIndexList
          v-else-if="dialog === 'import-stations'"
          class="import-list"
          :items="byStations"
          sortable
          v-model:sort-dir="stationSort"
          count-noun="個系統"
          :metric-of="metroMetric"
          @pick="importSystem"
        />

        <!-- Global Metro Map -->
        <!-- 全球地鐵地圖：整份 catalog 用同一份分組清單（洲別→國家→城市，跟視圖 right view 一樣） -->
        <CityIndexList
          v-else-if="dialog === 'import-metro'"
          class="import-list"
          :items="metroAllItems"
          grouped
          :metric-of="metroMetric"
          @pick="importSystem"
        />
      </template>
    </div>

    <!-- Highways big tab -->
    <div v-if="HIGHWAY_DIALOGS.includes(dialog)" class="dialog-body" :class="{ 'stations-body': dialog === 'import-highway-stations' || dialog === 'import-highway-quick' }">
      <div v-if="highwayError" class="import-status error">載入高速公路清單失敗：{{ highwayError }}</div>
      <div v-else-if="!highwayCatalog" class="import-status">載入高速公路系統清單…</div>
      <div v-else-if="!highwayCatalog.length" class="import-status">
        尚無高速公路資料 — 先執行 <code>npm run highway:all</code>（或 <code>highway:fetch twn</code> 試抓一國）
      </div>

      <template v-else>
        <!-- 快速選擇：洲別→國家→都會區可收合分組（跟視圖畫廊右側 list 一樣） -->
        <CityIndexList
          v-if="dialog === 'import-highway-quick'"
          class="import-list"
          :items="hwQuickItems"
          grouped
          :primary-zh="hwPrimaryZh"
          :primary-en="hwPrimaryEn"
          :metric-of="hwMetric"
          @pick="importHighway"
        />

        <!-- 依交流道數排序：平面清單＋頂端 sort icon -->
        <CityIndexList
          v-else-if="dialog === 'import-highway-stations'"
          class="import-list"
          :items="highwaysByStations"
          sortable
          v-model:sort-dir="highwaySort"
          count-noun="國家／地區"
          :primary-zh="hwPrimaryZh"
          :primary-en="hwPrimaryEn"
          :metric-of="hwMetric"
          @pick="importHighway"
        />

        <!-- 全球高速公路地圖：整份 catalog 用同一份分組清單（洲別→國家→都會區） -->
        <CityIndexList
          v-else-if="dialog === 'import-highway-map'"
          class="import-list"
          :items="hwAllItems"
          grouped
          :primary-zh="hwPrimaryZh"
          :primary-en="hwPrimaryEn"
          :metric-of="hwMetric"
          @pick="importHighway"
        />
      </template>
    </div>

    <!-- Railways big tab -->
    <div v-if="RAILWAY_DIALOGS.includes(dialog)" class="dialog-body" :class="{ 'stations-body': dialog === 'import-railway-stations' || dialog === 'import-railway-quick' }">
      <div v-if="railwayError" class="import-status error">載入鐵路清單失敗：{{ railwayError }}</div>
      <div v-else-if="!railwayCatalog" class="import-status">載入國家鐵路系統清單…</div>
      <div v-else-if="!railwayCatalog.length" class="import-status">
        尚無鐵路資料 — 先執行 <code>npm run railway:all</code>（或 <code>railway:fetch twn</code> 試抓一國）
      </div>

      <template v-else>
        <!-- 快速選擇：洲別→國家→系統可收合分組（跟視圖畫廊右側 list 一樣） -->
        <CityIndexList
          v-if="dialog === 'import-railway-quick'"
          class="import-list"
          :items="railQuickItems"
          grouped
          :primary-zh="railPrimaryZh"
          :primary-en="railPrimaryEn"
          :metric-of="railMetric"
          @pick="importRailway"
        />

        <!-- 依車站數排序：平面清單＋頂端 sort icon（高鐵／一般國鐵分開列） -->
        <CityIndexList
          v-else-if="dialog === 'import-railway-stations'"
          class="import-list"
          :items="railwaysByStations"
          sortable
          v-model:sort-dir="railwaySort"
          count-noun="個系統"
          :primary-zh="railPrimaryZh"
          :primary-en="railPrimaryEn"
          :metric-of="railMetric"
          @pick="importRailway"
        />

        <!-- 全球鐵路地圖：整份 catalog 用同一份分組清單（洲別→國家→系統） -->
        <CityIndexList
          v-else-if="dialog === 'import-railway-map'"
          class="import-list"
          :items="railAllItems"
          grouped
          :primary-zh="railPrimaryZh"
          :primary-en="railPrimaryEn"
          :metric-of="railMetric"
          @pick="importRailway"
        />
      </template>
    </div>
  </div>
</template>
