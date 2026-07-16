<script setup>
import { useMapStore } from '../stores/mapStore'
import { openLayerTab } from '../stores/dockHandle'
import { assetUrl } from '../lib/assetUrl'
import { rwdCellCompact, rwdCellVariant, RWD_VIEW_ORDER, rwdViewLabels } from '../stores/viewGeometry'
import GalleryShell from './GalleryShell.vue'
import CityViewGrid from './CityViewGrid.vue'

// A dockview tab showing every city's 8 pre-computed RWD Maps views as a 4×2
// card (data/metro/rwdviews/, built by scripts/buildViews.mjs). Sub-tabs / 排序
// / 狀態由 GalleryShell 提供。Clicking a card imports the city, builds a Map
// Adjust (D3) view, a Hill Climbing view on top, then an RWD Maps view — the
// clicked cell picks the 縮減網格 variant (基本/直角爬山/軸對齊/整數規劃).
const store = useMapStore()

async function load() {
  const res = await fetch(assetUrl('data/metro/rwdviews/index.json'), { cache: 'no-cache' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).systems ?? []
}

// Card click → import metro, build Map Adjust (D3) → Hill Climbing (原始) → RWD
// Maps. The clicked cell (viewId) picks which 縮減網格 the RWD sits on.
function pick(entry, viewId) {
  const metro = store.importMetroSystem(entry)
  const d3 = store.addD3Layer(metro.id)
  if (!d3) { store.toast('無法建立 Map Adjust 視圖'); return }
  const hc = store.addHillClimbLayer(d3.id, rwdCellVariant(viewId))
  if (!hc) { store.toast('無法建立 Hill Climbing 視圖'); return }
  const rwd = store.addRwdLayer(hc.id, rwdCellCompact(viewId))
  if (!rwd) { store.toast('無法建立 RWD Maps 視圖'); return }
  openLayerTab(rwd)
  store.toast(`已建立 ${entry.cityZh ?? entry.city} RWD Maps 視圖`)
}
</script>

<template>
  <GalleryShell :load="load" loading-text="載入全球 RWD Maps 視圖清單…" error-hint="npm run metro:views">
    <template #default="{ tiles }">
      <div class="tile-grid">
        <CityViewGrid
          v-for="s in tiles" :key="s.id" :entry="s"
          data-dir="rwdviews" :order="RWD_VIEW_ORDER" :labels-for-tilt="rwdViewLabels"
          :columns="2" cta-label="RWD Maps" @pick="pick" />
      </div>
    </template>
  </GalleryShell>
</template>

<style scoped>
.tile-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  align-content: start;
}
@container (max-width: 460px) { .tile-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
