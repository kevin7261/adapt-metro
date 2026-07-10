<script setup>
import { ref, computed, watch } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { loadMetroCatalog, prettyContinent } from '../stores/metroCatalog'
import { openLayerTab } from '../stores/dockHandle'
import {
  X, FileJson, Mountain, Grid2x2, Server, FileArchive, Layers2,
  Upload, Map as MapIcon, Github, Globe, TrainFront,
} from 'lucide-vue-next'

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
  { id: 'vector', label: 'Vector Layer', icon: FileJson },
  { id: 'raster', label: 'Raster Layer', icon: Mountain },
  { id: 'xyz', label: 'XYZ Tiles', icon: Grid2x2 },
  { id: 'wms', label: 'WMS / WMTS', icon: Server },
  { id: 'wfs', label: 'WFS', icon: Server },
  { id: 'geoparquet', label: 'GeoParquet', icon: FileArchive },
  { id: 'pmtiles', label: 'PMTiles', icon: Layers2 },
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
    <!-- Import: Quick Selection -->
    <div v-if="dialog === 'import-quick'" class="dialog import-quick">
      <div class="dialog-header">
        <h2 class="dialog-title">Quick Selection</h2>
        <button class="btn-icon" @click="close"><X :size="15" /></button>
      </div>
      <div class="dialog-body">
        <div v-if="catalogError" class="import-status error">載入城市清單失敗：{{ catalogError }}</div>
        <div v-else-if="!catalog" class="import-status">載入全球地鐵城市清單…</div>
        <div v-else class="quick-grid">
          <button
            v-for="q in quickCities"
            :key="q.en"
            class="quick-city"
            :disabled="!q.sys"
            :title="q.sys ? '' : '資料集中找不到此城市'"
            @click="importSystem(q.sys)"
          >
            <span class="quick-zh">{{ q.zh }}</span>
            <span class="quick-en">{{ q.en }}</span>
            <span class="quick-count">{{ q.sys ? `${q.sys.station_count} 站` : '—' }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Import: 依車站數排序 -->
    <div v-else-if="dialog === 'import-stations'" class="dialog import-stations">
      <div class="dialog-header">
        <h2 class="dialog-title">Sort by Station Count</h2>
        <button class="btn-icon" @click="close"><X :size="15" /></button>
      </div>
      <div class="dialog-body stations-body">
        <div v-if="catalogError" class="import-status error">載入城市清單失敗：{{ catalogError }}</div>
        <div v-else-if="!catalog" class="import-status">載入全球地鐵城市清單…</div>
        <template v-else>
          <div class="sort-toggle">
            <button
              class="sort-btn"
              :class="{ active: stationSort === 'desc' }"
              @click="stationSort = 'desc'"
            >多到少</button>
            <button
              class="sort-btn"
              :class="{ active: stationSort === 'asc' }"
              @click="stationSort = 'asc'"
            >少到多</button>
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
      </div>
    </div>

    <!-- Import: Global Metro Map -->
    <div v-else-if="dialog === 'import-metro'" class="dialog import-metro">
      <div class="dialog-header">
        <h2 class="dialog-title">Global Metro Map</h2>
        <button class="btn-icon" @click="close"><X :size="15" /></button>
      </div>
      <div class="dialog-body">
        <div v-if="catalogError" class="import-status error">
          載入城市清單失敗：{{ catalogError }}
        </div>
        <div v-else-if="!catalog" class="import-status">載入全球地鐵城市清單…</div>

        <template v-else>
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
                >
                  {{ prettyContinent(c) }}
                </button>
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
                >
                  {{ c }}
                </button>
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
                >
                  {{ c }}
                </button>
              </div>
            </div>
          </div>

          <div class="import-preview" :class="{ placeholder: !selectedSystem }">
            <TrainFront :size="14" />
            <span v-if="selectedSystem">
              {{ selectedSystem.city }} — {{ selectedSystem.line_count }} 條線 ·
              {{ selectedSystem.station_count }} 站
              <template v-if="selectedSystem.operator">（{{ selectedSystem.operator }}）</template>
            </span>
            <span v-else>選擇一個城市以匯入其 metro map</span>
          </div>
        </template>
      </div>
      <div class="dialog-footer">
        <button class="btn-outline" @click="close">取消</button>
        <button class="btn-primary" :disabled="!selectedSystem" @click="importMetro">確定</button>
      </div>
    </div>

    <!-- Add Data -->
    <div v-else-if="dialog === 'add-data'" class="dialog add-data">
      <div class="dialog-header">
        <h2 class="dialog-title">Add Data</h2>
        <button class="btn-icon" @click="close"><X :size="15" /></button>
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
            <component :is="s.icon" :size="14" /> {{ s.label }}
          </button>
        </nav>
        <div class="source-form">
          <div class="drop-zone">
            <Upload :size="20" />
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
        <button class="btn-icon" @click="close"><X :size="15" /></button>
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
        <button class="btn-icon" @click="close"><X :size="15" /></button>
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
          <span>Attribute table</span>
          <input v-model="store.ui.attributeTable" type="checkbox" />
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
        <button class="btn-icon" @click="close"><X :size="15" /></button>
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
        <button class="btn-icon" @click="close"><X :size="15" /></button>
      </div>
      <div class="dialog-body about-body">
        <MapIcon :size="40" class="about-logo" />
        <h3>Adapt-Metro</h3>
        <p class="muted">UI prototype v0.1.0 — layout inspired by GeoLibre</p>
        <p class="muted">Vue 3 · Vite · MapLibre GL JS</p>
        <div class="about-links">
          <button class="btn-outline" @click="store.fake('Website')"><Globe :size="13" /> Website</button>
          <button class="btn-outline" @click="store.fake('GitHub')"><Github :size="13" /> GitHub</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.import-metro { width: min(720px, calc(100vw - 32px)); }

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
.station-row:hover { background: hsl(var(--accent) / 0.6); }
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
