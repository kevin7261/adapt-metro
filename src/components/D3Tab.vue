<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { geoMercator, geoPath } from 'd3-geo'
import { select } from 'd3-selection'
import { zoom, zoomIdentity } from 'd3-zoom'
import { useMapStore } from '../stores/mapStore'
import { layerData } from '../stores/layerData'
import StylePanel from './StylePanel.vue'
import AttributeTable from './AttributeTable.vue'

// Dockview panel props: { params: { layerId }, api, containerApi }
const props = defineProps({ params: { type: Object, required: true } })

const store = useMapStore()
const layerId = props.params.params.layerId
const panelApi = props.params.api
const layer = computed(() => store.layers.find((l) => l.id === layerId) ?? null)

// Metro layers currently in the panel — the loadable sources.
const metroLayers = computed(() => store.layers.filter((l) => l.type === 'metro'))
// The metro layer this view draws — Info/Style/Object and the attribute table
// are bound to it, exactly like the MapLibre tab.
const sourceLayer = computed(() =>
  metroLayers.value.find((l) => l.id === layer.value?.sourceLayerId) ?? null)

const host = ref(null)      // container div
const svgEl = ref(null)     // <svg>
const gEl = ref(null)       // zoomable <g>
const loading = ref(false)
const loadError = ref(null)
const disposables = []
let zoomBehavior = null
let resizeObs = null

// Same station-role colouring as the MapLibre tab: transfer red, terminus blue.
function stationColor(p) {
  if (Array.isArray(p.lines) && p.lines.length > 1) return '#e11d48'
  if (p.is_terminus) return '#2563eb'
  return '#ffffff'
}

async function sourceData() {
  const src = metroLayers.value.find((l) => l.id === layer.value?.sourceLayerId)
  if (!src) {
    // A dangling reference (source layer was removed) — say so instead of a blank canvas.
    if (layer.value?.sourceLayerId) loadError.value = '來源圖層已被移除，請重新選擇'
    return null
  }
  if (layerData[src.id]) return layerData[src.id]
  loading.value = true
  try {
    const res = await fetch(src.file)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    layerData[src.id] = data
    return data
  } catch (err) {
    loadError.value = `無法載入 ${src.file}（${err.message}）`
    return null
  } finally {
    loading.value = false
  }
}

// (Re)draw the chosen metro layer with d3: mercator projection fit to the
// container, lines coloured per route, stations as role-coloured circles.
async function render() {
  const svg = svgEl.value, g = gEl.value, el = host.value
  if (!svg || !g || !el) return
  const sel = select(g)
  sel.selectAll('*').remove()
  loadError.value = null

  const data = await sourceData()
  if (!data) return

  const w = el.clientWidth || 600
  const h = el.clientHeight || 400
  const lines = data.features.filter((f) => f.geometry.type !== 'Point')
  const stations = data.features.filter((f) => f.geometry.type === 'Point')

  const projection = geoMercator().fitExtent(
    [[24, 24], [w - 24, h - 24]],
    { type: 'FeatureCollection', features: lines.length ? lines : data.features },
  )
  const path = geoPath(projection)

  sel.selectAll('path.line')
    .data(lines)
    .join('path')
    .attr('class', 'line')
    .attr('d', path)
    .attr('fill', 'none')
    .attr('stroke', (d) => d.properties.route_color ?? '#e11d48')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .style('cursor', 'pointer')
    .on('click', (e, d) => {
      e.stopPropagation()
      selectFeature(d)
    })

  sel.selectAll('circle.station')
    .data(stations)
    .join('circle')
    .attr('class', 'station')
    .attr('cx', (d) => projection(d.geometry.coordinates)[0])
    .attr('cy', (d) => projection(d.geometry.coordinates)[1])
    .attr('fill', (d) => stationColor(d.properties))
    .attr('stroke', '#3f3f46')
    .attr('stroke-width', 1)
    .style('cursor', 'pointer')
    .on('click', (e, d) => {
      e.stopPropagation()
      selectFeature(d)
    })
    .append('title')
    .text((d) => d.properties.station_name ?? '')

  applyStyle()

  // reset zoom to identity on re-render
  if (zoomBehavior) select(svg).call(zoomBehavior.transform, zoomIdentity)
}

