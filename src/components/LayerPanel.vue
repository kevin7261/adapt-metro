<script setup>
import { ref, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { openLayerTab, openAllGalleryTab, dockHandle } from '../stores/dockHandle'
import { layerData } from '../stores/layerData'
import { dragResize } from '../lib/dragResize'
import { openSkillDoc } from '../stores/skillHandle'
import { openLayerDoc } from '../stores/layerDocHandle'
import { docKeyForLayer } from '../stores/layerDocs'
import { assetUrl } from '../lib/assetUrl'
import MIcon from './MIcon.vue'

const store = useMapStore()

const typeIcons = { point: 'circle', line: 'polyline', polygon: 'hexagon', raster: 'image', metro: 'train', d3: 'polyline', hillclimb: 'terrain', rwd: 'route' }

// 2026-07 圈層改版：群組＝城市。Raw Maps / Map Adjust 直接列出；Straighten
// （原始/旋轉）與 RWD Maps（原始/旋轉 × 5 鏈＝10 層）收成可收合的子群組。
const RWD_COMPACT_ZH = { rect: '直角爬山', align: '軸對齊', ilp: '整數規劃', llm: 'LLM 對齊', hc: '基本' }
const rwdVariantZh = (l) =>
  (store.layers.find((s) => s.id === l.sourceLayerId)?.variant === 'rot' ? '旋轉' : '原始')
// 基底原始圖層名（metro→Metro Maps、railway→Railways、highway→Highways）。
const baseLabel = (l) => (l.railway ? 'Railways' : l.highway ? 'Highways' : 'Metro Maps')
// Metro Maps 基底層（地鐵、非鐵路／高速公路）——整城的錨點，不給單獨刪除。
const isMetroMaps = (l) => l.type === 'metro' && !l.railway && !l.highway
// 完整階段名（toast 用）：含子群組前綴＋變體。
function stageLabel(l) {
  if (l.type === 'd3') return 'Map Adjust'
  if (l.type === 'hillclimb') return `Straighten（${l.variant === 'rot' ? '旋轉' : '原始'}）`
  if (l.type === 'rwd') return `RWD Maps（${rwdVariantZh(l)}・${RWD_COMPACT_ZH[l.compact ?? 'hc']}）`
  return baseLabel(l)
}
// 圈層列顯示名：子群組內的列不重複群組名（Straighten 列＝原始/旋轉；RWD 列＝
// 變體・鏈）；基底／Map Adjust 用階段全名。
function rowLabel(l) {
  if (l.type === 'hillclimb') return l.variant === 'rot' ? '旋轉' : '原始'
  if (l.type === 'rwd') return `${rwdVariantZh(l)}・${RWD_COMPACT_ZH[l.compact ?? 'hc']}`
  if (l.type === 'd3') return 'Map Adjust'
  return baseLabel(l)
}
// 城市群組的 rows（layer / group）攤平成一維：sub-group header 在前、其下的
// 圖層列（depth 1）緊接（該子群組展開時才列出）。單一 v-for 即可渲染。
function flatRows(item) {
  const out = []
  for (const row of item.rows) {
    if (row.kind === 'layer') { out.push({ t: 'layer', key: row.layer.id, layer: row.layer, depth: 0 }); continue }
    out.push({ t: 'sub', key: row.id, sub: row, depth: 0 })
    if (!row.collapsed) for (const l of row.layers) out.push({ t: 'layer', key: l.id, layer: l, depth: 1 })
  }
  return out
}
// 一個城市群組（含子群組）的全部圖層——刪除／重算整城用。
function layersOf(item) {
  const out = []
  for (const row of item.rows) {
    if (row.kind === 'layer') out.push(row.layer)
    else out.push(...row.layers)
  }
  return out
}

// Skills surfaced PER LAYER ROW（attribute table 按鈕左邊）：只列「這個圖層的
// 計算實際用到」的 skill——metro 圖層＝metro 管線＋只有自己城市的規則（＋地標
// 層加 landmark）；railway / highway 圖層＝各自管線；Map Adjust＝骨架＋格網化；
// Straighten＝爬山＋全部後處理/movewise；RWD＝循環結果輸入＋畫線＋LLM 調整/評價。
const STAGE_SKILLS = {
  d3: ['route-skeleton-connect', 'route-skeleton-grid'],
  hillclimb: ['route-skeleton-grid', 'route-hillclimb', 'route-rect-polish',
    'route-axis-align', 'route-axis-ilp', 'route-llm-align', 'route-endpoint-move',
    'route-line-compact', 'route-grid-merge', 'route-span-cap', 'route-movewise-loop',
    'route-step-verify'],
  rwd: ['route-movewise-loop', 'route-rwd-draw', 'route-llm-grid', 'route-llm-eval'],
}
// 城市專屬規則：只有圖層 id 對得上的那個城市 skill 才顯示（tokyo 涵蓋全日本、
// germany 涵蓋德國五城）。
const CITY_SKILL = [
  ['metro-city-hongkong', /hong-kong/],  // 先於中國他城比對（id 同為 -chn-）
  ['metro-city-taipei', /taipei/],
  ['metro-city-tokyo', /-jpn-/],         // 東京 skill 涵蓋全日本城市
  ['metro-city-germany', /-deu-/],       // 德國五城
  ['metro-city-newyork', /new-york/],
  ['metro-city-beijing', /beijing/],
  ['metro-city-shanghai', /shanghai/],
  ['metro-city-chengdu', /chengdu/],
  ['metro-city-suzhou', /suzhou/],
]
const skillIndex = ref({})       // id -> description (for the dropdown subtitle)
const skillMenuFor = ref(null)   // layer id whose skill menu is open
onMounted(async () => {
  try {
    const res = await fetch(assetUrl('skills/index.json'))
    if (res.ok) for (const s of await res.json()) skillIndex.value[s.id] = s.description
  } catch { /* labels fall back to the id */ }
  document.addEventListener('mousedown', onSkillDocClick)
  document.addEventListener('mousedown', onImportMenuClick)
})
// Skills actually used by one layer's computation.
function layerSkills(layer) {
  let ids
  if (layer.type === 'metro') {
    if (layer.railway) ids = ['railway-osm-fetch']
    else if (layer.highway) ids = ['highway-osm-fetch', 'highway-audit', 'highway-cities']
    else {
      ids = ['metro-osm-fetch', 'metro-audit', 'metro-cities']
      const id = layer.id ?? ''
      for (const [skill, re] of CITY_SKILL) if (re.test(id)) { ids.push(skill); break }
      if (/-lm$/.test(id)) ids.push('landmark-osm-fetch')
    }
  } else {
    ids = STAGE_SKILLS[layer.type] ?? []
  }
  return ids.map((id) => ({ id, description: skillIndex.value[id] ?? '' }))
}
// The menu is teleported to <body> with fixed positioning so it isn't clipped
// by the layer tree's `overflow-y: auto`. skillMenuFor holds the layer id.
const skillMenuPos = ref({ top: 0, left: 0 })
function toggleSkillMenu(layer, e) {
  if (skillMenuFor.value === layer.id) { skillMenuFor.value = null; return }
  skillMenuFor.value = layer.id
  const r = e.currentTarget.getBoundingClientRect()
  skillMenuPos.value = { top: r.bottom + 4, left: Math.max(8, Math.min(r.right - 320, window.innerWidth - 328)) }
}
function pickSkill(id) {
  skillMenuFor.value = null
  openSkillDoc(id)
}
function onSkillDocClick(e) {
  if (skillMenuFor.value && !e.target.closest('.skill-wrap') && !e.target.closest('.skill-menu')) {
    skillMenuFor.value = null
  }
}

// 匯入下拉：一顆 + 按鈕，選 城市／鐵路／高速公路（各自開對應的匯入 modal）。
const IMPORT_OPTIONS = [
  { label: '地鐵', icon: 'train', dialog: 'import-quick' },
  { label: '鐵路', icon: 'directions_railway', dialog: 'import-railway-quick' },
  { label: '高速公路', icon: 'add_road', dialog: 'import-highway-quick' },
]
const importMenuOpen = ref(false)
function pickImport(dialog) {
  importMenuOpen.value = false
  store.ui.dialog = dialog
}
function onImportMenuClick(e) {
  if (importMenuOpen.value && !e.target.closest('.import-wrap')) importMenuOpen.value = false
}

// Click a layer → open (or focus) its editor tab, like opening a file in an IDE.
function openLayer(layer) {
  store.selectedLayerId = layer.id
  openLayerTab(layer)
}

// Overflow 選單動作（lookup table；template 傳常數字串）。
const OVERFLOW_ACTIONS = {
  // Zoom to layer 已移到 TopToolbar（對目前選取的圖層縮放）。
  // Toggle THIS layer's own attribute table (independent per layer); does
  // not touch the active tab / layer highlight.
  table: (layer) => store.toggleAttributeTable(layer.id),
  export: (layer) => exportLayer(layer),
  remove: (layer) => removeLayer(layer),
}
const overflow = (layer, action) => OVERFLOW_ACTIONS[action]?.(layer)

// Strip internal render-only props (e.g. `_c0.._c5` dash colours the map tab
// adds to features) so the exported GeoJSON matches the source file.
function cleanForExport(data) {
  // 非 GeoJSON FeatureCollection（衍生視圖的版面 JSON）沒有 features 陣列——原樣匯出。
  if (!Array.isArray(data?.features)) return data
  return {
    ...data,
    features: data.features.map((f) => {
      const p = f.properties
      if (!p || !Object.keys(p).some((k) => k.startsWith('_'))) return f
      const cleaned = {}
      for (const k of Object.keys(p)) if (!k.startsWith('_')) cleaned[k] = p[k]
      return { ...f, properties: cleaned }
    }),
  }
}

// Export = download the layer's GeoJSON. Resolution order: the layer's own
// loaded data (metro layers, file-imported d3 views) → its source layer's data
// (metro-backed d3 views) → fetch from the owning file.
async function fetchJson(file) {
  const res = await fetch(file)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
async function exportLayer(layer) {
  try {
    let data = layerData[layer.id]
    if (!data && layer.sourceLayerId) {
      const src = store.layers.find((l) => l.id === layer.sourceLayerId)
      if (src) data = layerData[src.id] ?? (src.file && await fetchJson(src.file))
    }
    if (!data && layer.file) data = await fetchJson(layer.file)
    if (!data) throw new Error('沒有可匯出的資料')
    // 只有捷運路網（檔案在 data/metro/systems/，含「城市＋地標」的 -lm 變體）
    // 存成 .geojson；其他一律 .json——highway（data/highway/）、railway
    // （data/railway/）雖然也走 type 'metro'，連同衍生的示意佈局視圖都算「其他」。
    const isGeojson = /\/data\/metro\/systems\//.test(layer.file ?? '')
    const ext = isGeojson ? 'geojson' : 'json'
    const mime = isGeojson ? 'application/geo+json' : 'application/json'
    const blob = new Blob([JSON.stringify(cleanForExport(data))], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${layer.name}.${ext}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    store.toast(`已下載 ${layer.name}.${ext}`)
  } catch (err) {
    store.toast(`匯出失敗：${err.message}`)
  }
}

// 拆除一個圖層：close its editor tab、free its loaded GeoJSON、drop from store。
function disposeLayer(l) {
  dockHandle.api?.getPanel(l.id)?.api.close()
  delete layerData[l.id]
  store.removeLayer(l.id)
}
// Remove = 拆除單一圖層。
function removeLayer(layer) {
  disposeLayer(layer)
  store.toast(`已移除圖層「${layer.name} ${stageLabel(layer)}」`)
}

// Remove every layer of one city group (含子群組), one summary toast.
function removeCityLayers(item) {
  const all = layersOf(item)
  if (!all.length) return
  for (const l of all) disposeLayer(l)
  store.toast(`已刪除「${item.group.label}」的 ${all.length} 個圖層`)
}

// 重新計算整個城市：關掉該城市所有分頁、清掉快取的 GeoJSON，再重開——tab
// 重新 mount 時 Raw Maps 會重新抓檔、Map Adjust / Straighten / RWD 會整條鏈
// 重新計算。
async function recomputeCity(item) {
  const all = layersOf(item)
  if (!all.length) return
  for (const l of all) {
    dockHandle.api?.getPanel(l.id)?.api.close()
    delete layerData[l.id]
  }
  await nextTick()
  for (const l of all) openLayerTab(l)
  store.toast(`重新計算「${item.group.label}」的 ${all.length} 個圖層…`)
}

/* ---- resize ---- */
const dragging = ref(false)
function startResize(e) {
  const startW = store.layerPanelWidth
  dragResize(e, {
    dragging,
    onMove: (dx) => {
      // 拖到極限：可一路拖到編輯區只剩一小條（不越過），另一邊縮到很小——不設固定上下限。
      const maxW = Math.max(120, window.innerWidth - 80)
      store.layerPanelWidth = Math.min(maxW, Math.max(44, startW + dx))
    },
  })
}
onBeforeUnmount(() => {
  dragging.value = false
  document.removeEventListener('mousedown', onSkillDocClick)
  document.removeEventListener('mousedown', onImportMenuClick)
})
</script>

<template>
  <!-- Collapsed rail -->
  <aside v-if="!store.ui.layerPanelOpen" class="rail" aria-label="Layers (collapsed)">
    <button class="btn-icon" title="Expand layers panel" @click="store.ui.layerPanelOpen = true">
      <MIcon name="left_panel_open" :size="15" />
    </button>
    <span class="rail-label">圖層</span>
  </aside>

  <template v-else>
    <aside class="layer-panel" aria-label="Layers" :style="{ width: store.layerPanelWidth + 'px' }">
      <div class="panel-header">
        <span class="panel-title">圖層</span>
        <div class="header-actions">
          <button class="btn-icon" title="Collapse panel" @click="store.ui.layerPanelOpen = false">
            <MIcon name="left_panel_close" :size="14" />
          </button>
        </div>
      </div>

      <!-- 最上面（靠右）：田 視圖 ＋ + 加入 下拉（地鐵／鐵路／高速公路） -->
      <div class="panel-actions">
        <button class="bar-btn" title="視圖畫廊（所有城市 · 所有地圖）" @click="openAllGalleryTab()">
          <MIcon name="grid_view" :size="14" />
          <span>視圖</span>
        </button>
        <div class="import-wrap">
          <button
            class="bar-btn"
            :class="{ active: importMenuOpen }"
            title="加入地鐵／鐵路／高速公路"
            @click.stop="importMenuOpen = !importMenuOpen"
          >
            <MIcon name="add" :size="15" />
            <span>加入</span>
          </button>
          <div v-if="importMenuOpen" class="menu-pop import-menu">
            <button
              v-for="o in IMPORT_OPTIONS"
              :key="o.dialog"
              class="menu-item"
              @click="pickImport(o.dialog)"
            >
              <MIcon :name="o.icon" :size="15" /> {{ o.label }}
            </button>
          </div>
        </div>
      </div>

      <div class="tree">
        <div v-if="!store.layerTree.length" class="tree-empty">
          按「+ 加入 → 地鐵」匯入一個城市（會建立該城市的 Metro Maps / Map
          Adjust / Straighten / RWD Maps 圖層）；「鐵路」「高速公路」匯入國家路網
        </div>
        <div v-for="item in store.layerTree" :key="item.group.id" class="group-card">
          <!-- 城市群組標題：chevron + folder + 城市名 + 刪除整組 -->
          <div class="group-header" @click="store.toggleCityCollapsed(item.group.id)">
            <MIcon :name="item.group.collapsed ? 'chevron_right' : 'expand_more'" :size="14" class="group-chevron" />
            <MIcon :name="item.group.collapsed ? 'folder' : 'folder_open'" :size="14" class="group-folder" />
            <span class="group-name">{{ item.group.label }}</span>
            <button
              class="btn-icon group-add"
              title="重新計算此城市全部圖層"
              @click.stop="recomputeCity(item)"
            >
              <MIcon name="autorenew" :size="14" />
            </button>
            <button
              class="btn-icon group-add group-del"
              title="刪除此城市全部圖層"
              @click.stop="removeCityLayers(item)"
            >
              <MIcon name="delete" :size="14" />
            </button>
          </div>

          <!-- 城市的管線列：Raw Maps / Map Adjust 直接列出；Straighten / RWD
               Maps 為可收合子群組（flatRows 已攤平：sub header + 展開的圖層列） -->
          <template v-if="!item.group.collapsed">
            <template v-for="row in flatRows(item)" :key="row.key">
              <!-- 子群組標題（Straighten / RWD Maps）：可收合 -->
              <div
                v-if="row.t === 'sub'"
                class="subgroup-header"
                @click="store.toggleCityCollapsed(row.sub.id)"
              >
                <MIcon :name="row.sub.collapsed ? 'chevron_right' : 'expand_more'" :size="13" class="sub-chevron" />
                <span class="subgroup-name">{{ row.sub.label }}</span>
                <span class="subgroup-count">{{ row.sub.layers.length }}</span>
              </div>

              <!-- 圖層列（子群組內的 depth 1 縮排） -->
              <div
                v-else
                class="layer-row"
                :class="{ selected: store.selectedLayerId === row.layer.id, nested: row.depth > 0 }"
                @click="openLayer(row.layer)"
              >
                <div class="layer-title">
                  <MIcon
                    :name="row.layer.railway ? 'directions_railway' : row.layer.highway ? 'add_road' : (typeIcons[row.layer.type] ?? 'circle')"
                    :size="13"
                    class="type-icon"
                    :style="row.layer.color ? { color: row.layer.color } : {}"
                  />
                  <span class="layer-name">{{ rowLabel(row.layer) }}</span>
                </div>

                <!-- stop only on the buttons — a click on the strip's empty area
                     must still bubble to the row and open the layer's tab -->
                <div class="layer-actions">
                  <!-- Zoom to layer 已移到上方 TopToolbar（對目前選取的圖層縮放）。 -->
                  <!-- 「?」說明：這個圖層的做法／JSON 格式／顯示方式（LayerDocViewer）。
                       放在 skill icon 前面（使用者要求）。 -->
                  <button
                    class="btn-icon"
                    title="這個圖層的做法／JSON 格式／顯示方式"
                    @click.stop="openLayerDoc(docKeyForLayer(row.layer), rowLabel(row.layer))"
                  >
                    <MIcon name="help" :size="14" />
                  </button>
                  <!-- Skills（此圖層階段用到的）— attribute table 左邊，同改版前位置 -->
                  <div class="skill-wrap">
                    <button
                      class="btn-icon"
                      :class="{ active: skillMenuFor === row.layer.id }"
                      title="Skills"
                      @click.stop="toggleSkillMenu(row.layer, $event)"
                    >
                      <MIcon name="auto_awesome" :size="14" />
                    </button>
                    <Teleport to="body">
                      <div
                        v-if="skillMenuFor === row.layer.id"
                        class="menu-pop skill-menu"
                        :style="{ position: 'fixed', top: skillMenuPos.top + 'px', left: skillMenuPos.left + 'px', right: 'auto' }"
                      >
                        <button
                          v-for="s in layerSkills(row.layer)"
                          :key="s.id"
                          class="menu-item skill-item"
                          @click="pickSkill(s.id)"
                        >
                          <MIcon name="auto_awesome" :size="13" class="skill-icon" />
                          <span class="skill-text">
                            <span class="skill-name">{{ s.id }}</span>
                            <span v-if="s.description" class="skill-desc">{{ s.description }}</span>
                          </span>
                        </button>
                      </div>
                    </Teleport>
                  </div>
                  <button
                    class="btn-icon"
                    :class="{ active: store.ui.attributeTableOpen[row.layer.id] }"
                    title="Attribute table"
                    @click.stop="overflow(row.layer, 'table')"
                  >
                    <MIcon name="table" :size="14" />
                  </button>
                  <button class="btn-icon" title="Export GeoJSON" @click.stop="overflow(row.layer, 'export')">
                    <MIcon name="download" :size="14" />
                  </button>
                  <!-- 只有主圖層（無 sourceLayerId）可單獨刪除；衍生子圖層不需刪除功能
                       （使用者裁決）——整城清理走群組標題的「刪除此城市全部圖層」。
                       Metro Maps 基底層是整城的錨點（刪它會孤立所有衍生層），不給單獨刪除。 -->
                  <button
                    v-if="!row.layer.sourceLayerId && !isMetroMaps(row.layer)"
                    class="btn-icon danger"
                    title="Remove layer"
                    @click.stop="overflow(row.layer, 'remove')"
                  >
                    <MIcon name="delete" :size="14" />
                  </button>
                </div>
              </div>
            </template>
          </template>
        </div>
      </div>
    </aside>

    <div
      class="resize-x"
      :class="{ dragging }"
      role="separator"
      aria-orientation="vertical"
      @pointerdown="startResize"
    />
  </template>
</template>

<style scoped>
.layer-panel {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-height: 0;
  background: hsl(var(--card));
  border-right: 1px solid hsl(var(--border));
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
  border-right: 1px solid hsl(var(--border));
}
.rail-label {
  writing-mode: vertical-rl;
  font-size: 11px;
  color: hsl(var(--muted-foreground));
}
.header-actions { display: flex; gap: 2px; }

/* 最上面的動作列：視圖畫廊按鈕＋ + 匯入下拉，靠右 */
.panel-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding: 8px 8px 0;
}
/* 田 視圖 ／ + 加入：中性配色（不用藍色），文字＋圖示 */
.bar-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  font-size: 12.5px;
  font-weight: 600;
  color: hsl(var(--foreground));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--card));
  white-space: nowrap;
}
.bar-btn:hover, .bar-btn.active { background: hsl(var(--accent)); }
.import-wrap { position: relative; flex-shrink: 0; }
/* 下拉選單：貼齊 + 按鈕右緣下方，不被面板裁切（動作列在最上方、無 overflow） */
.import-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  left: auto;
  z-index: 60;
  min-width: 140px;
}
.import-menu .menu-item { width: 100%; }

