<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { mapHandle } from '../stores/mapHandle'
import { layerData, boundsOfGeojson } from '../stores/layerData'
import { rwdFrameGroups } from '../lib/rwdFrames'
import { DEFAULT_RIVER_GRAY_SINUOSITY } from '../stores/skeleton'

// 樣式工具列（地圖上方）：一條工具列，每個工具各自縮成一顆 icon——按某顆 icon
// 才彈出「那一個」控制項的小視窗，且每個小視窗都有「預設」按鈕（把該屬性還原）。
// 控制項與原「樣式」tab 相同（依 isMetro / editable / viewKind 分支）。layer 為
// store 的響應式物件，直接改其屬性。
const props = defineProps({
  layer: { type: Object, required: true },
  viewKind: { type: String, default: 'metro' }, // 'metro' | 'map-adjust' | 'hillclimb' | 'rwd'
  // 以下皆為 RWD Maps 版面控制（狀態都在 D3Tab，工具列只顯示＋emit 回去）：
  showWeights: { type: Boolean, default: true }, // 顯示權重數字
  weightMode: { type: String, default: 'uniform' }, // 'uniform' | 'weight' | 'square'
  dirs: { type: Number, default: 8 }, // 允許的線方向數：4（只H/V）| 8（+45°）| 16（+22.5°）
  frame: { type: String, default: 'auto' }, // RWD 版面尺寸預設（目前／網頁／手機／IG）
  weightAuto: { type: Boolean, default: false }, // 每 5 秒自動重抽
  hideStops: { type: Boolean, default: false }, // 自動隱藏白點
  minStopPx: { type: Number, default: 5 }, // 最小站距（pt）
  stopStat: { type: Object, default: null }, // 即時診斷：{ high, wide, hidden, canvas }
  spanApplied: { type: Number, default: null }, // 顏色點間最大跨距「已套用」值（只 Straighten）
  riverGrayApplied: { type: Number, default: null }, // 河流分隔曲折度「已套用」值（只 Map Adjust）
  fisheye: { type: Boolean, default: false }, // 滑鼠放大鏡（魚眼變形，游標處放大網格）
  // OSM 實際軌道路線（25%）：只有 metro 地圖視圖、且該城市有軌道資料時才顯示。狀態
  // 在 LayerTab，工具列只顯示＋emit 回去。
  tracksAvailable: { type: Boolean, default: false },
  tracksOn: { type: Boolean, default: false },
  // 路線中線（同路線兩軌收成一條）：同上，另一個獨立的切換圖層。
  centerAvailable: { type: Boolean, default: false },
  centerOn: { type: Boolean, default: false },
})
const emit = defineEmits(['show-weights', 'weight-mode', 'dir-count', 'frame', 'weight-random', 'weight-auto', 'hide-stops', 'min-stop-px', 'recalc-span', 'recalc-river-gray', 'recalc-layout', 'fit-view', 'set-tracks', 'set-center', 'fisheye'])
const frameGroups = rwdFrameGroups()

// 地圖底色的 8 個預設快選色（依明度深→淺排序）
const BG_PRESETS = [
  '#000000', // 純黑
  '#0d1117', // 深灰藍（預設）
  '#1a1a2e', // 深藍紫
  '#12263a', // 深海藍
  '#0b3d2e', // 深墨綠
  '#333333', // 中灰
  '#f5f5f5', // 淺灰白
  '#fdf6e3', // 米黃
]

const isMetro = computed(() => props.layer?.type === 'metro' || props.layer?.metroLike === true)
// metro 地圖 tab（MapLibre）＝viewKind 'metro'；其餘（map-adjust/hillclimb/rwd）是 D3 network。
const isMetroView = computed(() => props.viewKind === 'metro')

