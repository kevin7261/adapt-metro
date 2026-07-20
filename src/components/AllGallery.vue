<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { openLayerTab } from '../stores/dockHandle'
import { assetUrl } from '../lib/assetUrl'
import { rwdCellCompact, rwdCellVariant, loopCellCompact } from '../stores/viewGeometry'
import GalleryShell from './GalleryShell.vue'
import CityAllCard from './CityAllCard.vue'
import MIcon from './MIcon.vue'

// 視圖畫廊：every city 的「所有地圖」縮圖。左側清單＝圈層面板的同款結構（Raw
// Maps / Map Adjust 直接列、Straighten 與 RWD Maps 為可收合子群組），逐一勾選
// 要顯示的圖層；每個圖層對應一張代表縮圖（Raw＝路網縮圖，其餘取 data/metro/
// {views,hcviews,rwdviews}/ 的代表視圖；RWD LLM 無預算圖 → 顯示「尚未預算」，
// 點擊仍即時計算）。預設顯示 Raw Maps＋全部 RWD Maps。點任何一格都匯入該城市
// 整組管線圖層（importCityChain）並開啟點到的那個圖層的 tab。
const store = useMapStore()

// 這是無圖層的固定 tab——圖層 tab 靠 selectedLayerId 記錄 active tab，畫廊得自己
// 回報，重新開啟時才能還原到畫廊。props.params.api = 本面板的 dockview api。
const props = defineProps({ params: { type: Object, required: true } })
onMounted(() => {
  const panelApi = props.params?.api
  if (!panelApi) return
  const mark = (active) => { if (active) store.setActiveTab('all-gallery') }
  const dispose = panelApi.onDidActiveChange(({ isActive }) => mark(isActive))
  mark(panelApi.isActive)
  onBeforeUnmount(() => dispose?.dispose?.())
})

