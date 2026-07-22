<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { assetUrl } from '../lib/assetUrl'
import { openSkillDoc } from '../stores/skillHandle'
import MIcon from './MIcon.vue'

// One city's view card (Hill Climbing / RWD Maps 共用): a title header + a grid
// of pre-computed views. Geometry is fetched lazily
// (data/metro/<dataDir>/<id>.json) when the card scrolls into view.
// 差異全部參數化：資料目錄、view 順序、標籤（RWD 靜態表 / HC 依 tilt 動態
// 「旋轉 N°」）、欄數、按鈕文案。
const props = defineProps({
  entry: { type: Object, required: true },
  dataDir: { type: String, required: true },   // 'straighten' | 'rwd-maps'
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
  // 縮圖固定 240×180（4/3）→ 欄寬固定 --gv-w，圖以 contain letterbox 塞入。
  ? { gridAutoFlow: 'column', gridTemplateRows: `repeat(${props.maxRows}, auto)`, gridAutoColumns: 'var(--gv-w, 240px)' }
  : { gridTemplateColumns: `repeat(${props.columns}, 1fr)` })

const root = ref(null)
const data = ref(null)          // { W, H, tilt?, views:{...}, stats:{...} }
const state = ref('idle')       // idle | loading | done | error
const lab = ref(props.labelsForTilt ? props.labelsForTilt(props.entry.tilt ?? 0) : props.labels)
// RWD 畫廊：llmcompares → 右上角「全部／原始／旋轉最佳」徽章
const compare = ref(null)       // { winner, winnerOrig, winnerRot } | null
let observer = null

// LLM 對齊循環的視圖（loop-llm-* / rwd-llm-*）→ 左上角標 AI icon
const isLlmView = (id) => /-llm-(orig|rot)$/.test(id ?? '')
// rwd-rect-orig → orig.rect（與 llmcompares 候選 id 對齊）
function compareIdOf(viewId) {
  const m = /^rwd-([a-z]+)-(orig|rot)$/.exec(viewId ?? '')
  return m ? `${m[2]}.${m[1]}` : null
}
function compareTags(viewId) {
  const r = compare.value
  const id = compareIdOf(viewId)
  if (!r || !id) return []
  const tags = []
  if (r.winner === id) tags.push({ kind: 'all', label: '全部最佳' })
  if (r.winnerOrig === id) tags.push({ kind: 'orig', label: '原始最佳' })
  if (r.winnerRot === id) tags.push({ kind: 'rot', label: '旋轉最佳' })
  return tags
}

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
    if (props.dataDir === 'rwd-maps') {
      try {
        const cr = await fetch(assetUrl(`data/metro/rwd-compare/${props.entry.id}.json`), { cache: 'no-cache' })
        if (cr.ok) {
          const cj = await cr.json()
          compare.value = {
            winner: cj.winner, winnerOrig: cj.winnerOrig, winnerRot: cj.winnerRot,
          }
        }
      } catch { /* 無比較結果＝不顯示徽章 */ }
    }
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
      <span class="sh-open">建立 {{ ctaLabel }} <MIcon name="chevron_right" :size="12" /></span>
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
          <!-- 巢狀在 view-cell(button) 內 → 用 span＋@click.stop 當按鈕，
               點了開 LLM 對齊使用的 skill（route-llm-align） -->
          <span
            v-if="isLlmView(id)"
            class="vc-ai"
            role="button"
            tabindex="0"
            title="LLM 對齊使用的 skill：route-llm-align（點開說明）"
            @click.stop="openSkillDoc('route-llm-align')"
            @keydown.enter.stop="openSkillDoc('route-llm-align')"
          >
            <MIcon name="auto_awesome" :size="12" />
          </span>
          <div v-if="compareTags(id).length" class="vc-badges">
            <span
              v-for="t in compareTags(id)"
              :key="t.kind"
              class="vc-badge"
              :class="'vc-badge--' + t.kind"
            ><MIcon name="auto_awesome" :size="10" /><span>{{ t.label }}</span></span>
          </div>
          <span v-if="state === 'error'" class="vc-msg">載入失敗</span>
          <span v-else-if="data && !data.views[id]" class="vc-msg">{{ /-shape$/.test(id) ? '成方路線沒有算' : '尚未預算' }}</span>
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
.sh-open { margin-left: auto; display: inline-flex; align-items: center; gap: 2px; font-size: 10.5px; color: hsl(var(--primary)); opacity: 0; transition: opacity 0.12s; white-space: nowrap; }
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
  width: var(--gv-w, 240px);    /* 固定 240×180（4/3），圖以 contain letterbox 塞入 */
  height: var(--gv-h, 180px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  background: hsl(var(--muted) / 0.35);
}
/* 填滿固定框、preserveAspectRatio="xMidYMid meet" 保持長寬比 letterbox */
.vc-canvas svg { width: 100%; height: 100%; overflow: visible; }
/* LLM 對齊循環：左上角白色 AI 圖示按鈕（無底色，點開 route-llm-align skill） */
.vc-ai {
  position: absolute;
  top: 3px;
  left: 3px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1px;
  color: #fff;
  cursor: pointer;
  pointer-events: auto;
  /* 白圖示在淺色縮圖上也看得見：加深色描邊陰影 */
  text-shadow: 0 0 2px rgb(0 0 0 / 0.55), 0 1px 1px rgb(0 0 0 / 0.4);
  transition: transform 0.1s ease, opacity 0.1s ease;
  opacity: 0.92;
}
.vc-ai:hover { opacity: 1; transform: scale(1.15); }
.vc-ai:focus-visible { outline: 2px solid #fff; outline-offset: 1px; border-radius: 3px; }
.vc-badges {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  pointer-events: none;
}
.vc-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 5px 1px 3px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1.4;
  color: #fff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
}
.vc-badge--all { background: #f59e0b; }   /* 全部最佳：金 */
.vc-badge--orig { background: #0d9488; }  /* 原始最佳：青绿 */
.vc-badge--rot { background: #2563eb; }   /* 旋轉最佳：藍 */
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
  animation: sg-shimmer 1.2s ease-in-out infinite;
}
@keyframes sg-shimmer {
  0%, 100% { background-color: hsl(var(--muted) / 0.3); }
  50% { background-color: hsl(var(--muted) / 0.5); }
}
</style>
