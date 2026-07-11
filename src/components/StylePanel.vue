<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { layerData } from '../stores/layerData'
import { prettyContinent, loadMapsIndex } from '../stores/metroCatalog'
import { computeOrientation } from '../stores/orientation'
import OrientationRose from './OrientationRose.vue'
import {
  PanelRightClose, PanelRightOpen, SlidersHorizontal, ExternalLink,
  CircleCheck, CircleX, TriangleAlert,
} from 'lucide-vue-next'

// The layer this tab edits — passed in by LayerTab.
const props = defineProps({
  layer: { type: Object, required: true },
  // 'd3' when shown inside a Map Adjust (D3.js) tab — Info then documents the
  // skeleton rules instead of the audit verdict.
  context: { type: String, default: 'map' },
})
const isD3 = computed(() => props.context === 'd3')

const open = ref(true)
const width = ref(300)

// Panel sections — add more entries here later (e.g. Analysis, Export).
const TABS = [
  { id: 'info', label: 'Info' },
  { id: 'style', label: 'Style' },
  { id: 'object', label: 'Object' },
]
const activeTab = ref('info')

/* ---- Object: properties of the last-clicked map feature (blank if none) ---- */
const store = useMapStore()
const selectedProps = computed(() => store.selectedFeatures[props.layer.id] ?? null)
const asText = (v) => {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'object') return JSON.stringify(v, null, 2)
  return String(v)
}
// A wikipedia value is a raw OSM tag ("en:Taipei Main Station") or a URL;
// a wikidata value is a Q-id. Turn both into a clickable link in the Object tab.
const linkFor = (key, v) => {
  if (typeof v !== 'string' || !v) return null
  if (key === 'wikipedia') {
    if (/^https?:\/\//.test(v)) return v
    const m = /^([a-z-]+):(.+)$/.exec(v)
    if (m) return `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, '_'))}`
    return `https://en.wikipedia.org/wiki/${encodeURIComponent(v.replace(/ /g, '_'))}`
  }
  if (key === 'wikidata' && /^Q\d+$/.test(v)) return `https://www.wikidata.org/wiki/${v}`
  return null
}
// MapLibre serialises nested arrays/objects to JSON strings for GeoJSON source
// features — parse them back. Arrays render as an ordered list (no brackets);
// everything else as text.
const selectedEntries = computed(() => {
  const p = selectedProps.value
  if (!p) return []
  // Skip internal render-only props (e.g. `_c0.._c5` flattened dash colours).
  return Object.keys(p).filter((k) => !k.startsWith('_')).sort().map((k) => {
    let v = p[k]
    if (typeof v === 'string' && /^[[{]/.test(v.trim())) {
      try { v = JSON.parse(v) } catch { /* leave as-is */ }
    }
    if (Array.isArray(v)) return { key: k, isList: true, items: v.map(asText) }
    const href = linkFor(k, v)
    return { key: k, isList: false, value: asText(v), href }
  })
})

// Clicking a feature auto-opens the Object tab (only when something is selected).
watch(selectedProps, (v) => { if (v) activeTab.value = 'object' })

// 點到路段時：顯示每條行經 route 的完整車站列表（依站序）。
// 列表來自 route meta 的 stations（build 保證與圖面一致——audit 有不變式檢查）。
const selectedRouteLists = computed(() => {
  const p = selectedProps.value
  if (!p) return []
  let routes = p.routes
  if (typeof routes === 'string') { try { routes = JSON.parse(routes) } catch { return [] } }
  if (!Array.isArray(routes)) return []
  return routes.map((r) => ({
    route_id: r.route_id,
    name: r.route_name ?? r.route_id,
    ref: r.route_ref,
    color: r.route_color ?? '#e11d48',
    stations: r.stations ?? [],
    // stations 保序不去重（支線接續站/環線閉合站重複出現）——計數用唯一站數
    uniqueCount: new Set((r.stations ?? []).map((s) => s.station_id)).size,
  }))
})

const layer = computed(() => props.layer)
// metroLike: a D3 view created from an imported metro GeoJSON — same panels.
const isMetro = computed(() => layer.value?.type === 'metro' || layer.value?.metroLike === true)
const editable = computed(() => layer.value && !layer.value.isBasemap && !isMetro.value)

/* ---- Info: metro system metadata (from the loaded GeoJSON) ---- */
const meta = computed(() => layerData[layer.value.id]?.metro_system ?? null)
const metroLines = computed(() => {
  const d = layerData[layer.value.id]
  if (!d) return []
  // line features are overlap-deduped SEGMENTS carrying `routes: [...]` —
  // the city's line list is the unique routes across all segments
  const byId = new Map()
  for (const f of d.features) {
    if (f.geometry.type === 'Point') continue
    for (const r of f.properties.routes ?? [f.properties]) {
      if (r.route_id && !byId.has(r.route_id)) byId.set(r.route_id, r)
    }
  }
  return [...byId.values()].sort((a, b) =>
    String(a.route_ref ?? a.route_name ?? '').localeCompare(
      String(b.route_ref ?? b.route_name ?? ''), undefined, { numeric: true },
    ),
  )
})
const wikidataUrl = computed(() =>
  meta.value?.wikidata ? `https://www.wikidata.org/wiki/${meta.value.wikidata}` : null,
)

/* ---- Info: network orientation rose (Boeing 2019) ---- */
// Length-weighted distribution of line bearings + orientation-order φ.
const orientation = computed(() => {
  const d = layerData[layer.value.id]
  if (!isMetro.value || !d) return null
  return computeOrientation(d)
})
// Suggested rotation to square the network up (rotate by −tilt): a clockwise tilt
// is cancelled by a counter-clockwise turn, and vice versa.
function rotationHint(o) {
  const t = o?.tilt ?? 0
  if (Math.abs(t) < 0.05) return '0°（已對齊正南北）'
  return `${Math.abs(t).toFixed(1)}° ${t > 0 ? '逆時針' : '順時針'}`
}

/* ---- Info: per-city audit verdict (metro_system.audit, from metro:audit) ---- */
const auditInfo = computed(() => meta.value?.audit ?? null)
const auditChecks = computed(() => auditInfo.value?.checks ?? [])

/* ---- Info: external links (wiki / official route map / urbanrail) ---- */
const mapsIndex = ref(null)
onMounted(() => {
  if (isMetro.value) loadMapsIndex().then((v) => { mapsIndex.value = v }).catch(() => {})
})
// '/data/metro/systems/asia/taiwan/asia-taiwan-taipei.geojson' → 'asia/taiwan/asia-taiwan-taipei'
const systemKey = computed(() => layer.value.file?.match(/systems\/(.+)\.geojson$/)?.[1] ?? null)
const mapEntry = computed(() => (systemKey.value && mapsIndex.value?.[systemKey.value]) || null)

// Wikipedia article of this metro system: via its Wikidata item, else the
// wiki URL recorded in the system metadata (metro_system.official_map).
const wikipediaUrl = computed(() =>
  meta.value?.wikidata
    ? `https://www.wikidata.org/wiki/Special:GoToLinkedPage/enwiki/${meta.value.wikidata}`
    : (meta.value?.official_map ?? null),
)
// Official operator website.
const websiteUrl = computed(() => meta.value?.official_website ?? null)
// Official schematic route map: only the local downloaded image (the wiki URL
// is surfaced separately as the Wikipedia link, not mislabelled as a map).
const routeMapUrl = computed(() =>
  mapEntry.value?.map_file ? `/data/metro/${mapEntry.value.map_file}` : null,
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

            <div class="section-title">Orientation</div>
            <div v-if="!orientation || !orientation.segments" class="info-empty">
              載入中…
            </div>
            <template v-else>
              <OrientationRose
                :bins="orientation.bins"
                :size="220"
                :tilt="orientation.tilt"
                :strength="orientation.strength"
              />
              <div class="info-rows rose-stats">
                <div class="info-row">
                  <span class="info-key">φ 秩序度</span><span>{{ orientation.phi.toFixed(3) }}</span>
                </div>
                <div class="info-row">
                  <span class="info-key">H<sub>w</sub> 方向熵</span>
                  <span>{{ orientation.hw.toFixed(3) }} nats</span>
                </div>
                <div class="info-row">
                  <span class="info-key">路線總長</span>
                  <span>{{ orientation.totalKm.toFixed(1) }} km</span>
                </div>
                <div class="info-row">
                  <span class="info-key">建議旋轉</span>
                  <span>{{ rotationHint(orientation) }}</span>
                </div>
                <div class="info-row">
                  <span class="info-key">方正度</span>
                  <span>{{ (orientation.strength * 100).toFixed(0) }}%</span>
                </div>
              </div>
              <div class="rose-note">
                依 Boeing (2019)：線段方位角分 36 格、雙向、以長度加權。
                φ = 0 為方向均勻（無序），φ = 1 為完美方格網。
                「建議旋轉」為把主軸對齊正南北／東西所需的角度（不改地圖，僅供參考）；
                方正度越高代表網路越接近單一方格、此建議越可靠。
              </div>
            </template>

            <!-- Skeleton computation rules (Map Adjust / D3.js view) -->
            <template v-if="isD3">
              <div class="section-title">骨架化規則</div>
              <div class="skeleton-rules">
                <p>不拉直、保留地理形狀，只做拓撲收縮與標記（connect 骨架）。</p>
                <p class="sk-sub">節點（依圖 degree）</p>
                <ul>
                  <li><span class="sk-dot" style="background:#e11d48" /> 紅：分歧／轉乘（degree≥3，或兩側路線不同的 degree-2）</li>
                  <li><span class="sk-dot" style="background:#2563eb" /> 藍：真端點（degree≤1）</li>
                  <li><span class="sk-dot sk-ring" /> 白：直通中段站（degree=2、兩側同路線；不變）</li>
                  <li><span class="sk-dot" style="background:#a855f7" /> 紫：頭尾共點／環線切斷點</li>
                  <li><span class="sk-dot" style="background:#ec4899" /> 粉紅：曲折邊的代表性轉折點</li>
                  <li><span class="sk-dot" style="background:#9ca3af" /> 灰：過長黑點段的分隔（每段 ≤4，G=⌊N/5⌋）</li>
                </ul>
                <p class="sk-sub">邊（收縮後底色）</p>
                <ul>
                  <li><span class="sk-line" style="background:#e11d48" /> 紅底：共線合併（≥2 路線；不切紫點）</li>
                  <li><span class="sk-line" style="background:#16a34a" /> 綠：環線（自環；1/3、2/3 切 2 紫）</li>
                  <li><span class="sk-line" style="background:#2563eb" /> 藍：頭尾共點（平行多重邊；1/2 切 1 紫）</li>
                  <li><span class="sk-line sk-plain" /> 一般：路線原色</li>
                </ul>
                <p class="rose-note">
                  依 skill <code>route-skeleton-connect</code>。座標一律照原地理、不移動；
                  黃色幾何交叉為 v2（metro 交叉多為轉乘站，罕見）。
                </p>
              </div>
            </template>

            <template v-if="!isD3">
            <div class="section-title">Audit</div>
            <div v-if="!auditInfo" class="info-empty">
              尚未執行資料驗證（npm run metro:audit）
            </div>
            <template v-else>
              <div class="audit-banner" :class="auditInfo.passed ? 'pass' : 'fail'">
                <CircleCheck v-if="auditInfo.passed" :size="14" />
                <CircleX v-else :size="14" />
                <span>{{ auditInfo.passed ? '資料驗證通過' : '資料驗證未通過' }}</span>
                <span v-if="auditInfo.audited_at" class="audit-date">
                  {{ auditInfo.audited_at.slice(0, 10) }}
                </span>
              </div>

              <div v-if="!auditInfo.passed && auditInfo.reasons?.length" class="audit-list fail">
                <div v-for="(r, i) in auditInfo.reasons" :key="i" class="audit-item">
                  <CircleX :size="12" class="audit-ic" /> {{ r }}
                </div>
              </div>
              <div v-if="auditInfo.covered_by" class="audit-list">
                <div class="audit-item">
                  <TriangleAlert :size="12" class="audit-ic warn" />
                  由 {{ auditInfo.covered_by }} 系統檔涵蓋（同都會區）
                </div>
              </div>
              <div v-if="auditInfo.warnings?.length" class="audit-list warn">
                <div v-for="(w, i) in auditInfo.warnings" :key="i" class="audit-item">
                  <TriangleAlert :size="12" class="audit-ic warn" /> {{ w }}
                </div>
              </div>
              <div v-if="auditChecks.length" class="audit-list">
                <div v-for="c in auditChecks.filter((c) => c.ok)" :key="c.id" class="audit-item ok">
                  <CircleCheck :size="12" class="audit-ic ok" /> {{ c.detail }}
                </div>
              </div>
            </template>
            </template>

            <div class="section-title">Links</div>
            <div class="link-list">
              <a v-if="wikipediaUrl" :href="wikipediaUrl" target="_blank" rel="noopener" class="info-link link-item">
                <ExternalLink :size="12" /> Wikipedia — {{ layer.city }} metro
              </a>
              <a v-if="websiteUrl" :href="websiteUrl" target="_blank" rel="noopener" class="info-link link-item">
                <ExternalLink :size="12" /> Official website
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
                <span v-if="ln.status === 'under_construction'" class="line-uc">建設中</span>
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

        <template v-else-if="activeTab === 'object'">
          <div v-if="!selectedEntries.length" class="obj-empty">
            點地圖上的物件以檢視其屬性
          </div>
          <!-- 路段：每條行經 route 的車站列表（依站序，與圖面一致——audit 不變式保證） -->
          <template v-for="rt in selectedRouteLists" :key="rt.route_id">
            <div class="obj-route-head">
              <span class="line-swatch" :style="{ background: rt.color }" />
              <span v-if="rt.ref" class="line-ref">{{ rt.ref }}</span>
              <span class="obj-route-name">{{ rt.name }}</span>
              <span class="obj-route-count">{{ rt.uniqueCount }} 站</span>
            </div>
            <ol class="obj-station-list">
              <li v-for="st in rt.stations" :key="st.station_id">{{ st.station_name }}</li>
            </ol>
          </template>
          <table v-if="selectedEntries.length" class="obj-table">
            <tbody>
              <tr v-for="row in selectedEntries" :key="row.key">
                <th class="obj-key">{{ row.key }}</th>
                <td class="obj-val">
                  <template v-if="row.isList">
                    <span v-if="!row.items.length">—</span>
                    <div v-for="(it, i) in row.items" :key="i" class="obj-li">{{ it }}</div>
                  </template>
                  <a v-else-if="row.href" :href="row.href" target="_blank" rel="noopener" class="info-link">
                    {{ row.value }} <ExternalLink :size="11" />
                  </a>
                  <template v-else>{{ row.value }}</template>
                </td>
              </tr>
            </tbody>
          </table>
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

/* Object tab: all properties of the clicked feature */
.obj-empty { color: hsl(var(--muted-foreground)); font-size: 12px; padding: 8px 2px; }
.obj-route-head {
  display: flex; align-items: center; gap: 6px;
  margin: 10px 0 4px; font-size: 12.5px; font-weight: 600; min-width: 0;
}
.obj-route-head:first-of-type { margin-top: 0; }
.obj-route-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.obj-route-count {
  margin-left: auto; flex-shrink: 0;
  font-weight: 400; font-size: 11px; color: hsl(var(--muted-foreground));
}
.obj-station-list {
  margin: 0 0 10px; padding-left: 26px; font-size: 12px; line-height: 1.7;
  color: hsl(var(--foreground));
}
.obj-station-list li::marker { color: hsl(var(--muted-foreground)); font-size: 10.5px; }
.obj-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.obj-table tr { border-bottom: 1px solid hsl(var(--border)); }
.obj-key {
  text-align: left;
  vertical-align: top;
  padding: 5px 8px 5px 2px;
  font-weight: 600;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
.obj-val {
  padding: 5px 2px;
  word-break: break-word;
  white-space: pre-wrap;
  font-variant-numeric: tabular-nums;
}
.obj-li { padding: 1px 0; }
.obj-li + .obj-li { border-top: 1px dotted hsl(var(--border)); }
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

/* Audit */
.audit-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: calc(var(--radius) - 2px);
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 8px;
}
.audit-banner.pass {
  background: hsl(142 71% 45% / 0.12);
  color: hsl(142 60% 40%);
}
.dark .audit-banner.pass { color: hsl(142 65% 55%); }
.audit-banner.fail {
  background: hsl(var(--destructive) / 0.12);
  color: hsl(var(--destructive));
}
.audit-date {
  margin-left: auto;
  font-weight: 400;
  font-size: 10.5px;
  opacity: 0.75;
}
.audit-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.audit-item {
  display: flex;
  gap: 6px;
  font-size: 11.5px;
  line-height: 1.45;
  color: hsl(var(--foreground));
}
.audit-item.ok { color: hsl(var(--muted-foreground)); }
.audit-ic { flex-shrink: 0; margin-top: 2px; }
.audit-ic.ok { color: hsl(142 60% 42%); }
.audit-ic.warn { color: hsl(38 92% 50%); }
.audit-list.fail .audit-ic { color: hsl(var(--destructive)); }

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
.line-uc {
  font-size: 10px;
  color: hsl(38 92% 40%);
  background: hsl(38 92% 50% / 0.15);
  border-radius: 4px;
  padding: 1px 5px;
  margin-left: auto;
  flex: none;
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
.skeleton-rules { font-size: 12px; line-height: 1.55; color: hsl(var(--foreground)); }
.skeleton-rules p { margin: 4px 0; }
.skeleton-rules .sk-sub { font-weight: 600; margin-top: 10px; color: hsl(var(--muted-foreground)); }
.skeleton-rules ul { list-style: none; margin: 4px 0; padding: 0; }
.skeleton-rules li { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
.sk-dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  border: 1.5px solid #3f3f46;
}
.sk-dot.sk-ring { background: #fff; }
.sk-line { width: 16px; height: 4px; border-radius: 2px; flex-shrink: 0; }
.sk-line.sk-plain { background: linear-gradient(90deg, #e11d48, #2563eb, #16a34a); }
.skeleton-rules .rose-note { margin-top: 10px; font-size: 11px; color: hsl(var(--muted-foreground)); }
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
.rose-stats { margin-top: 10px; }
.rose-stats sub { font-size: 0.75em; }
.rose-note {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.5;
  color: hsl(var(--muted-foreground));
}
</style>
