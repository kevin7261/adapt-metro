<script setup>
import { ref } from 'vue'
import { useMapStore } from '../../stores/mapStore'
import MIcon from '../MIcon.vue'

const emit = defineEmits(['close'])
const store = useMapStore()

/* Add Data */
const sources = [
  { id: 'vector', label: 'Vector Layer', icon: 'data_object' },
  { id: 'raster', label: 'Raster Layer', icon: 'terrain' },
  { id: 'xyz', label: 'XYZ Tiles', icon: 'grid_view' },
  { id: 'wms', label: 'WMS / WMTS', icon: 'dns' },
  { id: 'wfs', label: 'WFS', icon: 'dns' },
  { id: 'geoparquet', label: 'GeoParquet', icon: 'folder_zip' },
  { id: 'pmtiles', label: 'PMTiles', icon: 'stacks' },
]
const activeSource = ref('vector')
</script>

<template>
  <!-- Add Data -->
  <div class="dialog add-data">
    <div class="dialog-header">
      <h2 class="dialog-title">新增資料</h2>
      <button class="btn-icon" @click="emit('close')"><MIcon name="close" :size="15" /></button>
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
          <MIcon :name="s.icon" :size="14" /> {{ s.label }}
        </button>
      </nav>
      <div class="source-form">
        <div class="drop-zone">
          <MIcon name="upload" :size="20" />
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
      <button class="btn-outline" @click="emit('close')">Cancel</button>
      <button class="btn-primary" @click="store.fake('Add layer'); emit('close')">Add</button>
    </div>
  </div>
</template>