// 「顯示全部」：把目前視圖縮放到能看見全部內容。
//  · metro 地圖（MapLibre）：fitBounds 到圖層的地理範圍。
//  · D3 network：emit 給 D3Tab，把 d3-zoom 重置回 identity（＝初始 fit 到容器的狀態）。
function fitView() {
  if (isMetroView.value) {
    const data = layerData[props.layer.id]
    const bbox = data && boundsOfGeojson(data)
    if (bbox) mapHandle.map?.fitBounds(bbox, { padding: 48, maxZoom: 13 })
  } else {
    emit('fit-view')
  }
}
const editable = computed(() => props.layer && !props.layer.isBasemap && !isMetro.value)
const isRwd = computed(() => props.viewKind === 'rwd')
// 第 2 排：RWD 有版面控制；Straighten（hillclimb）才有顏色點間最大跨距（SPAN_CAP
// 只約束爬山 movewise，RWD 畫線不用）；Map Adjust 有河流分隔曲折度。
const isHillclimb = computed(() => props.viewKind === 'hillclimb')
const isMapAdjust = computed(() => props.viewKind === 'map-adjust')
const hasRow2 = computed(() => isRwd.value || isHillclimb.value || isMapAdjust.value)

// 河流分隔曲折度草稿 vs 已套用——不同才亮「確定」。
// 草稿＝layer.riverGraySinuosity；已套用＝riverGrayApplied（來自 D3Tab 的 applied 快照，
// 與 panelLayer.riverGraySinuosityApplied 同步）。
const riverGrayDirty = computed(() => {
  const draft = +(props.layer?.riverGraySinuosity ?? DEFAULT_RIVER_GRAY_SINUOSITY)
  const applied = +(props.riverGrayApplied ?? props.layer?.riverGraySinuosityApplied ?? DEFAULT_RIVER_GRAY_SINUOSITY)
  return Math.abs(draft - applied) > 1e-9
})
function setRiverGrayDraft(raw) {
  const v = Math.max(1.01, Math.round((+raw || DEFAULT_RIVER_GRAY_SINUOSITY) * 100) / 100)
  props.layer.riverGraySinuosity = v // 只改草稿，不觸發重算
}

// 工具依「相關功能」分組（每組一格，組間加分隔線）：
//  · 路線：線寬（＋一般向量的 Symbology/顏色/邊寬）
//  · 車站：站點半徑、顯示站名
//  · 地圖：地圖底色
//  · 版面：顏色點間最大跨距（只 Straighten）
// 數字型的尺寸工具（線寬／半徑）直接在工具列用數字輸入，不彈小視窗——
// `num` = { prop, min, max, step, def }。其餘工具（顏色/Symbology/底色/跨距）
// 仍是點 icon 彈出自己的控制項。
const groups = computed(() => {
  const g = []
  if (isMetro.value) {
    g.push([{ id: 'bg', icon: 'format_color_fill', title: '地圖底色' }])
    g.push([{ id: 'lineWidth', icon: 'line_weight', title: '線寬', num: { prop: 'strokeWidth', min: 0.5, max: 8, step: 0.5, def: 2.5, unit: 'px' } }])
    const station = [
      { id: 'radius', icon: 'scatter_plot', title: '站點半徑', num: { prop: 'radius', min: 1, max: 10, step: 0.5, def: 4, unit: 'px' } },
    ]
    // 顯示/隱藏網格：只有 D3 示意圖視圖（map-adjust/straighten/rwd）有藍色示意網格；
    // 純 metro 地圖沒有網格。放在「顯示站名」前面（使用者要求）。預設顯示（showGrid
    // 未設＝開）→ toggle 帶 defaultOn。
    if (props.viewKind !== 'metro') {
      station.push({ id: 'grid', icon: 'grid_on', title: '網格', toggle: 'showGrid', defaultOn: true })
    }
    // 站名＝直接切換（不彈小視窗）；按鈕亮起＝開。預設關（layer.showLabels 未設）。
    station.push({ id: 'labels', icon: 'label', title: '站名', toggle: 'showLabels' })
    // 隱藏 Highlight（邊分類襯底：共線紅底／環線綠／頭尾共點藍，RWD 另含殘留衝突
    // 琥珀光暈）——除 Metro Maps 外都可切換（使用者要求，放在「站名」後面）。預設顯示
    //（showHighlight 未設＝開）→ toggle 帶 defaultOn。
    if (props.viewKind !== 'metro') {
      station.push({ id: 'highlight', icon: 'highlight', title: '注意路段', toggle: 'showHighlight', defaultOn: true })
      // 注意路段 | 重新計算——只由按鈕觸發完整下游 bake（開啟分頁不重算）
      station.push({ id: '_sep_recalc', sep: true })
      station.push({
        id: 'recalcLayout',
        title: '重新計算（寫入 straighten-cells，含直線演算法／循環／端點／縮減／合併）',
        action: 'recalc-layout',
      })
    }
    g.push(station)
  }
  if (editable.value) {
    const e = [
      { id: 'symbology', icon: 'category', title: 'Symbology' },
      { id: 'color', icon: 'palette', title: props.layer.type === 'line' ? '線色' : '填色／邊色' },
      { id: 'strokeWidth', icon: 'line_weight', title: props.layer.type === 'line' ? '線寬' : '邊寬', num: { prop: 'strokeWidth', min: 0, max: 10, step: 0.5, def: 2.5, unit: 'px' } },
    ]
    if (props.layer.type === 'point') e.push({ id: 'pointRadius', icon: 'scatter_plot', title: '半徑', num: { prop: 'radius', min: 1, max: 20, step: 1, def: 4, unit: 'px' } })
    g.push(e)
  }
  // RWD Maps 的版面控制（模式切換／隱藏白點／隨機權重…）改在模板裡直接列出（型別
  // 不一，見下方 v-if="isRwd" 區塊）。
  return g
})

