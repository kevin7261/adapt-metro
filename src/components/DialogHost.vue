<script setup>
import { ref, computed, watch } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { loadMetroCatalog, prettyContinent } from '../stores/metroCatalog'
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
  { id: 'import-quick', label: 'Quick Selection' },
  { id: 'import-stations', label: 'Sort by Station Count' },
  { id: 'import-metro', label: 'Global Metro Map' },
]

watch(dialog, (d) => {
  if (!IMPORT_DIALOGS.includes(d) || catalog.value) return
  catalogError.value = null
  loadMetroCatalog()
    .then((systems) => { catalog.value = systems })
    .catch((err) => { catalogError.value = String(err) })
})

const continents = computed(() => {
  if (!catalog.value) return []
  return [...new Set(catalog.value.map((s) => s.continent))].sort()
})
const countries = computed(() => {
  if (!catalog.value || !selContinent.value) return []
  return [...new Set(
    catalog.value.filter((s) => s.continent === selContinent.value).map((s) => s.country),
  )].sort()
})
const cities = computed(() => {
  if (!catalog.value || !selCountry.value) return []
  return catalog.value
    .filter((s) => s.continent === selContinent.value && s.country === selCountry.value)
    .map((s) => s.city)
    .sort()
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
  store.toast(`已匯入 ${sys.city} metro map（${sys.line_count} 條線 / ${sys.station_count} 站）`)
}

function importMetro() {
  importSystem(selectedSystem.value)
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
function addHillClimbView(src, variant) {
  const hcLayer = store.addHillClimbLayer(src.id, variant)
  if (!hcLayer) return
  openLayerTab(hcLayer)
  close()
  const vLabel = HC_VARIANTS.find((v) => v.id === hcLayer.variant)?.label ?? ''
  store.toast(`已建立 Hill Climbing 視圖（來源：${src.name} ${vLabel}）`)
}

/* Quick Selection — 常用城市 */
const QUICK_CITIES = [
  { zh: '台北', en: 'Taipei' }, { zh: '台中', en: 'Taichung' }, { zh: '高雄', en: 'Kaohsiung' },
  { zh: '東京', en: 'Tokyo' }, { zh: '大阪', en: 'Osaka' }, { zh: '首爾', en: 'Seoul' },
  { zh: '北京', en: 'Beijing' }, { zh: '上海', en: 'Shanghai' }, { zh: '香港', en: 'Hong Kong' },
  { zh: '新加坡', en: 'Singapore' }, { zh: '倫敦', en: 'London' }, { zh: '巴黎', en: 'Paris' },
  { zh: '柏林', en: 'Berlin' }, { zh: '維也納', en: 'Vienna' }, { zh: '紐約', en: 'New York' },
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
        <h2 class="dialog-title">Import Metro Map</h2>
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
          <!-- Quick Selection -->
          <div v-if="dialog === 'import-quick'" class="stations-list">
            <button
              v-for="q in quickCities"
              :key="q.en"
              class="station-row"
              :disabled="!q.sys"
              :title="q.sys ? '' : '資料集中找不到此城市'"
              @click="importSystem(q.sys)"
            >
              <span class="station-city">{{ q.en }}</span>
              <span class="station-country">{{ q.sys?.country ?? '' }}</span>
              <span class="station-count">{{ q.sys ? `${q.sys.station_count} stations · ${q.sys.line_count} lines` : '—' }}</span>
            </button>
          </div>

          <!-- Sort by Station Count -->
          <template v-else-if="dialog === 'import-stations'">
            <div class="sort-toggle">
              <button class="sort-btn" :class="{ active: stationSort === 'desc' }" @click="stationSort = 'desc'">多到少</button>
              <button class="sort-btn" :class="{ active: stationSort === 'asc' }" @click="stationSort = 'asc'">少到多</button>
              <span class="sort-meta">{{ byStations.length }} 個系統</span>
            </div>
            <div class="stations-list">
              <button
                v-for="(s, i) in byStations"
                :key="s.file"
                class="station-row"
                @click="importSystem(s)"
              >
                <span class="station-rank">{{ i + 1 }}</span>
                <span class="station-city">{{ s.city }}</span>
                <span class="station-country">{{ s.country }}</span>
                <span class="station-count">{{ s.station_count }} 站 · {{ s.line_count }} 線</span>
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
                    :key="c"
                    class="miller-item"
                    :class="{ active: selContinent === c }"
                    @click="selContinent = c"
                  >{{ prettyContinent(c) }}</button>
                </div>
              </div>
              <div class="miller-col">
                <div class="miller-head">國家</div>
                <div class="miller-list">
                  <div v-if="!selContinent" class="miller-empty">← 先選洲別</div>
                  <button
                    v-for="c in countries"
                    :key="c"
                    class="miller-item"
                    :class="{ active: selCountry === c }"
                    @click="selCountry = c"
                  >{{ c }}</button>
                </div>
              </div>
              <div class="miller-col">
                <div class="miller-head">城市</div>
                <div class="miller-list">
                  <div v-if="!selCountry" class="miller-empty">← 先選國家</div>
                  <button
                    v-for="c in cities"
                    :key="c"
                    class="miller-item"
                    :class="{ active: selCity === c }"
                    @click="selCity = c"
                  >{{ c }}</button>
                </div>
              </div>
            </div>

            <div class="import-preview" :class="{ placeholder: !selectedSystem }">
              <MIcon name="train" :size="14" />
              <span v-if="selectedSystem">
                {{ selectedSystem.city }} — {{ selectedSystem.line_count }} 條線 ·
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
        <button class="btn-primary" :disabled="!selectedSystem" @click="importMetro">確定</button>
      </div>
    </div>

    <!-- Add D3.js view: pick a loaded metro map layer (fixed once chosen) -->
    <div v-else-if="dialog === 'add-d3'" class="dialog add-d3">
      <div class="dialog-header">
        <h2 class="dialog-title">Add D3.js View</h2>
        <button class="btn-icon" @click="close"><MIcon name="close" :size="15" /></button>
      </div>
      <div class="dialog-body">
        <div v-if="!metroLayerChoices.length" class="import-status">
          Metro Maps group 還沒有圖層 — 先用 + 匯入一個 metro map，或直接匯入 GeoJSON 檔案
        </div>
        <template v-else>
          <p class="add-d3-hint">選擇一個 metro map 圖層作為 D3.js 視圖的資料來源（建立後不可更改）：</p>
          <div class="stations-list">
            <button
              v-for="l in metroLayerChoices"
              :key="l.id"
              class="station-row"
              @click="addD3View(l)"
            >
              <MIcon name="train" :size="14" />
              <span class="station-city">{{ l.name }}</span>
              <span class="station-country">{{ l.city }}</span>
              <span class="station-count">{{ l.stationCount }} 站 · {{ l.lineCount }} 線</span>
            </button>
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
        <h2 class="dialog-title">Add Hill Climbing View</h2>
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
          <div class="stations-list">
            <template v-for="l in d3LayerChoices" :key="l.id">
              <button
                v-for="v in HC_VARIANTS"
                :key="`${l.id}-${v.id}`"
                class="station-row"
                @click="addHillClimbView(l, v.id)"
              >
                <MIcon name="polyline" :size="14" />
                <span class="station-city">{{ l.name }}</span>
                <span class="station-country">{{ v.label }}</span>
                <span class="station-count">{{ d3Meta(l) }}</span>
              </button>
            </template>
          </div>
        </template>
      </div>
    </div>

    <!-- Add Data -->
    <div v-else-if="dialog === 'add-data'" class="dialog add-data">
      <div class="dialog-header">
        <h2 class="dialog-title">Add Data</h2>
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
        <h2 class="dialog-title">New Project</h2>
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
        <h2 class="dialog-title">Settings</h2>
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
        <h2 class="dialog-title">Keyboard Shortcuts</h2>
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
        <h2 class="dialog-title">About</h2>
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
.import-modal { width: min(720px, calc(100vw - 32px)); }
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
.import-metro { width: min(720px, calc(100vw - 32px)); }
.add-d3 { width: min(520px, calc(100vw - 32px)); }
.add-d3-hint { font-size: 12.5px; color: hsl(var(--muted-foreground)); margin: 0 0 10px; }
.d3-file-row { width: 100%; margin-top: 8px; color: hsl(var(--primary)); }

/* Quick Selection */
.import-quick { width: min(560px, calc(100vw - 32px)); }
.quick-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.quick-city {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 6px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--muted) / 0.25);
}
.quick-city:hover:not(:disabled) {
  border-color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.08);
}
.quick-city:disabled { opacity: 0.4; cursor: default; }
.quick-zh { font-size: 15px; font-weight: 600; }
.quick-en { font-size: 11.5px; color: hsl(var(--muted-foreground)); }
.quick-count { font-size: 10.5px; color: hsl(var(--muted-foreground)); }

