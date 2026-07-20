<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { assetUrl } from '../lib/assetUrl'

// One city's view card (Hill Climbing / RWD Maps 共用): a title header + a grid
// of pre-computed views. Geometry is fetched lazily
// (data/metro/<dataDir>/<id>.json) when the card scrolls into view.
// 差異全部參數化：資料目錄、view 順序、標籤（RWD 靜態表 / HC 依 tilt 動態
// 「旋轉 N°」）、欄數、按鈕文案。
const props = defineProps({
  entry: { type: Object, required: true },
  dataDir: { type: String, required: true },   // 'hcviews' | 'rwdviews'
  order: { type: Array, required: true },      // view id 順序
  labels: { type: Object, default: null },     // 靜態標籤表（RWD）
  labelsForTilt: { type: Function, default: null }, // (tilt) => labels（HC）
  columns: { type: Number, required: true },   // grid 欄數（maxRows 未設時用）
  maxRows: { type: Number, default: null },    // 設定＝改為「填滿 N 列後向右加欄」（欄流）
  ctaLabel: { type: String, required: true },  // 「建立 X ›」的 X
  head: { type: Boolean, default: true },      // false = 不畫城市標題列（視圖畫廊自己有）
  bare: { type: Boolean, default: false },     // true = 無外框（嵌在視圖畫廊卡片內）
})
const emit = defineEmits(['pick'])

// maxRows 設定時：欄流——每欄固定寬（--gv-tile），填滿 maxRows 列後往右加欄。
// 一個城市高固定 maxRows 個視圖、超過往右排；否則沿用固定欄數的列流。
const gridStyle = computed(() => props.maxRows
  ? { gridAutoFlow: 'column', gridTemplateRows: `repeat(${props.maxRows}, auto)`, gridAutoColumns: 'var(--gv-tile, 108px)' }
  : { gridTemplateColumns: `repeat(${props.columns}, 1fr)` })

const root = ref(null)
const data = ref(null)          // { W, H, tilt?, views:{...}, stats:{...} }
const state = ref('idle')       // idle | loading | done | error
const lab = ref(props.labelsForTilt ? props.labelsForTilt(props.entry.tilt ?? 0) : props.labels)
let observer = null

