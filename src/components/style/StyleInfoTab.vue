<script setup>
import { ref, computed, onMounted } from 'vue'
import { layerData } from '../../stores/layerData'
import { prettyContinent, continentZh, loadSitesIndex } from '../../stores/metroCatalog'
import { URBANRAIL_CITIES, URBANRAIL_CONTINENTS } from '../../stores/urbanrail'
import { computeOrientation } from '../../stores/orientation'
import { getShapePreset } from '../../stores/paper/shapePresets.js'
import OrientationRose from '../OrientationRose.vue'
import OfficialMapTile from '../OfficialMapTile.vue'
import MIcon from '../MIcon.vue'
import './style-panel.css'

const props = defineProps({
  layer: { type: Object, required: true },
  context: { type: String, default: 'map' },
  viewKind: { type: String, default: 'metro' },
  spanApplied: { type: Number, default: null },
  hideStops: { type: Boolean, default: false },
  stopStat: { type: Object, default: null },
  layoutStatus: { type: Object, default: null },
  dataSource: { type: String, default: null },
})
const emit = defineEmits(['llm-rerun'])

const isD3 = computed(() => props.context === 'd3')
const isMapAdjust = computed(() => isD3.value && props.viewKind === 'map-adjust')
const showOrientation = computed(() => !isD3.value || isMapAdjust.value)
const hasSpan = computed(() => props.viewKind === 'hillclimb')

const toggleIn = (setRef, id) => {
  const next = new Set(setRef.value)
  next.has(id) ? next.delete(id) : next.add(id)
  setRef.value = next
}
const expandedInfoRoutes = ref(new Set())
const toggleInfoRoute = (id) => toggleIn(expandedInfoRoutes, id)
function routeStationList(ln) {
  const stops = (ln.stations ?? []).map((s) => ({ ...s, pass: !!s.pass }))
  return { stops, uniqueCount: new Set(stops.filter((s) => !s.pass).map((s) => s.station_id)).size }
}

const layer = computed(() => props.layer)
const isMetro = computed(() => layer.value?.type === 'metro' || layer.value?.metroLike === true)
const isHighway = computed(() => layer.value?.highway === true)