// 工具列上的數字輸入：夾在 [min, max] 內寫回 layer。
function setNum(num, raw) {
  const v = +raw
  if (Number.isNaN(v)) return
  props.layer[num.prop] = Math.min(num.max, Math.max(num.min, v))
}

// 每個工具的預設值（「預設」按鈕還原用）。
function reset() {
  const l = props.layer
  switch (openTool.value) {
    case 'bg': l.d3Bg = null; break
    case 'symbology': l.symbology = 'categorized'; break
    case 'color': l.color = '#e11d48'; l.strokeColor = '#ffffff'; break
  }
}

// 目前展開的工具（單一）；每顆 icon 各自彈出自己的小視窗。
const openTool = ref(null)
const popPos = ref({ top: 0, left: 0 })
// 切換型工具（t.toggle＝layer 的屬性名，如 'showLabels'/'showGrid'）：亮起＝開。
// defaultOn＝未設值時視為開（網格預設顯示），否則未設＝關（站名預設隱藏）。
const toggleOn = (t) => (t.defaultOn ? props.layer[t.toggle] !== false : !!props.layer[t.toggle])
const isActive = (t) => (t.toggle ? toggleOn(t) : openTool.value === t.id)
function clickTool(t, e) {
  // 直接切換的工具（顯示站名／顯示網格）：不開彈窗，直接改 layer 屬性。
  if (t.toggle) { props.layer[t.toggle] = !toggleOn(t); openTool.value = null; return }
  if (openTool.value === t.id) { openTool.value = null; return }
  openTool.value = t.id
  const r = e.currentTarget.getBoundingClientRect()
  popPos.value = { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 240)) }
}
function onDocClick(e) {
  if (openTool.value && !e.target.closest('.sb-pop') && !e.target.closest('.sb-btn')) openTool.value = null
}
onMounted(() => document.addEventListener('mousedown', onDocClick))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick))
</script>