async function load() {
  if (state.value !== 'idle') return
  state.value = 'loading'
  try {
    const res = await fetch(assetUrl(`data/metro/${props.dataDir}/${props.entry.id}.json`), { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (props.labelsForTilt) lab.value = props.labelsForTilt(json.tilt ?? 0)
    data.value = json
    state.value = 'done'
  } catch {
    state.value = 'error'
  }
}

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) { load(); observer.disconnect(); observer = null; break }
    }
  }, { rootMargin: '300px' })
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div ref="root" class="sgrid-card" :class="{ bare }">
    <button v-if="head" class="sgrid-head" :title="`建立 ${entry.cityZh ?? entry.city} ${ctaLabel} 視圖`" @click="emit('pick', entry)">
      <span class="sh-name">
        <span class="sh-zh">{{ entry.cityZh ?? entry.city }} · {{ entry.countryZh ?? entry.country }}</span>
        <span class="sh-en">{{ entry.city }} · {{ entry.country }}</span>
      </span>
      <span class="sh-stats">{{ entry.line_count }} 線 · {{ entry.station_count }} 站</span>
      <span class="sh-open">建立 {{ ctaLabel }} ›</span>
    </button>

    <div class="sgrid" :style="gridStyle">
      <button
        v-for="id in order"
        :key="id"
        class="cell view-cell"
        :title="lab[id]"
        @click="emit('pick', entry, id)"
      >
        <div class="vc-canvas" :class="{ loading: state === 'loading' || state === 'idle' }">
          <svg
            v-if="data && data.views[id]"
            :viewBox="`0 0 ${data.W} ${data.H}`"
            preserveAspectRatio="xMidYMid meet"
          >
            <template v-if="data.views[id].grid">
              <line
                v-for="(x, i) in data.views[id].grid.xs"
                :key="'gx' + i"
                :x1="x" y1="0" :x2="x" :y2="data.H"
                class="grid-sep"
              />
              <line
                v-for="(y, i) in data.views[id].grid.ys"
                :key="'gy' + i"
                x1="0" :y1="y" :x2="data.W" :y2="y"
                class="grid-sep"
              />
            </template>
            <path
              v-for="(h, i) in data.views[id].hl"
              :key="'h' + i"
              :d="h.d"
              :stroke="h.color"
              class="hl"
            />
            <path
              v-for="(ln, i) in data.views[id].lines"
              :key="'l' + i"
              :d="ln.d"
              :stroke="ln.color"
              :stroke-dasharray="ln.dash || null"
              :stroke-linecap="ln.dash ? 'butt' : 'round'"
              class="ln"
            />
            <circle
              v-for="(dt, i) in data.views[id].dots"
              :key="'d' + i"
              :cx="dt.x"
              :cy="dt.y"
              r="1"
              :fill="dt.fill"
              class="dot"
            />
          </svg>
          <span v-if="state === 'error'" class="vc-msg">載入失敗</span>
          <span v-else-if="data && !data.views[id]" class="vc-msg">尚未預算</span>
        </div>
        <span class="vc-label">{{ lab[id] }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.sgrid-card {
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  overflow: hidden;
  background: hsl(var(--card));
}
/* 嵌在視圖畫廊卡片內：外框由外層卡片提供 */
.sgrid-card.bare { border: none; border-radius: 0; }
.sgrid-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  text-align: left;
  background: hsl(var(--muted) / 0.35);
  border-bottom: 1px solid hsl(var(--border));
  cursor: pointer;
}
/* 中文「城市 · 國家」一排、英文「City · Country」一排（同語言同排） */
.sh-name { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.sh-zh { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sgrid-head:hover .sh-zh { color: hsl(var(--primary)); }
.sh-en { font-size: 10.5px; color: hsl(var(--muted-foreground) / 0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sh-stats { font-size: 10.5px; color: hsl(var(--muted-foreground) / 0.85); white-space: nowrap; }
.sh-open { margin-left: auto; font-size: 10.5px; color: hsl(var(--primary)); opacity: 0; transition: opacity 0.12s; white-space: nowrap; }
.sgrid-head:hover .sh-open { opacity: 1; }

.sgrid {
  display: grid;
  gap: 1px;
  background: hsl(var(--border));
}
.cell {
  display: flex;
  flex-direction: column;
  background: hsl(var(--card));
  min-width: 0;
  cursor: pointer;
  transition: background 0.12s;
}
.view-cell:hover { background: hsl(var(--accent) / 0.6); }
.vc-canvas {
  position: relative;
  aspect-ratio: 4 / 3;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  background: radial-gradient(120% 120% at 50% 0%, hsl(var(--muted) / 0.5), hsl(var(--muted) / 0.2));
}
.vc-canvas svg { width: 100%; height: 100%; overflow: visible; }
.grid-sep { stroke: #3b82f6; stroke-width: 0.2; stroke-opacity: 0.18; }
.hl { fill: none; stroke-width: 3.2; stroke-opacity: 0.28; stroke-linecap: round; stroke-linejoin: round; }
.ln { fill: none; stroke-width: 1.4; stroke-linejoin: round; }
.dot { stroke: #3f3f46; stroke-width: 0.3; }
.vc-msg { font-size: 10px; color: hsl(var(--muted-foreground)); }
.vc-label {
  padding: 3px 5px 5px;
  font-size: 10px;
  color: hsl(var(--muted-foreground));
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.view-cell:hover .vc-label { color: hsl(var(--foreground)); }

.vc-canvas.loading {
  background: linear-gradient(100deg,
    hsl(var(--muted) / 0.3) 30%, hsl(var(--muted) / 0.5) 50%, hsl(var(--muted) / 0.3) 70%);
  background-size: 200% 100%;
  animation: sg-shimmer 1.2s ease-in-out infinite;
}
@keyframes sg-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
</style>
