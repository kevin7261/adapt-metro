<script setup>
import { ref, computed, watch } from 'vue'
import { useMapStore } from '../../stores/mapStore'
import {
  continentCols, countryCols, groupQuickByContinent,
} from '../../stores/metroCatalog'
import { loadHighwayCatalog } from '../../stores/highwayCatalog'
import { loadRailwayCatalog } from '../../stores/railwayCatalog'
import { openLayerTab } from '../../stores/dockHandle'
import { QUICK_CITIES, matchQuickSystem } from '../../lib/quickCities'
import { IMPORT_DIALOGS, useDialogCatalog } from './useDialogCatalog'
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
      <button class="btn-outline" @click="emit('close')">取消</button>
      <button class="btn-primary" :disabled="!selectedSystem" @click="importSystem(selectedSystem)">確定</button>
    </div>

    <!-- Highways big tab -->
    <div v-if="HIGHWAY_DIALOGS.includes(dialog)" class="dialog-body" :class="{ 'stations-body': dialog === 'import-highway-stations' || dialog === 'import-highway-quick' }">
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

    <!-- Railways big tab -->
    <div v-if="RAILWAY_DIALOGS.includes(dialog)" class="dialog-body" :class="{ 'stations-body': dialog === 'import-railway-stations' || dialog === 'import-railway-quick' }">
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
</template>
