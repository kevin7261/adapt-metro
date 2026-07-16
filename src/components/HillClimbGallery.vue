<script setup>
import { useMapStore } from '../stores/mapStore'
import { openLayerTab } from '../stores/dockHandle'
import { assetUrl } from '../lib/assetUrl'
import GalleryShell from './GalleryShell.vue'
import CityViewGrid from './CityViewGrid.vue'
import { HC_VIEW_ORDER, hcViewLabels } from '../stores/viewGeometry'

// A dockview tab showing every city's pre-computed Hill Climbing views as a
// card (data/metro/hcviews/, built by scripts/buildViews.mjs). Sub-tabs / 排序
// / 狀態由 GalleryShell 提供。Clicking a card imports the city, builds a Map
// Adjust (D3) view, then a Hill Climbing view on top of it — variant (orig/rot)
// taken from the clicked thumbnail.
const store = useMapStore()

async function load() {
  const res = await fetch(assetUrl('data/metro/hcviews/index.json'), { cache: 'no-cache' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).systems ?? []
}

// Card click → import metro, build a Map Adjust (D3) view, then a Hill Climbing
// view. `viewId` (a *-rot id) picks the rotated variant; the title picks orig.
function pick(entry, viewId) {
  const metro = store.importMetroSystem(entry)
  const d3 = store.addD3Layer(metro.id)
  if (!d3) { store.toast('無法建立 Map Adjust 視圖'); return }
  const variant = viewId && viewId.includes('rot') ? 'rot' : 'orig'
  const hc = store.addHillClimbLayer(d3.id, variant)
  if (!hc) { store.toast('無法建立 Hill Climbing 視圖'); return }
  openLayerTab(hc)
  store.toast(`已建立 ${entry.cityZh ?? entry.city} Straighten 視圖（${variant === 'rot' ? '旋轉' : '原始'}）`)
}
</script>

<template>
  <GalleryShell :load="load" loading-text="載入全球 Hill Climbing 視圖清單…" error-hint="npm run metro:views">
    <template #default="{ tiles }">
      <div class="tile-grid">
        <CityViewGrid
          v-for="s in tiles" :key="s.id" :entry="s"
          data-dir="hcviews" :order="HC_VIEW_ORDER" :labels-for-tilt="hcViewLabels"
          :columns="4" cta-label="Hill Climbing" @pick="pick" />
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
