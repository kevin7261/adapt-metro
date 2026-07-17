<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

// 樣式工具列（地圖上方）：一條工具列，每個工具各自縮成一顆 icon——按某顆 icon
// 才彈出「那一個」控制項的小視窗，且每個小視窗都有「預設」按鈕（把該屬性還原）。
// 控制項與原「樣式」tab 相同（依 isMetro / editable / viewKind 分支）。layer 為
// store 的響應式物件，直接改其屬性。
const props = defineProps({
  layer: { type: Object, required: true },
  viewKind: { type: String, default: 'metro' }, // 'metro' | 'map-adjust' | 'hillclimb' | 'rwd'
  // 以下皆為 RWD Maps 版面控制（狀態都在 D3Tab，工具列只顯示＋emit 回去）：
  showWeights: { type: Boolean, default: true }, // 顯示權重數字
  weightMode: { type: String, default: 'uniform' }, // 'uniform' | 'weight'
  weightAuto: { type: Boolean, default: false }, // 每 5 秒自動重抽
  hideStops: { type: Boolean, default: false }, // 自動隱藏白點
  minStopPx: { type: Number, default: 5 }, // 最小站距（pt）
})
const emit = defineEmits(['show-weights', 'weight-mode', 'weight-random', 'weight-auto', 'hide-stops', 'min-stop-px'])

const isMetro = computed(() => props.layer?.type === 'metro' || props.layer?.metroLike === true)
const editable = computed(() => props.layer && !props.layer.isBasemap && !isMetro.value)
const isRwd = computed(() => props.viewKind === 'rwd')

// 工具依「相關功能」分組（每組一格，組間加分隔線）：
//  · 路線：線寬（＋一般向量的 Symbology/顏色/邊寬）
//  · 車站：站點半徑、顯示站名
//  · 地圖：地圖底色
//  · 版面：顏色點間最大跨距（Straighten/RWD）
// 數字型的尺寸工具（線寬／半徑）直接在工具列用數字輸入，不彈小視窗——
// `num` = { prop, min, max, step, def }。其餘工具（顏色/Symbology/底色/跨距）
// 仍是點 icon 彈出自己的控制項。
const groups = computed(() => {
  const g = []
  if (isMetro.value) {
    g.push([{ id: 'bg', icon: 'format_color_fill', title: '地圖底色' }])
    g.push([{ id: 'lineWidth', icon: 'line_weight', title: '線寬', num: { prop: 'strokeWidth', min: 0.5, max: 8, step: 0.5, def: 2.5, unit: 'px' } }])
    g.push([
      { id: 'radius', icon: 'scatter_plot', title: '站點半徑', num: { prop: 'radius', min: 1, max: 10, step: 0.5, def: 4, unit: 'px' } },
      // 顯示站名＝直接切換（不彈小視窗）；按鈕亮起＝開。預設關（layer.showLabels 未設）。
      { id: 'labels', icon: 'label', title: '顯示站名', toggle: true },
    ])
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
  // 不一，見下方 v-if="isRwd" 區塊）。顏色點間最大跨距則移到右側面板的「設定」tab。
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
const isActive = (t) => (t.toggle ? props.layer.showLabels : openTool.value === t.id)
function clickTool(t, e) {
  // 直接切換的工具（顯示站名）：不開彈窗，直接改 layer 屬性。
  if (t.toggle) { props.layer.showLabels = !props.layer.showLabels; openTool.value = null; return }
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
    <template v-for="(grp, gi) in groups" :key="gi">
      <div v-if="gi" class="sb-sep" />
      <template v-for="t in grp" :key="t.id">
        <!-- 數字型尺寸（線寬／半徑）：文字標籤＋數字框，不用 icon -->
        <label v-if="t.num" class="sb-inline" :title="t.title">
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

    <!-- RWD Maps 版面控制（只有 RWD 視圖出現；狀態在 D3Tab，emit 回去）。
         權重 tab 只剩顯示資訊，這些互動控制全部搬到這裡。純文字、不用 icon。 -->
    <template v-if="isRwd">
      <div class="sb-sep" />
      <!-- 版面模式：均勻網格／權重比例＝二選一的 group button -->
      <div class="sb-group" role="group" aria-label="版面模式">
        <button
          class="sb-group-btn"
          :class="{ active: weightMode !== 'weight' }"
          @click="emit('weight-mode', 'uniform')"
        >均勻網格</button>
        <button
          class="sb-group-btn"
          :class="{ active: weightMode === 'weight' }"
          @click="emit('weight-mode', 'weight')"
        >權重比例</button>
      </div>
      <button
        class="sb-btn"
        :class="{ active: showWeights }"
        @click="emit('show-weights', !showWeights)"
      >顯示權重數字</button>

      <div class="sb-sep" />
      <button
        class="sb-btn"
        :class="{ active: hideStops }"
        @click="emit('hide-stops', !hideStops)"
      >自動隱藏白點</button>
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
      <button class="sb-btn" title="全部隨機（1–9）" @click="emit('weight-random')">隨機權重</button>
      <button
        class="sb-btn"
        :class="{ active: weightAuto }"
        @click="emit('weight-auto')"
      >{{ weightAuto ? '停止隨機權重' : '每5秒隨機權重' }}</button>
    </template>

    <Teleport to="body">
      <div
        v-if="openTool"
        class="sb-pop menu-pop"
        :style="{ position: 'fixed', top: popPos.top + 'px', left: popPos.left + 'px' }"
      >
        <!-- 地圖底色（metro） -->
        <template v-if="openTool === 'bg'">
          <label class="sb-label">地圖底色</label>
          <input type="color" class="sb-color" :value="layer.d3Bg || '#0d1117'" @input="layer.d3Bg = $event.target.value" />
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
  align-items: center;
  flex-wrap: wrap; /* RWD 視圖控制多，放不下就換行不裁切 */
  gap: 4px;
  padding: 5px 8px;
  flex-shrink: 0;
  border-bottom: 1px solid hsl(var(--border));
  background: hsl(var(--card));
}
/* 相關功能分組的分隔線 */
.sb-sep {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: hsl(var(--border));
}
/* 純文字按鈕（不用 icon）：寬度隨字撐開 */
.sb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
  white-space: nowrap;
  color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 3px);
}
.sb-btn:hover, .sb-btn.active {
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.12);
  border-color: hsl(var(--primary) / 0.4);
}

/* 二選一的 group button（均勻網格／權重比例）：兩顆併成一體、選中的高亮 */
.sb-group {
  display: inline-flex;
  height: 28px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 3px);
  overflow: hidden;
}
.sb-group-btn {
  padding: 0 10px;
  font-size: 12px;
  white-space: nowrap;
  color: hsl(var(--muted-foreground));
  background: transparent;
  border: none;
  border-right: 1px solid hsl(var(--border));
}
.sb-group-btn:last-child { border-right: none; }
.sb-group-btn:hover { color: hsl(var(--foreground)); }
.sb-group-btn.active {
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.15);
  font-weight: 600;
}

/* 工具列上直接輸入的數字尺寸（線寬／半徑／最小站距）：文字標籤＋數字框 */
.sb-inline {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 6px;
  color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 3px);
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
  padding: 4px 10px;
  font-size: 11.5px;
  border: 1px solid hsl(var(--primary) / 0.5);
  border-radius: calc(var(--radius) - 4px);
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
