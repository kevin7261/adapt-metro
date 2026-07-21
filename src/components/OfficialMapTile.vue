<script setup>
import { ref, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { assetUrl } from '../lib/assetUrl'
import { loadMapsIndex, mapsKeyFor, mapsKeyBase } from '../stores/metroCatalog'
import MIcon from './MIcon.vue'

// 城市的**官方**路線示意圖（downloadMaps.mjs 抓的 data/metro/maps/** 圖檔）。兩種呈現：
//  • 預設（tile）：視圖畫廊 Metro Maps 區段右邊那格——縮圖，點擊開 modal 燈箱。
//  • link：資訊 tab urbanrail 下方——一列連結（樣式同 urbanrail），點擊開同一個 modal。
// 懶載入（IntersectionObserver）；無圖 → tile 留白／link 不顯示（方塊大小不變）。
const props = defineProps({
  system: { type: Object, required: true },
  bare: { type: Boolean, default: false },
  link: { type: Boolean, default: false },   // true = 資訊 tab 的連結列模式
  label: { type: String, default: '' },      // bare 模式下方的名稱（對齊 CityViewGrid 的 vc-label）
})

const root = ref(null)
const state = ref('idle') // idle | loading | done | nomap | error
const src = ref(null)     // 圖檔 URL
const meta = ref(null)    // maps_index 該筆（授權/出處）
const open = ref(false)   // modal 燈箱開關
let observer = null

async function load() {
  if (state.value !== 'idle') return
  state.value = 'loading'
  try {
    const index = await loadMapsIndex()
    const key = mapsKeyFor(props.system)
    if (!key) { state.value = 'nomap'; return }
    const rec = index[key] || index[mapsKeyBase(key)] || null
    if (!rec || !rec.map_file) { state.value = 'nomap'; return }
    meta.value = rec
    // 帶版本號破除瀏覽器快取——覆蓋同路徑圖檔後 URL 不變會顯示舊圖，用 maps_index
    // 的 _rev（每次重建圖庫遞增）當 query 讓瀏覽器重抓。
    const rev = index._rev ? `?v=${index._rev}` : ''
    src.value = assetUrl(`data/metro/${rec.map_file}${rev}`)
    state.value = 'done'
  } catch {
    state.value = 'error'
  }
}

function openModal() { if (state.value === 'done') open.value = true }
function closeModal() { open.value = false }

function onKey(e) { if (e.key === 'Escape') closeModal() }
watch(open, (v) => {
  if (v) window.addEventListener('keydown', onKey)
  else window.removeEventListener('keydown', onKey)
})

onMounted(async () => {
  // link 模式（資訊 tab 文字列）直接載——不必懶載；也可避開 fragment root
  // 上 ref 尚未就緒時 observe(null) 導致永遠停在「載入中…」。
  if (props.link) {
    await load()
    return
  }
  await nextTick()
  if (!root.value) {
    await load()
    return
  }
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) { load(); observer.disconnect(); observer = null; break }
    }
  }, { rootMargin: '200px' })
  observer.observe(root.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('keydown', onKey)
})

const cityLabel = () => `${props.system.cityZh ?? props.system.city} · ${props.system.city}`
</script>

