<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
import { openLayerTab, openAllGalleryTab, dockHandle } from '../stores/dockHandle'
import { layerData, boundsOfGeojson } from '../stores/layerData'
import { dragResize } from '../lib/dragResize'
import { openSkillDoc } from '../stores/skillHandle'
import { assetUrl } from '../lib/assetUrl'
import MIcon from './MIcon.vue'

const store = useMapStore()

const typeIcons = { point: 'circle', line: 'polyline', polygon: 'hexagon', raster: 'image', metro: 'train', d3: 'polyline', hillclimb: 'terrain', rwd: 'route' }

// 2026-07 圈層改版：群組＝城市，列＝該城市的管線階段。列名顯示階段（不重複
// 城市名——群組標題已是城市）；Straighten / RWD 附變體。
const RWD_COMPACT_ZH = { rect: '直角爬山', align: '軸對齊', ilp: '整數規劃', llm: 'LLM 對齊', hc: '基本' }
function stageLabel(l) {
  if (l.type === 'd3') return 'Map Adjust'
  if (l.type === 'hillclimb') return `Straighten（${l.variant === 'rot' ? '旋轉' : '原始'}）`
  if (l.type === 'rwd') return `RWD Maps（${RWD_COMPACT_ZH[l.compact ?? 'hc']}）`
  return 'Raw Maps'
}

