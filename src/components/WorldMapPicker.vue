<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import maplibregl from 'maplibre-gl'
import { useMapStore } from '../stores/mapStore'
import { openLayerTab } from '../stores/dockHandle'
import { loadCityCoords } from '../stores/metroCatalog'
import { assetUrl } from '../lib/assetUrl'
import { styleFor, basemapById } from '../stores/basemaps'
import MIcon from './MIcon.vue'

// 視圖畫廊的「世界地圖」分頁內容：一張淺色全球底圖，每個地鐵系統一個可點圓點——
// 點下去就匯入該城市整組管線並開啟 Metro Maps（OSM 路網）tab（＝點卡片／＋加入
// 的結果）。圓點顏色＝內容完整（紅）／內容不完整（綠）：完整＝該城整個資料流的圖
// 都算出來——Straighten／RWD 的 straighten-cells 通過畫廊同門檻（見
// data/metro/city_status.json，由 vite 讀目前磁碟狀態即時計算）。
// 即時更新：開著本分頁每 2s 輪詢 city_status；UI 重算另靠 metroDataEpoch 立刻重抓。
// 座標來自 data/metro/city_coords.json（metro:coords 預算的 bbox 中心）。
// list↔地圖雙向連動：
//   focus     = 右側清單「點」城市時的 { id, n }，把地圖飛到該城。
//   highlight = 右側清單「hover」的城市 id，地圖強調該點＋開 popup。
//   emit hover = 地圖 hover 到某點時回報 id（父層再回灌 highlight 給清單反白）。
const props = defineProps({
  systems: { type: Array, default: () => [] }, // GalleryShell 的 catalog（含 id/city/cityZh/audit…）
  focus: { type: Object, default: null },
  highlight: { type: String, default: null },
})
const emit = defineEmits(['hover'])

const store = useMapStore()
const container = ref(null)
const loading = ref(true)
const loadError = ref(null)
let map = null

const byId = new Map()       // id → catalog entry
let coordsById = null        // id → [lng, lat]
let statusById = {}          // id → boolean（整個資料流是否都算出來）
let cityFc = null
let statusPoll = null        // 輪詢 city_status（CLI／重算寫盤後圓點即時變色）
let statusRefreshBusy = false
const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 })

// 讀 city_status.json（dev 由 vite 即時計算目前磁碟狀態）。cache:no-cache 確保重烤後拿到新值。
async function loadStatus() {
  try {
    const res = await fetch(assetUrl('data/metro/city_status.json'), { cache: 'no-cache' })
    if (!res.ok) return {}
    const j = await res.json()
    return j.status ?? j ?? {}
  } catch { return {} }
}

/** 重抓狀態；有任何城 complete 變動才 setData（避免無謂重繪）。 */
async function refreshStatus({ force = false } = {}) {
  if (!cityFc || !map) return
  if (statusRefreshBusy) return
  statusRefreshBusy = true
  try {
    const status = await loadStatus()
    let changed = force
    for (const f of cityFc.features) {
      const next = status[f.properties.id] === true ? 1 : 0
      if (f.properties.complete !== next) {
        f.properties.complete = next
        changed = true
      }
    }
    statusById = status
    if (changed) map.getSource?.('cities')?.setData(cityFc)
  } finally {
    statusRefreshBusy = false
  }
}

onMounted(async () => {
  await nextTick()
  map = new maplibregl.Map({
    container: container.value,
    style: styleFor(basemapById('openfreemap-positron')),
    center: [10, 25],
    zoom: 1.3,
    attributionControl: false,
    locale: {
      'NavigationControl.ZoomIn': '放大',
      'NavigationControl.ZoomOut': '縮小',
      'NavigationControl.ResetBearing': '拖曳旋轉地圖，點擊回正北',
    },
  })
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right')
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')

  Promise.all([loadCityCoords(), loadStatus()])
    .then(([coords, status]) => {
      coordsById = coords
      statusById = status
      const features = []
      for (const s of props.systems) {
        const c = coords[s.id]
        if (!c) continue
        byId.set(s.id, s)
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: c },
          properties: {
            id: s.id,
            label: `${s.countryZh ?? s.country}－${s.cityZh ?? s.city}`,
            complete: status[s.id] === true ? 1 : 0,
          },
        })
      }
      cityFc = { type: 'FeatureCollection', features }
      if (map.isStyleLoaded()) addCityLayer()
      else map.on('load', () => addCityLayer())
      loading.value = false
      // 開著世界地圖就輪詢：CLI bake／工具列重算寫盤後綠紅即時變，不必等 remount
      clearInterval(statusPoll)
      statusPoll = setInterval(() => {
        if (document.visibilityState === 'hidden') return
        refreshStatus()
      }, 2000)
    })
    .catch((err) => { loadError.value = String(err?.message ?? err); loading.value = false })
})

// UI 內重算／重烤也會 bump epoch → 立刻重抓（不等下一個 poll）。
watch(() => store.metroDataEpoch, () => { refreshStatus({ force: true }) })

