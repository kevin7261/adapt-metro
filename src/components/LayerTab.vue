<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
import { layerData, boundsOfGeojson } from '../stores/layerData'
import {
  DEFAULT_BASEMAP, MAPBOX_ENABLED, RAILWAY_OVERLAY,
  basemapById, basemapGroups, styleFor,
} from '../stores/basemaps'
import StylePanel from './StylePanel.vue'
import StatusBar from './StatusBar.vue'
import { Copy, Crosshair, ZoomIn, ZoomOut, Layers, Check, TrainFront } from 'lucide-vue-next'

// Dockview panel props: { params: { layerId }, api, containerApi }
const props = defineProps({ params: { type: Object, required: true } })

const store = useMapStore()

const layerId = props.params.params.layerId
const panelApi = props.params.api
const layer = computed(() => store.layers.find((l) => l.id === layerId) ?? null)

const container = ref(null)
const ctxMenu = ref(null) // { x, y, lng, lat }
const loading = ref(true)
const loadError = ref(null)
let map = null
const disposables = []

// Basemap picker state (bottom-right).
const basemapId = ref(DEFAULT_BASEMAP)
const railwayOn = ref(false)
const basemapMenuOpen = ref(false)
const groups = basemapGroups()
const currentBasemap = computed(() => basemapById(basemapId.value))

// Per-tab view state feeding this tab's footer.
const view = reactive({ lng: null, lat: null, zoom: 1.5, bearing: 0, pitch: 0, bounds: null })

onMounted(() => {
  map = new maplibregl.Map({
    container: container.value,
    style: styleFor(basemapById(DEFAULT_BASEMAP)),
    center: [10, 25],
    zoom: 1.5,
    attributionControl: false,  // no on-map copyright overlay (per request)
  })

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
  map.addControl(new maplibregl.FullscreenControl(), 'top-right')
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')

  map.on('load', () => addMetroLayers(true))

  map.on('mousemove', (e) => {
    view.lng = e.lngLat.lng
    view.lat = e.lngLat.lat
  })
  map.on('mouseout', () => {
    view.lng = null
    view.lat = null
  })
  const syncView = () => {
    view.zoom = map.getZoom()
    view.bearing = map.getBearing()
    view.pitch = map.getPitch()
    const b = map.getBounds()
    view.bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
  }
  map.on('move', syncView)
  syncView()

  map.on('contextmenu', (e) => {
    e.preventDefault()
    ctxMenu.value = { x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat }
  })
  map.on('click', () => { ctxMenu.value = null; basemapMenuOpen.value = false })

  // Station hover popup
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 })
  map.on('mouseenter', 'metro-stations', (e) => {
    map.getCanvas().style.cursor = 'pointer'
    const p = e.features[0].properties
    const local = p.station_name_local && p.station_name_local !== p.station_name
      ? `<br/>${p.station_name_local}` : ''
    const lines = p.lines && p.lines !== '[]'
      ? `<br/>Lines: ${JSON.parse(p.lines).join(', ')}` : ''
    popup
      .setLngLat(e.features[0].geometry.coordinates)
      .setHTML(`<strong>${p.station_name ?? '—'}</strong>${local}${lines}`)
      .addTo(map)
  })
  map.on('mouseleave', 'metro-stations', () => {
    map.getCanvas().style.cursor = ''
    popup.remove()
  })

  // Active tab drives the global map handle (toolbar / palette / attr table actions).
  const setHandle = (active) => {
    if (active) mapHandle.map = map
    else if (mapHandle.map === map) mapHandle.map = null
  }
  disposables.push(panelApi.onDidActiveChange(({ isActive }) => setHandle(isActive)))
  setHandle(panelApi.isActive)

  // Dockview resizes the panel element — keep the canvas in sync.
  disposables.push(panelApi.onDidDimensionsChange(() => map?.resize()))
})

async function addMetroLayers(fit) {
  const l = layer.value
  if (!l || l.type !== 'metro') { loading.value = false; return }

  let data = layerData[l.id]
  if (!data) {
    try {
      const res = await fetch(l.file)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data = await res.json()
      layerData[l.id] = data
    } catch (err) {
      loading.value = false
      loadError.value = `無法載入 ${l.file}（${err.message}）`
      return
    }
  }
  if (!map) return
  loading.value = false

  addMetroSourceLayers(data)
  if (railwayOn.value) addRailwayLayer()

  if (fit) {
    const bbox = boundsOfGeojson(data)
    if (bbox) map.fitBounds(bbox, { padding: 48, duration: 0, maxZoom: 13 })
  }
}

