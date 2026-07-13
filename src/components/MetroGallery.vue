<script setup>
import { ref, computed, onMounted } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { loadMetroCatalog } from '../stores/metroCatalog'
import { openLayerTab } from '../stores/dockHandle'
import GalleryTile from './GalleryTile.vue'

// A dockview tab that shows EVERY city's metro network as a thumbnail grid
// (max 4 per row). Three sub-tabs mirror the Import Metro Map modal; clicking a
// tile imports that city (same as the modal's list rows).
const store = useMapStore()

const catalog = ref(null)
const error = ref(null)
onMounted(() => {
  loadMetroCatalog()
    .then((systems) => { catalog.value = systems })
    .catch((err) => { error.value = String(err) })
})

const TABS = [
  { id: 'quick', label: 'Quick Selection' },
  { id: 'stations', label: 'Sort by Station Count' },
  { id: 'global', label: 'Global Metro Map' },
]
const tab = ref('stations')
const stationSort = ref('desc')

// Same short list as the modal's Quick Selection.
const QUICK = ['Taipei', 'Taichung', 'Kaohsiung', 'Tokyo', 'Osaka', 'Seoul',
  'Beijing', 'Shanghai', 'Hong Kong', 'Singapore', 'London', 'Paris',
  'Berlin', 'Vienna', 'New York']

const tiles = computed(() => {
  const all = catalog.value ?? []
  if (tab.value === 'quick') {
    return QUICK
      .map((c) => all.find((s) => s.city === c)
        ?? all.find((s) => (s.city || '').toLowerCase().startsWith(c.toLowerCase())))
      .filter(Boolean)
  }
  if (tab.value === 'stations') {
    const dir = stationSort.value === 'asc' ? 1 : -1
    return [...all].sort((a, b) => (a.station_count - b.station_count) * dir)
  }
  // global: grouped by continent, then country + city
  return [...all].sort((a, b) =>
    String(a.continent).localeCompare(String(b.continent)) ||
    String(a.country).localeCompare(String(b.country)) ||
    String(a.city).localeCompare(String(b.city)))
})

function pick(sys) {
  const layer = store.importMetroSystem(sys)
  openLayerTab(layer)
  store.toast(`已匯入 ${sys.cityZh ?? sys.city} metro map（${sys.line_count} 條線 / ${sys.station_count} 站）`)
}
</script>

<template>
  <div class="gallery">
    <div class="gallery-tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="gallery-tab"
        :class="{ active: tab === t.id }"
        role="tab"
        :aria-selected="tab === t.id"
        @click="tab = t.id"
      >{{ t.label }}</button>

      <div v-if="tab === 'stations'" class="sort-toggle">
        <button class="sort-btn" :class="{ active: stationSort === 'desc' }" @click="stationSort = 'desc'">多到少</button>
        <button class="sort-btn" :class="{ active: stationSort === 'asc' }" @click="stationSort = 'asc'">少到多</button>
      </div>
      <span class="gallery-count">{{ tiles.length }} 城市</span>
    </div>

    <div class="gallery-body">
      <div v-if="error" class="gallery-status">載入城市清單失敗：{{ error }}</div>
      <div v-else-if="!catalog" class="gallery-status">載入全球地鐵城市清單…</div>
      <div v-else class="tile-grid">
        <GalleryTile v-for="s in tiles" :key="s.file" :system="s" @pick="pick" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.gallery { display: flex; flex-direction: column; height: 100%; background: hsl(var(--background)); }
.gallery-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid hsl(var(--border));
  flex-shrink: 0;
}
.gallery-tab {
  padding: 9px 12px;
  font-size: 13px;
  color: hsl(var(--muted-foreground));
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  white-space: nowrap;
}
.gallery-tab:hover { color: hsl(var(--foreground)); }
.gallery-tab.active {
  color: hsl(var(--primary));
  font-weight: 600;
  border-bottom-color: hsl(var(--primary));
}
.sort-toggle { display: flex; gap: 2px; margin-left: 10px; }
.sort-btn {
  padding: 3px 10px;
  font-size: 12px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 3px);
  color: hsl(var(--muted-foreground));
}
.sort-btn.active { color: hsl(var(--primary)); border-color: hsl(var(--primary) / 0.5); }
.gallery-count { margin-left: auto; font-size: 12px; color: hsl(var(--muted-foreground)); }
/* container-type so the grid responds to the PANEL width, not the viewport
   (the gallery lives in a resizable dockview panel). */
.gallery-body { flex: 1; overflow-y: auto; padding: 16px; container-type: inline-size; }
.gallery-status { padding: 32px; text-align: center; color: hsl(var(--muted-foreground)); font-size: 13px; }
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