<template>
  <div class="stylebar">
    <!-- 第 1 排：一般工具（地圖底色／線寬／站點半徑／顯示站名…） -->
    <div class="sb-row">
      <!-- 顯示全部：縮放到能看見全部內容（metro 地圖 fitBounds／D3 network 重置縮放） -->
      <button class="sb-btn" title="顯示全部內容" @click="fitView">顯示全部</button>
      <div class="sb-sep" />
      <template v-for="(grp, gi) in groups" :key="gi">
        <div v-if="gi" class="sb-sep" />
        <template v-for="t in grp" :key="t.id">
          <div v-if="t.sep" class="sb-sep" />
          <!-- 數字型尺寸（線寬／半徑）：文字標籤＋數字框，不用 icon -->
          <label v-else-if="t.num" class="sb-inline" :title="t.title">
            <span class="sb-inline-label">{{ t.title }}</span>
            <input
              type="number"
              class="sb-inline-num"
              :min="t.num.min" :max="t.num.max" :step="t.num.step"
              :value="layer[t.num.prop] ?? t.num.def"
              @change="setNum(t.num, $event.target.value)"
            />
            <span v-if="t.num.unit" class="sb-unit">{{ t.num.unit }}</span>
          </label>
          <button
            v-else-if="t.action === 'recalc-layout'"
            class="sb-btn"
            :title="t.title"
            @click.stop="emit('recalc-layout')"
          >重新計算</button>
          <!-- 其餘工具（切換的顯示站名、或彈窗的地圖底色/顏色…）：純文字按鈕 -->
          <button
            v-else
            class="sb-btn"
            :class="{ active: isActive(t) }"
            :title="t.title"
            @click.stop="clickTool(t, $event)"
          >{{ t.title }}</button>
        </template>
      </template>
      <!-- OSM 實際軌道路線（25%）：切換型按鈕，只有 metro 地圖且該城市有軌道資料時出現。 -->
      <template v-if="tracksAvailable">
        <div class="sb-sep" />
        <button
          class="sb-btn"
          :class="{ active: tracksOn }"
          title="實際路線（25%）"
          @click="emit('set-tracks', !tracksOn)"
        >實際路線</button>
      </template>
      <!-- 路線中線：同路線上下行兩軌收成一條，疊在原軌道之上、可獨立切換。 -->
      <template v-if="centerAvailable">
        <div class="sb-sep" />
        <button
          class="sb-btn"
          :class="{ active: centerOn }"
          title="路線中線（同路線兩軌收成一條）"
          @click="emit('set-center', !centerOn)"
        >路線中線</button>
      </template>
    </div>

    <!-- 第 2 排：RWD 版面控制／Straighten 的線段最大跨距。權重 tab、設定 tab 都已
         拆空——工具在這排、說明移到右側「資訊」tab。 -->
    <div v-if="hasRow2" class="sb-row sb-row-2">
      <!-- RWD 專屬：方向數／版面模式／顯示權重數字／隱藏白點／最小站距／隨機權重 -->
      <template v-if="isRwd">
        <!-- 線方向數：4（只H/V）／8（+45°）／16（+22.5°）＝下拉選單 -->
        <label class="sb-inline" title="允許的線方向數">
          <span class="sb-inline-label">方向</span>
          <select
            class="sb-inline-select"
            :value="dirs"
            @change="emit('dir-count', +$event.target.value)"
          >
            <option :value="4">4方向</option>
            <option :value="8">8方向</option>
            <option :value="16">16方向</option>
          </select>
        </label>
        <!-- 版面尺寸：目前面板／網頁／手機／IG（固定座標系 + letterbox，模擬 RWD） -->
        <label class="sb-inline" title="模擬 RWD 的版面尺寸">
          <span class="sb-inline-label">版面</span>
          <select
            class="sb-inline-select sb-inline-select-wide"
            :value="frame"
            @change="emit('frame', $event.target.value)"
          >
            <template v-for="(g, gi) in frameGroups" :key="gi">
              <template v-if="!g.group">
                <option v-for="f in g.items" :key="f.id" :value="f.id">{{ f.label }}</option>
              </template>
              <optgroup v-else :label="g.group">
                <option v-for="f in g.items" :key="f.id" :value="f.id">{{ f.label }}</option>
              </optgroup>
            </template>
          </select>
        </label>
        <div class="sb-sep" />
        <!-- 版面模式：均勻網格／權重網格＝下拉選單 -->
        <label class="sb-inline" title="版面模式">
          <span class="sb-inline-label">網格</span>
          <select
            class="sb-inline-select"
            :value="['weight', 'square'].includes(weightMode) ? weightMode : 'uniform'"
            @change="emit('weight-mode', $event.target.value)"
          >
            <option value="uniform">均勻網格</option>
            <option value="square">方形網格</option>
            <option value="weight">權重網格</option>
          </select>
        </label>
        <!-- 權重數字：開關，顯示中就亮起（不翻標籤）。 -->
        <button
          class="sb-btn"
          :class="{ active: showWeights }"
          title="顯示權重數字"
          @click="emit('show-weights', !showWeights)"
        >權重</button>

        <div class="sb-sep" />
        <!-- 車站白點（直通站圓點）：亮起＝顯示，暗＝依最小站距自動隱藏。 -->
        <button
          class="sb-btn"
          :class="{ active: !hideStops }"
          title="車站白點（直通站圓點）：亮起＝顯示，暗＝依最小站距自動隱藏"
          @click="emit('hide-stops', !hideStops)"
        >車站白點</button>
        <label class="sb-inline" title="最小站距（pt）">
          <span class="sb-inline-label">最小站距</span>
          <input
            type="number" class="sb-inline-num" min="1" step="1"
            :value="minStopPx"
            @change="emit('min-stop-px', $event.target.value)"
          />
          <span class="sb-unit">pt</span>
        </label>
        <div class="sb-sep" />
        <!-- 權重：全部隨機一次／每 5 秒自動重抽（開關）——只在權重比例模式有意義。 -->
        <button class="sb-btn" title="全部隨機（1–9）" @click="emit('weight-random')">隨機權重</button>
        <button
          class="sb-btn"
          :class="{ active: weightAuto }"
          @click="emit('weight-auto')"
        >{{ weightAuto ? '停止隨機權重' : '每5秒隨機權重' }}</button>
        <div class="sb-sep" />
        <!-- 滑鼠放大鏡：開啟後游標所在細格為焦點，附近欄／列撐開、遠處壓扁（魚眼變形，
             外框固定）；footer 顯示游標座標。 -->
        <button
          class="sb-btn"
          :class="{ active: fisheye }"
          title="滑鼠放大鏡（魚眼變形）：游標處放大網格，footer 顯示座標"
          @click="emit('fisheye', !fisheye)"
        >放大鏡</button>
      </template>

      <!-- 顏色點間最大跨距（只 Straighten）：改數字即重算（不必再按按鈕）。 -->
      <label v-if="isHillclimb" class="sb-inline" title="線段最大跨距（格）">
        <span class="sb-inline-label">線段最大跨距</span>
        <input
          type="number" class="sb-inline-num" min="1" step="1"
          :value="layer.spanCap ?? 3"
          @change="layer.spanCap = Math.max(1, Math.round(+$event.target.value) || 3); emit('recalc-span')"
        />
        <span class="sb-unit">格</span>
      </label>

      <!-- 河流分隔曲折度（只 Map Adjust）：輸入改草稿，按「確定」才重算本城市骨架灰點。
           門檻＝粉紅／黃點等邊界之間子段弧長÷弦長；> 此值就在最中間放灰並遞迴細分。
           下限 1.01（1.0 會讓幾乎每個河點變灰、佈局卡死）。 -->
      <label v-if="isMapAdjust" class="sb-inline" title="河流分隔曲折度：粉紅／黃點之間子段弧長÷弦長 > 此值就放灰分隔點（預設 1.15）">
        <span class="sb-inline-label">河流分隔曲折度</span>
        <input
          type="number" class="sb-inline-num" min="1.01" max="3" step="0.01"
          :value="layer.riverGraySinuosity ?? DEFAULT_RIVER_GRAY_SINUOSITY"
          @change="setRiverGrayDraft($event.target.value)"
        />
      </label>
      <button
        v-if="isMapAdjust"
        class="sb-btn"
        :class="{ active: riverGrayDirty }"
        :disabled="!riverGrayDirty"
        title="套用河流分隔曲折度並重算本城市：骨架灰點 ＋ Straighten ＋ RWD Maps（已開啟的分頁會一併重算）"
        @click="emit('recalc-river-gray')"
      >確定</button>
    </div>

    <Teleport to="body">
      <div
        v-if="openTool"
        class="sb-pop menu-pop"
        :style="{ position: 'fixed', top: popPos.top + 'px', left: popPos.left + 'px' }"
      >
        <!-- 地圖底色（metro） -->
        <template v-if="openTool === 'bg'">
          <label class="sb-label">地圖底色</label>
          <div class="sb-swatches">
            <button
              v-for="c in BG_PRESETS"
              :key="c"
              type="button"
              class="sb-swatch"
              :class="{ 'is-active': (layer.d3Bg || '#0d1117').toLowerCase() === c.toLowerCase() }"
              :style="{ background: c }"
              :title="c"
              @click="layer.d3Bg = c"
            />
          </div>
          <label class="sb-custom">
            <span class="sb-label">自訂</span>
            <span class="sb-custom-hex">{{ (layer.d3Bg || '#0d1117').toUpperCase() }}</span>
            <input type="color" class="sb-color sb-color-sm" :value="layer.d3Bg || '#0d1117'" @input="layer.d3Bg = $event.target.value" />
          </label>
        </template>

        <!-- Symbology（一般向量） -->
        <template v-else-if="openTool === 'symbology'">
          <label class="sb-label">Symbology</label>
          <select v-model="layer.symbology" class="sb-select">
            <option value="single">Single symbol</option>
            <option value="categorized">Categorized</option>
            <option value="graduated">Graduated</option>
            <option value="rule-based">Rule-based</option>
            <option value="expression">Expression</option>
          </select>
        </template>

        <!-- 顏色（一般向量） -->
        <template v-else-if="openTool === 'color'">
          <div class="sb-row">
            <div class="sb-col">
              <label class="sb-label">{{ layer.type === 'line' ? '線色' : '填色' }}</label>
              <input v-model="layer.color" type="color" class="sb-color" />
            </div>
            <div v-if="layer.type !== 'line'" class="sb-col">
              <label class="sb-label">邊色</label>
              <input v-model="layer.strokeColor" type="color" class="sb-color" />
            </div>
          </div>
        </template>

        <!-- 每個工具都有的「預設」按鈕 -->
        <div class="sb-foot">
          <button class="sb-reset" @click="reset">預設</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.stylebar {
  display: flex;
  flex-direction: column; /* 一般工具在第 1 排、RWD 版面控制在第 2 排 */
  gap: 3px;
  padding: 6px 10px;
  flex-shrink: 0;
  border-bottom: 1px solid hsl(var(--border));
  background: hsl(var(--card));
}
.sb-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap; /* 放不下就換行不裁切 */
  gap: 3px;
}
/* 第 2 排（RWD）與第 1 排間的分隔線 */
.sb-row-2 {
  padding-top: 4px;
  border-top: 1px solid hsl(var(--border) / 0.6);
}
/* 相關功能分組的分隔線 */
.sb-sep {
  width: 1px;
  height: 18px;
  margin: 0 3px;
  background: hsl(var(--border));
}
/* 純文字按鈕（不用 icon）：寬度隨字撐開 */
.sb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;          /* 全站按鈕統一高度 30px（＝bar-btn） */
  padding: 0 11px;
  font-size: 12px;
  font-weight: 550;
  white-space: nowrap;
  color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius));
  background: hsl(var(--background));
  transition: background 0.08s ease, color 0.08s ease, border-color 0.08s ease;
}
.sb-btn:hover:not(:disabled), .sb-btn.active {
  color: hsl(var(--foreground));
  background: hsl(var(--accent));
  border-color: hsl(var(--border));
}
.sb-btn.active {
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.12);
  border-color: hsl(var(--primary) / 0.35);
}
.sb-btn:disabled { opacity: 0.4; cursor: default; }

