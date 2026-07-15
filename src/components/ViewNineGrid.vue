<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { assetUrl } from '../lib/assetUrl'
import { VIEW_ORDER, viewLabels } from '../stores/viewGeometry'

// One city's 3×3 九宮格 card: a title cell + the 8 pre-computed Map Adjust view
// thumbnails (原始 / 旋轉 / 骨架化 / 格網化前後 …). Geometry is fetched lazily
// (per-city JSON under data/metro/views/) when the card scrolls into view, then
// drawn as inline SVG — same approach as the Metro Maps GalleryTile.
const props = defineProps({ entry: { type: Object, required: true } })
const emit = defineEmits(['pick'])

const root = ref(null)
const data = ref(null)          // { W, H, tilt, views:{...} }
const state = ref('idle')       // idle | loading | done | error
const order = VIEW_ORDER
let labels = viewLabels(props.entry.tilt ?? 0)
let observer = null

async function load() {
  if (state.value !== 'idle') return
  state.value = 'loading'
  try {
    const res = await fetch(assetUrl(`data/metro/views/${props.entry.id}.json`), { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    labels = viewLabels(json.tilt ?? 0)
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
  <div ref="root" class="ngrid-card">
    <div class="ngrid">
      <!-- title cell -->
      <button class="cell title-cell" :title="`建立 ${entry.cityZh ?? entry.city} Map Adjust 視圖`" @click="emit('pick', entry)">
        <span class="tc-city">{{ entry.cityZh ?? entry.city }} · {{ entry.countryZh ?? entry.country }}</span>
        <span class="tc-en">{{ entry.city }} · {{ entry.country }}</span>
        <span class="tc-stats">{{ entry.line_count }} 線 · {{ entry.station_count }} 站</span>
        <span class="tc-open">建立 Map Adjust ›</span>
      </button>

      <!-- 8 view thumbnails -->
      <button
        v-for="id in order"
        :key="id"
        class="cell view-cell"
        :title="labels[id]"
        @click="emit('pick', entry, id)"
      >
        <div class="vc-canvas" :class="{ loading: state === 'loading' || state === 'idle' }">
          <svg
            v-if="data"
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
        </div>
        <span class="vc-label">{{ labels[id] }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ngrid-card {
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  overflow: hidden;
  background: hsl(var(--card));
}
.ngrid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: hsl(var(--border));
}
.cell {
  display: flex;
  flex-direction: column;
  background: hsl(var(--card));
  text-align: left;
  min-width: 0;
  cursor: pointer;
}
/* title cell */
.title-cell {
  gap: 2px;
  padding: 10px;
  justify-content: center;
  background: hsl(var(--muted) / 0.35);
}
.tc-city {
  font-size: 13px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.title-cell:hover .tc-city { color: hsl(var(--primary)); }
.tc-en { font-weight: 400; font-size: 10.5px; color: hsl(var(--muted-foreground)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tc-stats { font-size: 10.5px; color: hsl(var(--muted-foreground) / 0.85); margin-top: 2px; }
.tc-open { font-size: 10.5px; color: hsl(var(--primary)); margin-top: 6px; opacity: 0; transition: opacity 0.12s; }
.title-cell:hover .tc-open { opacity: 1; }

/* view cells */
.view-cell { transition: background 0.12s; }
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

/* shimmer while the geojson streams in */
.vc-canvas.loading {
  background: linear-gradient(100deg,
    hsl(var(--muted) / 0.3) 30%, hsl(var(--muted) / 0.5) 50%, hsl(var(--muted) / 0.3) 70%);
  background-size: 200% 100%;
  animation: ng-shimmer 1.2s ease-in-out infinite;
}
@keyframes ng-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
</style>