// Add the metro source + line/station layers (idempotent; re-run after setStyle).
function addMetroSourceLayers(data) {
  const l = layer.value
  if (!map || map.getSource('metro')) return
  map.addSource('metro', { type: 'geojson', data })
  map.addLayer({
    id: 'metro-lines', source: 'metro', type: 'line',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'route_color'], '#e11d48'],
      'line-width': l.strokeWidth,
      'line-opacity': l.opacity,
    },
  })
  map.addLayer({
    id: 'metro-stations', source: 'metro', type: 'circle',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': l.radius,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#3f3f46',
      'circle-stroke-width': 1.2,
      'circle-opacity': l.opacity,
      'circle-stroke-opacity': l.opacity,
    },
  })
  applyLayerState()
}

/* ---- basemap + OpenRailwayMap overlay ---- */
function addRailwayLayer() {
  if (!map || map.getSource('railway')) return
  map.addSource('railway', { type: 'raster', tiles: RAILWAY_OVERLAY.tiles, tileSize: 256 })
  // Keep the railway overlay below the metro data so our lines stay on top.
  const before = map.getLayer('metro-lines') ? 'metro-lines' : undefined
  map.addLayer({ id: 'railway', type: 'raster', source: 'railway',
    paint: { 'raster-opacity': 0.9 } }, before)
}
function removeRailwayLayer() {
  if (map?.getLayer('railway')) map.removeLayer('railway')
  if (map?.getSource('railway')) map.removeSource('railway')
}
function setRailway(on) {
  railwayOn.value = on
  if (!map) return
  if (on) addRailwayLayer(); else removeRailwayLayer()
}

function setBasemap(id) {
  const bm = basemapById(id)
  if (bm.needsToken && !MAPBOX_ENABLED) return
  basemapId.value = id
  basemapMenuOpen.value = false
  if (!map) return
  // setStyle wipes all sources/layers — re-add our overlays once the new style loads.
  map.setStyle(styleFor(bm))
  map.once('style.load', () => {
    const l = layer.value
    if (l?.type === 'metro' && layerData[l.id]) addMetroSourceLayers(layerData[l.id])
    if (railwayOn.value) addRailwayLayer()
  })
}

function applyLayerState() {
  const l = layer.value
  if (!map || !l || !map.getLayer('metro-lines')) return
  const vis = l.visible ? 'visible' : 'none'
  map.setLayoutProperty('metro-lines', 'visibility', vis)
  map.setLayoutProperty('metro-stations', 'visibility', vis)
  map.setPaintProperty('metro-lines', 'line-opacity', l.opacity)
  map.setPaintProperty('metro-lines', 'line-width', l.strokeWidth)
  map.setPaintProperty('metro-stations', 'circle-opacity', l.opacity)
  map.setPaintProperty('metro-stations', 'circle-stroke-opacity', l.opacity)
  map.setPaintProperty('metro-stations', 'circle-radius', l.radius)
}

watch(layer, applyLayerState, { deep: true })

/* context menu actions */
function copyCoords() {
  const { lng, lat } = ctxMenu.value
  navigator.clipboard?.writeText(`${lng.toFixed(6)}, ${lat.toFixed(6)}`)
  store.toast('Coordinates copied')
  ctxMenu.value = null
}
function centerHere() {
  map.easeTo({ center: [ctxMenu.value.lng, ctxMenu.value.lat] })
  ctxMenu.value = null
}
function ctxZoom(delta) {
  map.easeTo({
    center: [ctxMenu.value.lng, ctxMenu.value.lat],
    zoom: map.getZoom() + delta,
  })
  ctxMenu.value = null
}

onBeforeUnmount(() => {
  disposables.forEach((d) => d?.dispose?.())
  if (mapHandle.map === map) mapHandle.map = null
  map?.remove()
  map = null
})
</script>