async function load() {
  const res = await fetch(assetUrl('data/metro/views/index.json'), { cache: 'no-cache' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).systems ?? []
}

// 圖層節點：key（勾選鍵）、label（清單顯示名）、kind（卡片區段 raw/adjust/
// straighten/rwd）、view（代表縮圖 id）、icon（與圈層面板同款圖示）。
// 「基本」（hc 源）僅作 fallback，不列入畫廊——使用者裁決移除「原始・基本」「旋轉・基本」。
// Straighten 與 RWD Maps 共用同一組 4 條循環鏈（直角爬山／軸對齊／整數規劃／
// LLM 對齊）：Straighten 列每鏈的「循環結果」縮圖（loop-*），RWD 列其 RWD 路網
// 重繪（rwd-*）。LLM 對齊循環無離線預算 → 縮圖顯示「尚未預算」，點擊即時計算。
const CHAINS = [
  ['rect', '直角爬山'], ['align', '軸對齊'], ['ilp', '整數規劃'], ['llm', 'LLM 對齊'],
  ['stroke', '筆畫法'], ['milp', 'MILP規劃'], ['force', '力導向'], ['lsq', '最小平方'],
  ['octi', '八向格網'], ['path', '路徑簡化'], ['sat', 'SAT規劃'],
]
const stRows = (variant, vLabel) => CHAINS.map(([c, zh]) => ({
  key: `st-${variant}-${c}`, label: `${vLabel}・${zh}`, kind: 'straighten', view: `loop-${c}-${variant}`, icon: 'terrain',
}))
const rwdRows = (variant, vLabel) => CHAINS.map(([c, zh]) => ({
  key: `rwd-${variant}-${c}`, label: `${vLabel}・${zh}`, kind: 'rwd', view: `rwd-${c}-${variant}`, icon: 'route',
}))
// 左側清單樹（＝圈層面板結構）：直接列的圖層 + 可收合子群組。
const SIDE = [
  { t: 'layer', key: 'raw', label: 'Metro Maps', kind: 'raw', view: 'thumb', icon: 'train' },
  { t: 'group', id: 'adjust', label: 'Map Adjust', layers: [
    { key: 'adjust-orig', label: '原始・格網化後', kind: 'adjust', view: 'grid-orig-post', icon: 'polyline' },
    { key: 'adjust-rot', label: '旋轉・格網化後', kind: 'adjust', view: 'grid-rot-post', icon: 'polyline' },
  ] },
  { t: 'group', id: 'straighten', label: 'Straighten', layers: [...stRows('orig', '原始'), ...stRows('rot', '旋轉')] },
  { t: 'group', id: 'rwd', label: 'RWD Maps', layers: [...rwdRows('orig', '原始'), ...rwdRows('rot', '旋轉')] },
]
// 攤平成全部圖層（sections 計算與全選用）。
const ALL = SIDE.flatMap((n) => (n.t === 'layer' ? [n] : n.layers))

// 已勾選的圖層。預設：Raw Maps ＋全部 RWD Maps。
const shown = ref(new Set(['raw', ...ALL.filter((l) => l.kind === 'rwd').map((l) => l.key)]))
const isOn = (key) => shown.value.has(key)
function toggle(key) {
  const s = new Set(shown.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  shown.value = s
}
const allOn = computed(() => ALL.every((l) => shown.value.has(l.key)))
function toggleAll() {
  shown.value = allOn.value ? new Set() : new Set(ALL.map((l) => l.key))
}
// 子群組整組開關（tri-state：全開才勾）。
const groupAllOn = (node) => node.layers.every((l) => shown.value.has(l.key))
const groupSomeOn = (node) => node.layers.some((l) => shown.value.has(l.key))
function toggleGroup(node) {
  const on = groupSomeOn(node)
  const s = new Set(shown.value)
  for (const l of node.layers) { if (on) s.delete(l.key); else s.add(l.key) }
  shown.value = s
}
// 子群組收合（清單內，本地狀態；預設展開）。
const collapsed = reactive({ adjust: false, straighten: false, rwd: false })

// 卡片要畫的區段：把勾選的圖層依 kind 併起（同 kind 的代表 view 收成 order）。
const sections = computed(() => {
  const byKind = new Map()
  for (const l of ALL) {
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
  // variant 由 cell id 的 -orig/-rot 後綴決定（raw/adjust 無 viewId → 'orig'）。
  const variant = rwdCellVariant(viewId)
  // compact＝點到的那條鏈：RWD 從 rwd-/compact- 前綴剝、Straighten 從 loop- 前綴剝。
  const compact = kind === 'rwd' ? rwdCellCompact(viewId)
    : kind === 'straighten' ? loopCellCompact(viewId) : 'rect'
  const { metro, d3, hc, rwd } = store.importCityChain(entry, { variant, compact })
  const target = { raw: metro, adjust: d3, straighten: hc, rwd }[kind] ?? metro
  if (!target) { store.toast('無法建立視圖'); return }
  openLayerTab(target)
  store.toast(`已匯入 ${entry.cityZh ?? entry.city}`)
}
</script>

<template>
  <GalleryShell :load="load" loading-text="載入全球視圖清單…" error-hint="npm run metro:views">
    <!-- 左側清單（＝圈層面板結構）：顯示哪些圖層 -->
    <template #side>
      <div class="side-head">
        <span class="side-title">顯示圖層</span>
        <button class="side-all" @click="toggleAll">{{ allOn ? '全部清除' : '全部顯示' }}</button>
      </div>
      <template v-for="node in SIDE" :key="node.key ?? node.id">
        <!-- 直接列的圖層（Raw Maps / Map Adjust） -->
        <label v-if="node.t === 'layer'" class="side-row" :class="{ on: isOn(node.key) }">
          <input type="checkbox" :checked="isOn(node.key)" @change="toggle(node.key)" />
          <MIcon :name="node.icon" :size="13" class="side-icon" />
          <span class="side-name">{{ node.label }}</span>
        </label>
        <!-- 可收合子群組（Straighten / RWD Maps） -->
        <template v-else>
          <div class="side-sub">
            <button class="side-chev" @click="collapsed[node.id] = !collapsed[node.id]">
              <MIcon :name="collapsed[node.id] ? 'chevron_right' : 'expand_more'" :size="14" />
            </button>
            <input
              type="checkbox"
              class="side-sub-check"
              :checked="groupAllOn(node)"
              :indeterminate.prop="groupSomeOn(node) && !groupAllOn(node)"
              @change="toggleGroup(node)"
            />
            <span class="side-sub-name" @click="collapsed[node.id] = !collapsed[node.id]">{{ node.label }}</span>
            <span class="side-sub-count">{{ node.layers.length }}</span>
          </div>
          <template v-if="!collapsed[node.id]">
            <label
              v-for="l in node.layers"
              :key="l.key"
              class="side-row nested"
              :class="{ on: isOn(l.key) }"
            >
              <input type="checkbox" :checked="isOn(l.key)" @change="toggle(l.key)" />
              <MIcon :name="l.icon" :size="13" class="side-icon" />
              <span class="side-name">{{ l.label }}</span>
            </label>
          </template>
        </template>
      </template>
    </template>

    <template #default="{ tiles }">
      <div class="tile-grid">
        <CityAllCard v-for="s in tiles" :key="s.id" :entry="s" :sections="sections" @pick="pick" />
      </div>
    </template>
  </GalleryShell>
</template>

<style scoped>
.side-head { display: flex; align-items: center; gap: 6px; padding: 2px 4px 8px; }
.side-title { font-size: 12px; font-weight: 600; color: hsl(var(--muted-foreground)); }
.side-all {
  margin-left: auto;
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 4px);
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
.side-all:hover { color: hsl(var(--primary)); border-color: hsl(var(--primary) / 0.5); }

/* 圖層列（＝圈層面板 layer-row 的清單版） */
.side-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border-radius: calc(var(--radius) - 4px);
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: hsl(var(--foreground));
}
.side-row:hover { background: hsl(var(--accent) / 0.6); }
.side-row.on { color: hsl(var(--primary)); }
.side-row.nested { margin-left: 14px; border-left: 2px solid hsl(var(--border)); padding-left: 8px; }
.side-icon { flex-shrink: 0; color: hsl(var(--muted-foreground)); }
.side-row.on .side-icon { color: hsl(var(--primary)); }
.side-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-row input, .side-sub-check { accent-color: hsl(var(--primary)); margin: 0; flex-shrink: 0; }

/* 子群組標題（可收合 + 整組開關） */
.side-sub { display: flex; align-items: center; gap: 4px; padding: 4px 6px; }
.side-chev {
  display: inline-flex;
  color: hsl(var(--muted-foreground));
  flex-shrink: 0;
}
.side-sub-name {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  color: hsl(var(--muted-foreground));
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-sub-count {
  font-size: 10.5px;
  color: hsl(var(--muted-foreground) / 0.8);
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
}

/* 卡片自動排列：視圖少（窄）的城市同一排放多個、放不下就換行；卡片最寬 100%
   （很寬的城市卡片在卡片內部水平捲，頁面本身不出現水平捲軸）。 */
.tile-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}
</style>
