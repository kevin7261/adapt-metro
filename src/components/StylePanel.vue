<script setup>
import { ref, computed, onMounted } from 'vue'
import { layerData } from '../stores/layerData'
import { prettyContinent, loadMapsIndex } from '../stores/metroCatalog'
import { PanelRightClose, PanelRightOpen, SlidersHorizontal, ExternalLink } from 'lucide-vue-next'

// The layer this tab edits — passed in by LayerTab.
const props = defineProps({ layer: { type: Object, required: true } })

const open = ref(true)
const width = ref(300)

// Panel sections — add more entries here later (e.g. Analysis, Export).
const TABS = [
  { id: 'info', label: 'Info' },
  { id: 'style', label: 'Style' },
]
const activeTab = ref('info')

const layer = computed(() => props.layer)
const isMetro = computed(() => layer.value?.type === 'metro')
const editable = computed(() => layer.value && !layer.value.isBasemap && !isMetro.value)

/* ---- Info: metro system metadata (from the loaded GeoJSON) ---- */
const meta = computed(() => layerData[layer.value.id]?.metro_system ?? null)
const metroLines = computed(() => {
  const d = layerData[layer.value.id]
  if (!d) return []
  return d.features
    .filter((f) => f.geometry.type !== 'Point')
    .map((f) => f.properties)
    .sort((a, b) =>
      String(a.route_ref ?? a.route_name ?? '').localeCompare(
        String(b.route_ref ?? b.route_name ?? ''), undefined, { numeric: true },
      ),
    )
})
const wikidataUrl = computed(() =>
  meta.value?.wikidata ? `https://www.wikidata.org/wiki/${meta.value.wikidata}` : null,
)

/* ---- Info: external links (wiki / official route map / urbanrail) ---- */
const mapsIndex = ref(null)
onMounted(() => {
  if (isMetro.value) loadMapsIndex().then((v) => { mapsIndex.value = v }).catch(() => {})
})
// '/data/metro/systems/asia/taiwan/asia-taiwan-taipei.geojson' → 'asia/taiwan/asia-taiwan-taipei'
const systemKey = computed(() => layer.value.file?.match(/systems\/(.+)\.geojson$/)?.[1] ?? null)
const mapEntry = computed(() => (systemKey.value && mapsIndex.value?.[systemKey.value]) || null)

// Wikipedia article of this metro system (via its Wikidata item).
const wikipediaUrl = computed(() =>
  meta.value?.wikidata
    ? `https://www.wikidata.org/wiki/Special:GoToLinkedPage/enwiki/${meta.value.wikidata}`
    : null,
)
// Official schematic route map: local downloaded image if we have it,
// otherwise the wiki link recorded in the system metadata.
const routeMapUrl = computed(() =>
  mapEntry.value?.map_file ? `/data/metro/${mapEntry.value.map_file}` : (meta.value?.official_map ?? null),
)
// urbanrail.net continent index (city pages have irregular URLs, so link the
// continent page — the city is one click away).
const URBANRAIL_CONTINENTS = {
  asia: 'as/asia.htm',
  europe: 'eu/euromet.htm',
  'north-america': 'am/america.htm',
  'south-america': 'am/america.htm',
  africa: 'af/africa.htm',
  oceania: 'au/oceania.htm',
}
const urbanrailUrl = computed(() => {
  const path = URBANRAIL_CONTINENTS[layer.value.continent]
  return path ? `https://www.urbanrail.net/${path}` : 'https://www.urbanrail.net/'
})