/* 依車站數排序 */
.import-stations { width: min(560px, calc(100vw - 32px)); }
.stations-body { display: flex; flex-direction: column; min-height: 0; }
.sort-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  flex-shrink: 0;
}
.sort-btn {
  padding: 5px 14px;
  font-size: 12.5px;
  border: 1px solid hsl(var(--border));
  border-radius: 999px;
  color: hsl(var(--muted-foreground));
}
.sort-btn:hover { background: hsl(var(--accent)); }
.sort-btn.active {
  background: hsl(var(--primary) / 0.12);
  border-color: hsl(var(--primary));
  color: hsl(var(--primary));
  font-weight: 500;
}
.sort-meta { margin-left: auto; font-size: 11.5px; color: hsl(var(--muted-foreground)); }
.stations-list {
  flex: 1;
  min-height: 0;
  max-height: 46vh;
  overflow-y: auto;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  padding: 4px;
}
.station-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 5px 8px;
  border-radius: calc(var(--radius) - 4px);
  font-size: 12.5px;
  text-align: left;
}
.station-row:hover:not(:disabled) { background: hsl(var(--accent) / 0.6); }
.station-row:disabled { opacity: 0.4; cursor: default; }
.station-rank {
  width: 30px;
  flex-shrink: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: hsl(var(--muted-foreground));
  text-align: right;
}
.station-city { font-weight: 500; white-space: nowrap; }
.station-country {
  color: hsl(var(--muted-foreground));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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
