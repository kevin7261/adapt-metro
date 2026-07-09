<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
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
let map = null
const disposables = []

// Per-tab view state feeding this tab's footer.
const view = reactive({ lng: null, lat: null, zoom: 11.2, bearing: 0, pitch: 0, bounds: null })

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

// Map store layer ids → maplibre layer ids inside this tab
const LAYER_MAP = {
  stations: ['stations-circle'],
  lines: ['lines-line'],
  catchment: ['catchment-fill', 'catchment-outline'],
  flood: ['flood-fill', 'flood-outline'],
}

onMounted(() => {
  map = new maplibregl.Map({
    container: container.value,
    style: MAP_STYLE,
    center: [121.5405, 25.0430],
    zoom: 11.2,
    attributionControl: false,
  })

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
  map.addControl(new maplibregl.FullscreenControl(), 'top-right')
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')

  map.on('load', addLayerData)

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

  // Station hover popup (only meaningful in the stations tab)
  if (layerId === 'stations') {
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 })
    map.on('mouseenter', 'stations-circle', (e) => {
      map.getCanvas().style.cursor = 'pointer'
      const p = e.features[0].properties
      popup
        .setLngLat(e.features[0].geometry.coordinates)
        .setHTML(`<strong>${p.name}</strong><br/>Line: ${p.line}<br/>Ridership: ${Number(p.ridership).toLocaleString()}`)
        .addTo(map)
    })
    map.on('mouseleave', 'stations-circle', () => {
      map.getCanvas().style.cursor = ''
      popup.remove()
    })
  }

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

function addLayerData() {
  if (!layer.value || layer.value.isBasemap) return
  const demoData = store.demoData

  if (layerId === 'flood') {
    map.addSource('flood', { type: 'geojson', data: demoData.flood })
    map.addLayer({
      id: 'flood-fill', source: 'flood', type: 'fill',
      paint: { 'fill-color': '#06b6d4', 'fill-opacity': 0.4 },
    })
    map.addLayer({
      id: 'flood-outline', source: 'flood', type: 'line',
      paint: { 'line-color': '#0891b2', 'line-width': 1 },
    })
  } else if (layerId === 'catchment') {
    map.addSource('catchment', { type: 'geojson', data: demoData.catchment })
    map.addLayer({
      id: 'catchment-fill', source: 'catchment', type: 'fill',
      paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.35 },
    })
    map.addLayer({
      id: 'catchment-outline', source: 'catchment', type: 'line',
      paint: { 'line-color': '#2563eb', 'line-width': 1 },
    })
  } else if (layerId === 'lines') {
    map.addSource('lines', { type: 'geojson', data: demoData.lines })
    map.addLayer({
      id: 'lines-line', source: 'lines', type: 'line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 1 },
    })
  } else if (layerId === 'stations') {
    map.addSource('stations', { type: 'geojson', data: demoData.stations })
    map.addLayer({
      id: 'stations-circle', source: 'stations', type: 'circle',
      paint: {
        'circle-radius': 5,
        'circle-color': '#f59e0b',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-opacity': 1,
      },
    })
  }

  applyLayerState()
}

function applyLayerState() {
  const l = layer.value
  if (!map || !l) return
  const ids = LAYER_MAP[l.id]
  if (!ids || !map.getLayer(ids[0])) return
  for (const id of ids) {
    if (!map.getLayer(id)) continue
    map.setLayoutProperty(id, 'visibility', l.visible ? 'visible' : 'none')
  }
  if (l.id === 'stations') {
    map.setPaintProperty('stations-circle', 'circle-opacity', l.opacity)
    map.setPaintProperty('stations-circle', 'circle-color', l.color)
    map.setPaintProperty('stations-circle', 'circle-stroke-color', l.strokeColor)
    map.setPaintProperty('stations-circle', 'circle-stroke-width', l.strokeWidth)
    map.setPaintProperty('stations-circle', 'circle-radius', l.radius)
  } else if (l.id === 'lines') {
    map.setPaintProperty('lines-line', 'line-opacity', l.opacity)
    map.setPaintProperty(
      'lines-line', 'line-color',
      l.symbology === 'categorized' ? ['get', 'color'] : l.color,
    )
    map.setPaintProperty('lines-line', 'line-width', l.strokeWidth)
  } else if (l.id === 'catchment' || l.id === 'flood') {
    map.setPaintProperty(`${l.id}-fill`, 'fill-opacity', l.opacity)
    map.setPaintProperty(`${l.id}-fill`, 'fill-color', l.color)
    map.setPaintProperty(`${l.id}-outline`, 'line-color', l.strokeColor)
    map.setPaintProperty(`${l.id}-outline`, 'line-width', l.strokeWidth)
  }
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
