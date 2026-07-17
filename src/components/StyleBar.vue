<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import MIcon from './MIcon.vue'

// 樣式工具列（地圖上方）：仍是一條工具列，但「每個工具各自縮成一顆 icon」——
// 按某顆 icon 才彈出「那一個」控制項的小視窗（不是全部擠在一個彈窗）。控制項
// 與原「樣式」tab 相同（依 isMetro / editable / viewKind 分支）；地圖底色的
// 「預設」在它自己的彈窗裡。layer 為 store 的響應式物件，直接改其屬性。
const props = defineProps({
  layer: { type: Object, required: true },
  viewKind: { type: String, default: 'metro' }, // 'metro' | 'map-adjust' | 'hillclimb' | 'rwd'
  spanApplied: { type: Number, default: null },
})
const emit = defineEmits(['recalc-span'])

const isMetro = computed(() => props.layer?.type === 'metro' || props.layer?.metroLike === true)
const editable = computed(() => props.layer && !props.layer.isBasemap && !isMetro.value)
const hasSpan = computed(() => props.viewKind === 'hillclimb' || props.viewKind === 'rwd')

// 工具清單（依情境）：id、icon、tooltip。'labels' 是布林、直接切換不開彈窗。
const tools = computed(() => {
  const out = []
  if (hasSpan.value) out.push({ id: 'span', icon: 'straighten', title: '顏色點間最大跨距' })
  if (isMetro.value) {
    out.push({ id: 'lineWidth', icon: 'line_weight', title: '線寬' })
    out.push({ id: 'radius', icon: 'scatter_plot', title: '站點半徑' })
    out.push({ id: 'labels', icon: 'label', title: '顯示站名', toggle: true })
    out.push({ id: 'bg', icon: 'format_color_fill', title: '地圖底色' })
  }
  if (editable.value) {
    out.push({ id: 'symbology', icon: 'category', title: 'Symbology' })
    out.push({ id: 'color', icon: 'palette', title: props.layer.type === 'line' ? '線色' : '填色／邊色' })
    out.push({ id: 'strokeWidth', icon: 'line_weight', title: props.layer.type === 'line' ? '線寬' : '邊寬' })
    if (props.layer.type === 'point') out.push({ id: 'pointRadius', icon: 'scatter_plot', title: '半徑' })
  }
  out.push({ id: 'opacity', icon: 'opacity', title: '不透明度' })
  return out
})

// 目前展開的工具（單一）；每顆 icon 各自彈出自己的小視窗。
const openTool = ref(null)
const popPos = ref({ top: 0, left: 0 })
const isActive = (t) => (t.toggle ? props.layer.showLabels : openTool.value === t.id)
function clickTool(t, e) {
  if (t.toggle) { props.layer.showLabels = !props.layer.showLabels; return }
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
    <button
      v-for="t in tools"
      :key="t.id"
      class="sb-btn"
      :class="{ active: isActive(t) }"
      :title="t.title"
      @click.stop="clickTool(t, $event)"
    >
      <MIcon :name="t.icon" :size="16" />
    </button>

    <Teleport to="body">
      <div
        v-if="openTool"
        class="sb-pop menu-pop"
        :style="{ position: 'fixed', top: popPos.top + 'px', left: popPos.left + 'px' }"
      >
        <!-- 顏色點間最大跨距 -->
        <template v-if="openTool === 'span'">
          <label class="sb-label">顏色點間最大跨距（格）</label>
          <div class="sb-row">
            <input
              :value="layer.spanCap ?? 3"
              type="number" min="1" step="1" class="sb-num"
              @change="layer.spanCap = Math.max(1, Math.round(+$event.target.value) || 3)"
            />
            <button
              class="sb-btn2"
              :disabled="(layer.spanCap ?? 3) === (spanApplied ?? 3)"
              @click="emit('recalc-span')"
            >重新計算</button>
          </div>
        </template>

        <!-- 線寬（metro） -->
        <template v-else-if="openTool === 'lineWidth'">
          <label class="sb-label">線寬 — {{ layer.strokeWidth }} px</label>
          <input v-model.number="layer.strokeWidth" type="range" min="0.5" max="8" step="0.5" class="sb-slider" />
        </template>

        <!-- 站點半徑（metro） -->
        <template v-else-if="openTool === 'radius'">
          <label class="sb-label">站點半徑 — {{ layer.radius }} px</label>
          <input v-model.number="layer.radius" type="range" min="1" max="10" step="0.5" class="sb-slider" />
        </template>

        <!-- 地圖底色（metro）＋預設 -->
        <template v-else-if="openTool === 'bg'">
          <label class="sb-label">地圖底色</label>
          <div class="sb-row">
            <input type="color" class="sb-color" :value="layer.d3Bg || '#0d1117'" @input="layer.d3Bg = $event.target.value" />
            <button v-if="layer.d3Bg" class="sb-btn2" @click="layer.d3Bg = null">預設</button>
          </div>
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

        <!-- 邊/線寬（一般向量） -->
        <template v-else-if="openTool === 'strokeWidth'">
          <label class="sb-label">{{ layer.type === 'line' ? '線寬' : '邊寬' }} — {{ layer.strokeWidth }} px</label>
          <input v-model.number="layer.strokeWidth" type="range" min="0" max="10" step="0.5" class="sb-slider" />
        </template>

        <!-- 半徑（一般向量 point） -->
        <template v-else-if="openTool === 'pointRadius'">
          <label class="sb-label">半徑 — {{ layer.radius }} px</label>
          <input v-model.number="layer.radius" type="range" min="1" max="20" step="1" class="sb-slider" />
        </template>

        <!-- 不透明度 -->
        <template v-else-if="openTool === 'opacity'">
          <label class="sb-label">不透明度 — {{ Math.round(layer.opacity * 100) }}%</label>
          <input v-model.number="layer.opacity" type="range" min="0" max="1" step="0.05" class="sb-slider" />
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.stylebar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  flex-shrink: 0;
  border-bottom: 1px solid hsl(var(--border));
  background: hsl(var(--card));
}
.sb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 3px);
}
.sb-btn:hover, .sb-btn.active {
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.12);
  border-color: hsl(var(--primary) / 0.4);
}

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
</style>