/* 二選一的 group button（均勻網格／權重比例）：兩顆併成一體、選中的高亮 */
.sb-group {
  display: inline-flex;
  height: 26px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  overflow: hidden;
  background: hsl(var(--background));
}
.sb-group-btn {
  display: inline-flex;
  align-items: center;
  height: 30px;          /* 全站按鈕統一高度 30px */
  padding: 0 11px;
  font-size: 12px;
  font-weight: 550;
  white-space: nowrap;
  color: hsl(var(--muted-foreground));
  background: transparent;
  border: none;
  border-right: 1px solid hsl(var(--border));
}
.sb-group-btn:last-child { border-right: none; }
.sb-group-btn:hover { color: hsl(var(--foreground)); background: hsl(var(--accent)); }
.sb-group-btn.active {
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.12);
  font-weight: 600;
}

/* 工具列上直接輸入的數字尺寸（線寬／半徑／最小站距）：文字標籤＋數字框 */
.sb-inline {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;          /* 數字輸入框（input）與按鈕同高 30px */
  padding: 0 8px;
  color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius));
  background: hsl(var(--background));
}
.sb-inline-label { font-size: 12px; white-space: nowrap; }
.sb-inline:focus-within {
  color: hsl(var(--primary));
  border-color: hsl(var(--primary) / 0.4);
}
.sb-inline-num {
  /* 夠寬讓數字不被右側原生上下箭頭擋住；靠左對齊，數字在左、spinner 在右 */
  width: 48px;
  padding: 2px 2px 2px 4px;
  font-size: 12px;
  text-align: left;
  color: hsl(var(--foreground));
  background: transparent;
  border: none;
}
.sb-inline-num:focus { outline: none; }
.sb-inline-select {
  padding: 0 2px;
  font-size: 12px;
  color: hsl(var(--foreground));
  background: transparent;
  border: none;
  cursor: pointer;
  max-width: 140px;
}
.sb-inline-select-wide { max-width: 200px; }
.sb-inline-select:focus { outline: none; }
.sb-unit { font-size: 11px; color: hsl(var(--muted-foreground)); padding-right: 2px; }

