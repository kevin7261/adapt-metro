<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { layerData, boundsOfGeojson } from '../stores/layerData'
import { assetUrl } from '../lib/assetUrl'

// One city tile: lazily fetch its GeoJSON when scrolled into view, then draw a
// lightweight SVG thumbnail of the network (lines in their colour + station
// dots). Real MapLibre maps can't scale to hundreds of tiles (WebGL contexts).
// bare = 只畫縮圖（無外框、無城市文字列）——嵌在視圖畫廊卡片內用。
const props = defineProps({
  system: { type: Object, required: true },
  bare: { type: Boolean, default: false },
  label: { type: String, default: '' },   // bare 模式下方的名稱（對齊 CityViewGrid 的 vc-label）
})
const emit = defineEmits(['pick'])

const root = ref(null)
const thumb = ref(null)   // { W, H, lines:[{d,color}], dots:[{x,y}] }
const state = ref('idle') // idle | loading | done | error
let observer = null

const W = 168, H = 116, PAD = 7
// Same rendering rules as the MapLibre metro map (LayerTab).
const MAX_OVERLAP = 6
const DASH = 2.5
// Station fill — MUST match LayerTab's STATION_COLOR exactly (thumbnail = map):
// transfer (is_interchange, network-graph degree>2) red, terminus blue, else white.
// 用資料端的 is_interchange，不是 lines.length（七張/濱海沙崙 lines 只有一個 ref
// 但 degree=3 是換乘，用 length 會漏、與主地圖不一致）。
function stationFill(p) {
  if (p.is_interchange) return '#e11d48'
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
      // Only interleave dashes when ≥2 DISTINCT colours share the stretch; same-
      // colour overlaps (e.g. Singapore CCL) draw as one solid line (matches LayerTab).
      const distinct = new Set(colors).size
      for (const seg of f.geometry.coordinates) {
        const d = seg.map((c, i) => `${i ? 'L' : 'M'}${px(c[0]).toFixed(1)} ${py(c[1]).toFixed(1)}`).join(' ')
        if (!d) continue
        // ≥2 distinct colours share the stretch → interleaved coloured dashes
        // (same rule as LayerTab, incl. NYC's multi-colour overlaps); same-colour
        // overlaps fall through to one solid line.
        if (rc > 1 && distinct > 1) {
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
          lines.push({ d, color: colors[0] || '#e11d48' })
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
      const res = await fetch(assetUrl(`data/metro/${props.system.file}`), { cache: 'no-cache' })
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
  <button ref="root" class="tile" :class="{ bare }" :title="`匯入 ${system.cityZh ?? system.city}`" @click="emit('pick', system)">
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
    <span v-if="bare && label" class="tile-label">{{ label }}</span>
    <div v-if="!bare" class="tile-meta">
      <span class="tile-city">{{ system.cityZh ?? system.city }} · {{ system.countryZh ?? system.country }}</span>
      <span class="tile-en">{{ system.city }} · {{ system.country }}</span>
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
/* 嵌在視圖畫廊卡片內：外框與 hover 浮起由外層卡片決定；縮圖比例對齊
   CityViewGrid 的 cell（4/3）→ 卡片內每張圖同大小 */
.tile.bare { border: none; border-radius: 0; }
.tile.bare:hover { transform: none; box-shadow: none; }
/* 視圖畫廊卡片內：縮圖固定 240×180（4/3），圖以 contain letterbox 塞入 */
.tile.bare .tile-canvas { border-bottom: none; aspect-ratio: auto; width: var(--gv-w, 240px); height: var(--gv-h, 180px); }
.tile.bare .tile-canvas svg { width: 100%; height: 100%; max-width: none; }
/* bare 模式的名稱列（對齊 CityViewGrid 的 .vc-label） */
.tile-label {
  padding: 3px 5px 5px;
  font-size: 10px;
  text-align: center;
  color: hsl(var(--muted-foreground));
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tile:hover .tile-label { color: hsl(var(--foreground)); }
.tile-canvas {
  position: relative;
  aspect-ratio: 16 / 11;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  background: hsl(var(--muted) / 0.35);
  border-bottom: 1px solid hsl(var(--border));
}
.tile-canvas svg { width: 100%; height: 100%; overflow: visible; }
.tile-dot { stroke: #3f3f46; stroke-width: 0.3; }
.tile-msg { font-size: 11.5px; color: hsl(var(--muted-foreground)); }
/* 載入中：平面底色淡入淡出（不用漸層） */
.tile-canvas.loading {
  animation: tile-shimmer 1.2s ease-in-out infinite;
}
@keyframes tile-shimmer {
  0%, 100% { background-color: hsl(var(--muted) / 0.3); }
  50% { background-color: hsl(var(--muted) / 0.55); }
}

.tile-meta { padding: 7px 9px; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.tile-city {
  font-size: 12.5px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tile:hover .tile-city { color: hsl(var(--primary)); }
.tile-en {
  font-weight: 400; font-size: 10.5px; color: hsl(var(--muted-foreground));
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tile-stats { font-size: 10.5px; color: hsl(var(--muted-foreground) / 0.85); margin-top: 1px; }
</style>