function addCityLayer() {
  if (!map || map.getSource('cities')) return
  map.addSource('cities', { type: 'geojson', data: cityFc })
  // 圓點顏色：內容完整＝綠、內容不完整＝紅。
  map.addLayer({
    id: 'city-dots',
    type: 'circle',
    source: 'cities',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3.5, 6, 6.5],
      'circle-color': ['case', ['==', ['get', 'complete'], 1], '#ef4444', '#16a34a'],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.9,
    },
  })
  // 強調層：hover／點選的城市畫一顆放大的深框圓（濾鏡只留 highlight 那顆）。
  map.addLayer({
    id: 'city-hot',
    type: 'circle',
    source: 'cities',
    filter: ['==', ['get', 'id'], props.highlight ?? '__none__'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 7, 6, 11],
      'circle-color': ['case', ['==', ['get', 'complete'], 1], '#ef4444', '#16a34a'],
      'circle-stroke-width': 3,
      'circle-stroke-color': '#1e293b',
      'circle-opacity': 1,
    },
  })
  // 城市名標籤——放大後才出現，避免全球視角糊成一片。
  map.addLayer({
    id: 'city-labels',
    type: 'symbol',
    source: 'cities',
    minzoom: 3.2,
    layout: {
      'text-field': ['get', 'label'],
      'text-size': 11,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-font': ['Noto Sans Regular'],
    },
    paint: {
      'text-color': '#334155',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.4,
    },
  })

  // hover：只回報 id 給父層，由父層回灌 highlight → 強調圓＋popup 全部走 watch 統一處理。
  map.on('mouseenter', 'city-dots', (e) => {
    map.getCanvas().style.cursor = 'pointer'
    emit('hover', e.features?.[0]?.properties?.id ?? null)
  })
  map.on('mouseleave', 'city-dots', () => {
    map.getCanvas().style.cursor = ''
    emit('hover', null)
  })
  map.on('click', 'city-dots', (e) => {
    const id = e.features?.[0]?.properties?.id
    const entry = id && byId.get(id)
    if (entry) openCity(entry)
  })
}

// 點城市：匯入整組管線（同視圖畫廊卡片／＋加入）並開 Metro Maps tab。
function openCity(entry) {
  const { metro } = store.importCityChain(entry, { variant: 'orig', compact: 'rect' })
  if (!metro) { store.toast('無法建立視圖'); return }
  openLayerTab(metro)
  store.toast(`已匯入 ${entry.cityZh ?? entry.city}`)
}

// 右側全球清單點城市：把地圖飛過去並開該城 popup。
function flyToCity(id) {
  const c = coordsById?.[id]
  if (!c || !map) return
  map.flyTo({ center: c, zoom: Math.max(map.getZoom(), 5), speed: 1.2 })
  const s = byId.get(id)
  if (s) {
    popup.setLngLat(c)
      .setHTML(`<div class="wm-pop">${s.countryZh ?? s.country}－${s.cityZh ?? s.city}</div>`)
      .addTo(map)
  }
}
watch(() => props.focus, (f) => { if (f?.id) flyToCity(f.id) })

// highlight（來自地圖自身 hover，或右側清單 hover）：強調該點＋開 popup；null 則清除。
watch(() => props.highlight, (id) => {
  if (!map) return
  if (map.getLayer('city-hot')) {
    map.setFilter('city-hot', ['==', ['get', 'id'], id ?? '__none__'])
  }
  const c = id && coordsById?.[id]
  const s = id && byId.get(id)
  if (c && s) {
    popup.setLngLat(c)
      .setHTML(`<div class="wm-pop">${s.countryZh ?? s.country}－${s.cityZh ?? s.city}</div>`)
      .addTo(map)
  } else {
    popup.remove()
  }
})

onBeforeUnmount(() => {
  clearInterval(statusPoll)
  statusPoll = null
  try { popup.remove() } catch { /* */ }
  try { map?.remove() } catch { /* */ }
  map = null
})
</script>

<template>
  <div class="world-map-picker">
    <div ref="container" class="wm-canvas" />
    <div v-if="loading" class="wm-overlay">
      <MIcon name="public" :size="20" /> 載入全球城市座標…
    </div>
    <div v-else-if="loadError" class="wm-overlay wm-error">
      <MIcon name="error" :size="20" /> 載入失敗：{{ loadError }}
      <div class="wm-hint">請先執行 <code>npm run metro:coords</code></div>
    </div>
    <div class="wm-legend">
      <span><i class="dot complete" /> 內容完整</span>
      <span><i class="dot incomplete" /> 內容不完整</span>
    </div>
  </div>
</template>

<style scoped>
.world-map-picker { position: relative; width: 100%; height: 100%; min-height: 0; }
.wm-canvas { position: absolute; inset: 0; }
.wm-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  flex-direction: column;
  font-size: 13px; color: hsl(var(--muted-foreground));
  background: hsl(var(--background) / 0.6);
  pointer-events: none;
}
.wm-error { color: hsl(var(--destructive, 0 72% 51%)); pointer-events: auto; }
.wm-hint { font-size: 12px; color: hsl(var(--muted-foreground)); }
.wm-hint code {
  background: hsl(var(--muted)); padding: 1px 5px; border-radius: 4px;
  font-family: ui-monospace, monospace;
}
.wm-legend {
  position: absolute; left: 10px; bottom: 34px; z-index: 2;
  display: flex; gap: 12px;
  background: hsl(var(--background) / 0.92);
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius));
  padding: 5px 10px; font-size: 11.5px; color: hsl(var(--foreground));
}
.wm-legend span { display: inline-flex; align-items: center; gap: 5px; }
.wm-legend .dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: #16a34a; border: 1.5px solid #fff;
  box-shadow: 0 0 0 1px hsl(var(--border));
}
.wm-legend .dot.complete { background: #ef4444; }
.wm-legend .dot.incomplete { background: #16a34a; }
:deep(.wm-pop) { font-size: 12px; font-weight: 550; }
</style>
