<script setup>
import { ref, computed } from 'vue'
import { store } from '../store'
import {
  X, FileJson, Mountain, Grid2x2, Server, FileArchive, Layers2,
  Upload, Map as MapIcon, Github, Globe,
} from 'lucide-vue-next'

const dialog = computed(() => store.ui.dialog)
function close() { store.ui.dialog = null }

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
    <!-- Add Data -->
    <div v-if="dialog === 'add-data'" class="dialog add-data">
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
          <span>Style panel</span>
          <input v-model="store.ui.stylePanelOpen" type="checkbox" />
        </label>
        <label class="settings-row check">
          <span>Attribute table</span>
          <input v-model="store.ui.attributeTable" type="checkbox" />
        </label>
        <div class="settings-section">Map</div>
        <div class="settings-row">
          <span>Basemap</span>
          <select class="select settings-select" @change="store.fake('Basemap switch')">
            <option>OpenFreeMap Liberty</option>
            <option>Protomaps</option>
            <option>EOX Sentinel-2 cloudless</option>
            <option>Blank</option>
          </select>
        </div>
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
