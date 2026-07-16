<script setup>
import { useMapStore } from '../stores/mapStore'
import { loadMetroCatalog } from '../stores/metroCatalog'
import { openLayerTab } from '../stores/dockHandle'
import GalleryShell from './GalleryShell.vue'
import GalleryTile from './GalleryTile.vue'

// A dockview tab that shows EVERY city's metro network as a thumbnail grid
// (max 3 per row). Sub-tabs / 排序 / 狀態由 GalleryShell 提供；clicking a
// tile imports that city (same as the modal's list rows).
const store = useMapStore()

function pick(sys) {
  const layer = store.importMetroSystem(sys)
  openLayerTab(layer)
  store.toast(`已匯入 ${sys.cityZh ?? sys.city} metro map（${sys.line_count} 條線 / ${sys.station_count} 站）`)
}
</script>

<template>
  <GalleryShell :load="loadMetroCatalog" loading-text="載入全球地鐵城市清單…" error-text="載入城市清單失敗">
    <template #default="{ tiles }">
      <div class="tile-grid">
        <GalleryTile v-for="s in tiles" :key="s.file" :system="s" @pick="pick" />
      </div>
    </template>
  </GalleryShell>
</template>

<style scoped>
/* max 3 per row, shrinking responsively on narrow panels */
.tile-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  align-content: start;
}
@container (max-width: 720px) { .tile-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 460px) { .tile-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
