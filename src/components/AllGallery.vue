<script setup>
import { ref, computed } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { openLayerTab } from '../stores/dockHandle'
import { assetUrl } from '../lib/assetUrl'
import { rwdCellCompact, rwdCellVariant } from '../stores/viewGeometry'
import GalleryShell from './GalleryShell.vue'
import CityAllCard from './CityAllCard.vue'

// 視圖畫廊：every city 的「所有地圖」縮圖。工具列的開關與圈層左側 list 一致——
// 就是一城的 9 個管線圖層（Raw Maps／Map Adjust／Straighten 原始‧旋轉／RWD
// Maps 基本‧直角爬山‧軸對齊‧整數規劃‧LLM 對齊）；每個圖層對應一張代表縮圖
//（Raw＝路網縮圖，其餘取 data/metro/{views,hcviews,rwdviews}/ 的一個代表視圖）。
// 預設顯示 Raw Maps＋全部 RWD Maps。點任何一格都匯入該城市整組管線圖層
//（importCityChain：一城一群組 9 層）並開啟點到的那個圖層的 tab。
const store = useMapStore()

async function load() {
  const res = await fetch(assetUrl('data/metro/views/index.json'), { cache: 'no-cache' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).systems ?? []
}

// 9 個管線圖層＝圈層左側 list。kind＝卡片區段（raw／adjust／straighten／rwd），
// view＝該圖層在畫廊的代表縮圖 id（llm 無預算圖，cell 顯示「尚未預算」，點擊
// 仍即時計算）。label 與 stageLabel（LayerPanel）一致。
const LAYERS = [
  { key: 'raw', label: 'Raw Maps', kind: 'raw', view: 'thumb' },
  { key: 'adjust', label: 'Map Adjust', kind: 'adjust', view: 'grid-orig-post' },
  { key: 'st-orig', label: 'Straighten（原始）', kind: 'straighten', view: 'loop-rect-orig' },
  { key: 'st-rot', label: 'Straighten（旋轉）', kind: 'straighten', view: 'loop-rect-rot' },
  { key: 'rwd-hc', label: 'RWD Maps（基本）', kind: 'rwd', view: 'rwd-hc-orig' },
  { key: 'rwd-rect', label: 'RWD Maps（直角爬山）', kind: 'rwd', view: 'rwd-rect-orig' },
  { key: 'rwd-align', label: 'RWD Maps（軸對齊）', kind: 'rwd', view: 'rwd-align-orig' },
  { key: 'rwd-ilp', label: 'RWD Maps（整數規劃）', kind: 'rwd', view: 'rwd-ilp-orig' },
  { key: 'rwd-llm', label: 'RWD Maps（LLM 對齊）', kind: 'rwd', view: 'rwd-llm-orig' },
]

// 已勾選的圖層。預設：Raw Maps ＋全部 RWD Maps。
const shown = ref(new Set(['raw', 'rwd-hc', 'rwd-rect', 'rwd-align', 'rwd-ilp', 'rwd-llm']))
const isOn = (key) => shown.value.has(key)
function toggle(key) {
  const s = new Set(shown.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  shown.value = s
}
const allOn = computed(() => LAYERS.every((l) => shown.value.has(l.key)))
function toggleAll() {
  shown.value = allOn.value ? new Set() : new Set(LAYERS.map((l) => l.key))
}

// 卡片要畫的區段：把勾選的圖層依 kind 併起（同 kind 的代表 view 收成 order）。
const sections = computed(() => {
  const byKind = new Map()
  for (const l of LAYERS) {
    if (!shown.value.has(l.key)) continue
    if (!byKind.has(l.kind)) byKind.set(l.kind, [])
    byKind.get(l.kind).push(l.view)
  }
  return [...byKind.entries()].map(([id, order]) => ({ id, order }))
})

// 點卡片標題或任何一格：匯入整組管線圖層，變體由點到的 cell 決定
// （Straighten 的 *-rot → 旋轉；RWD 的 cell id → 縮減網格來源＋變體），
// 再開啟點到那種視圖的 tab。
function pick(kind, entry, viewId) {
  const variant = kind === 'rwd' ? rwdCellVariant(viewId)
    : kind === 'straighten' && /-rot$/.test(viewId ?? '') ? 'rot' : 'orig'
  const compact = kind === 'rwd' ? rwdCellCompact(viewId) : 'rect'
  const { metro, d3, hc, rwd } = store.importCityChain(entry, { variant, compact })
  const target = { raw: metro, adjust: d3, straighten: hc, rwd }[kind] ?? metro
  if (!target) { store.toast('無法建立視圖'); return }
  openLayerTab(target)
  store.toast(`已匯入 ${entry.cityZh ?? entry.city}`)
}
</script>

<template>
  <GalleryShell :load="load" loading-text="載入全球視圖清單…" error-hint="npm run metro:views">
    <template #toolbar>
      <span class="kind-title">顯示圖層：</span>
      <button class="kind-all" @click="toggleAll">{{ allOn ? '全部清除' : '全部顯示' }}</button>
      <label
        v-for="l in LAYERS"
        :key="l.key"
        class="kind-check"
        :class="{ on: isOn(l.key) }"
      >
        <input type="checkbox" :checked="isOn(l.key)" @change="toggle(l.key)" />
        {{ l.label }}
      </label>
    </template>
    <template #default="{ tiles }">
      <div class="tile-grid">
        <CityAllCard v-for="s in tiles" :key="s.id" :entry="s" :sections="sections" @pick="pick" />
      </div>
    </template>
  </GalleryShell>
</template>

<style scoped>
.kind-title { font-size: 12px; color: hsl(var(--muted-foreground)); }
.kind-all {
  padding: 2px 10px;
  font-size: 11.5px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 3px);
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
.kind-all:hover { color: hsl(var(--primary)); border-color: hsl(var(--primary) / 0.5); }
/* 圖層勾選（＝圈層左側 list 的 9 個管線圖層） */
.kind-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 3px);
  color: hsl(var(--muted-foreground));
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.kind-check.on {
  background: hsl(var(--primary) / 0.12);
  border-color: hsl(var(--primary) / 0.5);
  color: hsl(var(--primary));
}
.kind-check input { accent-color: hsl(var(--primary)); margin: 0; }

.tile-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  align-content: start;
}
@container (max-width: 720px) { .tile-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 460px) { .tile-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
