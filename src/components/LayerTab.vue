<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import { useMapStore } from '../stores/mapStore'
import { mapHandle } from '../stores/mapHandle'
import { layerData, boundsOfGeojson } from '../stores/layerData'
import {
  DEFAULT_BASEMAP, MAPBOX_ENABLED, RAILWAY_OVERLAY,
  basemapById, basemapGroups, styleFor, solidStyle,
} from '../stores/basemaps'
import StylePanel from './StylePanel.vue'
import StatusBar from './StatusBar.vue'
import AttributeTable from './AttributeTable.vue'
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
const railwayOn = ref(true)
const basemapMenuOpen = ref(false)
const groups = basemapGroups()
// Solid-color basemap (a plain black/white/custom canvas behind the metro data).
const solidColor = ref('#ffffff')
const currentBasemap = computed(() =>
  basemapId.value === 'solid'
    ? { id: 'solid', label: `純色 ${solidColor.value}` }
    : basemapById(basemapId.value))

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
  // Click a feature -> select it (its properties feed the Object tab); click
  // empty map -> clear. One handler + queryRenderedFeatures avoids the ordering
  // race between layer-scoped and global click handlers.
  map.on('click', (e) => {
    ctxMenu.value = null
    basemapMenuOpen.value = false
    const ids = ['metro-stations', ...ALL_LINE_LAYER_IDS].filter((id) => map.getLayer(id))
    const hits = ids.length ? map.queryRenderedFeatures(e.point, { layers: ids }) : []
    store.setSelectedFeature(layerId, hits.length ? hits[0].properties : null)
  })

  // Station hover popup
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 })
  map.on('mouseenter', 'metro-stations', (e) => {
    map.getCanvas().style.cursor = 'pointer'
    const p = e.features[0].properties
    map.setFilter('metro-stations-hover', ['==', ['get', 'station_id'], p.station_id ?? ''])
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
    map.setFilter('metro-stations-hover', ['==', ['get', 'station_id'], ''])
    popup.remove()
  })

  // Line hover popup + highlight. Line features are overlap-deduped SEGMENTS
  // (`routes` lists every route on the stretch) — the popup shows them all,
  // the highlight matches the hovered segment by seg_id. Anchor the popup to
  // the cursor and update it on move rather than to a fixed vertex.
  const linePopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 })
  const showLine = (e) => {
    map.getCanvas().style.cursor = 'pointer'
    const p = e.features[0].properties
    map.setFilter('metro-lines-hover', ['==', ['get', 'seg_id'], p.seg_id ?? ''])
    // nested props arrive JSON-stringified from event features
    let routes = p.routes
    if (typeof routes === 'string') { try { routes = JSON.parse(routes) } catch { routes = [] } }
    routes = routes ?? []
    const html = routes.map((r) => {
      const local = r.route_name_local && r.route_name_local !== r.route_name
        ? `（${r.route_name_local}）` : ''
      return `<span style="color:${r.route_color ?? '#e11d48'}">▬</span> ` +
        `<strong>${r.route_ref ? `[${r.route_ref}] ` : ''}${r.route_name ?? '—'}</strong>${local}`
    }).join('<br/>')
    linePopup.setLngLat(e.lngLat).setHTML(html || '—').addTo(map)
  }
  for (const id of ALL_LINE_LAYER_IDS) {
    map.on('mouseenter', id, showLine)
    map.on('mousemove', id, showLine)
    map.on('mouseleave', id, () => {
      map.getCanvas().style.cursor = ''
      map.setFilter('metro-lines-hover', ['==', ['get', 'seg_id'], ''])
      linePopup.remove()
    })
  }

  // Active tab drives the global map handle (toolbar / palette / attr table actions)
  // and the "selected layer" (drives the layer-list highlight). Per-panel
  // onDidActiveChange is used because dockview 7's api.onDidActivePanelChange is
  // mis-wired to group changes and won't fire on same-group tab switches.
  const setHandle = (active) => {
    if (active) {
      mapHandle.map = map
      store.selectedLayerId = layerId
    } else if (mapHandle.map === map) {
      mapHandle.map = null
    }
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

// Line features are overlap-deduped SEGMENTS: `route_count` routes share the
// stretch, colors in `route_colors`. Rendering rule (metro-osm-fetch skill):
//   route_count = 1 → solid line in the route color
//   route_count = n → n interleaved dashed lines, one per route color, via the
//     dasharray-offset trick [0, i·D, D, (n−1−i)·D]. dasharray cannot be
//     data-driven, so one layer per (n, i) slot; n ≥ MAX_OVERLAP clamps and
//     cycles colors with modulo.
const MAX_OVERLAP = 6
const DASH = 2.5
const ALL_LINE_LAYER_IDS = ['metro-lines']

// Station fill by role: transfer → red, terminal → blue, otherwise white.
// A station is a transfer when >1 distinct route (line) passes through it — the
// `is_interchange` flag is unreliable, so derive it from the `lines` array.
// Transfer wins when a station is both a transfer and a terminus.
const STATION_COLOR = [
  'case',
  ['>', ['length', ['coalesce', ['get', 'lines'], ['literal', []]]], 1], '#e11d48',
  ['coalesce', ['get', 'is_terminus'], false], '#2563eb',
  '#ffffff',
]
for (let n = 2; n <= MAX_OVERLAP; n++)
  for (let i = 0; i < n; i++) ALL_LINE_LAYER_IDS.push(`metro-lines-d${n}-${i}`)

// Add the metro source + line/station layers (idempotent; re-run after setStyle).
function addMetroSourceLayers(data) {
  const l = layer.value
  if (!map || map.getSource('metro')) return
  // MapLibre serialises array properties to JSON strings, so an expression can't
  // index into `route_colors` (the dashes then fall back to black). Flatten each
  // overlap slot's colour into scalar props `_c0.._c{MAX_OVERLAP-1}` up front so
  // the interleaved-dash layers can just ['get'] them. Idempotent.
  for (const f of data.features) {
    const rc = f.properties?.route_colors
    if (!Array.isArray(rc) || rc.length === 0 || f.properties._c0 != null) continue
    for (let i = 0; i < MAX_OVERLAP; i++) f.properties[`_c${i}`] = rc[i % rc.length]
  }
  map.addSource('metro', { type: 'geojson', data })

  // single-route segments: solid
  map.addLayer({
    id: 'metro-lines', source: 'metro', type: 'line',
    filter: ['all', ['==', ['geometry-type'], 'LineString'],
      ['==', ['coalesce', ['get', 'route_count'], 1], 1]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'route_color'], '#e11d48'],
      'line-width': l.strokeWidth,
      'line-opacity': l.opacity,
    },
  })
  // overlap segments: n interleaved dashes, one slot per route
  for (let n = 2; n <= MAX_OVERLAP; n++) {
    const isN = n < MAX_OVERLAP
      ? ['==', ['get', 'route_count'], n]
      : ['>=', ['get', 'route_count'], MAX_OVERLAP]
    for (let i = 0; i < n; i++) {
      map.addLayer({
        id: `metro-lines-d${n}-${i}`, source: 'metro', type: 'line',
        filter: ['all', ['==', ['geometry-type'], 'LineString'], isN],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': ['coalesce', ['get', `_c${i}`], ['get', 'route_color'], '#888888'],
          'line-dasharray': [0, i * DASH, DASH, (n - 1 - i) * DASH],
          'line-width': l.strokeWidth,
          'line-opacity': l.opacity,
        },
      })
    }
  }
  // Hover highlight: thicker/opaque copy filtered to the hovered segment
  // (empty match by default). Above the lines, below the stations.
  map.addLayer({
    id: 'metro-lines-hover', source: 'metro', type: 'line',
    filter: ['==', ['get', 'seg_id'], ''],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'route_color'], '#e11d48'],
      'line-width': (l.strokeWidth || 2) + 3,
      'line-opacity': 1,
    },
  })
  map.addLayer({
    id: 'metro-stations', source: 'metro', type: 'circle',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': l.radius,
      'circle-color': STATION_COLOR,
      'circle-stroke-color': '#3f3f46',
      'circle-stroke-width': 1.2,
      'circle-opacity': l.opacity,
      'circle-stroke-opacity': l.opacity,
    },
  })
  // Hover highlight for stations: same circle, enlarged, filtered to the
  // hovered station only (empty match by default). Sits on top so it's visible.
  map.addLayer({
    id: 'metro-stations-hover', source: 'metro', type: 'circle',
    filter: ['==', ['get', 'station_id'], ''],
    paint: {
      'circle-radius': (l.radius || 4) + 3,
      'circle-color': STATION_COLOR,
      'circle-stroke-color': '#3f3f46',
      'circle-stroke-width': 2,
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

// setStyle wipes all sources/layers — re-add our metro data + overlays afterwards.
function reAddOverlays() {
  const l = layer.value
  if (l?.type === 'metro' && layerData[l.id]) addMetroSourceLayers(layerData[l.id])
  if (railwayOn.value) addRailwayLayer()
}

function setBasemap(id) {
  const bm = basemapById(id)
  if (bm.needsToken && !MAPBOX_ENABLED) return
  basemapId.value = id
  basemapMenuOpen.value = false
  if (!map) return
  // diff:false forces a clean reload so `style.load` reliably fires; otherwise a
  // diffed setStyle can drop our imperatively-added metro source without re-adding it.
  map.setStyle(styleFor(bm), { diff: false })
  map.once('style.load', reAddOverlays)
}

// Solid-color canvas: quick black/white or a custom color from the picker.
function applySolid(color) {
  const wasSolid = basemapId.value === 'solid'
  solidColor.value = color
  basemapId.value = 'solid'
  if (!map) return
  // If already solid, recolor live (smooth); otherwise swap in the solid style.
  if (wasSolid && map.getLayer('background')) {
    map.setPaintProperty('background', 'background-color', color)
  } else {
    map.setStyle(solidStyle(color))
    map.once('style.load', reAddOverlays)
  }
}

function applyLayerState() {
  const l = layer.value
  if (!map || !l || !map.getLayer('metro-lines')) return
  const vis = l.visible ? 'visible' : 'none'
  for (const id of ALL_LINE_LAYER_IDS) {
    if (!map.getLayer(id)) continue
    map.setLayoutProperty(id, 'visibility', vis)
    map.setPaintProperty(id, 'line-opacity', l.opacity)
    map.setPaintProperty(id, 'line-width', l.strokeWidth)
  }
  if (map.getLayer('metro-lines-hover')) {
    map.setLayoutProperty('metro-lines-hover', 'visibility', vis)
    map.setPaintProperty('metro-lines-hover', 'line-width', (l.strokeWidth || 2) + 3)
  }
  map.setLayoutProperty('metro-stations', 'visibility', vis)
  map.setPaintProperty('metro-stations', 'circle-opacity', l.opacity)
  map.setPaintProperty('metro-stations', 'circle-stroke-opacity', l.opacity)
  map.setPaintProperty('metro-stations', 'circle-radius', l.radius)
  if (map.getLayer('metro-stations-hover')) {
    map.setLayoutProperty('metro-stations-hover', 'visibility', vis)
    map.setPaintProperty('metro-stations-hover', 'circle-radius', (l.radius || 4) + 3)
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
      <div class="map-col">
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
            <div class="bm-color">
              <div class="menu-label">底圖顏色</div>
              <div class="bm-color-row">
                <button
                  class="bm-swatch white"
                  :class="{ active: basemapId === 'solid' && solidColor.toLowerCase() === '#ffffff' }"
                  title="White"
                  @click="applySolid('#ffffff')"
                />
                <button
                  class="bm-swatch black"
                  :class="{ active: basemapId === 'solid' && solidColor.toLowerCase() === '#000000' }"
                  title="Black"
                  @click="applySolid('#000000')"
                />
                <label class="bm-swatch custom" title="自訂顏色">
                  <input type="color" :value="solidColor"
                    @input="applySolid($event.target.value)" />
                </label>
                <span class="bm-color-hint">自訂</span>
              </div>
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
        <AttributeTable v-if="store.ui.attributeTable && layer" :layer="layer" />
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
/* Map + its attribute table stack vertically; StylePanel sits full-height beside. */
.map-col {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.tab-map {
  position: relative;
  isolation: isolate;
  flex: 1;
  min-width: 0;
  min-height: 0;
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

/* ---- solid base color ---- */
.bm-color { padding: 2px 0 4px; }
.bm-color-row { display: flex; align-items: center; gap: 8px; padding: 2px 8px 4px; }
.bm-swatch {
  width: 24px; height: 24px; flex-shrink: 0;
  border-radius: calc(var(--radius) - 4px);
  border: 1px solid hsl(var(--border));
  cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}
.bm-swatch.white { background: #ffffff; }
.bm-swatch.black { background: #000000; }
.bm-swatch.active { border-color: hsl(var(--primary)); box-shadow: 0 0 0 2px hsl(var(--primary) / 0.4); }
.bm-swatch.custom {
  background: conic-gradient(red, yellow, lime, aqua, blue, magenta, red);
  position: relative;
}
.bm-swatch.custom input {
  position: absolute; inset: 0; opacity: 0; cursor: pointer;
  width: 100%; height: 100%; border: none; padding: 0;
}
.bm-color-hint { font-size: 11.5px; color: hsl(var(--muted-foreground)); }
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