<template>
  <div class="layer-tab">
    <div class="tab-body">
      <div class="tab-map">
        <div ref="container" class="map-container" />

        <div v-if="loading" class="map-loading">
          <div class="spinner" />
          <span>載入 {{ layer?.city ?? '' }} metro map…</span>
        </div>
        <div v-else-if="loadError" class="map-loading error">
          <span>{{ loadError }}</span>
        </div>

        <div
          v-if="ctxMenu"
          class="menu-pop ctx-menu"
          :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        >
          <div class="ctx-coords">
            {{ ctxMenu.lng.toFixed(5) }}, {{ ctxMenu.lat.toFixed(5) }}
          </div>
          <div class="menu-sep" />
          <button class="menu-item" @click="copyCoords">
            <Copy :size="14" /> Copy coordinates
          </button>
          <button class="menu-item" @click="centerHere">
            <Crosshair :size="14" /> Center map here
          </button>
          <button class="menu-item" @click="ctxZoom(1)">
            <ZoomIn :size="14" /> Zoom in here
          </button>
          <button class="menu-item" @click="ctxZoom(-1)">
            <ZoomOut :size="14" /> Zoom out here
          </button>
        </div>

        <!-- Basemap picker (bottom-right) -->
        <div class="basemap-control" @click.stop>
          <button
            class="basemap-btn"
            :class="{ active: basemapMenuOpen }"
            title="Basemaps"
            @click="basemapMenuOpen = !basemapMenuOpen"
          >
            <Layers :size="16" />
          </button>
          <div v-if="basemapMenuOpen" class="menu-pop basemap-menu">
            <div class="bm-current">{{ currentBasemap.label }}</div>
            <div class="bm-scroll">
              <template v-for="grp in groups" :key="grp.group">
                <div class="menu-label">{{ grp.group }}</div>
                <button
                  v-for="b in grp.items"
                  :key="b.id"
                  class="bm-item"
                  :class="{ active: basemapId === b.id }"
                  :disabled="b.needsToken && !MAPBOX_ENABLED"
                  @click="setBasemap(b.id)"
                >
                  <Check v-if="basemapId === b.id" :size="13" class="bm-check" />
                  <span v-else class="bm-check-spacer" />
                  <span class="bm-label">{{ b.label }}</span>
                  <span v-if="b.needsToken && !MAPBOX_ENABLED" class="bm-note">需 token</span>
                </button>
              </template>
            </div>
            <div class="menu-sep" />
            <label class="bm-overlay">
              <input type="checkbox" :checked="railwayOn"
                @change="setRailway($event.target.checked)" />
              <TrainFront :size="14" />
              <span>OpenRailwayMap 鐵路圖層</span>
            </label>
          </div>
        </div>
      </div>

      <StylePanel v-if="layer" :layer="layer" />
    </div>

    <StatusBar :view="view" />
  </div>
</template>

<style scoped>
.layer-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: hsl(var(--background));
}
.tab-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.tab-map {
  position: relative;
  isolation: isolate;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.map-container { position: absolute; inset: 0; }
.map-loading {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: hsl(var(--background) / 0.75);
  backdrop-filter: blur(2px);
  color: hsl(var(--muted-foreground));
  font-size: 13px;
}
.map-loading.error { color: hsl(var(--destructive)); }
.spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 3px solid hsl(var(--border));
  border-top-color: hsl(var(--primary));
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.ctx-menu { min-width: 200px; }
.ctx-coords {
  padding: 6px 8px 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
}

/* ---- basemap picker (bottom-right) ---- */
.basemap-control { position: absolute; right: 10px; bottom: 10px; z-index: 6; }
.basemap-btn {
  display: flex; align-items: center; justify-content: center;
  width: 34px; height: 34px;
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--card)); color: hsl(var(--foreground));
  border: 1px solid hsl(var(--border));
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.18);
}
.basemap-btn:hover { background: hsl(var(--accent)); }
.basemap-btn.active { color: hsl(var(--primary)); border-color: hsl(var(--primary) / 0.5); }
.basemap-menu {
  position: absolute; right: 0; bottom: 42px;
  width: 240px; padding: 6px;
  display: flex; flex-direction: column;
}
.bm-current {
  font-size: 12px; font-weight: 600; color: hsl(var(--foreground));
  padding: 4px 8px 6px; border-bottom: 1px solid hsl(var(--border)); margin-bottom: 4px;
}
.bm-scroll { max-height: 46vh; overflow-y: auto; }
.bm-item {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 5px 8px; border-radius: calc(var(--radius) - 4px);
  text-align: left; font-size: 12.5px; color: hsl(var(--popover-foreground));
}
.bm-item:hover { background: hsl(var(--accent)); }
.bm-item.active { color: hsl(var(--primary)); font-weight: 600; }
.bm-item:disabled { opacity: 0.45; cursor: default; }
.bm-item:disabled:hover { background: none; }
.bm-check { color: hsl(var(--primary)); flex-shrink: 0; }
.bm-check-spacer { width: 13px; flex-shrink: 0; }
.bm-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bm-note {
  font-size: 10px; color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border)); border-radius: 4px; padding: 0 4px;
}
.bm-overlay {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; font-size: 12.5px; cursor: pointer;
  color: hsl(var(--foreground));
}
.bm-overlay input { accent-color: hsl(var(--primary)); }
</style>

<style>
.maplibregl-popup-content {
  background: hsl(var(--popover)) !important;
  color: hsl(var(--popover-foreground)) !important;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  font-size: 12px;
  padding: 8px 10px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.2);
}
.maplibregl-popup-tip { display: none; }
</style>
