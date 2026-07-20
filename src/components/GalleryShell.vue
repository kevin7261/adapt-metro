<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { QUICK_CITIES, matchQuickSystem } from '../lib/quickCities'
import { continentZh } from '../stores/metroCatalog'
import MIcon from './MIcon.vue'

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
}

// 「依車站數排序」tab 照站數順序、不分組；其餘 tab 依洲別/國家分組。
const grouped = computed(() => tab.value !== 'stations')
// 索引群組的收合狀態。預設「縮」：洲別預設收起（只顯示洲別標題）；展開洲別後其
// 國家預設展開（直接看到城市），可再個別收起國家。
const expandedCont = reactive({})     // true = 展開該洲
const collapsedCountry = reactive({}) // true = 收起該國城市
const toggleCont = (k) => { expandedCont[k] = !expandedCont[k] }
const toggleCountry = (k) => { collapsedCountry[k] = !collapsedCountry[k] }

// 右側索引依「加入 modal」的分類分組：洲別 → 國家 → 城市。**順序完全跟著左邊
// 卡片（tiles）走**——逐一掃過 tiles、洲別/國家一變就插一個標題，故左右順序一致。
const indexGroups = computed(() => {
  const groups = []
  let g = null, c = null
  for (const t of tiles.value) {
    if (!g || g.continent !== t.continent) {
      g = { continent: t.continent, contLabel: continentZh(t.continent), countries: [] }
      groups.push(g); c = null
    }
    if (!c || c.country !== t.country) {
      c = { country: t.country, countryLabel: t.countryZh ?? t.country, cities: [] }
      g.countries.push(c)
    }
    c.cities.push(t)
  }
  return groups
})

// 左（顯示圖層）與右（城市索引）兩塊面板都可左右拖拉調寬。
const sideWidth = ref(220)
const indexWidth = ref(184)
function makeResize(widthRef, dir, min, max) {
  return (e) => {
    e.preventDefault()
    const startX = e.clientX, startW = widthRef.value
    const el = e.currentTarget
    // 把手抓住 pointer——拖過其他 dockview 面板/iframe 時事件才不會漏、不會拖到一半卡住。
    el.setPointerCapture?.(e.pointerId)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const move = (ev) => {
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
const startSideResize = makeResize(sideWidth, 1, 150, 640)   // 把手在右緣：往右拖變寬
const startIndexResize = makeResize(indexWidth, -1, 140, 640) // 把手在左緣：往左拖變寬

const TABS = [
  { id: 'quick', label: '快速選擇' },
  { id: 'stations', label: '依車站數排序' },
  { id: 'global', label: '全球地鐵地圖' },
]
const tab = ref(TABS[0].id)
const stationSort = ref('desc')

const tiles = computed(() => {
  const all = catalog.value ?? []
  if (tab.value === 'quick') {
    // 與加入 modal 的「快速選擇」共用同一份清單（含＋地標／＋山手／＋環狀變體）。
    return QUICK_CITIES.map((q) => matchQuickSystem(all, q.en)).filter(Boolean)
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
        <!-- 分組模式 -->
        <template v-if="grouped">
          <template v-for="g in indexGroups" :key="g.continent">
            <button class="gi-cont" @click="toggleCont(g.continent)">
              <MIcon :name="expandedCont[g.continent] ? 'expand_more' : 'chevron_right'" :size="14" class="gi-chev" />
              <span>{{ g.contLabel }}</span>
            </button>
            <template v-if="expandedCont[g.continent]">
              <template v-for="c in g.countries" :key="c.country">
                <button class="gi-country" @click="toggleCountry(g.continent + '|' + c.country)">
                  <MIcon :name="collapsedCountry[g.continent + '|' + c.country] ? 'chevron_right' : 'expand_more'" :size="12" class="gi-chev" />
                  <span>{{ c.countryLabel }}</span>
                </button>
                <template v-if="!collapsedCountry[g.continent + '|' + c.country]">
                  <button
                    v-for="t in c.cities"
                    :key="t.id"
                    class="gi-item"
                    :title="`${t.cityZh ?? t.city} · ${t.countryZh ?? t.country}`"
                    @click="scrollToCity(t.id)"
                  >{{ t.cityZh ?? t.city }}</button>
                </template>
              </template>
            </template>
          </template>
        </template>
        <!-- 依車站數排序：照順序的平面清單 -->
        <template v-else>
          <button
            v-for="t in tiles"
            :key="t.id"
            class="gi-item flat"
            :title="`${t.cityZh ?? t.city} · ${t.countryZh ?? t.country}`"
            @click="scrollToCity(t.id)"
          >{{ t.cityZh ?? t.city }}</button>
        </template>
      </nav>
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

/* 右側城市索引：依洲別/國家分組（可收合），順序跟左邊卡片一致。
   block 排版（非 flex）——flex column 子項會被壓扁裁切文字。 */
.gallery-index {
  display: block;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 0 0 14px;
  background: hsl(var(--card));
}
/* 洲別標題（可點收合、置頂） */
.gi-cont {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 3px;
  width: 100%;
  padding: 7px 10px 6px;
  font-size: 13px;
  font-weight: 700;
  text-align: left;
  color: hsl(var(--foreground));
  background: hsl(var(--muted) / 0.5);
  border-bottom: 1px solid hsl(var(--border));
  backdrop-filter: blur(2px);
}
.gi-cont:hover { color: hsl(var(--primary)); }
/* 國家標題（可點收合） */
.gi-country {
  display: flex;
  align-items: center;
  gap: 3px;
  width: 100%;
  padding: 5px 10px 3px 16px;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  color: hsl(var(--muted-foreground));
}
.gi-country:hover { color: hsl(var(--primary)); }
.gi-chev { flex-shrink: 0; opacity: 0.55; }
/* 城市（可點捲動目標） */
.gi-item {
  display: block;
  width: 100%;
  padding: 4px 10px 4px 34px;
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  color: hsl(var(--foreground) / 0.82);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gi-item.flat { padding-left: 12px; }
.gi-item:hover { background: hsl(var(--accent)); color: hsl(var(--primary)); }
</style>