<template>
  <!-- link 模式：資訊 tab 的連結列（樣式同 urbanrail），點擊開 modal -->
  <a
    v-if="link"
    ref="root"
    class="omap-link"
    :class="{ ready: state === 'done' }"
    href="#"
    @click.prevent="openModal"
  >
    官方路線圖<template v-if="state === 'done'">：{{ cityLabel() }} <MIcon name="open_in_new" :size="11" /></template>
    <template v-else-if="state === 'loading' || state === 'idle'"> 載入中…</template>
    <template v-else>（尚未收錄）</template>
  </a>

  <!-- 預設 tile 模式：畫廊縮圖，點擊開 modal -->
  <button
    v-else
    ref="root"
    class="omap"
    :class="{ bare, clickable: state === 'done' }"
    :title="state === 'done' ? `官方路線圖（${meta?.license || '出處見 maps_index'}）— 點擊放大` : '官方路線圖'"
    @click="openModal"
  >
    <div class="omap-canvas" :class="{ loading: state === 'loading' || state === 'idle' }">
      <img v-if="state === 'done'" :src="src" :alt="`${system.cityZh ?? system.city} 官方路線圖`" loading="lazy" />
      <!-- 無圖 / 載入失敗：留白（不顯示文字），方塊大小仍與其他格一致 -->
    </div>
    <span v-if="bare && label" class="omap-label">{{ label }}</span>
  </button>

  <!-- 燈箱 modal：點圖放大看原圖，點背景 / 關閉鈕 / Esc 關閉 -->
  <Teleport to="body">
    <div v-if="open" class="omap-modal" @click="closeModal">
      <div class="omap-modal-inner" @click.stop>
        <div class="omap-modal-head">
          <span class="omap-modal-title">{{ cityLabel() }} · 官方路線圖</span>
          <button class="omap-modal-close" title="關閉 (Esc)" @click="closeModal">✕</button>
        </div>
        <div class="omap-modal-body">
          <img :src="src" :alt="`${system.cityZh ?? system.city} 官方路線圖`" />
        </div>
        <div class="omap-modal-foot">
          <span v-if="meta?.license">授權：{{ meta.license }}<span v-if="meta.artist"> · {{ meta.artist }}</span></span>
          <a v-if="meta?.source_url" :href="meta.source_url" target="_blank" rel="noopener">原始出處 ↗</a>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.omap {
  display: flex;
  flex-direction: column;
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  overflow: hidden;
  background: hsl(var(--card));
  text-align: left;
  cursor: default;
}
.omap.clickable { cursor: zoom-in; }
.omap.bare { border: none; border-radius: 0; }
/* bare 模式的名稱列（對齊 CityViewGrid 的 .vc-label） */
.omap-label {
  display: block;
  padding: 3px 5px 5px;
  font-size: 10px;
  text-align: center;
  color: hsl(var(--muted-foreground));
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.omap.clickable:hover .omap-label { color: hsl(var(--foreground)); }
.omap-canvas {
  position: relative;
  aspect-ratio: 4 / 3;
  /* 官方圖多為白底 → 給白底避免深色主題下透明區看不清 */
  background: #ffffff;
}
/* img 絕對定位填滿 4/3 框、object-fit:contain fit 長或寬——不論圖片原比例，
   方塊尺寸永遠鎖在 4/3，與其他所有格一致（不會撐破 grid row） */
.omap-canvas img {
  position: absolute;
  inset: 6px;
  width: calc(100% - 12px);
  height: calc(100% - 12px);
  object-fit: contain;
  display: block;
}

/* ---- link 模式（資訊 tab）---- */
.omap-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: hsl(var(--primary));
  text-decoration: none;
  cursor: pointer;
}
.omap-link:hover { text-decoration: underline; }
.omap-link:not(.ready) { color: hsl(var(--muted-foreground)); cursor: default; pointer-events: none; }
.omap.clickable:hover img { opacity: 0.92; }
.omap-canvas.loading {
  background: linear-gradient(100deg,
    hsl(var(--muted) / 0.3) 30%, hsl(var(--muted) / 0.55) 50%, hsl(var(--muted) / 0.3) 70%);
  background-size: 200% 100%;
  animation: omap-shimmer 1.2s ease-in-out infinite;
}
@keyframes omap-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

/* ---- 燈箱 modal ---- */
.omap-modal {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3vh 3vw;
  background: rgba(0, 0, 0, 0.72);
  cursor: zoom-out;
}
.omap-modal-inner {
  display: flex;
  flex-direction: column;
  max-width: 94vw;
  max-height: 94vh;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  overflow: hidden;
  cursor: default;
}
.omap-modal-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid hsl(var(--border));
}
.omap-modal-title { font-size: 13px; font-weight: 600; }
.omap-modal-close {
  margin-left: auto;
  border: none;
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: 15px;
  cursor: pointer;
  line-height: 1;
}
.omap-modal-close:hover { color: hsl(var(--foreground)); }
.omap-modal-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  background: #ffffff;
  overflow: auto;
}
.omap-modal-body img {
  max-width: 100%;
  max-height: 82vh;
  object-fit: contain;
  display: block;
}
.omap-modal-foot {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 6px 12px;
  font-size: 11px;
  color: hsl(var(--muted-foreground));
  border-top: 1px solid hsl(var(--border));
}
.omap-modal-foot a { color: hsl(var(--primary)); text-decoration: none; }
.omap-modal-foot a:hover { text-decoration: underline; }
</style>
