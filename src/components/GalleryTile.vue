<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { layerData, boundsOfGeojson } from '../stores/layerData'

// One city tile: lazily fetch its GeoJSON when scrolled into view, then draw a
// lightweight SVG thumbnail of the network (lines in their colour + station
// dots). Real MapLibre maps can't scale to hundreds of tiles (WebGL contexts).
const props = defineProps({ system: { type: Object, required: true } })
const emit = defineEmits(['pick'])

const root = ref(null)
const thumb = ref(null)   // { W, H, lines:[{d,color}], dots:[{x,y}] }
const state = ref('idle') // idle | loading | done | error
let observer = null

const W = 168, H = 116, PAD = 7
// Same rendering rules as the MapLibre metro map (LayerTab).
const MAX_OVERLAP = 6
const DASH = 2.5
// Station fill: transfer (>1 route) red, terminus blue, else white.
function stationFill(p) {
  if (Array.isArray(p.lines) && p.lines.length > 1) return '#e11d48'
  if (p.is_terminus) return '#2563eb'
  return '#ffffff'
}

function build(geojson) {
  const b = boundsOfGeojson(geojson)
  if (!b) return null
  const [w, s, e, n] = b
  const dx = (e - w) || 1e-6, dy = (n - s) || 1e-6
  const scale = Math.min((W - 2 * PAD) / dx, (H - 2 * PAD) / dy)
  const ox = (W - dx * scale) / 2, oy = (H - dy * scale) / 2
  const px = (lon) => ox + (lon - w) * scale
  const py = (lat) => oy + (n - lat) * scale // flip y for screen space
  const lines = [], dots = []
  for (const f of geojson.features) {
    if (f.geometry?.type === 'Point') {
      const [lo, la] = f.geometry.coordinates
      dots.push({ x: +px(lo).toFixed(1), y: +py(la).toFixed(1), fill: stationFill(f.properties ?? {}) })
    } else if (f.geometry?.coordinates) {
      const p = f.properties ?? {}
      const rc = p.route_count ?? 1
      const colors = Array.isArray(p.route_colors) ? p.route_colors : []
      for (const seg of f.geometry.coordinates) {
        const d = seg.map((c, i) => `${i ? 'L' : 'M'}${px(c[0]).toFixed(1)} ${py(c[1]).toFixed(1)}`).join(' ')
        if (!d) continue
        if (rc > 1 && colors.length) {
          // n interleaved coloured dashes, one slot per route (dasharray offset).
          const cnt = Math.min(rc, MAX_OVERLAP)
          for (let i = 0; i < cnt; i++) {
            lines.push({
              d,
              color: colors[i % colors.length],
              dash: `0 ${(i * DASH).toFixed(2)} ${DASH} ${((cnt - 1 - i) * DASH).toFixed(2)}`,
            })
          }
        } else {
          lines.push({ d, color: p.route_color || '#e11d48' })
        }
      }
    }
  }
  return { W, H, lines, dots }
}

async function load() {
  if (state.value !== 'idle') return
  state.value = 'loading'
  try {
    // catalog entries carry a relative `file` (systems/...) and no id; derive
    // the same id the imported layer uses so the fetch is cached/shared.
    const id = props.system.file.split('/').pop().replace(/\.geojson$/, '')
    let data = layerData[id]
    if (!data) {
      const res = await fetch(`/data/metro/${props.system.file}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data = await res.json()
      layerData[id] = data
    }
    thumb.value = build(data)
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
  }, { rootMargin: '200px' })
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <button ref="root" class="tile" :title="`匯入 ${system.city}`" @click="emit('pick', system)">
    <div class="tile-canvas" :class="{ loading: state === 'loading' || state === 'idle' }">
      <svg v-if="thumb" :viewBox="`0 0 ${thumb.W} ${thumb.H}`" preserveAspectRatio="xMidYMid meet">
        <path
          v-for="(ln, i) in thumb.lines"
          :key="'l' + i"
          :d="ln.d"
          :stroke="ln.color"
          :stroke-dasharray="ln.dash || null"
          fill="none"
          stroke-width="1.1"
          stroke-linejoin="round"
          :stroke-linecap="ln.dash ? 'butt' : 'round'"
        />
        <circle
          v-for="(dt, i) in thumb.dots"
          :key="'d' + i"
          :cx="dt.x"
          :cy="dt.y"
          r="0.6"
          :fill="dt.fill"
          class="tile-dot"
        />
      </svg>
      <span v-if="state === 'error'" class="tile-msg">載入失敗</span>
    </div>
    <div class="tile-meta">
      <span class="tile-city">{{ system.city }}</span>
      <span class="tile-sub">{{ system.country }}</span>
      <span class="tile-stats">{{ system.line_count }} 線 · {{ system.station_count }} 站</span>
    </div>
  </button>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  overflow: hidden;
  background: hsl(var(--card));
  text-align: left;
  cursor: pointer;
  transition: transform 0.12s ease, border-color 0.12s, box-shadow 0.12s;
}
.tile:hover {
  transform: translateY(-2px);
  border-color: hsl(var(--primary) / 0.55);
  box-shadow: 0 6px 18px -6px hsl(var(--primary) / 0.35), 0 0 0 1px hsl(var(--primary) / 0.25);
}
.tile-canvas {
  position: relative;
  aspect-ratio: 16 / 11;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  background:
    radial-gradient(120% 120% at 50% 0%, hsl(var(--muted) / 0.55), hsl(var(--muted) / 0.25));
  border-bottom: 1px solid hsl(var(--border));
}
.tile-canvas svg { width: 100%; height: 100%; overflow: visible; }
.tile-dot { stroke: #3f3f46; stroke-width: 0.3; }
.tile-msg { font-size: 11.5px; color: hsl(var(--muted-foreground)); }
/* shimmer while the geojson streams in */
.tile-canvas.loading {
  background: linear-gradient(100deg,
    hsl(var(--muted) / 0.3) 30%, hsl(var(--muted) / 0.55) 50%, hsl(var(--muted) / 0.3) 70%);
  background-size: 200% 100%;
  animation: tile-shimmer 1.2s ease-in-out infinite;
}
@keyframes tile-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

.tile-meta { padding: 7px 9px; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.tile-city {
  font-size: 12.5px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tile:hover .tile-city { color: hsl(var(--primary)); }
.tile-sub {
  font-size: 11px; color: hsl(var(--muted-foreground));
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tile-stats { font-size: 10.5px; color: hsl(var(--muted-foreground) / 0.85); margin-top: 1px; }
</style>
