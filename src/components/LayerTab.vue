<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
import { layerData, boundsOfGeojson } from '../stores/layerData'
import StylePanel from './StylePanel.vue'
import StatusBar from './StatusBar.vue'
import { Copy, Crosshair, ZoomIn, ZoomOut } from 'lucide-vue-next'

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

// Per-tab view state feeding this tab's footer.
const view = reactive({ lng: null, lat: null, zoom: 1.5, bearing: 0, pitch: 0, bounds: null })

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

onMounted(() => {
  map = new maplibregl.Map({
    container: container.value,
    style: MAP_STYLE,
    center: [10, 25],
    zoom: 1.5,
    attributionControl: false,
  })

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
  map.addControl(new maplibregl.FullscreenControl(), 'top-right')
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')

  map.on('load', addMetroLayers)

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
  map.on('click', () => { ctxMenu.value = null })

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

async function addMetroLayers() {
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

  const bbox = boundsOfGeojson(data)
  if (bbox) map.fitBounds(bbox, { padding: 48, duration: 0, maxZoom: 13 })

  applyLayerState()
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

        <div v-if="loading" class="map-overlay">載入 metro map…</div>
        <div v-else-if="loadError" class="map-overlay error">{{ loadError }}</div>

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
.map-overlay {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  background: hsl(var(--popover) / 0.9);
  color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: 999px;
  padding: 5px 14px;
  font-size: 12px;
  white-space: nowrap;
}
.map-overlay.error { color: hsl(var(--destructive)); }
.ctx-menu { min-width: 200px; }
.ctx-coords {
  padding: 6px 8px 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
}
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
