<script setup>
import { ref, computed, watch } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { dragResize } from '../lib/dragResize'
import MIcon from './MIcon.vue'
import StyleInfoTab from './style/StyleInfoTab.vue'
import StyleObjectTab from './style/StyleObjectTab.vue'
import StyleLlmTab from './style/StyleLlmTab.vue'
import './style/style-panel.css'

// The layer this tab edits — passed in by LayerTab.
const props = defineProps({
  layer: { type: Object, required: true },
  // LLM 對齊 provenance (the llmview file: model / prompt / per-round
  // transcript / finalOutput) — passed by D3Tab for Hill Climbing views;
  // when present, an extra「LLM對齊」tab appears after Object.
  llmRecord: { type: Object, default: null },
  // Run controls, wired to D3Tab's headless trigger: whether a run is in
  // flight, and whether this view has a city id to run against.
  llmRunning: { type: Boolean, default: false },
  llmCanRun: { type: Boolean, default: false },
  // 目前是否在「LLM 對齊」視圖（hc-llm 及其鏈）——只有這時才顯示自動/指定對齊 tab。
  llmView: { type: Boolean, default: false },
  llmText: { type: String, default: '' },   // 執行中即時串流的 LLM 回傳
  llmMsg: { type: String, default: null },  // 無結果/不符時的提示
  llmError: { type: String, default: '' },  // 執行失敗的尾巴訊息
  // 「執行調整」：對齊結果檔存了移動後座標，按鈕只切換「LLM 對齊」主視圖顯示
  // （套用對齊後座標 ⇄ 恢復對齊前的 Hill Climbing 佈局），不再跑 LLM。
  llmApplied: { type: Boolean, default: false },
  // 「指定對齊」（依一句話）＝與自動對齊完全獨立的一組：另存 .prompt.json、自己的
  // run/串流/結果/toggle。與自動對齊在主視圖互斥（同一個視圖只能顯示一種）。
  promptRecord: { type: Object, default: null },
  promptRunning: { type: Boolean, default: false },
  promptText: { type: String, default: '' },
  promptMsg: { type: String, default: null },
  promptError: { type: String, default: '' },
  promptApplied: { type: Boolean, default: false },
  // LLM 互動（RWD Maps「AI 改網格長寬」，skill route-llm-grid）：結果檔
  // （model / userPrompt / note / colW / rowW）＋run 控制＋即時串流——D3Tab 對
  // RWD 視圖傳入；「LLM互動」tab 對 rwd 常駐（輸入一句話觸發，跑完按「執行調整」
  // 才套用），跟「LLM評價」同一套唯讀＋切換的 UX。
  gridRecord: { type: Object, default: null },
  gridRunning: { type: Boolean, default: false },
  gridCanRun: { type: Boolean, default: false },
  gridText: { type: String, default: '' },   // 執行中即時串流的 LLM 回傳
  gridMsg: { type: String, default: null },  // 無結果/不符時的提示
  gridError: { type: String, default: '' },  // 執行失敗的尾巴訊息
  // 「執行調整」：跑完的區間權重（colW/rowW）存在結果檔，按鈕只切換顯示
  // （套用 intervalAxes ⇄ 恢復均勻/流量網格），不再跑 LLM。
  gridApplied: { type: Boolean, default: false },
  // LLM 評價（RWD Maps「AI 評路網佈局」，skill route-llm-eval）：結果檔
  // （model / summary / scores / lines / suggestions）＋run 控制與即時串流——
  // 只評價、不修改；「LLM評價」tab 對 rwd 常駐，接在「LLM互動」之後。
  evalRecord: { type: Object, default: null },
  evalRunning: { type: Boolean, default: false },
  evalCanRun: { type: Boolean, default: false },
  evalText: { type: String, default: '' },   // 執行中即時串流的 LLM 回傳
  evalMsg: { type: String, default: null },  // 無結果/不符時的提示
  evalError: { type: String, default: '' },  // 執行失敗的尾巴訊息
  // 「執行調整」：評價時已把附帶的 moves 過硬規則、把調整後佈局存進結果檔的
  // exec——按鈕只切換顯示（套用 exec.cells ⇄ 恢復原佈局），不再跑 LLM。
  evalApplied: { type: Boolean, default: false },
  // LLM 全部評價：一次比較原始＋旋轉最多 8 個候選，選全體／原始／旋轉最佳。
  compareRecord: { type: Object, default: null },
  compareRunning: { type: Boolean, default: false },
  compareCanRun: { type: Boolean, default: false },
  compareText: { type: String, default: '' },
  compareMsg: { type: String, default: null },
  compareError: { type: String, default: '' },
  // ⑨ LLM 成方（Shape-Guided 的 LLM 版，skill route-llm-shape）：結果檔
  // （model / square / crosses / transcript）＋run 控制與即時串流——只在
  // 「LLM 成方」比較視圖（layout-shape-llm）顯示，跟自動對齊同一套唯讀 UX。
  shapeRecord: { type: Object, default: null },
  shapeRunning: { type: Boolean, default: false },
  shapeCanRun: { type: Boolean, default: false },
  shapeView: { type: Boolean, default: false }, // 目前在 layout-shape-llm view
  shapeText: { type: String, default: '' },
  shapeMsg: { type: String, default: null },
  shapeError: { type: String, default: '' },
  shapeApplied: { type: Boolean, default: false },
  // 'd3' when shown inside a Map Adjust (D3.js) tab — Info then documents the
  // skeleton rules instead of the audit verdict.
  context: { type: String, default: 'map' },
  // Which D3 view this is: 'map-adjust' | 'hillclimb' | 'rwd' (D3Tab sets it),
  // or 'metro' for the MapLibre tab. Orientation shows only for metro maps and
  // Map Adjust; the skeleton rules only for Map Adjust.
  viewKind: { type: String, default: 'metro' },
  // RWD Maps 權重驅動版面（論文 §九）：目前模式（'uniform' | 'weight'），tab 在物件之後。
  weightMode: { type: String, default: 'uniform' },
  weightAuto: { type: Boolean, default: false }, // 每 5 秒自動重抽是否開啟
  showWeights: { type: Boolean, default: true },  // 是否顯示 weight 數字
  hideStops: { type: Boolean, default: false },  // 自動隱藏白點
  minStopPx: { type: Number, default: 5 },       // 最小站距門檻（pt），站距 < 此值才刪
  stopStat: { type: Object, default: null },     // { high, wide, hidden, hiddenNames, hiddenMaxT }
  // 顏色點間最大跨距：目前「已套用」的值（D3Tab 的快取是用它算的）——與滑桿
  // 值不同時「重新計算」按鈕亮起。
  spanApplied: { type: Number, default: null },
  // 原 footer 左側運算狀態（D3／Straighten／RWD）——顯示在資訊 tab 底部。
  layoutStatus: { type: Object, default: null }, // { text, llmRerun }
  dataSource: { type: String, default: null },
  // 三個 LLM 功能（評價/對齊/調整）共用的模型選擇短鍵（'default' | 'opus' |
  // 'fable' | 'sonnet' | 'haiku'）；下拉改動時 emit update:llm-model 回 D3Tab。
  llmModel: { type: String, default: 'opus' },
})
const emit = defineEmits(['run-llm', 'run-prompt', 'run-grid', 'run-eval', 'run-compare', 'run-shape', 'toggle-eval-exec', 'toggle-grid-exec', 'toggle-llm-exec', 'toggle-prompt-exec', 'toggle-shape-exec', 'weight-mode', 'weight-random', 'weight-auto', 'hide-stops', 'min-stop-px', 'show-weights', 'recalc-span', 'update:llm-model', 'llm-rerun'])