/* 單一控制項的小視窗 */
.sb-pop {
  z-index: 80;
  min-width: 200px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sb-label { font-size: 11.5px; color: hsl(var(--muted-foreground)); }
.sb-row { display: flex; align-items: center; gap: 8px; }
.sb-col { display: flex; flex-direction: column; gap: 4px; }
.sb-slider { width: 176px; }
.sb-num {
  width: 60px;
  padding: 4px 6px;
  font-size: 12px;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 4px);
  color: hsl(var(--foreground));
}
.sb-select {
  padding: 4px 6px;
  font-size: 12px;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 4px);
  color: hsl(var(--foreground));
}
.sb-color {
  width: 44px;
  height: 26px;
  padding: 0;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 4px);
  background: none;
  cursor: pointer;
}
.sb-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 2px 0 4px;
}
.sb-swatch {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid hsla(0, 0%, 50%, 0.35);
  border-radius: 5px;
  cursor: pointer;
  transition: transform 0.08s ease, box-shadow 0.08s ease;
}
.sb-swatch:hover {
  transform: scale(1.12);
}
.sb-swatch.is-active {
  box-shadow: 0 0 0 1.5px hsl(var(--background)), 0 0 0 3px hsl(var(--primary));
}
.sb-custom {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 6px;
  margin-top: 2px;
  border-top: 1px solid hsl(var(--border));
  cursor: pointer;
}
.sb-custom-hex {
  margin-left: auto;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.3px;
  color: hsl(var(--muted-foreground));
}
.sb-color-sm {
  width: 30px;
  height: 22px;
}
.sb-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: hsl(var(--foreground));
  cursor: pointer;
}
.sb-check input { accent-color: hsl(var(--primary)); margin: 0; }
.sb-btn2 {
  display: inline-flex;
  align-items: center;
  height: 30px;          /* 全站按鈕統一高度 30px */
  padding: 0 11px;
  font-size: 12px;
  border: 1px solid hsl(var(--primary) / 0.5);
  border-radius: calc(var(--radius));
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.1);
  white-space: nowrap;
}
.sb-btn2:hover:not(:disabled) { background: hsl(var(--primary) / 0.2); }
.sb-btn2:disabled { opacity: 0.45; cursor: default; }
/* 預設按鈕：與控制項間隔一條分隔線 */
.sb-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid hsl(var(--border));
}
.sb-reset {
  padding: 3px 12px;
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 4px);
}
.sb-reset:hover { color: hsl(var(--primary)); border-color: hsl(var(--primary) / 0.5); }
</style>
