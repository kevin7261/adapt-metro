<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
import { openLayerTab, openGalleryTab, dockHandle } from '../stores/dockHandle'
import { layerData, boundsOfGeojson } from '../stores/layerData'
import { openSkillDoc } from '../stores/skillHandle'
import { assetUrl } from '../lib/assetUrl'
import MIcon from './MIcon.vue'

const store = useMapStore()

const typeIcons = { point: 'circle', line: 'polyline', polygon: 'hexagon', raster: 'image', metro: 'train', d3: 'polyline', hillclimb: 'terrain' }
const typeBadges = { metro: 'METRO', d3: 'D3', hillclimb: 'HC' }

// Skills exposed per layer type (moved off the top toolbar into each layer):
// Metro Maps layers get the two general data-pipeline skills + the cities index;
// Map Adjust gets the skeleton + gridding skills; Hill Climbing its own.
const LAYER_SKILLS = {
  metro: ['metro-osm-fetch', 'metro-audit', 'metro-cities'],
  d3: ['route-skeleton-connect', 'route-skeleton-grid'],
  hillclimb: ['route-hillclimb', 'route-skeleton-grid'],
}
// 城市 → 該城專屬 skill（讓每個城市的圖層在下拉多顯示自己的規則 skill）。
const CITY_SKILL = {
  Taipei: 'metro-city-taipei',
  Tokyo: 'metro-city-tokyo', Osaka: 'metro-city-tokyo',
  Berlin: 'metro-city-germany', Hamburg: 'metro-city-germany',
  Munich: 'metro-city-germany', Frankfurt: 'metro-city-germany',
  Nuremberg: 'metro-city-germany',
  'New York City': 'metro-city-newyork',
  'Hong Kong': 'metro-city-hongkong', Shanghai: 'metro-city-shanghai',
  Beijing: 'metro-city-beijing', Chengdu: 'metro-city-chengdu',
  Suzhou: 'metro-city-suzhou',
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
function layerSkills(layer) {
  const ids = [...(LAYER_SKILLS[layer.type] ?? [])]
  if (layer.type === 'metro') {
    // 使用者：所有城市的 skill 都要在下拉。當前城市的 skill 排最前，其餘城市依序列出。
    const cur = CITY_SKILL[layer.city]
    if (cur && !ids.includes(cur)) ids.push(cur)
    for (const id of Object.keys(skillIndex.value).sort())
      if (id.startsWith('metro-city-') && !ids.includes(id)) ids.push(id)
  }
  return ids.map((id) => ({ id, description: skillIndex.value[id] ?? '' }))
}
// The menu is teleported to <body> with fixed positioning so it isn't clipped
// by the layer tree's `overflow-y: auto`.
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

// Add a D3.js view: a dialog picks the source metro layer (fixed afterwards).
function addD3() {
  store.ui.dialog = 'add-d3'
}

// Click a layer → open (or focus) its editor tab, like opening a file in an IDE.
function openLayer(layer) {
  store.selectedLayerId = layer.id
  openLayerTab(layer)
}

function overflow(layer, action) {
  if (action === 'zoom') {
    openLayer(layer)
    const data = layerData[layer.id]
    const bbox = data && boundsOfGeojson(data)
    if (bbox) mapHandle.map?.fitBounds(bbox, { padding: 48, maxZoom: 13 })
  } else if (action === 'table') {
    // Toggle THIS layer's own attribute table (independent per layer); does
    // not touch the active tab / layer highlight.
    store.toggleAttributeTable(layer.id)
  } else if (action === 'export') {
    exportLayer(layer)
  } else if (action === 'remove') {
    removeLayer(layer)
  }
}

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

// Remove = drop the layer, close its editor tab, free its loaded GeoJSON.
function removeLayer(layer) {
  dockHandle.api?.getPanel(layer.id)?.api.close()
  delete layerData[layer.id]
  store.removeLayer(layer.id)
  store.toast(`已移除圖層「${layer.name}」`)
}

// Remove every layer in a group (close each tab, free its data), one summary toast.
function removeGroupLayers(groupId, label) {
  const inGroup = store.layers.filter((l) => l.groupId === groupId)
  if (!inGroup.length) return
  for (const l of inGroup) {
    dockHandle.api?.getPanel(l.id)?.api.close()
    delete layerData[l.id]
    store.removeLayer(l.id)
  }
  store.toast(`已刪除「${label}」群組的 ${inGroup.length} 個圖層`)
}

/* ---- resize ---- */
const dragging = ref(false)
function startResize(e) {
  dragging.value = true
  const startX = e.clientX
  const startW = store.layerPanelWidth
  const move = (ev) => {
    store.layerPanelWidth = Math.min(560, Math.max(180, startW + ev.clientX - startX))
  }
  const up = () => {
    dragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
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
    <span class="rail-label">Layers</span>
  </aside>

  <template v-else>
    <aside class="layer-panel" aria-label="Layers" :style="{ width: store.layerPanelWidth + 'px' }">
      <div class="panel-header">
        <span class="panel-title">Layers</span>
        <div class="header-actions">
          <button class="btn-icon" title="Collapse panel" @click="store.ui.layerPanelOpen = false">
            <MIcon name="left_panel_close" :size="14" />
          </button>
        </div>
      </div>

      <div class="tree">
        <div v-for="item in store.layerTree" :key="item.group.id" class="group-card">
          <!-- Group header: chevron + folder + name (+ add for the D3 group) -->
          <div class="group-header" @click="item.group.collapsed = !item.group.collapsed">
            <MIcon :name="item.group.collapsed ? 'chevron_right' : 'expand_more'" :size="14" class="group-chevron" />
            <MIcon :name="item.group.collapsed ? 'folder' : 'folder_open'" :size="14" class="group-folder" />
            <span class="group-name">{{ item.group.label }}</span>
            <span class="group-count">{{ item.children.length }}</span>
            <button
              v-if="item.children.length"
              class="btn-icon group-add group-del"
              title="刪除此群組全部圖層"
              @click.stop="removeGroupLayers(item.group.id, item.group.label)"
            >
              <MIcon name="delete" :size="14" />
            </button>
            <button
              v-if="item.group.id === 'metro-maps'"
              class="btn-icon group-add"
              title="Metro Maps gallery（全部城市縮圖）"
              @click.stop="openGalleryTab()"
            >
              <MIcon name="grid_view" :size="14" />
            </button>
            <button
              v-if="item.group.id === 'metro-maps'"
              class="btn-icon group-add"
              title="Import metro map"
              @click.stop="store.ui.dialog = 'import-quick'"
            >
              <MIcon name="add" :size="14" />
            </button>
            <button
              v-if="item.group.id === 'd3'"
              class="btn-icon group-add"
              title="Add D3.js view"
              @click.stop="addD3()"
            >
              <MIcon name="add" :size="14" />
            </button>
            <button
              v-if="item.group.id === 'hillclimb'"
              class="btn-icon group-add"
              title="Add Hill Climbing view（來源：Map Adjust 格網化後）"
              @click.stop="store.ui.dialog = 'add-hillclimb'"
            >
              <MIcon name="add" :size="14" />
            </button>
          </div>

          <!-- Group children -->
          <template v-if="!item.group.collapsed">
            <div v-if="!item.children.length" class="group-empty">
              {{ item.group.id === 'd3' ? '按 + 新增 D3.js 視圖'
                : item.group.id === 'hillclimb' ? '按 + 從 Map Adjust 的「格網化後」建立 Hill Climbing 視圖'
                : '用 Import 匯入 metro map' }}
            </div>
            <div
              v-for="layer in item.children"
              :key="layer.id"
              class="layer-row"
              :class="{ selected: store.selectedLayerId === layer.id }"
              @click="openLayer(layer)"
            >
              <div class="layer-title">
                <MIcon
                  :name="typeIcons[layer.type] ?? 'circle'"
                  :size="13"
                  class="type-icon"
                  :style="layer.color ? { color: layer.color } : {}"
                />
                <span class="layer-name">{{ layer.name }}</span>
                <span class="type-badge">{{ typeBadges[layer.type] ?? layer.type }}</span>
              </div>

              <!-- stop only on the buttons — a click on the strip's empty area
                   must still bubble to the row and open the layer's tab -->
              <div class="layer-actions">
                <div v-if="LAYER_SKILLS[layer.type]" class="skill-wrap">
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
                  v-if="layer.type === 'metro'"
                  class="btn-icon"
                  title="Zoom to layer"
                  @click.stop="overflow(layer, 'zoom')"
                >
                  <MIcon name="zoom_in" :size="14" />
                </button>
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

.tree { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }

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
.group-count {
  font-size: 10.5px;
  color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: 999px;
  padding: 0 6px;
  line-height: 16px;
}
.group-add { width: 22px; height: 22px; color: hsl(var(--muted-foreground)); }
.group-add:hover, .group-add.active { color: hsl(var(--primary)); background: hsl(var(--primary) / 0.12); }
.group-del:hover { color: hsl(var(--destructive)); background: hsl(var(--destructive) / 0.12); }
.group-add-wrap { position: relative; }
.group-add-menu { right: 0; top: 26px; min-width: 200px; }
.group-empty {
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
  padding: 4px 8px 6px 26px;
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
.type-badge {
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: hsl(var(--muted-foreground));
  flex-shrink: 0;
  padding-left: 6px;
}
/* second row: the actions, aligned bottom-right */
.layer-actions { display: flex; align-items: center; justify-content: flex-end; gap: 1px; }
.skill-wrap { position: relative; display: flex; }
.skill-menu {
  min-width: 260px;
  max-width: 340px;
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
