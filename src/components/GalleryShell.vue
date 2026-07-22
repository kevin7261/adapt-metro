<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { QUICK_CITIES, matchQuickSystem, orderQuickMetro } from '../lib/quickCities'
import { continentRank } from '../stores/metroCatalog'
import { getShapePresets } from '../stores/paper/shapePresets.js'
import CityIndexList from './CityIndexList.vue'

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

// 關掉畫廊 tab 再開／reload：還原目前分頁、排序、面板寬、捲動位置。
const SHELL_LS = 'adaptMetro.galleryShell.v1'
const TAB_IDS = new Set(['quick', 'stations', 'global', 'rings'])
function readShellLs() {
  try { return JSON.parse(localStorage.getItem(SHELL_LS) || 'null') } catch { return null }
}
function writeShellLs(partial) {
  try {
    const prev = readShellLs()
    const base = prev && typeof prev === 'object' ? prev : {}
    localStorage.setItem(SHELL_LS, JSON.stringify({ ...base, ...partial }))
  } catch { /* quota / private */ }
}
const savedShell = readShellLs() || {}

const catalog = ref(null)
const error = ref(null)
const bodyRef = ref(null)   // 卡片捲動容器——右側索引點城市時捲到對應卡片
onMounted(() => {
  Promise.resolve(props.load())
    .then((systems) => { catalog.value = systems ?? [] })
    .catch((err) => { error.value = String(err) })
})

