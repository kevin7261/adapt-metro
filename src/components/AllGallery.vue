<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { openLayerTab } from '../stores/dockHandle'
import { assetUrl } from '../lib/assetUrl'
import { rwdCellCompact, rwdCellVariant, loopCellCompact } from '../stores/viewGeometry'
import { PAPER_KINDS } from '../stores/paperAlign'
import GalleryShell from './GalleryShell.vue'
import CityAllCard from './CityAllCard.vue'
import MIcon from './MIcon.vue'

// 視圖畫廊：every city 的「所有地圖」縮圖。左側清單＝圈層面板的同款結構（Metro
// Maps / Map Adjust / Straighten / RWD Maps 各為可收合子群組），逐一勾選
// 要顯示的圖層；每個圖層對應一張代表縮圖（Metro Maps＝OSM路網縮圖／官方路線圖，
// 其餘取 data/metro/
// {views,hcviews,rwdviews}/ 的代表視圖；LLM 對齊鏈在有 llmviews 時由
// buildViews 預算進 hcviews/rwdviews，缺檔才顯示「尚未預算」）。預設只顯示
// Metro Maps（不含 RWD Maps）。點任何一格都匯入該城市
// 整組管線圖層（importCityChain）並開啟點到的那個圖層的 tab。
// Straighten／RWD 再依「無形狀／有形狀」分子群組；勾選狀態存 localStorage。
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
  const res = await fetch(assetUrl('data/metro/map-adjust/index.json'), { cache: 'no-cache' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).systems ?? []
}

// 圖層節點：key（勾選鍵）、label（清單顯示名）、kind（卡片區段 raw/adjust/
// straighten/rwd）、view（代表縮圖 id）、icon（與圈層面板同款圖示）。
// 「基本」（hc 源）僅作 fallback，不列入畫廊——使用者裁決移除「原始・基本」「旋轉・基本」。
// Straighten 與 RWD Maps 共用同一組 9 條循環鏈（論文①〜⑧＋LLM 對齊，鏈名取自
// paperAlign 的 PAPER_KINDS）：Straighten 列每鏈的「循環結果」縮圖（loop-*），
// RWD 列其 RWD 路網重繪（rwd-*）。LLM 對齊循環由 llmviews＋buildViews 離線預算。
const CHAINS = [
  ...PAPER_KINDS.map(({ kind, zh }) => [kind, zh]),
  ['llm', 'LLM 對齊'],
]
const stRows = (variant, vLabel) => CHAINS.map(([c, zh]) => ({
  key: `st-${variant}-${c}`, label: `${vLabel}・${zh}`, kind: 'straighten', view: `loop-${c}-${variant}`, icon: 'terrain',
}))
const rwdRows = (variant, vLabel) => CHAINS.map(([c, zh]) => ({
  key: `rwd-${variant}-${c}`, label: `${vLabel}・${zh}`, kind: 'rwd', view: `rwd-${c}-${variant}`, icon: 'route',
}))
// 左側清單樹：頂層群組可再含「無形狀／有形狀」子群組（Straighten／RWD）。
const SIDE = [
  { t: 'group', id: 'raw', label: 'Metro Maps', layers: [
    { key: 'raw-osm', label: 'OSM路網', kind: 'raw', view: 'thumb', icon: 'train' },
    { key: 'raw-official', label: '官方路線圖', kind: 'raw', view: 'official', icon: 'map' },
  ] },
  { t: 'group', id: 'adjust', label: 'Map Adjust', layers: [
    { key: 'adjust-orig', label: '原始・格網化後', kind: 'adjust', view: 'grid-orig-post', icon: 'polyline' },
    { key: 'adjust-rot', label: '旋轉・格網化後', kind: 'adjust', view: 'grid-rot-post', icon: 'polyline' },
  ] },
  // 無形狀＝原始／旋轉；有形狀＝原始-形狀／旋轉-形狀（餵 LLM 成方後的整條鏈）。
  // 縮圖由 buildViews 預算；形狀變體缺檔（非規定表城市）顯示「尚未預算」。
  { t: 'group', id: 'straighten', label: 'Straighten', subgroups: [
    { id: 'straighten-plain', label: '無形狀', layers: [
      ...stRows('orig', '原始'), ...stRows('rot', '旋轉'),
    ] },
    { id: 'straighten-shape', label: '有形狀', layers: [
      ...stRows('orig-shape', '原始-形狀'), ...stRows('rot-shape', '旋轉-形狀'),
    ] },
  ] },
  { t: 'group', id: 'rwd', label: 'RWD Maps', subgroups: [
    { id: 'rwd-plain', label: '無形狀', layers: [
      ...rwdRows('orig', '原始'), ...rwdRows('rot', '旋轉'),
    ] },
    { id: 'rwd-shape', label: '有形狀', layers: [
      ...rwdRows('orig-shape', '原始-形狀'), ...rwdRows('rot-shape', '旋轉-形狀'),
    ] },
  ] },
]
/** 頂層／子群組底下的圖層列（全選、sections、持久化過濾用）。 */
function nodeLayers(n) {
  if (n.t === 'layer') return [n]
  if (n.subgroups) return n.subgroups.flatMap((sg) => sg.layers)
  return n.layers ?? []
}
const ALL = SIDE.flatMap(nodeLayers)
const ALL_KEYS = new Set(ALL.map((l) => l.key))