/* ---- resize ---- */
const dragging = ref(false)
function startResize(e) {
  dragging.value = true
  const startX = e.clientX
  const startW = width.value
  const move = (ev) => {
    width.value = Math.min(560, Math.max(180, startW - (ev.clientX - startX)))
  }
  const up = () => {
    dragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
</script>

<template>
  <!-- Collapsed rail -->
  <aside v-if="!open" class="rail" aria-label="Panel (collapsed)">
    <button class="btn-icon" title="Expand panel" @click="open = true">
      <PanelRightOpen :size="15" />
    </button>
    <SlidersHorizontal :size="14" class="rail-icon" />
    <span class="rail-label">Info / Style</span>
  </aside>

  <template v-else>
    <div
      class="resize-x"
      :class="{ dragging }"
      role="separator"
      aria-orientation="vertical"
      @pointerdown="startResize"
    />

    <aside class="style-panel" aria-label="Layer panel" :style="{ width: width + 'px' }">
      <div class="panel-header tabs-header">
        <div class="panel-tabs" role="tablist">
          <button
            v-for="t in TABS"
            :key="t.id"
            class="panel-tab"
            :class="{ active: activeTab === t.id }"
            role="tab"
            :aria-selected="activeTab === t.id"
            @click="activeTab = t.id"
          >
            {{ t.label }}
          </button>
        </div>
        <button class="btn-icon" title="Collapse panel" @click="open = false">
          <PanelRightClose :size="14" />
        </button>
      </div>

      <div class="style-body">
        <div class="layer-heading">
          <span class="layer-name">{{ layer.name }}</span>
          <span class="layer-type">{{ layer.type }}</span>
        </div>

        <!-- ============ Info ============ -->
        <template v-if="activeTab === 'info'">
          <template v-if="isMetro">
            <div class="info-rows">
              <div class="info-row"><span class="info-key">City</span><span>{{ layer.city }}</span></div>
              <div class="info-row"><span class="info-key">Country</span><span>{{ layer.country }}</span></div>
              <div class="info-row">
                <span class="info-key">Continent</span><span>{{ prettyContinent(layer.continent) }}</span>
              </div>
              <div class="info-row"><span class="info-key">Lines</span><span>{{ layer.lineCount }}</span></div>
              <div class="info-row"><span class="info-key">Stations</span><span>{{ layer.stationCount }}</span></div>
              <div v-if="meta?.operator" class="info-row">
                <span class="info-key">Operator</span><span>{{ meta.operator }}</span>
              </div>
              <div v-if="meta?.official_website" class="info-row">
                <span class="info-key">Website</span>
                <a :href="meta.official_website" target="_blank" rel="noopener" class="info-link">
                  {{ meta.official_website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') }}
                  <ExternalLink :size="11" />
                </a>
              </div>
              <div v-if="wikidataUrl" class="info-row">
                <span class="info-key">Wikidata</span>
                <a :href="wikidataUrl" target="_blank" rel="noopener" class="info-link">
                  {{ meta.wikidata }} <ExternalLink :size="11" />
                </a>
              </div>
              <div v-if="meta?.osm_networks?.length" class="info-row">
                <span class="info-key">Networks</span>
                <span>{{ meta.osm_networks.join(', ') }}</span>
              </div>
            </div>

            <div class="section-title">Links</div>
            <div class="link-list">
              <a v-if="wikipediaUrl" :href="wikipediaUrl" target="_blank" rel="noopener" class="info-link link-item">
                <ExternalLink :size="12" /> Wikipedia — {{ layer.city }} metro
              </a>
              <a v-if="routeMapUrl" :href="routeMapUrl" target="_blank" rel="noopener" class="info-link link-item">
                <ExternalLink :size="12" /> Official route map
                <span v-if="mapEntry" class="link-note">（{{ mapEntry.license ?? 'image' }}）</span>
              </a>
              <a :href="urbanrailUrl" target="_blank" rel="noopener" class="info-link link-item">
                <ExternalLink :size="12" /> urbanrail.net — {{ prettyContinent(layer.continent) }}
              </a>
            </div>

            <div class="section-title">Lines</div>
            <div v-if="!metroLines.length" class="info-empty">載入中…</div>
            <div v-else class="line-list">
              <div v-for="ln in metroLines" :key="ln.route_id" class="line-row">
                <span class="line-swatch" :style="{ background: ln.route_color ?? '#e11d48' }" />
                <span v-if="ln.route_ref" class="line-ref">{{ ln.route_ref }}</span>
                <span class="line-name">
                  {{ ln.route_name ?? ln.route_name_local ?? '—' }}
                </span>
              </div>
            </div>
          </template>
          <div v-else class="info-empty">此圖層沒有 metro 資訊。</div>
        </template>

        <!-- ============ Style ============ -->
        <template v-else-if="activeTab === 'style'">
          <template v-if="isMetro">
            <div class="field">
              <label class="field-label">Line width — {{ layer.strokeWidth }} px</label>
              <input v-model.number="layer.strokeWidth" type="range" min="0.5" max="8" step="0.5" class="slider" />
            </div>

            <div class="field">
              <label class="field-label">Station radius — {{ layer.radius }} px</label>
              <input v-model.number="layer.radius" type="range" min="1" max="10" step="0.5" class="slider" />
            </div>
          </template>

          <template v-if="editable">
            <div class="field">
              <label class="field-label">Symbology</label>
              <select v-model="layer.symbology" class="select">
                <option value="single">Single symbol</option>
                <option value="categorized">Categorized</option>
                <option value="graduated">Graduated</option>
                <option value="rule-based">Rule-based</option>
                <option value="expression">Expression</option>
              </select>
            </div>

            <div class="field-row">
              <div class="field">
                <label class="field-label">{{ layer.type === 'line' ? 'Line color' : 'Fill color' }}</label>
                <input v-model="layer.color" type="color" class="color-input" />
              </div>
              <div v-if="layer.type !== 'line'" class="field">
                <label class="field-label">Stroke color</label>
                <input v-model="layer.strokeColor" type="color" class="color-input" />
              </div>
            </div>

            <div class="field">
              <label class="field-label">
                {{ layer.type === 'line' ? 'Line width' : 'Stroke width' }} — {{ layer.strokeWidth }} px
              </label>
              <input v-model.number="layer.strokeWidth" type="range" min="0" max="10" step="0.5" class="slider" />
            </div>

            <div v-if="layer.type === 'point'" class="field">
              <label class="field-label">Circle radius — {{ layer.radius }} px</label>
              <input v-model.number="layer.radius" type="range" min="1" max="20" step="1" class="slider" />
            </div>
          </template>

          <div class="field">
            <label class="field-label">Opacity — {{ Math.round(layer.opacity * 100) }}%</label>
            <input v-model.number="layer.opacity" type="range" min="0" max="1" step="0.05" class="slider" />
          </div>
        </template>
      </div>
    </aside>
  </template>
</template>

<style scoped>
.style-panel {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-height: 0;
  background: hsl(var(--card));
  border-left: 1px solid hsl(var(--border));
}
.rail {
  width: 44px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  background: hsl(var(--card));
  border-left: 1px solid hsl(var(--border));
}
.rail-icon { color: hsl(var(--muted-foreground)); }
.rail-label {
  writing-mode: vertical-rl;
  font-size: 11px;
  color: hsl(var(--muted-foreground));
}

/* header tabs */
.tabs-header { padding: 4px 8px 0 8px; align-items: flex-end; }
.panel-tabs { display: flex; gap: 2px; }
.panel-tab {
  padding: 7px 12px 8px;
  font-size: 12.5px;
  color: hsl(var(--muted-foreground));
  border-bottom: 2px solid transparent;
  border-radius: calc(var(--radius) - 4px) calc(var(--radius) - 4px) 0 0;
}
.panel-tab:hover { background: hsl(var(--accent) / 0.6); color: hsl(var(--foreground)); }
.panel-tab.active {
  color: hsl(var(--primary));
  font-weight: 600;
  border-bottom-color: hsl(var(--primary));
}

.style-body { flex: 1; overflow-y: auto; padding: 12px; }
.layer-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
  min-width: 0;
}
.layer-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.layer-type {
  font-size: 10.5px;
  color: hsl(var(--muted-foreground));
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}

/* Info */
.info-rows { display: flex; flex-direction: column; gap: 2px; }
.info-row {
  display: flex;
  gap: 10px;
  padding: 4px 0;
  font-size: 12.5px;
  border-bottom: 1px solid hsl(var(--border) / 0.5);
}
.info-row:last-child { border-bottom: none; }
.info-key {
  width: 84px;
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
}
.info-row > span:not(.info-key), .info-row > a { min-width: 0; overflow-wrap: anywhere; }
.info-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: hsl(var(--primary));
  text-decoration: none;
}
.info-link:hover { text-decoration: underline; }
.info-empty { font-size: 12.5px; color: hsl(var(--muted-foreground)); padding: 8px 0; }

.link-list { display: flex; flex-direction: column; gap: 6px; }
.link-item { font-size: 12.5px; }
.link-note { color: hsl(var(--muted-foreground)); font-size: 11px; }

.line-list { display: flex; flex-direction: column; gap: 2px; }
.line-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 2px;
  font-size: 12.5px;
  min-width: 0;
}
.line-swatch {
  width: 14px;
  height: 6px;
  border-radius: 3px;
  flex-shrink: 0;
}
.line-ref {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: hsl(var(--muted-foreground));
  background: hsl(var(--muted));
  border-radius: 4px;
  padding: 1px 5px;
  flex-shrink: 0;
}
.line-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Style */
.field { margin-bottom: 12px; flex: 1; min-width: 0; }
.field-row { display: flex; gap: 10px; }
.color-input {
  width: 100%;
  height: 30px;
  padding: 2px;
  border: 1px solid hsl(var(--input));
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  cursor: pointer;
}
.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: hsl(var(--muted-foreground));
  border-top: 1px solid hsl(var(--border));
  padding-top: 12px;
  margin: 12px 0 10px;
}
</style>
