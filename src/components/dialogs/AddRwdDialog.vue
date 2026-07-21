<script setup>
import { computed } from 'vue'
import { useMapStore } from '../../stores/mapStore'
import { openLayerTab } from '../../stores/dockHandle'
import { PAPER_KINDS } from '../../stores/paperAlign'
import { useDialogCatalog } from './useDialogCatalog'
import MIcon from '../MIcon.vue'

const emit = defineEmits(['close'])
const store = useMapStore()
const { cityParts } = useDialogCatalog()

/* Add RWD Maps view — source = a Hill Climbing chain's 循環結果 layout
   (端點移動+直線縮減+中位集中+縮減網格循環, straightenCompactLoop),
   redrawn with strict H/V/45° polylines (版面路網畫線規則). */
const hcLayerChoices = computed(() => store.layers.filter((l) => l.type === 'hillclimb'))
// RWD 抓的是循環的 9 個結果（論文①〜⑧＋LLM 對齊的循環，對應 D3Tab 的
// LOOP_KIND）；舊圖層的 'hc'（基本循環）僅作 fallback、不再提供建立。
// 鏈名統一取自 paperAlign 的 PAPER_KINDS（帶論文圈號）。
const RWD_VARIANTS = [
  ...PAPER_KINDS.map(({ kind, zh }) => ({ id: kind, label: `${zh}循環` })),
  { id: 'llm', label: 'LLM 對齊循環' },
]
// Station/line counts shown per row: the d3 layer's own (file import) or its
// source metro layer's.
function d3Meta(l) {
  const src = l.sourceLayerId ? store.layers.find((s) => s.id === l.sourceLayerId) : l
  return src?.stationCount ? `${src.stationCount} 站 · ${src.lineCount} 線` : ''
}
function hcMeta(l) {
  const d3l = store.layers.find((s) => s.id === l.sourceLayerId)
  return d3l ? d3Meta(d3l) : ''
}
function addRwdView(src, compact = 'rect') {
  const rwdLayer = store.addRwdLayer(src.id, compact)
  if (!rwdLayer) return
  openLayerTab(rwdLayer)
  emit('close')
  const vLabel = RWD_VARIANTS.find((v) => v.id === compact)?.label ?? compact
  store.toast(`已建立 RWD Maps 視圖（來源：${src.name} ${vLabel}）`)
}
</script>

<template>
  <!-- Add RWD Maps view: pick a Hill Climbing layer + one of the 4 循環結果 as input -->
  <div class="dialog add-d3">
    <div class="dialog-header">
      <h2 class="dialog-title">新增 RWD Maps 視圖</h2>
      <button class="btn-icon" @click="emit('close')"><MIcon name="close" :size="15" /></button>
    </div>
    <div class="dialog-body">
      <div v-if="!hcLayerChoices.length" class="import-status">
        Hill Climbing group 還沒有圖層 — 先在 Hill Climbing 用 + 建立一個視圖
      </div>
      <template v-else>
        <p class="add-d3-hint">
          選擇 Hill Climbing 視圖與循環結果（端點移動+直線縮減+中位集中+縮減網格循環
          的 4 條鏈）——該佈局將以 H/V/45° 折線重繪（版面路網畫線規則，建立後不可更改）：
        </p>
        <div class="hc-city-list">
          <div v-for="l in hcLayerChoices" :key="l.id" class="hc-city-row">
            <div class="hc-city-name">
              <span class="hc-city-zh">{{ cityParts(l).zh || cityParts(l).en }}</span>
              <span v-if="cityParts(l).zh" class="hc-city-en">{{ cityParts(l).en }}</span>
            </div>
            <span class="hc-city-meta">{{ hcMeta(l) }}</span>
            <button
              v-for="v in RWD_VARIANTS"
              :key="`${l.id}-${v.id}`"
              class="hc-variant-btn"
              @click="addRwdView(l, v.id)"
            >{{ v.label }}</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
