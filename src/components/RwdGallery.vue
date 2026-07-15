<script setup>
import { ref, computed, onMounted } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { openLayerTab } from '../stores/dockHandle'
import { assetUrl } from '../lib/assetUrl'
import { rwdCellCompact } from '../stores/viewGeometry'
import RwdViewGrid from './RwdViewGrid.vue'

// A dockview tab showing every city's 8 pre-computed RWD Maps views as a 4×2
// card (data/metro/rwdviews/, built by scripts/buildViews.mjs). Clicking a card
// imports the city, builds a Map Adjust (D3) view, a Hill Climbing view on top,
// then an RWD Maps view — the clicked cell picks the 縮減網格 variant
// (基本/直角爬山/軸對齊/整數規劃).
const store = useMapStore()

const catalog = ref(null)
const error = ref(null)
onMounted(async () => {
  try {
    const res = await fetch(assetUrl('data/metro/rwdviews/index.json'), { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    catalog.value = (await res.json()).systems ?? []
  } catch (err) {
    error.value = String(err)
  }
})

const TABS = [
  { id: 'quick', label: '快速選擇' },
  { id: 'stations', label: '依車站數排序' },
  { id: 'global', label: '全球地鐵地圖' },
]
const tab = ref('stations')
const stationSort = ref('desc')

const QUICK = ['Taipei', 'Taichung', 'Kaohsiung', 'Tokyo', 'Osaka', 'Seoul',
  'Beijing', 'Shanghai', 'Hong Kong', 'Singapore', 'London', 'Paris',
  'Berlin', 'Vienna', 'New York', 'San Francisco']

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
    return [...all].sort((a, b) => ((a.station_count ?? 0) - (b.station_count ?? 0)) * dir)
  }
  return [...all].sort((a, b) =>
    String(a.continent).localeCompare(String(b.continent)) ||
    String(a.country).localeCompare(String(b.country)) ||
    String(a.city).localeCompare(String(b.city)))
})

// Card click → import metro, build Map Adjust (D3) → Hill Climbing (原始) → RWD
// Maps. The clicked cell (viewId) picks which 縮減網格 the RWD sits on.
function pick(entry, viewId) {
  const metro = store.importMetroSystem(entry)
  const d3 = store.addD3Layer(metro.id)
  if (!d3) { store.toast('無法建立 Map Adjust 視圖'); return }
  const hc = store.addHillClimbLayer(d3.id, 'orig')
  if (!hc) { store.toast('無法建立 Hill Climbing 視圖'); return }
  const rwd = store.addRwdLayer(hc.id, rwdCellCompact(viewId))
  if (!rwd) { store.toast('無法建立 RWD Maps 視圖'); return }
  openLayerTab(rwd)
  store.toast(`已建立 ${entry.cityZh ?? entry.city} RWD Maps 視圖`)
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
      <div v-if="error" class="gallery-status">載入視圖清單失敗：{{ error }}<br />（請先執行 <code>npm run metro:views</code>）</div>
      <div v-else-if="!catalog" class="gallery-status">載入全球 RWD Maps 視圖清單…</div>
      <div v-else class="tile-grid">
        <RwdViewGrid v-for="s in tiles" :key="s.id" :entry="s" @pick="pick" />
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
.sort-toggle {
  display: inline-flex;
  margin-left: 10px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 3px);
  overflow: hidden;
}
.sort-btn {
  padding: 3px 12px;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
  border-right: 1px solid hsl(var(--border));
}
.sort-btn:last-child { border-right: none; }
.sort-btn.active { background: hsl(var(--primary) / 0.12); color: hsl(var(--primary)); }
.gallery-count { margin-left: auto; font-size: 12px; color: hsl(var(--muted-foreground)); }
.gallery-body { flex: 1; overflow-y: auto; padding: 16px; container-type: inline-size; }
.gallery-status { padding: 32px; text-align: center; color: hsl(var(--muted-foreground)); font-size: 13px; line-height: 1.7; }
.gallery-status code { font-size: 12px; background: hsl(var(--muted) / 0.6); padding: 1px 5px; border-radius: 4px; }
.tile-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  align-content: start;
}
@container (max-width: 460px) { .tile-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