// 勾選＋收合跨 reload（localStorage）。鍵變了（未知 key）會濾掉；缺省＝只勾 Metro Maps。
const LS_KEY = 'adaptMetro.galleryLayers.v2'
const DEFAULT_COLLAPSED = {
  raw: true, adjust: true, straighten: true, rwd: true,
  'straighten-plain': true, 'straighten-shape': true,
  'rwd-plain': true, 'rwd-shape': true,
}
function defaultShown() {
  return new Set(ALL.filter((l) => l.kind === 'raw').map((l) => l.key))
}
function readLs() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null') } catch { return null }
}
function writeLs(payload) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(payload)) } catch { /* quota / private */ }
}
function loadShown() {
  const raw = readLs()
  if (!raw?.shown || !Array.isArray(raw.shown)) return defaultShown()
  const next = raw.shown.filter((k) => ALL_KEYS.has(k))
  return next.length ? new Set(next) : defaultShown()
}
function loadCollapsed() {
  const raw = readLs()?.collapsed
  return { ...DEFAULT_COLLAPSED, ...(raw && typeof raw === 'object' ? raw : {}) }
}

const shown = ref(loadShown())
const collapsed = reactive(loadCollapsed())
watch([shown, collapsed], () => {
  writeLs({ shown: [...shown.value], collapsed: { ...collapsed } })
}, { deep: true })

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
// 群組／子群組整組開關（tri-state：全開才勾）。頂層有 subgroups 時涵蓋其全部圖層。
const layersOf = (node) => node.layers ?? nodeLayers(node)
const groupAllOn = (node) => layersOf(node).every((l) => shown.value.has(l.key))
const groupSomeOn = (node) => layersOf(node).some((l) => shown.value.has(l.key))
function toggleGroup(node) {
  const layers = layersOf(node)
  const on = groupSomeOn(node)
  const s = new Set(shown.value)
  for (const l of layers) { if (on) s.delete(l.key); else s.add(l.key) }
  shown.value = s
}

