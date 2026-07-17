<script setup>
import { ref, computed, onMounted } from 'vue'

// 四個畫廊 tab（Metro Maps / Map Adjust / Hill Climbing / RWD Maps）的共用外殼：
// 三個子分頁（快速選擇 / 依車站數排序 / 全球地鐵地圖）、多到少/少到多 segmented
// 排序、城市計數、loading / error 狀態。城市卡片由各畫廊以 scoped slot 提供
//（`#default="{ tiles }"`），點擊行為（pick 的 store 呼叫鏈）留在各畫廊。
const props = defineProps({
  load: { type: Function, required: true },        // () => Promise<systems[]>
  loadingText: { type: String, required: true },   // 載入中訊息
  errorText: { type: String, default: '載入視圖清單失敗' },
  errorHint: { type: String, default: '' },        // 附註指令（如 npm run metro:views）
})

const catalog = ref(null)
const error = ref(null)
onMounted(() => {
  Promise.resolve(props.load())
    .then((systems) => { catalog.value = systems ?? [] })
    .catch((err) => { error.value = String(err) })
})

const TABS = [
  { id: 'quick', label: '快速選擇' },
  { id: 'stations', label: '依車站數排序' },
  { id: 'global', label: '全球地鐵地圖' },
]
const tab = ref('stations')
const stationSort = ref('desc')

// Same short list as the modal's Quick Selection.
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
  // global: grouped by continent, then country + city
  return [...all].sort((a, b) =>
    String(a.continent).localeCompare(String(b.continent)) ||
    String(a.country).localeCompare(String(b.country)) ||
    String(a.city).localeCompare(String(b.city)))
})
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

    <!-- 額外工具列（如視圖畫廊的「顯示哪些地圖」勾選）——有提供 slot 才渲染 -->
    <div v-if="$slots.toolbar" class="gallery-toolbar">
      <slot name="toolbar" />
    </div>

    <div class="gallery-body">
      <div v-if="error" class="gallery-status">
        {{ errorText }}：{{ error }}
        <template v-if="errorHint"><br />（請先執行 <code>{{ errorHint }}</code>）</template>
      </div>
      <div v-else-if="!catalog" class="gallery-status">{{ loadingText }}</div>
      <slot v-else :tiles="tiles" />
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
/* segmented group button：多到少／少到多 併成一組 */
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
.gallery-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 7px 12px;
  border-bottom: 1px solid hsl(var(--border));
  flex-shrink: 0;
}
/* container-type so the tile grid responds to the PANEL width, not the viewport
   (the gallery lives in a resizable dockview panel). */
.gallery-body { flex: 1; overflow-y: auto; padding: 16px; container-type: inline-size; }
.gallery-status { padding: 32px; text-align: center; color: hsl(var(--muted-foreground)); font-size: 13px; line-height: 1.7; }
.gallery-status code { font-size: 12px; background: hsl(var(--muted) / 0.6); padding: 1px 5px; border-radius: 4px; }
</style>
