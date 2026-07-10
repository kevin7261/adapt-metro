<script setup>
import { ref, onBeforeUnmount } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
import { openLayerTab, dockHandle } from '../stores/dockHandle'
import { layerData, boundsOfGeojson } from '../stores/layerData'
import {
  PanelLeftClose, PanelLeftOpen,
  ZoomIn, TableProperties, Download, Trash2,
  Circle, Spline, Hexagon, Image as ImageIcon, TrainFront,
} from 'lucide-vue-next'

const store = useMapStore()

const typeIcons = { point: Circle, line: Spline, polygon: Hexagon, raster: ImageIcon, metro: TrainFront }

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
    // Pure toggle of the attribute table for the active tab — must NOT change
    // the active tab / layer highlight (highlight is driven by tab selection).
    store.ui.attributeTable = !store.ui.attributeTable
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

// Export = download the layer's GeoJSON (uses the loaded copy, else fetches it).
async function exportLayer(layer) {
  try {
    let data = layerData[layer.id]
    if (!data) {
      const res = await fetch(layer.file)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data = await res.json()
    }
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
onBeforeUnmount(() => { dragging.value = false })
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
        <div
          v-for="layer in store.layers"
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
          </div>

          <div class="layer-actions" @click.stop>
            <button class="btn-icon" title="Zoom to layer" @click="overflow(layer, 'zoom')">
              <ZoomIn :size="14" />
            </button>
            <button
              class="btn-icon"
              :class="{ active: store.ui.attributeTable && store.selectedLayerId === layer.id }"
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

.tree { flex: 1; overflow-y: auto; padding: 8px; }

.layer-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border-radius: calc(var(--radius) - 4px);
  cursor: pointer;
  border: 1px solid transparent;
}
.layer-row:hover { background: hsl(var(--accent) / 0.6); }
/* Active layer = the layer shown in the active editor tab. */
.layer-row.selected {
  background: hsl(var(--primary) / 0.18);
  border-color: hsl(var(--primary) / 0.55);
}
.layer-row.selected::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 2px;
  background: hsl(var(--primary));
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