const meta = computed(() => layerData[layer.value.id]?.metro_system ?? null)
// ⑨形狀計算環形成方：這城市在規定表（shapePresets）有沒有設定要收成方的環形路段
const shapePreset = computed(() => getShapePreset(layer.value?.id))
const metroLines = computed(() => {
  const d = layerData[layer.value.id]
  if (!d) return []
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

const orientation = computed(() => {
  const d = layerData[layer.value.id]
  if (!isMetro.value || !d) return null
  return computeOrientation(d)
})
function rotationHint(o) {
  const t = o?.tilt ?? 0
  if (Math.abs(t) < 0.5) return '0°（已對齊正南北）'
  return `${Math.abs(t).toFixed(0)}° ${t > 0 ? '逆時針' : '順時針'}`
}

const auditInfo = computed(() => meta.value?.audit ?? null)
const auditChecks = computed(() => auditInfo.value?.checks ?? [])

const sitesIndex = ref(null)
onMounted(() => {
  if (isMetro.value) loadSitesIndex().then((v) => { sitesIndex.value = v }).catch(() => {})
})
const systemKey = computed(() => layer.value.file?.match(/systems\/(.+)\.geojson$/)?.[1] ?? null)
const officialSite = computed(() =>
  (systemKey.value && sitesIndex.value?.[systemKey.value]?.website) ||
  meta.value?.official_website || null)

const WIKI_TERM = {
  'oc-aus-sydney': '雪梨城市鐵路',
}
const wikiTerm = computed(() =>
  WIKI_TERM[layer.value?.id] ?? `${layer.value?.cityZh ?? layer.value?.city}地鐵`)
const wikipediaUrl = computed(() =>
  layer.value ? `https://zh.wikipedia.org/w/index.php?search=${encodeURIComponent(wikiTerm.value)}` : null)

const urbanrailUrl = computed(() => {
  const city = URBANRAIL_CITIES[layer.value.city]
  if (city) return `https://www.urbanrail.net/${city}`
  const path = URBANRAIL_CONTINENTS[layer.value.continent]
  return path ? `https://www.urbanrail.net/${path}` : 'https://www.urbanrail.net/'
})
const urbanrailLabel = computed(() =>
  URBANRAIL_CITIES[layer.value.city] ? layer.value.city : prettyContinent(layer.value.continent))

const systemForMap = computed(() => layer.value ? {
  file: layer.value.file,
  city: layer.value.city, cityZh: layer.value.cityZh,
  country: layer.value.country, countryZh: layer.value.countryZh,
} : null)
</script>

<template>
          <template v-if="isMetro">
            <!-- 城市標題已移到 style-body 頂端（所有 tab 共用），這裡不重複 -->
            <div class="info-rows">
              <div class="info-row">
                <span class="info-key">洲別</span><span>{{ continentZh(layer.continent) }}</span>
              </div>
              <div class="info-row"><span class="info-key">{{ isHighway ? '道路數' : '路線數' }}</span><span>{{ layer.lineCount }}</span></div>
              <div class="info-row"><span class="info-key">{{ isHighway ? '交流道數' : '車站數' }}</span><span>{{ layer.stationCount }}</span></div>
              <div v-if="meta?.operator" class="info-row">
                <span class="info-key">營運單位</span><span>{{ meta.operator }}</span>
              </div>
              <div v-if="officialSite" class="info-row">
                <span class="info-key">官網</span>
                <a :href="officialSite" target="_blank" rel="noopener" class="info-link">
                  {{ officialSite.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') }}
                  <MIcon name="open_in_new" :size="11" />
                </a>
              </div>
              <div v-if="!isHighway && wikipediaUrl" class="info-row">
                <span class="info-key">Wikipedia</span>
                <a :href="wikipediaUrl" target="_blank" rel="noopener" class="info-link">
                  {{ wikiTerm }} <MIcon name="open_in_new" :size="11" />
                </a>
              </div>
              <div v-if="!isHighway" class="info-row">
                <span class="info-key">urbanrail</span>
                <a :href="urbanrailUrl" target="_blank" rel="noopener" class="info-link">
                  UrbanRail.Net：{{ urbanrailLabel }} <MIcon name="open_in_new" :size="11" />
                </a>
              </div>
              <!-- 官方路線圖：urbanrail 下方，一列連結（同 urbanrail 樣式），點擊開燈箱 -->
              <div v-if="!isHighway && systemForMap" class="info-row">
                <span class="info-key">官方路線圖</span>
                <OfficialMapTile :system="systemForMap" link />
              </div>
              <!-- ⑨ 環形成方：規定表有設定就顯示該環形路線名，沒有就說「沒有」 -->
              <div v-if="!isHighway" class="info-row">
                <span class="info-key">環形成方</span>
                <span v-if="shapePreset">{{ shapePreset.label }}（收成方形，⑨形狀計算）</span>
                <span v-else class="info-muted">沒有</span>
              </div>
              <div v-if="meta?.osm_networks?.length" class="info-row">
                <span class="info-key">路網</span>
                <span>{{ meta.osm_networks.join(', ') }}</span>
              </div>
            </div>

            <template v-if="showOrientation">
            <div class="section-title">方位</div>
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
                  <span class="info-key">路線總長</span>
                  <span>{{ orientation.totalKm.toFixed(1) }} km</span>
                </div>
                <div class="info-row">
                  <span class="info-key">建議旋轉</span>
                  <span>{{ rotationHint(orientation) }}</span>
                </div>
              </div>
              <div class="rose-note">
                <strong>玫瑰圖的算法</strong>：把每條線段的羅盤方位角（0°=北、順時針）連同反向
                （+180°），依<strong>線段長度</strong>加權，分進 36 個 10° 方向格；每根 wedge 的半徑
                ∝ 該方向的長度佔比（面積等比、雙向對稱）。共用主幹只算一條、不乘路線數。
                <br />
                <strong>φ 秩序度</strong>（Boeing 2019 方向熵）：φ = 0 方向均勻（無序），
                φ = 1 完美方格網——越高代表越接近單一方格、旋轉建議越可靠。
                <br />
                <strong>建議旋轉的算法</strong>：<strong>只取玫瑰圖<span class="rose-red">紅色（最長）</span>那格內的線</strong>，
                以各自長度為權重、平均它們的角度（精確值，非取格子中心），再轉到<strong>最近</strong>的水平／垂直
                （摺 90°，轉幅 ≤ 45°，即最小旋轉）。其他方向不參與。此角度不改地圖。
              </div>
            </template>
            </template>

            <!-- 圖例：Metro Maps／Map Adjust／Straighten／RWD 共用——路線＋節點＋注意路段（Highlight）整合顯示 -->
            <template v-if="isMetro && !isHighway">
              <div class="section-title">圖例</div>
              <div class="map-legend skeleton-rules">
                <p class="sk-sub">路線</p>
                <ul>
                  <li><span class="sk-line sk-plain" /> 單線實線（route 原色）</li>
                  <li><span class="sk-line sk-dash" /> 多線交錯虛線（共線走廊）</li>
                  <li v-if="viewKind === 'hillclimb' || viewKind === 'rwd'"><span class="sk-line" style="background:#3b82f6" /> 藍線：示意網格</li>
                </ul>
                <p class="sk-sub">節點</p>
                <ul>
                  <li><span class="sk-dot" style="background:#e11d48" /> 紅：分歧／轉乘</li>
                  <li><span class="sk-dot" style="background:#2563eb" /> 藍：端點</li>
                  <li><span class="sk-dot sk-ring" /> 白：直通站</li>
                  <li><span class="sk-dot" style="background:#a855f7" /> 紫：切斷點</li>
                  <li><span class="sk-dot" style="background:#ec4899" /> 粉紅：轉折點</li>
                  <li><span class="sk-dot" style="background:#9ca3af" /> 灰：分隔點</li>
                  <li><span class="sk-dot" style="background:#eab308" /> 黃：路線交叉</li>
                </ul>
                <p class="sk-sub">注意路段（線底下襯底）</p>
                <ul>
                  <li><span class="sk-hl" style="background:#e11d48" /> 紅：共線合併</li>
                  <li><span class="sk-hl" style="background:#16a34a" /> 綠：環線</li>
                  <li><span class="sk-hl" style="background:#2563eb" /> 藍：頭尾共點</li>
                  <li><span class="sk-hl" style="background:#7c3aed" /> 紫：紅＋藍疊色（共線又頭尾共點）</li>
                  <li v-if="viewKind === 'rwd'"><span class="sk-hl" style="background:#f59e0b" /> 琥珀：殘留衝突</li>
                </ul>
                <p v-if="isMapAdjust" class="rose-note">
                  Map Adjust 骨架化後才套用節點色與 注意路段；依 skill <code>route-skeleton-connect</code>，
                  座標照原地理、不移動。
                </p>
                <p v-else-if="!isD3" class="rose-note">
                  Metro Maps 以白點＋路線原色為主；節點色與 注意路段 見 Map Adjust／Straighten／RWD。
                </p>
              </div>
            </template>

            <!-- Map Adjust：骨架化做法說明（圖例已整合在上方，這裡只留規則摘要） -->
            <template v-if="isMapAdjust">
              <div class="section-title">骨架化規則</div>
              <div class="skeleton-rules">
                <p>不拉直、保留地理形狀，只做拓撲收縮與標記（connect 骨架）。節點依 degree 分色；邊分類以 注意路段 襯底標示（見上方圖例）。</p>
                <p class="rose-note">
                  紅＝分歧／轉乘（degree≥3，或兩側路線不同的 degree-2）；藍＝真端點（degree≤1）；
                  白＝直通中段；紫＝頭尾共點／環線切斷；粉紅＝代表性轉折（曲折度&gt;1.25）；
                  灰＝過長段分隔（每段 ≤4）。注意路段：共線紅／環線綠／頭尾共點藍；紅藍重疊呈紫。
                </p>
              </div>
            </template>

            <template v-if="!isD3">
            <div class="section-title">資料驗證</div>
            <div v-if="!auditInfo" class="info-empty">
              尚未執行資料驗證（npm run metro:audit）
            </div>
            <template v-else>
              <div class="audit-banner" :class="auditInfo.passed ? 'pass' : 'fail'">
                <MIcon name="check_circle" v-if="auditInfo.passed" :size="14" />
                <MIcon name="cancel" v-else :size="14" />
                <span>{{ auditInfo.passed ? '資料驗證通過' : '資料驗證未通過' }}</span>
                <span v-if="auditInfo.audited_at" class="audit-date">
                  {{ auditInfo.audited_at.slice(0, 10) }}
                </span>
              </div>

              <div v-if="!auditInfo.passed && auditInfo.reasons?.length" class="audit-list fail">
                <div v-for="(r, i) in auditInfo.reasons" :key="i" class="audit-item">
                  <MIcon name="cancel" :size="12" class="audit-ic" /> {{ r }}
                </div>
              </div>
              <div v-if="auditInfo.covered_by" class="audit-list">
                <div class="audit-item">
                  <MIcon name="warning" :size="12" class="audit-ic warn" />
                  由 {{ auditInfo.covered_by }} 系統檔涵蓋（同都會區）
                </div>
              </div>
              <div v-if="auditInfo.warnings?.length" class="audit-list warn">
                <div v-for="(w, i) in auditInfo.warnings" :key="i" class="audit-item">
                  <MIcon name="warning" :size="12" class="audit-ic warn" /> {{ w }}
                </div>
              </div>
              <div v-if="auditChecks.length" class="audit-list">
                <div v-for="c in auditChecks.filter((c) => c.ok)" :key="c.id" class="audit-item ok">
                  <MIcon name="check_circle" :size="12" class="audit-ic ok" /> {{ c.detail }}
                </div>
              </div>
            </template>
            </template>

            <!-- 路線 list: only on the Metro Maps (MapLibre) view -->
            <template v-if="!isD3">
              <div class="section-title">路線</div>
              <div v-if="!metroLines.length" class="info-empty">載入中…</div>
              <div v-else class="line-list">
                <template v-for="ln in metroLines" :key="ln.route_id">
                  <button type="button" class="line-row line-row-toggle"
                    :aria-expanded="expandedInfoRoutes.has(ln.route_id)"
                    @click="toggleInfoRoute(ln.route_id)">
                    <MIcon :name="expandedInfoRoutes.has(ln.route_id) ? 'expand_more' : 'chevron_right'" class="obj-route-caret" />
                    <span class="line-swatch" :style="{ background: ln.route_color ?? '#e11d48' }" />
                    <span v-if="ln.route_ref" class="line-ref">{{ ln.route_ref }}</span>
                    <span class="line-name">
                      {{ ln.route_name ?? ln.route_name_local ?? '—' }}
                    </span>
                    <span v-if="ln.status === 'under_construction'" class="line-uc">建設中</span>
                    <span class="obj-route-count">{{ routeStationList(ln).uniqueCount }} 站</span>
                  </button>
                  <ol v-if="expandedInfoRoutes.has(ln.route_id)" class="obj-station-list">
                    <li v-for="(st, i) in routeStationList(ln).stops" :key="`${st.station_id}-${i}`"
                      :class="{ 'st-pass': st.pass }">
                      <span v-if="st.code" class="obj-st-code">{{ st.code }}</span>{{ st.station_name
                      }}<span v-if="st.pass" class="obj-pass-tag">pass</span>
                    </li>
                  </ol>
                </template>
              </div>
            </template>

            <!-- 顏色點間最大跨距（SPAN_CAP）：只 Straighten——控制在地圖上方工具列，
                 這裡只留說明。 -->
            <template v-if="hasSpan">
              <div class="section-title">顏色點間最大跨距</div>
              <p class="weight-hint">
                水平／垂直最大化的每一次移動，都不得讓一條線段的兩個顏色點在網格上橫跨
                超過這個格數（Chebyshev＝max(|Δx|,|Δy|)）——避免某條線被拉成過長的斜段。
                本來就超標的舊長段只准縮短、不准再拉長。
              </p>
              <p class="weight-hint">
                目前套用值 <b>{{ spanApplied ?? 3 }}</b> 格。上方工具列改「線段最大跨距」的數字，
                即以新值重跑水平垂直最大化（不必再按按鈕）。
              </p>
            </template>

            <!-- 版面（權重驅動）：RWD 視圖——控制與即時診斷（最小站距／畫布／已隱藏）
                 已移到地圖上方工具列第 2 排，這裡只留說明與被隱藏的站清單。 -->
            <template v-if="viewKind === 'rwd'">
              <div class="section-title">版面（權重驅動）</div>
              <p class="weight-hint">
                版面簡化不改拓撲：用各欄／列最忙路段的流量（weight）決定該欄多寬、該列多高
                ——主走廊變寬、次要區壓窄，外框固定，路線在新像素座標重畫成 H/V/45°。
                模式切換、顯示權重數字、隨機權重、自動隱藏白點與最小站距等控制，都在地圖
                上方工具列的第 2 排。
              </p>
              <p class="weight-hint">
                「隨機權重」每按一次整表重抽：每個沿路相鄰站對抽 1–9，反等比（機率 ∝ 1/2ᵏ）
                ——數字越小越常見，少數主走廊、多數次要邊。「每5秒隨機權重」開啟後每 5 秒
                整表重抽一次，network 點跟著新版面變形（自動切到權重模式）。
              </p>
              <p class="weight-hint">
                自動隱藏白點：由最擠的路段決定一個全域 weight 差 cutoff T（升高 T 直到最擠段
                均分後站距 ≥「最小站距」），然後全圖任何白點（直通站）只要左右兩段 weight 差
                ≤ T 就一律隱藏（相鄰標籤合併取 max）。彩色錨點（紅／藍／黃）不會被藏。
              </p>
              <div v-if="hideStops && stopStat && stopStat.hidden > 0" class="hidden-list">
                <div class="hidden-list-title">被隱藏的站（{{ stopStat.hidden }}）</div>
                <ol class="hidden-list-items">
                  <li v-for="(n, i) in stopStat.hiddenNames" :key="i">{{ n }}</li>
                </ol>
              </div>
            </template>

            <!-- 資料儲存方式：GeoJSON（原始地理資料）＋ JSON（預算佈局快取）的
                 詳細欄位與座標系統說明，對所有 metro 圖層常駐（可折疊）。 -->
            <div class="section-title">資料儲存方式</div>
            <details class="data-format">
              <summary><b>GeoJSON</b>：原始地理資料（<code>metro-maps/&lt;洲&gt;/&lt;國&gt;/&lt;洲2碼&gt;-&lt;IOC3碼&gt;-&lt;城&gt;.geojson</code>＝Metro Maps）</summary>
              <div class="df-body">
                <p>
                  標準 <code>FeatureCollection</code>，另加一個非標準頂層 <code>metro_system</code>
                  中繼資料物件。座標為 <b>WGS84 經緯度</b>（<code>[經度, 緯度]</code>）。
                  每檔＝一城一系統（桃園等併入母城）；另有全球彙整檔
                  <code>metro_lines.geojson</code>／<code>metro_stations.geojson</code>。
                </p>
                <p class="df-sub">車站 feature（<code>Point</code>）</p>
                <p>
                  <code>station_id</code>、<code>station_name</code>（在地語言）、
                  <code>station_name_local</code>／<code>station_name_en</code>、
                  <code>lines</code>（停靠路線 refs，<b>至少一條</b>）、
                  <code>codes</code>（官方站碼，如台北車站 <code>[A1, BL12, R10]</code>）、
                  <code>routes</code>（每項 <code>{ ref, name, pass? }</code>）、
                  <code>station_role</code>（interchange／terminus／normal）、
                  <code>is_interchange</code>／<code>is_terminus</code>、
                  <code>merged_from</code>／<code>merged_names</code>（共站合併來源）、
                  <code>station_degree</code>、<code>pass_count</code>、
                  <code>wikidata</code>／<code>wikipedia</code>。
                  <b>每站輸出完全相同的欄位集</b>（缺值填 null／false）。
                </p>
                <p class="df-sub">路段 feature（<code>MultiLineString</code>）</p>
                <p>
                  頂層 <code>seg_id</code>、<code>route_count</code>、<code>route_refs</code>、
                  <code>route_colors</code>（<b>無單數 <code>route_color</code></b>——一段可多線共用）；
                  <code>routes</code> 為 list，每條記 <code>route_id</code>／<code>route_name</code>／
                  <code>route_ref</code>／<code>route_color</code>（<code>#rrggbb</code>）／
                  <code>network</code>／<code>wikidata</code>／<code>osm_route_ids</code>，及
                  <code>stations</code>（該線完整行經序，每項 <code>{ station_id, station_name, code?, pass? }</code>，
                  <code>pass:true</code>＝行經不停靠）。幾何＝各停靠站依站序、吸附到<b>共站合併後的車站點</b>
                  連成的折線（示意，非真實軌道線形；重疊走廊只畫一條）。
                </p>
                <p class="df-sub">metro_system（頂層中繼資料）</p>
                <p>
                  <code>continent</code>／<code>country</code>／<code>city</code>（由車站中心點反向地理編碼取得，檔名即由此組成）、
                  <code>osm_networks</code>、<code>operator</code>、
                  <code>official_website</code>／<code>official_map</code>、<code>wikidata</code>、
                  <code>line_count</code>／<code>segment_count</code>／<code>station_count</code>、
                  <code>audit</code>（逐城市驗證結果，未跑 audit 時為 null，即上方「資料驗證」）。
                </p>
              </div>
            </details>
            <details class="data-format">
              <summary><b>JSON</b>：預算好的版面佈局快取（<code>views/&lt;id&gt;.json</code> 等）</summary>
              <div class="df-body">
                <p>
                  <b>不是原始資料</b>，而是把 GeoJSON 的經緯度投影＋演算法處理後、供 D3 直接畫的
                  <b>畫布佈局</b>——座標是 <code>W×H</code> 畫布內的 <b>pixel</b>（非經緯度）。
                </p>
                <p>
                  每檔含：<code>id</code>／<code>file</code>（指回來源 geojson）、
                  <code>city</code>／<code>country</code>／<code>cityZh</code>／<code>countryZh</code>／<code>continent</code>、
                  <code>line_count</code>／<code>station_count</code>、
                  <code>tilt</code>／<code>canRotate</code>（建議旋轉角）、
                  <code>W</code>／<code>H</code>（畫布尺寸）、
                  <code>views</code>（各種佈局），及 <code>_fp</code> 指紋
                  （<b>來源 geojson 一變就重算</b>）。
                </p>
                <p>
                  <code>views</code> 每個鍵是一種佈局（<code>original</code>／<code>rotated</code>／
                  <code>skeleton</code>／<code>grid-orig-pre</code>／<code>grid-*-post</code>…），
                  值含 <code>lines</code>（每條 <code>{ d: SVG path 字串, color }</code>）與對應點資料。
                </p>
                <p>
                  各後續演算法階段資料夾名＝圖層名：
                  <code>map-adjust/</code>（Map Adjust）、
                  <code>straighten/</code>（Straighten 畫廊）、
                  <code>rwd-maps/</code>（RWD Maps 畫廊）、
                  <code>straighten-llm/</code>（LLM 對齊）、
                  <code>straighten-shape/</code>（LLM 成方）、
                  <code>straighten-cells/</code>（互動整數格）；
                  <code>index.json</code> 存全站系統清單與覆蓋率統計。
                </p>
              </div>
            </details>
          </template>
          <div v-else class="info-empty">此圖層沒有 metro 資訊。</div>

          <!-- 原 footer 左側：運算狀態＋資料來源（D3／Straighten／RWD） -->
          <template v-if="isD3 && (layoutStatus || dataSource)">
            <div class="section-title">運算狀態</div>
            <p v-if="layoutStatus" class="layout-status">
              {{ layoutStatus.text }}
              <button
                v-if="layoutStatus.llmRerun"
                type="button"
                class="llm-rerun"
                title="重新啟動 headless Claude Code 繼續改善"
                @click="emit('llm-rerun')"
              >重跑</button>
            </p>
            <div v-if="dataSource" class="info-rows">
              <div class="info-row"><span class="info-key">資料來源</span><span>{{ dataSource }}</span></div>
            </div>
          </template>
</template>