const store = useMapStore()
const selectedProps = computed(() => store.selectedFeatures[props.layer.id] ?? null)

const open = ref(true)
const width = ref(300)
const activeTab = ref('info')

const layer = computed(() => props.layer)
const isMetro = computed(() => layer.value?.type === 'metro' || layer.value?.metroLike === true)

const LLM_TABS = new Set(['grid', 'eval', 'compare', 'llm', 'llm-prompt', 'shape-llm'])
const isLlmTab = computed(() => LLM_TABS.has(activeTab.value))

function parseRoutes(p) {
  let routes = p?.routes
  if (typeof routes === 'string') {
    try { routes = JSON.parse(routes) } catch { return [] }
  }
  return Array.isArray(routes) ? routes : []
}

// 物件 tab 標籤＝目前選中 feature 的內容類型；TABS 用輕量判斷（不必跑完整站序）。
const objectKind = computed(() => {
  const p = selectedProps.value
  if (!p) return null
  if (p.landmark_id) return '地標'
  if (p.station_id) return '站點'
  if (parseRoutes(p).length) return '路線'
  return null
})

// Panel sections — the LLM對齊 tab is always present for Hill Climbing views
// (hosts run controls + streaming + the 執行調整/恢復 toggle, like LLM評價/互動).
// 「樣式」tab 已移到地圖上方的樣式工具列（StyleBar），這裡不再列出。
const TABS = computed(() => [
  { id: 'info', label: '資訊' },
  ...(objectKind.value ? [{ id: 'object', label: objectKind.value }] : []),
  ...(props.viewKind === 'rwd' ? [
    { id: 'grid', label: '互動', icon: 'auto_awesome', title: 'LLM互動' },
    { id: 'eval', label: '評價', icon: 'auto_awesome', title: 'LLM評價' },
    { id: 'compare', label: '比較', icon: 'auto_awesome', title: 'LLM全部評價' },
  ] : []),
  ...(props.llmView ? [{ id: 'llm', label: '自動對齊', icon: 'auto_awesome', title: 'LLM自動對齊' }, { id: 'llm-prompt', label: '指定對齊', icon: 'auto_awesome', title: 'LLM指定對齊' }] : []),
  ...(props.shapeView ? [{ id: 'shape-llm', label: 'LLM成方', icon: 'auto_awesome', title: 'LLM成方' }] : []),
])

watch(TABS, (tabs) => { if (!tabs.some((t) => t.id === activeTab.value)) activeTab.value = 'info' })
watch(selectedProps, (v) => { if (v) activeTab.value = 'object' })

