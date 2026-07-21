<script setup>
import { ref, computed } from 'vue'
import { useMapStore } from '../../stores/mapStore'
import { openLayerTab } from '../../stores/dockHandle'
import { layerData } from '../../stores/layerData'
import { useDialogCatalog } from './useDialogCatalog'
import MIcon from '../MIcon.vue'

const emit = defineEmits(['close'])
const store = useMapStore()
const { cityParts } = useDialogCatalog()

/* Add D3.js view — pick one of the loaded metro map layers as its source */
const metroLayerChoices = computed(() => store.layers.filter((l) => l.type === 'metro'))
function addD3View(src) {
  const d3Layer = store.addD3Layer(src.id)
  if (!d3Layer) return
  openLayerTab(d3Layer)
  emit('close')
  store.toast(`已建立 D3.js 視圖（來源：${src.name}）`)
}

/* Add D3.js view — or import a GeoJSON file as its own data source */
const d3FileInput = ref(null)
async function onD3File(e) {
  const file = e.target.files?.[0]
  e.target.value = '' // allow re-picking the same file
  if (!file) return
  try {
    const data = JSON.parse(await file.text())
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
      throw new Error('不是有效的 GeoJSON FeatureCollection')
    }
    const name = file.name.replace(/\.(geo)?json$/i, '')
    const d3Layer = store.addD3LayerFromData(name, data)
    layerData[d3Layer.id] = data
    openLayerTab(d3Layer)
    emit('close')
    store.toast(`已匯入 ${file.name} 為 D3.js 視圖`)
  } catch (err) {
    store.toast(`匯入失敗：${err.message}`)
  }
}
</script>

<template>
  <!-- Add D3.js view: pick a loaded metro map layer (fixed once chosen) -->
  <div class="dialog add-d3">
    <div class="dialog-header">
      <h2 class="dialog-title">新增 Map Adjust 視圖</h2>
      <button class="btn-icon" @click="emit('close')"><MIcon name="close" :size="15" /></button>
    </div>
    <div class="dialog-body">
      <div v-if="!metroLayerChoices.length" class="import-status">
        Metro Maps group 還沒有 metro 圖層 — 先用 + 匯入一個 metro map，或直接匯入 GeoJSON 檔案
      </div>
      <template v-else>
        <p class="add-d3-hint">選擇一個 metro map 圖層作為 D3.js 視圖的資料來源（建立後不可更改）：</p>
        <div class="hc-city-list">
          <div v-for="l in metroLayerChoices" :key="l.id" class="hc-city-row">
            <div class="hc-city-name">
              <span class="hc-city-zh">{{ cityParts(l).zh || cityParts(l).en }}</span>
              <span v-if="cityParts(l).zh" class="hc-city-en">{{ cityParts(l).en }}</span>
            </div>
            <span class="hc-city-meta">{{ l.stationCount }} 站 · {{ l.lineCount }} 線</span>
            <button class="hc-variant-btn" @click="addD3View(l)">建立</button>
          </div>
        </div>
      </template>

      <div class="menu-sep" />
      <button class="station-row d3-file-row" @click="d3FileInput?.click()">
        <MIcon name="upload" :size="14" />
        <span class="station-city">匯入 GeoJSON 檔案…</span>
        <span class="station-count">.geojson / .json</span>
      </button>
      <input
        ref="d3FileInput"
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        hidden
        @change="onD3File"
      />
    </div>
  </div>
</template>