// Skills surfaced PER LAYER ROW（attribute table 按鈕左邊）：每列顯示該圖層
// 所屬階段用到的 skills——Raw Maps 列收 metro / railway / highway 三管線＋
// 城市規則；Map Adjust 列收骨架＋格網化；Straighten / RWD 各自的演算法 skill。
const STAGE_SKILLS = {
  metro: ['metro-osm-fetch', 'metro-audit', 'metro-cities',
    'railway-osm-fetch', 'highway-osm-fetch', 'highway-audit', 'highway-cities'],
  d3: ['route-skeleton-connect', 'route-skeleton-grid'],
  hillclimb: ['route-hillclimb', 'route-skeleton-grid'],
  rwd: ['route-rwd-draw', 'route-hillclimb'],
}
const skillIndex = ref({})       // id -> description (for the dropdown subtitle)
const skillMenuFor = ref(null)   // layer id whose skill menu is open
onMounted(async () => {
  try {
    const res = await fetch(assetUrl('skills/index.json'))
    if (res.ok) for (const s of await res.json()) skillIndex.value[s.id] = s.description
  } catch { /* labels fall back to the id */ }
  document.addEventListener('mousedown', onSkillDocClick)
})
// Skills for one layer row: its stage's general skills, plus (Raw Maps) every
// city rule sorted after them.
function layerSkills(layer) {
  const ids = [...(STAGE_SKILLS[layer.type] ?? [])]
  if (layer.type === 'metro') {
    for (const id of Object.keys(skillIndex.value).sort())
      if (id.startsWith('metro-city-') && !ids.includes(id)) ids.push(id)
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

// Click a layer → open (or focus) its editor tab, like opening a file in an IDE.
function openLayer(layer) {
  store.selectedLayerId = layer.id
  openLayerTab(layer)
}

// Overflow 選單動作（lookup table；template 傳常數字串）。
const OVERFLOW_ACTIONS = {
  zoom: (layer) => {
    openLayer(layer)
    const data = layerData[layer.id]
    const bbox = data && boundsOfGeojson(data)
    if (bbox) mapHandle.map?.fitBounds(bbox, { padding: 48, maxZoom: 13 })
  },
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
    const blob = new Blob([JSON.stringify(cleanForExport(data))], { type: 'application/geo+json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${layer.name}.geojson`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    store.toast(`已下載 ${layer.name}.geojson`)
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

// Remove every layer of one city group, one summary toast.
function removeCityLayers(item) {
  if (!item.children.length) return
  for (const l of [...item.children]) disposeLayer(l)
  store.toast(`已刪除「${item.group.label}」的 ${item.children.length} 個圖層`)
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

      <!-- 最上面：選各城市地圖（開啟現有的匯入 modal）＋視圖畫廊 -->
      <div class="panel-actions">
        <button class="city-pick-btn" title="選擇城市地圖（Metro Maps / Railways / Highways）" @click="store.ui.dialog = 'import-quick'">
          <MIcon name="add_location_alt" :size="14" />
          <span>選擇城市地圖</span>
        </button>
        <button class="btn-icon gallery-btn" title="視圖畫廊（所有城市 · 所有地圖）" @click="openAllGalleryTab()">
          <MIcon name="grid_view" :size="14" />
        </button>
      </div>

      <div class="tree">
        <div v-if="!store.layerTree.length" class="tree-empty">
          按「選擇城市地圖」匯入一個城市——會建立該城市的
          Raw Maps / Map Adjust / Straighten / RWD Maps 圖層
        </div>
        <div v-for="item in store.layerTree" :key="item.group.id" class="group-card">
          <!-- 城市群組標題：chevron + folder + 城市名 + 刪除整組 -->
          <div class="group-header" @click="store.toggleCityCollapsed(item.group.id)">
            <MIcon :name="item.group.collapsed ? 'chevron_right' : 'expand_more'" :size="14" class="group-chevron" />
            <MIcon :name="item.group.collapsed ? 'folder' : 'folder_open'" :size="14" class="group-folder" />
            <span class="group-name">{{ item.group.label }}</span>
            <button
              class="btn-icon group-add group-del"
              title="刪除此城市全部圖層"
              @click.stop="removeCityLayers(item)"
            >
              <MIcon name="delete" :size="14" />
            </button>
          </div>

          <!-- 城市的管線圖層：Raw Maps → Map Adjust → Straighten → RWD Maps -->
          <template v-if="!item.group.collapsed">
            <div
              v-for="layer in item.children"
              :key="layer.id"
              class="layer-row"
              :class="{ selected: store.selectedLayerId === layer.id }"
              @click="openLayer(layer)"
            >
              <div class="layer-title">
                <MIcon
                  :name="layer.railway ? 'directions_railway' : layer.highway ? 'add_road' : (typeIcons[layer.type] ?? 'circle')"
                  :size="13"
                  class="type-icon"
                  :style="layer.color ? { color: layer.color } : {}"
                />
                <span class="layer-name">{{ stageLabel(layer) }}</span>
              </div>

              <!-- stop only on the buttons — a click on the strip's empty area
                   must still bubble to the row and open the layer's tab -->
              <div class="layer-actions">
                <button
                  v-if="layer.type === 'metro'"
                  class="btn-icon"
                  title="Zoom to layer"
                  @click.stop="overflow(layer, 'zoom')"
                >
                  <MIcon name="zoom_in" :size="14" />
                </button>
                <!-- Skills（此圖層階段用到的）— attribute table 左邊，同改版前位置 -->
                <div class="skill-wrap">
                  <button
                    class="btn-icon"
                    :class="{ active: skillMenuFor === layer.id }"
                    title="Skills"
                    @click.stop="toggleSkillMenu(layer, $event)"
                  >
                    <MIcon name="auto_awesome" :size="14" />
                  </button>
                  <Teleport to="body">
                    <div
                      v-if="skillMenuFor === layer.id"
                      class="menu-pop skill-menu"
                      :style="{ position: 'fixed', top: skillMenuPos.top + 'px', left: skillMenuPos.left + 'px', right: 'auto' }"
                    >
                      <button
                        v-for="s in layerSkills(layer)"
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
                  :class="{ active: store.ui.attributeTableOpen[layer.id] }"
                  title="Attribute table"
                  @click.stop="overflow(layer, 'table')"
                >
                  <MIcon name="table" :size="14" />
                </button>
                <button class="btn-icon" title="Export GeoJSON" @click.stop="overflow(layer, 'export')">
                  <MIcon name="download" :size="14" />
                </button>
                <button class="btn-icon danger" title="Remove layer" @click.stop="overflow(layer, 'remove')">
                  <MIcon name="delete" :size="14" />
                </button>
              </div>
            </div>
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

/* 最上面的動作列：選城市地圖（開匯入 modal）＋視圖畫廊 */
.panel-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 0;
}
.city-pick-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 10px;
  font-size: 12.5px;
  font-weight: 600;
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.1);
  border: 1px solid hsl(var(--primary) / 0.5);
  border-radius: calc(var(--radius) - 2px);
  white-space: nowrap;
}
.city-pick-btn:hover { background: hsl(var(--primary) / 0.2); }
.gallery-btn {
  width: 30px;
  height: 30px;
  color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
}
.gallery-btn:hover { color: hsl(var(--primary)); background: hsl(var(--primary) / 0.12); }

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
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-add { width: 22px; height: 22px; color: hsl(var(--muted-foreground)); }
.group-add:hover, .group-add.active { color: hsl(var(--primary)); background: hsl(var(--primary) / 0.12); }
.group-del:hover { color: hsl(var(--destructive)); background: hsl(var(--destructive) / 0.12); }

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