// 右側城市索引：點一下捲到該城市的卡片（卡片以 data-city=系統 id 標記）。
function scrollToCity(id) {
  const el = bodyRef.value?.querySelector(`[data-city="${CSS.escape(String(id))}"]`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (id) writeShellLs({ scrollCity: id })
}

// 左（顯示圖層）與右（城市索引）兩塊面板都可左右拖拉調寬。
const sideWidth = ref(Number.isFinite(savedShell.sideWidth) ? savedShell.sideWidth : 220)
const indexWidth = ref(Number.isFinite(savedShell.indexWidth) ? savedShell.indexWidth : 184)
function makeResize(widthRef, dir, min, otherRef) {
  return (e) => {
    e.preventDefault()
    const startX = e.clientX, startW = widthRef.value
    const el = e.currentTarget
    // 上限不再寫死（原本 640＝只能拖一半）——改依畫廊主體寬度動態算，最多拖到只留
    // 「另一側面板寬 ＋ 240px 卡片區」，其餘都能給這一側（否則卡片區被擠到 0，縮圖
    // 幾何算出 NaN）。
    const main = el.closest('.gallery-main')
    // 把手抓住 pointer——拖過其他 dockview 面板/iframe 時事件才不會漏、不會拖到一半卡住。
    el.setPointerCapture?.(e.pointerId)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const move = (ev) => {
      const mainW = main?.clientWidth ?? window.innerWidth
      const max = Math.max(min, mainW - (otherRef?.value ?? 0) - 240)
      widthRef.value = Math.max(min, Math.min(max, startW + (ev.clientX - startX) * dir))
    }
    const up = (ev) => {
      el.releasePointerCapture?.(ev.pointerId)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
}
const startSideResize = makeResize(sideWidth, 1, 120, indexWidth)   // 把手在右緣：往右拖變寬
const startIndexResize = makeResize(indexWidth, -1, 120, sideWidth) // 把手在左緣：往左拖變寬

const TABS = [
  { id: 'quick', label: '快速選擇' },
  { id: 'stations', label: '依車站數排序' },
  { id: 'global', label: '全球地鐵地圖' },
  { id: 'rings', label: '環狀成方城市' },
]
const tab = ref(TAB_IDS.has(savedShell.tab) ? savedShell.tab : TABS[0].id)
const stationSort = ref(savedShell.stationSort === 'asc' ? 'asc' : 'desc')
// 「依車站數排序」tab 照站數順序、不分組；其餘 tab 依洲別/國家分組。
const grouped = computed(() => tab.value !== 'stations')

watch([tab, stationSort, sideWidth, indexWidth], () => {
  writeShellLs({
    tab: tab.value,
    stationSort: stationSort.value,
    sideWidth: sideWidth.value,
    indexWidth: indexWidth.value,
  })
})

// 卡片清單就緒後還原捲動（優先上次點過的城市，否則 scrollTop）。
let scrollRestored = false
watch(catalog, async (list) => {
  if (scrollRestored || !list?.length) return
  scrollRestored = true
  await nextTick()
  const el = bodyRef.value
  if (!el) return
  const city = savedShell.scrollCity
  if (city) {
    const card = el.querySelector(`[data-city="${CSS.escape(String(city))}"]`)
    if (card) { card.scrollIntoView({ block: 'start' }); return }
  }
  if (Number.isFinite(savedShell.scrollTop)) el.scrollTop = savedShell.scrollTop
})

let scrollTimer = null
function onBodyScroll() {
  const el = bodyRef.value
  if (!el) return
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => writeShellLs({ scrollTop: el.scrollTop }), 200)
}
onMounted(() => {
  bodyRef.value?.addEventListener('scroll', onBodyScroll, { passive: true })
})
onBeforeUnmount(() => {
  clearTimeout(scrollTimer)
  bodyRef.value?.removeEventListener('scroll', onBodyScroll)
  if (bodyRef.value) writeShellLs({ scrollTop: bodyRef.value.scrollTop })
})

const tiles = computed(() => {
  const all = catalog.value ?? []
  if (tab.value === 'quick') {
    // 與加入 modal 的「快速選擇」共用同一份清單＋同一套排序（國內依車站數多到少）。
    const matched = QUICK_CITIES.map((q) => matchQuickSystem(all, q.en)).filter(Boolean)
    return orderQuickMetro(matched, continentRank)
  }
  if (tab.value === 'stations') {
    const dir = stationSort.value === 'asc' ? 1 : -1
    return [...all].sort((a, b) => ((a.station_count ?? 0) - (b.station_count ?? 0)) * dir)
  }
  if (tab.value === 'rings') {
    // 只列「有規定環狀路段要成方」的城市（規定表 shapePresets）——排序跟快速選擇
    // 同一套（orderQuickMetro：洲別 → 國家首次出現序 → 國內站數多到少；變體跟 base）。
    // 先用 QUICK_CITIES 命中順序當輸入，國家首次出現序才會跟快速選擇一致。
    const withRings = all.filter((s) => (getShapePresets(s.id)?.length ?? 0) > 0)
    const fromQuick = QUICK_CITIES.map((q) => matchQuickSystem(withRings, q.en)).filter(Boolean)
    const seen = new Set(fromQuick.map((s) => s.id))
    const rest = withRings.filter((s) => !seen.has(s.id))
    return orderQuickMetro([...fromQuick, ...rest], continentRank)
  }
  // global: 依洲別「固定順序」（亞洲→歐洲→北美→南美→非洲→大洋洲，continentRank）分組，
  // 再國家→城市——與加入 modal／其他 tab 的 list 一致（原本用 localeCompare 會變字母序＝
  // 非洲排最前，與 list 不一樣）。
  return [...all].sort((a, b) =>
    continentRank(a.continent) - continentRank(b.continent) ||
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

    </div>

    <!-- 主體：可選的左側清單（#side，如視圖畫廊的「顯示圖層」）＋卡片區＋右側索引，
         左右兩塊面板都可拖拉調寬。 -->
    <div class="gallery-main">
      <template v-if="$slots.side">
        <aside class="gallery-side" :style="{ width: sideWidth + 'px' }">
          <slot name="side" />
        </aside>
        <div class="pane-resize" title="拖拉調整寬度" @pointerdown="startSideResize" />
      </template>
      <div ref="bodyRef" class="gallery-body">
        <div v-if="error" class="gallery-status">
          {{ errorText }}：{{ error }}
          <template v-if="errorHint"><br />（請先執行 <code>{{ errorHint }}</code>）</template>
        </div>
        <div v-else-if="!catalog" class="gallery-status">{{ loadingText }}</div>
        <slot v-else :tiles="tiles" />
      </div>

      <!-- 右側城市索引：依洲別/國家分組（同加入 modal）＋可收合；
           「依車站數排序」tab 則照站數順序、不分組。順序跟左邊卡片一致。 -->
      <div v-if="catalog && tiles.length" class="pane-resize" title="拖拉調整寬度" @pointerdown="startIndexResize" />
      <nav v-if="catalog && tiles.length" class="gallery-index" :style="{ width: indexWidth + 'px' }" aria-label="城市索引">
        <CityIndexList
          :items="tiles"
          :grouped="grouped"
          :sortable="tab === 'stations'"
          v-model:sort-dir="stationSort"
          count-noun="城市"
          @pick="scrollToCity($event.id)"
        />
      </nav>
    </div>

    <!-- Footer：每個 tab 都有 footer（即使沒資訊）。這裡顯示城市數當中性內容。 -->
    <footer class="gallery-statusbar">
      <span>{{ catalog ? `${tiles.length} 城市` : '—' }}</span>
    </footer>
  </div>
</template>

<style scoped>
.gallery { display: flex; flex-direction: column; height: 100%; background: hsl(var(--background)); }
/* Footer（與 LayerTab StatusBar／D3Tab ma-statusbar 同款）：每個 tab 都有 footer */
.gallery-statusbar {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 26px;
  flex-shrink: 0;
  padding: 0 12px;
  border-top: 1px solid hsl(var(--border));
  background: hsl(var(--background));
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
.gallery-tabs {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid hsl(var(--border));
  flex-shrink: 0;
  background: hsl(var(--card));
}
.gallery-tab {
  display: inline-flex;
  align-items: center;
  height: 30px;          /* 與工具列按鈕同高 30px */
  padding: 0 26px;
  font-size: 12px;
  font-weight: 500;
  color: hsl(var(--muted-foreground));
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  white-space: nowrap;
}
.gallery-tab:hover { color: hsl(var(--foreground)); }
.gallery-tab.active {
  color: hsl(var(--foreground));
  font-weight: 600;
  border-bottom-color: hsl(var(--primary));
}
/* 主體：左側清單｜卡片區｜右側索引，中間以可拖拉的把手分隔 */
.gallery-main { flex: 1; display: flex; min-height: 0; }
.gallery-side {
  flex-shrink: 0;
  overflow-y: auto;
  padding: 8px;
  background: hsl(var(--card));
}
/* 面板寬度拖拉把手（左側清單右緣／右側索引左緣共用） */
.pane-resize {
  flex: 0 0 5px;
  cursor: col-resize;
  touch-action: none;
  background: hsl(var(--border));
  transition: background 0.12s;
}
.pane-resize:hover { background: hsl(var(--primary) / 0.5); }
/* container-type so the tile grid responds to the PANEL width, not the viewport
   (the gallery lives in a resizable dockview panel). */
.gallery-body { flex: 1; overflow-y: auto; padding: 16px; container-type: inline-size; }
.gallery-status { padding: 32px; text-align: center; color: hsl(var(--muted-foreground)); font-size: 13px; line-height: 1.7; }
.gallery-status code { font-size: 12px; background: hsl(var(--muted) / 0.6); padding: 1px 5px; border-radius: 4px; }

/* 右側城市索引外框（內容由 CityIndexList 呈現）。block 排版讓子項不被壓扁。 */
.gallery-index {
  display: block;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 0 0 14px;
  background: hsl(var(--card));
}
</style>