// 卡片要畫的區段：跟左側清單同一棵樹——Metro Maps／Map Adjust 各一欄；
// Straighten／RWD 再拆「無形狀／有形狀」兩欄（只列有勾選的）。
const sections = computed(() => {
  const out = []
  for (const node of SIDE) {
    if (node.subgroups) {
      for (const sg of node.subgroups) {
        const order = sg.layers.filter((l) => shown.value.has(l.key)).map((l) => l.view)
        if (!order.length) continue
        out.push({
          id: sg.id,
          kind: node.id, // pick() 用：straighten | rwd
          label: node.label,
          subLabel: sg.label, // 無形狀／有形狀
          order,
        })
      }
      continue
    }
    const order = (node.layers ?? []).filter((l) => shown.value.has(l.key)).map((l) => l.view)
    if (!order.length) continue
    out.push({ id: node.id, kind: node.id, label: node.label, order })
  }
  return out
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
        <button class="side-all bar-btn" @click="toggleAll">
          <MIcon :name="allOn ? 'deselect' : 'select_all'" :size="14" />
          <span>{{ allOn ? '全部清除' : '全部顯示' }}</span>
        </button>
      </div>
      <template v-for="node in SIDE" :key="node.key ?? node.id">
        <!-- 直接列的圖層（Raw Maps / Map Adjust） -->
        <label v-if="node.t === 'layer'" class="side-row" :class="{ on: isOn(node.key) }">
          <input type="checkbox" :checked="isOn(node.key)" @change="toggle(node.key)" />
          <MIcon :name="node.icon" :size="13" class="side-icon" />
          <span class="side-name">{{ node.label }}</span>
        </label>
        <!-- 可收合頂層群組（Metro Maps / Map Adjust / Straighten / RWD Maps） -->
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
            <span class="side-sub-count">{{ layersOf(node).length }}</span>
          </div>
          <template v-if="!collapsed[node.id]">
            <!-- Straighten／RWD：再分「無形狀／有形狀」 -->
            <template v-if="node.subgroups">
              <template v-for="sg in node.subgroups" :key="sg.id">
                <div class="side-sub nested-sub">
                  <button class="side-chev" @click="collapsed[sg.id] = !collapsed[sg.id]">
                    <MIcon :name="collapsed[sg.id] ? 'chevron_right' : 'expand_more'" :size="14" />
                  </button>
                  <input
                    type="checkbox"
                    class="side-sub-check"
                    :checked="groupAllOn(sg)"
                    :indeterminate.prop="groupSomeOn(sg) && !groupAllOn(sg)"
                    @change="toggleGroup(sg)"
                  />
                  <span class="side-sub-name" @click="collapsed[sg.id] = !collapsed[sg.id]">{{ sg.label }}</span>
                  <span class="side-sub-count">{{ sg.layers.length }}</span>
                </div>
                <template v-if="!collapsed[sg.id]">
                  <label
                    v-for="l in sg.layers"
                    :key="l.key"
                    class="side-row nested deep"
                    :class="{ on: isOn(l.key) }"
                  >
                    <input type="checkbox" :checked="isOn(l.key)" @change="toggle(l.key)" />
                    <MIcon :name="l.icon" :size="13" class="side-icon" />
                    <span class="side-name">{{ l.label }}</span>
                  </label>
                </template>
              </template>
            </template>
            <!-- Metro Maps／Map Adjust：直接列圖層 -->
            <template v-else>
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
/* 與 LayerPanel 工具列標準按鈕（.bar-btn：＋加入／視圖／全部刪除）完全同款
   （padding／font／icon＋text／radius／hover 全部一致）——全站按鈕 size 一致 */
.side-all {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 30px;          /* 與工具列 bar-btn 同高 30px */
  padding: 0 11px;
  font-size: 12px;
  font-weight: 550;
  color: hsl(var(--foreground));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius));
  background: hsl(var(--background));
  white-space: nowrap;
  transition: background 0.1s ease, border-color 0.1s ease;
}
.side-all:hover { background: hsl(var(--accent)); border-color: hsl(var(--muted-foreground) / 0.35); }

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
.side-row.nested.deep { margin-left: 28px; }
.side-icon { flex-shrink: 0; color: hsl(var(--muted-foreground)); }
.side-row.on .side-icon { color: hsl(var(--primary)); }
.side-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-row input, .side-sub-check { accent-color: hsl(var(--primary)); margin: 0; flex-shrink: 0; width: 14px; height: 14px; }

/* 子群組標題（可收合 + 整組開關） */
.side-sub { display: flex; align-items: center; gap: 4px; padding: 4px 6px; }
.side-sub.nested-sub { margin-left: 14px; border-left: 2px solid hsl(var(--border)); padding-left: 8px; }
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
