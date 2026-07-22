<script setup>
import { computed } from 'vue'
import { useMapStore } from '../../stores/mapStore'
import { openLayerTab } from '../../stores/dockHandle'
import { useDialogCatalog } from './useDialogCatalog'
import { hcVariantsForCity, variantLabel } from '../../stores/layerMigrations'
import MIcon from '../MIcon.vue'

const emit = defineEmits(['close'])
const store = useMapStore()
const { cityParts } = useDialogCatalog()

/* 每個城市：原始／旋轉一定有；規定表城市再加原始-形狀／旋轉-形狀。 */
const d3LayerChoices = computed(() => store.layers.filter((l) => l.type === 'd3'))
function variantsFor(d3) {
  return hcVariantsForCity(d3.sourceLayerId).map((id) => ({ id, label: variantLabel(id) }))
}
function d3Meta(l) {
  const src = l.sourceLayerId ? store.layers.find((s) => s.id === l.sourceLayerId) : l
  return src?.stationCount ? `${src.stationCount} 站 · ${src.lineCount} 線` : ''
}
function addHillClimbView(src, variant) {
  const hcLayer = store.addHillClimbLayer(src.id, variant)
  if (!hcLayer) return
  openLayerTab(hcLayer)
  emit('close')
  store.toast(`已建立 Straighten 視圖（來源：${src.name} ${variantLabel(hcLayer.variant)}）`)
}
</script>

<template>
  <div class="dialog add-d3">
    <div class="dialog-header">
      <h2 class="dialog-title">新增 Straighten 視圖</h2>
      <button class="btn-icon" @click="emit('close')"><MIcon name="close" :size="15" /></button>
    </div>
    <div class="dialog-body">
      <div v-if="!d3LayerChoices.length" class="import-status">
        Map Adjust group 還沒有圖層 — 先在 Map Adjust 用 + 新增一個 D3.js 視圖
      </div>
      <template v-else>
        <p class="add-d3-hint">
          選擇 Map Adjust「格網化後」作為直線化輸入（原始／旋轉一定有；
          東京／新加坡等規定表城市另有原始-形狀／旋轉-形狀，可跑成方）：
        </p>
        <div class="hc-city-list">
          <div v-for="l in d3LayerChoices" :key="l.id" class="hc-city-row">
            <div class="hc-city-name">
              <span class="hc-city-zh">{{ cityParts(l).zh || cityParts(l).en }}</span>
              <span v-if="cityParts(l).zh" class="hc-city-en">{{ cityParts(l).en }}</span>
            </div>
            <span class="hc-city-meta">{{ d3Meta(l) }}</span>
            <button
              v-for="v in variantsFor(l)"
              :key="`${l.id}-${v.id}`"
              class="hc-variant-btn"
              @click="addHillClimbView(l, v.id)"
            >{{ v.label }}</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
