<script setup>
import { ref, onBeforeUnmount } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
import { openLayerTab } from '../stores/dockHandle'
import { layerData, boundsOfGeojson } from '../stores/layerData'
import {
  Map as MapIcon, PenTool, Eye, EyeOff, PanelLeftClose, PanelLeftOpen,
  GripVertical, MoreHorizontal,
  ZoomIn, Palette, TableProperties, RefreshCw, Download, Trash2,
  Circle, Spline, Hexagon, Image as ImageIcon, TrainFront,
} from 'lucide-vue-next'

const store = useMapStore()

const menuFor = ref(null)

const typeIcons = { point: Circle, line: Spline, polygon: Hexagon, raster: ImageIcon, metro: TrainFront }

// Click a layer → open (or focus) its editor tab, like opening a file in an IDE.
function openLayer(layer) {
  store.selectedLayerId = layer.id
  openLayerTab(layer)
}

function toggleAll() {
  const next = !store.allLayersVisible
  store.layers.forEach((l) => { l.visible = next })
}

function overflow(layer, action) {
  menuFor.value = null
  if (action === 'zoom') {
    openLayer(layer)
    const data = layerData[layer.id]
    const bbox = data && boundsOfGeojson(data)
    if (bbox) mapHandle.map?.fitBounds(bbox, { padding: 48, maxZoom: 13 })
  } else if (action === 'style') {
    openLayer(layer)
  } else if (action === 'table') {
    store.selectedLayerId = layer.id
    store.ui.attributeTable = true
  } else if (action === 'remove') {
    store.fake(`Remove layer「${layer.name}」`)
  } else {
    store.fake(action)
  }
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
          <button class="btn-icon" title="Basemaps" @click="store.fake('Basemap picker')">
            <MapIcon :size="14" />
          </button>
          <button class="btn-icon" title="Geo editor" @click="store.fake('Geo editor')">
            <PenTool :size="14" />
          </button>
          <button class="btn-icon" :title="store.allLayersVisible ? 'Hide all layers' : 'Show all layers'" @click="toggleAll">
            <Eye v-if="store.allLayersVisible" :size="14" />
            <EyeOff v-else :size="14" />
          </button>
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
          <GripVertical :size="13" class="grip" />
          <button
            class="btn-icon vis"
            :title="layer.visible ? 'Hide layer' : 'Show layer'"
            @click.stop="layer.visible = !layer.visible"
          >
            <Eye v-if="layer.visible" :size="14" />
            <EyeOff v-else :size="14" class="dim" />
          </button>
          <component
            :is="typeIcons[layer.type]"
            :size="13"
            class="type-icon"
            :style="layer.color ? { color: layer.color } : {}"
          />
          <span class="layer-name" :class="{ 'hidden-layer': !layer.visible }">{{ layer.name }}</span>

          <div class="row-menu-wrap" @click.stop>
            <button
              class="btn-icon more"
              title="Layer actions"
              @click="menuFor = menuFor === layer.id ? null : layer.id"
            >
              <MoreHorizontal :size="14" />
            </button>
            <div v-if="menuFor === layer.id" class="menu-pop layer-menu">
              <button class="menu-item" @click="overflow(layer, 'zoom')">
                <ZoomIn :size="14" /> Zoom to layer
              </button>
              <button class="menu-item" @click="overflow(layer, 'style')">
                <Palette :size="14" /> Style
              </button>
              <button class="menu-item" @click="overflow(layer, 'table')">
                <TableProperties :size="14" /> Attribute table
              </button>
              <button class="menu-item" @click="overflow(layer, 'Refresh')">
                <RefreshCw :size="14" /> Refresh
              </button>
              <button class="menu-item" @click="overflow(layer, 'Export')">
                <Download :size="14" /> Export
              </button>
              <div class="menu-sep" />
              <button class="menu-item danger" @click="overflow(layer, 'remove')">
                <Trash2 :size="14" /> Remove
              </button>
            </div>
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
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px;
  border-radius: calc(var(--radius) - 4px);
  cursor: pointer;
  border: 1px solid transparent;
}
.layer-row:hover { background: hsl(var(--accent) / 0.6); }
.layer-row.selected {
  background: hsl(var(--primary) / 0.1);
  border-color: hsl(var(--primary) / 0.4);
}
.grip { color: hsl(var(--muted-foreground) / 0.5); cursor: grab; flex-shrink: 0; }
.vis { width: 24px; height: 24px; }
.dim { color: hsl(var(--muted-foreground)); }
.type-icon { flex-shrink: 0; margin: 0 3px; }
.layer-name {
  flex: 1;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hidden-layer { color: hsl(var(--muted-foreground)); }
.more { width: 24px; height: 24px; opacity: 0; }
.layer-row:hover .more, .layer-row.selected .more { opacity: 1; }
.row-menu-wrap { position: relative; }
.layer-menu { right: 0; top: 26px; min-width: 180px; }
.menu-item.danger { color: hsl(var(--destructive)); }
.menu-item.danger:hover { background: hsl(var(--destructive) / 0.12); color: hsl(var(--destructive)); }

@media (max-width: 768px) {
  .layer-panel { position: absolute; z-index: 50; top: 0; bottom: 0; left: 0; }
}
</style>