// Width / radius / opacity come from the SOURCE layer's style (the same values
// the Style tab edits for the MapLibre view) — applied without a re-render so
// slider drags stay smooth.
function applyStyle() {
  const src = sourceLayer.value
  const sel = select(gEl.value)
  sel.selectAll('path.line')
    .attr('stroke-width', src?.strokeWidth ?? 2.5)
    .attr('stroke-opacity', src?.opacity ?? 1)
  sel.selectAll('circle.station')
    .attr('r', src?.radius ?? 4)
    .attr('opacity', src?.opacity ?? 1)
}

// Clicking a station/line feeds the Object tab (keyed by the source layer id,
// same as the MapLibre tab does).
function selectFeature(d) {
  if (sourceLayer.value) store.setSelectedFeature(sourceLayer.value.id, d.properties)
}

watch(() => layer.value?.sourceLayerId, render)
// Live style sync from the source layer (Style tab sliders).
watch(
  () => [sourceLayer.value?.strokeWidth, sourceLayer.value?.radius, sourceLayer.value?.opacity],
  applyStyle,
)

onMounted(() => {
  // d3-zoom drives the inner <g> transform (wheel zoom + drag pan).
  zoomBehavior = zoom()
    .scaleExtent([0.5, 20])
    .on('zoom', (e) => select(gEl.value).attr('transform', e.transform))
  select(svgEl.value).call(zoomBehavior)

  // Redraw when the panel is resized (dockview) or first laid out.
  resizeObs = new ResizeObserver(() => render())
  resizeObs.observe(host.value)

  // Active tab keeps the layer-list highlight in sync (same per-panel event as
  // LayerTab — dockview 7's api-level active-panel event is unreliable).
  const setActive = (active) => { if (active) store.selectedLayerId = layerId }
  disposables.push(panelApi.onDidActiveChange(({ isActive }) => setActive(isActive)))
  setActive(panelApi.isActive)

  render()
})

onBeforeUnmount(() => {
  disposables.forEach((d) => d?.dispose?.())
  resizeObs?.disconnect()
})
</script>

<template>
  <div class="d3-tab">
    <div class="tab-body">
      <div class="map-col">
        <div class="d3-toolbar">
          <span class="d3-label">D3.js view — 資料來源：</span>
          <span class="d3-source">{{ sourceLayer?.name ?? layer?.sourceLayerId ?? '—' }}</span>
        </div>

        <div ref="host" class="d3-canvas">
          <svg ref="svgEl" class="d3-svg" @click="sourceLayer && store.setSelectedFeature(sourceLayer.id, null)">
            <g ref="gEl" />
          </svg>
          <div v-if="loading" class="d3-hint">載入中…</div>
          <div v-else-if="loadError" class="d3-hint error">{{ loadError }}</div>
        </div>

        <AttributeTable
          v-if="store.ui.attributeTableOpen[layerId] && sourceLayer"
          :layer="sourceLayer"
          :owner-id="layerId"
        />
      </div>

      <StylePanel v-if="sourceLayer" :layer="sourceLayer" />
    </div>
  </div>
</template>

<style scoped>
.d3-tab {
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
/* Canvas + its attribute table stack vertically; StylePanel sits beside. */
.map-col {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.d3-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid hsl(var(--border));
  flex-shrink: 0;
}
.d3-label { font-size: 12.5px; color: hsl(var(--muted-foreground)); white-space: nowrap; }
.d3-source { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.d3-canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.d3-svg { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; }
.d3-svg:active { cursor: grabbing; }
.d3-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: hsl(var(--muted-foreground));
  pointer-events: none;
}
.d3-hint.error { color: hsl(var(--destructive)); }
</style>