.tree { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.tree-empty {
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
  padding: 8px 6px;
  line-height: 1.7;
}

/* ---- group card (GeoLibre-style: chevron + folder + name) ---- */
.group-card {
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--muted) / 0.25);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: calc(var(--radius) - 4px);
  cursor: pointer;
  user-select: none;
}
.group-header:hover { background: hsl(var(--accent) / 0.6); }
.group-chevron { color: hsl(var(--muted-foreground)); flex-shrink: 0; }
.group-folder { color: hsl(var(--muted-foreground)); flex-shrink: 0; }
.group-name {
  flex: 1;
  font-size: 15px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-add { width: 22px; height: 22px; color: hsl(var(--muted-foreground)); }
.group-add:hover, .group-add.active { color: hsl(var(--primary)); background: hsl(var(--primary) / 0.12); }
.group-del:hover { color: hsl(var(--destructive)); background: hsl(var(--destructive) / 0.12); }

/* 子群組標題（Straighten / RWD Maps）：可收合，縮排一層對齊子群組列 */
.subgroup-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 6px 4px 10px;
  border-radius: calc(var(--radius) - 4px);
  cursor: pointer;
  user-select: none;
}
.subgroup-header:hover { background: hsl(var(--accent) / 0.6); }
.sub-chevron { color: hsl(var(--muted-foreground)); flex-shrink: 0; }
.subgroup-name {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  color: hsl(var(--muted-foreground));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subgroup-count {
  font-size: 10.5px;
  color: hsl(var(--muted-foreground) / 0.8);
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
}

.layer-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border-radius: calc(var(--radius) - 4px);
  cursor: pointer;
  border: 1px solid hsl(var(--border) / 0.6);
  background: hsl(var(--card));
}
/* 子群組內的圖層列：縮排，左緣加一條線標示層級 */
.layer-row.nested { margin-left: 12px; border-left: 2px solid hsl(var(--border)); }
.layer-row:hover { background: hsl(var(--accent) / 0.6); }
/* Active layer = the layer shown in the active editor tab. */
.layer-row.selected {
  background: hsl(var(--primary) / 0.18);
  border-color: hsl(var(--primary) / 0.55);
}
.layer-row.selected .layer-name { color: hsl(var(--primary)); font-weight: 600; }
.layer-title { display: flex; align-items: center; gap: 2px; min-width: 0; }
.type-icon { flex-shrink: 0; margin: 0 3px; }
.layer-name {
  flex: 1;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* second row: the actions, aligned bottom-right */
.layer-actions { display: flex; align-items: center; justify-content: flex-end; gap: 1px; }
.skill-wrap { position: relative; display: flex; }
.skill-menu {
  min-width: 260px;
  max-width: 340px;
  max-height: 70vh;
  overflow-y: auto;
}
.skill-item { align-items: flex-start; }
.skill-icon { flex-shrink: 0; margin-top: 2px; color: hsl(var(--primary)); }
.skill-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; white-space: normal; text-align: left; }
.skill-name { font-weight: 600; font-size: 12.5px; }
.skill-desc {
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.layer-actions .btn-icon { width: 24px; height: 24px; color: hsl(var(--muted-foreground)); }
.layer-actions .btn-icon:hover { color: hsl(var(--foreground)); }
.layer-actions .btn-icon.active {
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.12);
}
.layer-actions .btn-icon.danger { color: hsl(var(--destructive) / 0.7); }
.layer-actions .btn-icon.danger:hover {
  color: hsl(var(--destructive));
  background: hsl(var(--destructive) / 0.12);
}

@media (max-width: 768px) {
  .layer-panel { position: absolute; z-index: 50; top: 0; bottom: 0; left: 0; }
}
</style>