const dragging = ref(false)
function startResize(e) {
  const startW = width.value
  const host = e.currentTarget?.parentElement
  const leftNav = host?.querySelector('.view-nav')
  dragResize(e, {
    dragging,
    onMove: (dx) => {
      const navW = leftNav ? leftNav.offsetWidth : 0
      const maxW = host ? Math.max(120, host.clientWidth - navW - 60) : 2000
      width.value = Math.min(maxW, Math.max(60, startW - dx))
    },
  })
}
</script>

<template>
  <!-- Collapsed rail -->
  <aside v-if="!open" class="rail" aria-label="Panel (collapsed)">
    <button class="btn-icon" title="展開面板" @click="open = true">
      <MIcon name="right_panel_open" :size="15" />
    </button>
    <MIcon name="tune" :size="14" class="rail-icon" />
    <span class="rail-label">資訊 / 物件</span>
  </aside>

  <template v-else>
    <div
      class="resize-x"
      :class="{ dragging }"
      role="separator"
      aria-orientation="vertical"
      @pointerdown="startResize"
    />

    <aside class="style-panel" aria-label="Layer panel" :style="{ width: width + 'px' }">
      <div class="panel-header tabs-header">
        <div class="panel-tabs" role="tablist">
          <button
            v-for="t in TABS"
            :key="t.id"
            class="panel-tab"
            :class="{ active: activeTab === t.id }"
            role="tab"
            :aria-selected="activeTab === t.id"
            :title="t.title ?? t.label"
            @click="activeTab = t.id"
          >
            <MIcon v-if="t.icon" :name="t.icon" :size="14" />
            {{ t.label }}
          </button>
        </div>
        <button class="btn-icon" title="收合面板" @click="open = false">
          <MIcon name="right_panel_close" :size="14" />
        </button>
      </div>

      <div class="style-body">
        <!-- 城市標題：所有 tab 都與「資訊」tab 一致（中文城市・國名 / 英文城市・國名） -->
        <div v-if="isMetro" class="info-title">
          <div class="info-title-zh">{{ layer.cityZh ?? layer.city }}・{{ layer.countryZh ?? layer.country }}</div>
          <div class="info-title-en">{{ layer.city }}・{{ layer.country }}</div>
        </div>
        <div v-else class="layer-heading">
          <span class="layer-name">{{ layer.name }}</span>
        </div>

        <StyleInfoTab
          v-if="activeTab === 'info'"
          :layer="layer"
          :context="context"
          :view-kind="viewKind"
          :span-applied="spanApplied"
          :hide-stops="hideStops"
          :stop-stat="stopStat"
          :layout-status="layoutStatus"
          :data-source="dataSource"
          @llm-rerun="emit('llm-rerun')"
        />

        <StyleObjectTab v-else-if="activeTab === 'object'" :layer="layer" />

        <StyleLlmTab
          v-else-if="isLlmTab"
          :kind="activeTab"
          :llm-record="llmRecord"
          :llm-running="llmRunning"
          :llm-can-run="llmCanRun"
          :llm-text="llmText"
          :llm-msg="llmMsg"
          :llm-error="llmError"
          :llm-applied="llmApplied"
          :prompt-record="promptRecord"
          :prompt-running="promptRunning"
          :prompt-text="promptText"
          :prompt-msg="promptMsg"
          :prompt-error="promptError"
          :prompt-applied="promptApplied"
          :grid-record="gridRecord"
          :grid-running="gridRunning"
          :grid-can-run="gridCanRun"
          :grid-text="gridText"
          :grid-msg="gridMsg"
          :grid-error="gridError"
          :grid-applied="gridApplied"
          :eval-record="evalRecord"
          :eval-running="evalRunning"
          :eval-can-run="evalCanRun"
          :eval-text="evalText"
          :eval-msg="evalMsg"
          :eval-error="evalError"
          :eval-applied="evalApplied"
          :compare-record="compareRecord"
          :compare-running="compareRunning"
          :compare-can-run="compareCanRun"
          :compare-text="compareText"
          :compare-msg="compareMsg"
          :compare-error="compareError"
          :shape-record="shapeRecord"
          :shape-running="shapeRunning"
          :shape-can-run="shapeCanRun"
          :shape-text="shapeText"
          :shape-msg="shapeMsg"
          :shape-error="shapeError"
          :shape-applied="shapeApplied"
          :llm-model="llmModel"
          @run-llm="emit('run-llm', $event)"
          @run-shape="emit('run-shape')"
          @toggle-shape-exec="emit('toggle-shape-exec')"
          @run-prompt="emit('run-prompt', $event)"
          @run-grid="emit('run-grid', $event)"
          @run-eval="emit('run-eval', $event)"
          @run-compare="emit('run-compare')"
          @toggle-eval-exec="emit('toggle-eval-exec')"
          @toggle-grid-exec="emit('toggle-grid-exec')"
          @toggle-llm-exec="emit('toggle-llm-exec')"
          @toggle-prompt-exec="emit('toggle-prompt-exec')"
          @update:llm-model="emit('update:llm-model', $event)"
        />
      </div>
    </aside>
  </template>
</template>
