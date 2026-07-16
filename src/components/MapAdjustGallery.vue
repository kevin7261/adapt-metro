<script setup>
import { useMapStore } from '../stores/mapStore'
import { openLayerTab } from '../stores/dockHandle'
import { assetUrl } from '../lib/assetUrl'
import GalleryShell from './GalleryShell.vue'
import ViewNineGrid from './ViewNineGrid.vue'

// A dockview tab that shows EVERY city's 8 pre-computed Map Adjust views as a
// 3×3 九宮格 card (data/metro/views/, built by scripts/buildViews.mjs).
// Sub-tabs / 排序 / 狀態由 GalleryShell 提供。Clicking a card imports that city
// and builds a Map Adjust (D3) view — optionally deep-linked to one of the 8 views.
const store = useMapStore()

async function load() {
  const res = await fetch(assetUrl('data/metro/views/index.json'), { cache: 'no-cache' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).systems ?? []
}

// Card click: import the city's metro layer, build a Map Adjust (D3) view, open
// it. `viewId` is the specific view thumbnail clicked (for a future deep-link;
// the D3 tab currently opens on 原始).
function pick(entry, viewId) {
  const metro = store.importMetroSystem(entry)
  const d3 = store.addD3Layer(metro.id)
  if (!d3) { store.toast('無法建立 Map Adjust 視圖'); return }
  openLayerTab(d3)
  const label = viewId ? `（${viewId}）` : ''
  store.toast(`已建立 ${entry.cityZh ?? entry.city} Map Adjust 視圖${label}`)
}
</script>

<template>
  <GalleryShell :load="load" loading-text="載入全球地鐵視圖清單…" error-hint="npm run metro:views">
    <template #default="{ tiles }">
      <div class="tile-grid">
        <ViewNineGrid v-for="s in tiles" :key="s.id" :entry="s" @pick="pick" />
      </div>
    </template>
  </GalleryShell>
</template>

<style scoped>
/* each card is a 九宮格; always 3 per row (drop to 1 only on a very narrow panel) */
.tile-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  align-content: start;
}
@container (max-width: 460px) { .tile-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
