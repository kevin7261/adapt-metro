<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
import { Copy, Crosshair, ZoomIn, ZoomOut } from 'lucide-vue-next'

const store = useMapStore()

const container = ref(null)
const ctxMenu = ref(null) // { x, y, lng, lat }
let map = null

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

onMounted(() => {
  map = new maplibregl.Map({
    container: container.value,
    style: MAP_STYLE,
    center: [121.5405, 25.0430],
    zoom: 11.2,
    attributionControl: false,
  })
  mapHandle.map = map

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
  map.addControl(new maplibregl.FullscreenControl(), 'top-right')
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')

  map.on('load', addDemoLayers)

  map.on('mousemove', (e) => {
    store.map.lng = e.lngLat.lng
    store.map.lat = e.lngLat.lat
  })
  map.on('mouseout', () => {
    store.map.lng = null
    store.map.lat = null
  })
  const syncView = () => {
    store.map.zoom = map.getZoom()
    store.map.bearing = map.getBearing()
    store.map.pitch = map.getPitch()
    const b = map.getBounds()
    store.map.bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
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
})

function addDemoLayers() {
  const demoData = store.demoData
  map.addSource('flood', { type: 'geojson', data: demoData.flood })
  map.addSource('catchment', { type: 'geojson', data: demoData.catchment })
  map.addSource('lines', { type: 'geojson', data: demoData.lines })
  map.addSource('stations', { type: 'geojson', data: demoData.stations })

  map.addLayer({
    id: 'flood-fill', source: 'flood', type: 'fill',
    paint: { 'fill-color': '#06b6d4', 'fill-opacity': 0.4 },
  })
  map.addLayer({
    id: 'flood-outline', source: 'flood', type: 'line',
    paint: { 'line-color': '#0891b2', 'line-width': 1 },
  })
  map.addLayer({
    id: 'catchment-fill', source: 'catchment', type: 'fill',
    paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.35 },
  })
  map.addLayer({
    id: 'catchment-outline', source: 'catchment', type: 'line',
    paint: { 'line-color': '#2563eb', 'line-width': 1 },
  })
  map.addLayer({
    id: 'lines-line', source: 'lines', type: 'line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 1 },
  })
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

  applyAllLayerState()
}

// Map store layer ids → maplibre layer ids
const LAYER_MAP = {
  stations: ['stations-circle'],
  lines: ['lines-line'],
  catchment: ['catchment-fill', 'catchment-outline'],
  flood: ['flood-fill', 'flood-outline'],
}

function applyLayerState(layer) {
  if (!map) return
  const ids = LAYER_MAP[layer.id]
  if (!ids || !map.getLayer(ids[0])) return
  for (const id of ids) {
    if (!map.getLayer(id)) continue
    map.setLayoutProperty(id, 'visibility', layer.visible ? 'visible' : 'none')
  }
  if (layer.id === 'stations') {
    map.setPaintProperty('stations-circle', 'circle-opacity', layer.opacity)
    map.setPaintProperty('stations-circle', 'circle-color', layer.color)
    map.setPaintProperty('stations-circle', 'circle-stroke-color', layer.strokeColor)
    map.setPaintProperty('stations-circle', 'circle-stroke-width', layer.strokeWidth)
    map.setPaintProperty('stations-circle', 'circle-radius', layer.radius)
  } else if (layer.id === 'lines') {
    map.setPaintProperty('lines-line', 'line-opacity', layer.opacity)
    map.setPaintProperty(
      'lines-line', 'line-color',
      layer.symbology === 'categorized' ? ['get', 'color'] : layer.color,
    )
    map.setPaintProperty('lines-line', 'line-width', layer.strokeWidth)
  } else if (layer.id === 'catchment' || layer.id === 'flood') {
    map.setPaintProperty(`${layer.id}-fill`, 'fill-opacity', layer.opacity)
    map.setPaintProperty(`${layer.id}-fill`, 'fill-color', layer.color)
    map.setPaintProperty(`${layer.id}-outline`, 'line-color', layer.strokeColor)
    map.setPaintProperty(`${layer.id}-outline`, 'line-width', layer.strokeWidth)
  }
}

function applyAllLayerState() {
  store.layers.forEach(applyLayerState)
}

watch(() => store.layers, applyAllLayerState, { deep: true })

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
  mapHandle.map = null
  map?.remove()
})
</script>

<template>
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
</template>

<style scoped>
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
