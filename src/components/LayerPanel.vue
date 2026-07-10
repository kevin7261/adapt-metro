<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
import { openLayerTab, dockHandle } from '../stores/dockHandle'
import { layerData, boundsOfGeojson } from '../stores/layerData'
import {
  PanelLeftClose, PanelLeftOpen,
  ZoomIn, TableProperties, Download, Trash2,
  Circle, Spline, Hexagon, Image as ImageIcon, TrainFront,
  ChevronDown, ChevronRight, Folder, FolderOpen, Plus,
  Zap, ArrowUpDown, Globe,
} from 'lucide-vue-next'

const store = useMapStore()

const typeIcons = { point: Circle, line: Spline, polygon: Hexagon, raster: ImageIcon, metro: TrainFront, d3: Spline }
const typeBadges = { metro: 'METRO', d3: 'D3' }

// Add a D3.js view: a dialog picks the source metro layer (fixed afterwards).
function addD3() {
  store.ui.dialog = 'add-d3'
}

// "+" on the Metro Maps group: the three import entry points (was the top-bar
// Import menu).
const metroAddOpen = ref(false)
const metroAddWrap = ref(null)
const importItems = [
  { id: 'import-quick', label: 'Quick Selection', icon: Zap },
  { id: 'import-stations', label: 'Sort by Station Count', icon: ArrowUpDown },
  { id: 'import-metro', label: 'Global Metro Map', icon: Globe },
]
function pickImport(id) {
  metroAddOpen.value = false
  store.ui.dialog = id
}
function onDocClick(e) {
  // template ref sits inside v-for, so Vue fills it as an array
  const wrap = Array.isArray(metroAddWrap.value) ? metroAddWrap.value[0] : metroAddWrap.value
  if (metroAddOpen.value && wrap && !wrap.contains(e.target)) {
    metroAddOpen.value = false
  }
}
onMounted(() => document.addEventListener('mousedown', onDocClick))

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
  document.removeEventListener('mousedown', onDocClick)
})
</script>

<template>
  <!-- Collapsed rail -->
  <aside v-if="!store.ui.layerPanelOpen" class="rail" aria-label="Layers (collapsed)">
    <button class="btn-icon" title="Expand layers panel" @click="store.ui.layerPanelOpen = true">
      <PanelLeftOpen :size="15" />
    </button>
    <span class="rail-label">Layers</span>
  </aside>

  <template v-else>
    <aside class="layer-panel" aria-label="Layers" :style="{ width: store.layerPanelWidth + 'px' }">
      <div class="panel-header">
        <span class="panel-title">Layers</span>
        <div class="header-actions">
          <button class="btn-icon" title="Collapse panel" @click="store.ui.layerPanelOpen = false">
            <PanelLeftClose :size="14" />
          </button>
        </div>
      </div>

      <div class="tree">
        <div v-for="item in store.layerTree" :key="item.group.id" class="group-card">
          <!-- Group header: chevron + folder + name (+ add for the D3 group) -->
          <div class="group-header" @click="item.group.collapsed = !item.group.collapsed">
            <component :is="item.group.collapsed ? ChevronRight : ChevronDown" :size="14" class="group-chevron" />
            <component :is="item.group.collapsed ? Folder : FolderOpen" :size="14" class="group-folder" />
            <span class="group-name">{{ item.group.label }}</span>
            <span class="group-count">{{ item.children.length }}</span>
            <div v-if="item.group.id === 'metro-maps'" ref="metroAddWrap" class="group-add-wrap" @click.stop>
              <button
                class="btn-icon group-add"
                :class="{ active: metroAddOpen }"
                title="Import metro map"
                @click="metroAddOpen = !metroAddOpen"
              >
                <Plus :size="14" />
              </button>
              <div v-if="metroAddOpen" class="menu-pop group-add-menu">
                <button v-for="it in importItems" :key="it.id" class="menu-item" @click="pickImport(it.id)">
                  <component :is="it.icon" :size="14" /> {{ it.label }}
                </button>
              </div>
            </div>
            <button
              v-if="item.group.id === 'd3'"
              class="btn-icon group-add"
              title="Add D3.js view"
              @click.stop="addD3()"
            >
              <Plus :size="14" />
            </button>
          </div>

          <!-- Group children -->
          <template v-if="!item.group.collapsed">
            <div v-if="!item.children.length" class="group-empty">
              {{ item.group.id === 'd3' ? '按 + 新增 D3.js 視圖' : '用 Import 匯入 metro map' }}
            </div>
            <div
              v-for="layer in item.children"
              :key="layer.id"
              class="layer-row"
              :class="{ selected: store.selectedLayerId === layer.id }"
              @click="openLayer(layer)"
            >
              <div class="layer-title">
                <component
                  :is="typeIcons[layer.type]"
                  :size="13"
                  class="type-icon"
                  :style="layer.color ? { color: layer.color } : {}"
                />
                <span class="layer-name">{{ layer.name }}</span>
                <span class="type-badge">{{ typeBadges[layer.type] ?? layer.type }}</span>
              </div>

              <div class="layer-actions" @click.stop>
                <button
                  v-if="layer.type === 'metro'"
                  class="btn-icon"
                  title="Zoom to layer"
                  @click="overflow(layer, 'zoom')"
                >
                  <ZoomIn :size="14" />
                </button>
                <button
                  class="btn-icon"
                  :class="{ active: store.ui.attributeTableOpen[layer.id] }"
                  title="Attribute table"
                  @click="overflow(layer, 'table')"
                >
                  <TableProperties :size="14" />
                </button>
                <button class="btn-icon" title="Export GeoJSON" @click="overflow(layer, 'export')">
                  <Download :size="14" />
                </button>
                <button class="btn-icon danger" title="Remove layer" @click="overflow(layer, 'remove')">
                  <Trash2 :size="14" />
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
/* second row: the four actions, aligned bottom-right */
.layer-actions { display: flex; align-items: center; justify-content: flex-end; gap: 1px; }
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
