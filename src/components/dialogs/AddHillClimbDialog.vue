<script setup>
import { computed } from 'vue'
import { useMapStore } from '../../stores/mapStore'
import { openLayerTab } from '../../stores/dockHandle'
import { useDialogCatalog } from './useDialogCatalog'
import MIcon from '../MIcon.vue'

const emit = defineEmits(['close'])
const store = useMapStore()
const { cityParts } = useDialogCatalog()

/* Add Hill Climbing view — pick a Map Adjust view's 格網化後 layout as input.
   每個城市（Map Adjust 圖層）有 2 個可選：原始格網化後 / 旋轉格網化後。 */
const d3LayerChoices = computed(() => store.layers.filter((l) => l.type === 'd3'))
const HC_VARIANTS = [
  { id: 'orig', label: '原始格網化後' },
  { id: 'rot', label: '旋轉格網化後' },
]
// Station/line counts shown per row: the d3 layer's own (file import) or its
// source metro layer's.
function d3Meta(l) {
  const src = l.sourceLayerId ? store.layers.find((s) => s.id === l.sourceLayerId) : l
  return src?.stationCount ? `${src.stationCount} 站 · ${src.lineCount} 線` : ''
}
function addHillClimbView(src, variant) {
  const hcLayer = store.addHillClimbLayer(src.id, variant)
  if (!hcLayer) return
  openLayerTab(hcLayer)
  emit('close')
  const vLabel = HC_VARIANTS.find((v) => v.id === hcLayer.variant)?.label ?? ''
  store.toast(`已建立 Hill Climbing 視圖（來源：${src.name} ${vLabel}）`)
}
</script>

<template>
  <!-- Add Hill Climbing view: pick a Map Adjust layer's 格網化後 variant (2 per city) -->
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
          選擇 Map Adjust 視圖的「格網化後」佈局作為爬山法最佳化的輸入
          （每個城市 2 個：原始／旋轉，建立後不可更改）：
        </p>
        <!-- 同一城市同一排：城市名 + 原始/旋轉兩個變體並排 -->
        <div class="hc-city-list">
          <div v-for="l in d3LayerChoices" :key="l.id" class="hc-city-row">
            <div class="hc-city-name">
              <span class="hc-city-zh">{{ cityParts(l).zh || cityParts(l).en }}</span>
              <span v-if="cityParts(l).zh" class="hc-city-en">{{ cityParts(l).en }}</span>
            </div>
            <span class="hc-city-meta">{{ d3Meta(l) }}</span>
            <button
              v-for="v in HC_VARIANTS"
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
