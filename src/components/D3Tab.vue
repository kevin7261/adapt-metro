<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { geoMercator, geoPath } from 'd3-geo'
import { select, pointer } from 'd3-selection'
import { zoom, zoomIdentity } from 'd3-zoom'
import { useMapStore } from '../stores/mapStore'
import { layerData } from '../stores/layerData'
import { computeOrientation } from '../stores/orientation'
import { buildConnectSkeleton } from '../stores/skeleton'
import StylePanel from './StylePanel.vue'
import AttributeTable from './AttributeTable.vue'
import { RotateCcw, RotateCw, Undo2, GitFork } from 'lucide-vue-next'

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
// A file-imported view owns its data (stored under its own id in layerData);
// panels and styling then bind to the d3 layer itself instead of a source layer.
const ownData = computed(() => !!layerData[layerId])
const panelLayer = computed(() => (ownData.value ? layer.value : sourceLayer.value))

const host = ref(null)      // container div
const svgEl = ref(null)     // <svg>
const gEl = ref(null)       // zoomable <g>
const tipEl = ref(null)     // hover tooltip
const loading = ref(false)
const loadError = ref(null)

// Suggested rotation (Boeing-style dominant-axis tilt, from the Info rose).
// `rotated` re-projects the whole map with projection.angle(tilt) — measured:
// a positive d3 angle turns the map counter-clockwise, which is exactly what
// cancels a clockwise (positive) tilt. fitExtent then refits the rotated map.
const tilt = ref(0)
const rotated = ref(false)
const canRotate = computed(() => Math.abs(tilt.value) >= 0.5)

// Skeletonize (see skill route-skeleton-connect): connect skeleton — keep the
// geographic shape, classify nodes (red/blue/black/purple/pink/gray) and edges
// (coline/loop/parallel). Nothing is moved.
const skeletonized = ref(false)
const disposables = []
let zoomBehavior = null
let resizeObs = null
let zk = 1 // current zoom scale — mark sizes are divided by it so they stay constant

// Keep dot radius and label size constant on zoom (strokes use non-scaling-stroke
// via CSS; only geometric sizes need counter-scaling by the zoom factor k).
function applyZoomSizing(k) {
  zk = k
  const g = select(gEl.value)
  const r0 = panelLayer.value?.radius ?? 4
  g.selectAll('circle.station').attr('r', r0 / k)
  g.selectAll('circle.ref-foot').attr('r', 2 / k)
  g.selectAll('text.st-label')
    .style('font-size', `${9 / k}px`)
    .attr('y', (d) => d.y - (r0 + 3) / k)
}

// Same station-role colouring as the MapLibre tab: transfer red, terminus blue.
function stationColor(p) {
  if (Array.isArray(p.lines) && p.lines.length > 1) return '#e11d48'
  if (p.is_terminus) return '#2563eb'
  return '#ffffff'
}

async function sourceData() {
  // File-imported view: its own GeoJSON lives under this layer's id.
  if (layerData[layerId]) return layerData[layerId]
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
  const stations = data.features.filter((f) => f.geometry.type === 'Point')
  const lineFeats = data.features.filter((f) => f.geometry.type !== 'Point')

  tilt.value = computeOrientation(data).tilt

  const projection = geoMercator()
    .angle(rotated.value ? tilt.value : 0)
    .fitExtent(
      [[24, 24], [w - 24, h - 24]],
      { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : data.features },
    )
  const path = geoPath(projection)
  const P = (c) => projection(c)

  // Skeleton mode: connect skeleton (骨架2) — keep the geographic line shape,
  // classify nodes (red/blue/black/purple/pink/gray) and edges (coline/loop/
  // parallel/plain). See skill route-skeleton-connect.
  const sk = skeletonized.value ? buildConnectSkeleton(data) : null
  const MAX_OVERLAP = 6, DASH = 5 // overlap interleaved-dash pattern (screen px)
  // 'black' = untouched through station → keep the normal white fill; only the
  // specially-marked nodes get a colour. All keep the dark border (set below).
  const NODE_COLOR = { red: '#e11d48', blue: '#2563eb', black: '#ffffff', purple: '#a855f7', pink: '#ec4899', gray: '#9ca3af' }
  // Edge-class colours are drawn as a BOTTOM HIGHLIGHT (underlay) — NOT the line
  // colour. The line itself is always the original metro-map rendering.
  const EDGE_HL = { coline: '#e11d48', loop: '#16a34a', parallel: '#2563eb' }
  const EDGE_LABEL = { coline: '共線合併', loop: '環線', parallel: '頭尾共點', plain: '一般' }

  let lineData, stationData, highlightData = []
  if (sk) {
    const coordById = new Map(stations.map((f) => [f.properties.station_id, f.geometry.coordinates]))
    const edgeD = (pathIds) => pathIds
      .map((id, i) => { const [x, y] = P(coordById.get(id)); return `${i ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}` })
      .join(' ')
    // Line = original metro-map drawing: single route → solid route colour,
    // overlap (≥2 routes) → interleaved route-colour dashes.
    lineData = sk.edges.flatMap((e) => {
      const d = edgeD(e.path)
      const html = `${EDGE_LABEL[e.cls]}（${e.routes.size} 線）`
      const cols = (e.routeColors ?? []).slice(0, MAX_OVERLAP)
      if (cols.length >= 2) {
        const n = cols.length
        return cols.map((color, i) => ({
          d, stroke: color, html,
          dash: `0 ${i * DASH} ${DASH} ${(n - 1 - i) * DASH}`,
        }))
      }
      return [{ d, stroke: cols[0] ?? e.color ?? '#e11d48', html }]
    })
    // Bottom highlight: one translucent underlay per classified edge.
    highlightData = sk.edges.filter((e) => EDGE_HL[e.cls]).map((e) => ({ d: edgeD(e.path), color: EDGE_HL[e.cls] }))
    stationData = stations.map((f) => {
      const [x, y] = P(f.geometry.coordinates)
      return { x, y, props: f.properties, fill: NODE_COLOR[sk.stationClass.get(f.properties.station_id)] ?? '#ffffff' }
    })
  } else {
    lineData = lineFeats.map((f) => ({ d: path(f), stroke: f.properties.route_color ?? '#e11d48', props: f.properties }))
    stationData = stations.map((f) => {
      const [x, y] = P(f.geometry.coordinates)
      return { x, y, props: f.properties, fill: stationColor(f.properties) }
    })
  }

  // Bottom-to-top: edge-class highlight underlay, lines, pink reference lines
  // (shown on hover), then stations.
  const highlightG = sel.append('g').attr('class', 'hl-layer')
  const linesG = sel.append('g').attr('class', 'lines-layer')
  const refG = sel.append('g').attr('class', 'ref-layer').style('pointer-events', 'none')
  const stationsG = sel.append('g').attr('class', 'stations-layer')

  // Pink reference lines: the whole-edge chord (sinuosity baseline), the DP
  // sub-segment baseline, and this point's perpendicular drop to it.
  function drawRef(info) {
    refG.selectAll('*').remove()
    const seg = (a, b, dash) => refG.append('line')
      .attr('x1', P(a)[0]).attr('y1', P(a)[1]).attr('x2', P(b)[0]).attr('y2', P(b)[1])
      .attr('stroke', '#ec4899').attr('stroke-width', 1.5)
      .attr('stroke-dasharray', dash || null)
    seg(info.chordA, info.chordB, '4 3') // edge chord (sinuosity)
    seg(info.baseA, info.baseB)          // DP baseline
    seg(info.pt, info.foot)              // perpendicular (垂距)
    refG.append('circle')
      .attr('cx', P(info.foot)[0]).attr('cy', P(info.foot)[1])
      .attr('r', 2).attr('fill', '#ec4899')
  }
  const clearRef = () => refG.selectAll('*').remove()

  highlightG.selectAll('path.hl')
    .data(highlightData)
    .join('path')
    .attr('class', 'hl')
    .attr('d', (d) => d.d)
    .attr('fill', 'none')
    .attr('stroke', (d) => d.color)
    .attr('stroke-opacity', 0.55)
    .attr('stroke-width', (panelLayer.value?.strokeWidth ?? 2.5) + 11)
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .style('pointer-events', 'none')

  linesG.selectAll('path.line')
    .data(lineData)
    .join('path')
    .attr('class', 'line')
    .attr('d', (d) => d.d)
    .attr('fill', 'none')
    .attr('stroke', (d) => d.stroke)
    .attr('stroke-dasharray', (d) => d.dash ?? null)
    .attr('stroke-linecap', (d) => (d.dash ? 'butt' : 'round'))
    .attr('stroke-linejoin', 'round')
    .style('cursor', 'pointer')
    .on('click', (e, d) => { e.stopPropagation(); if (d.props) store.setSelectedFeature(panelLayer.value?.id, d.props) })
    .on('mouseenter', function (e, d) {
      select(this).raise().attr('stroke-width', (panelLayer.value?.strokeWidth ?? 2.5) + 3)
      showTip(e, d.html ?? lineHtml(d.props))
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function () {
      select(this).attr('stroke-width', panelLayer.value?.strokeWidth ?? 2.5)
      hideTip()
    })

  stationsG.selectAll('circle.station')
    .data(stationData)
    .join('circle')
    .attr('class', 'station')
    .attr('cx', (d) => d.x)
    .attr('cy', (d) => d.y)
    .attr('fill', (d) => d.fill)
    .attr('stroke', '#3f3f46')
    .attr('stroke-width', 1)
    .style('cursor', 'pointer')
    .on('click', (e, d) => { e.stopPropagation(); store.setSelectedFeature(panelLayer.value?.id, d.props) })
    .on('mouseenter', function (e, d) {
      select(this).raise().attr('r', ((panelLayer.value?.radius ?? 4) + 3) / zk)
      const info = sk?.pinkInfo?.get(d.props.station_id)
      if (info) { drawRef(info); showTip(e, pinkHtml(d.props, info)) }
      else showTip(e, stationHtml(d.props))
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function () {
      select(this).attr('r', (panelLayer.value?.radius ?? 4) / zk)
      clearRef()
      hideTip()
    })

  // Station name labels above the dots (toggled by the Style tab).
  if (panelLayer.value?.showLabels) {
    const r = panelLayer.value?.radius ?? 4
    stationsG.selectAll('text.st-label')
      .data(stationData)
      .join('text')
      .attr('class', 'st-label')
      .attr('x', (d) => d.x)
      .attr('y', (d) => d.y - r - 3)
      .attr('text-anchor', 'middle')
      .style('pointer-events', 'none')
      .text((d) => d.props.station_name ?? '')
  }

  applyStyle()

  // reset zoom to identity on re-render
  if (zoomBehavior) select(svg).call(zoomBehavior.transform, zoomIdentity)
}

// Width / radius / opacity come from the SOURCE layer's style (the same values
// the Style tab edits for the MapLibre view) — applied without a re-render so
// slider drags stay smooth.
function applyStyle() {
  const src = panelLayer.value
  const sel = select(gEl.value)
  sel.selectAll('path.line')
    .attr('stroke-width', src?.strokeWidth ?? 2.5)
    .attr('stroke-opacity', src?.opacity ?? 1)
  sel.selectAll('path.hl')
    .attr('stroke-width', (src?.strokeWidth ?? 2.5) + 11)
  sel.selectAll('circle.station')
    .attr('r', (src?.radius ?? 4) / zk)
    .attr('opacity', src?.opacity ?? 1)
}

/* ---- hover popup (same content as the MapLibre tab) ---- */
function asArray(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.startsWith('[')) { try { return JSON.parse(v) } catch { /* */ } }
  return []
}
function stationHtml(p) {
  const local = p.station_name_local && p.station_name_local !== p.station_name
    ? `<br/>${p.station_name_local}` : ''
  const lines = asArray(p.lines)
  const linesHtml = lines.length ? `<br/>Lines: ${lines.join(', ')}` : ''
  return `<strong>${p.station_name ?? '—'}</strong>${local}${linesHtml}`
}
function lineHtml(p) {
  const routes = asArray(p.routes)
  const list = routes.length ? routes : [p]
  return list.map((r) => {
    const local = r.route_name_local && r.route_name_local !== r.route_name
      ? `（${r.route_name_local}）` : ''
    return `<span style="color:${r.route_color ?? '#e11d48'}">▬</span> `
      + `<strong>${r.route_ref ? `[${r.route_ref}] ` : ''}${r.route_name ?? '—'}</strong>${local}`
  }).join('<br/>')
}
// Pink (representative bend) hover: explain the two gates + this point's numbers.
function pinkHtml(p, info) {
  return `<strong>${p.station_name ?? '—'}</strong>`
    + '<br/><span style="color:#ec4899">● 代表性轉折點（粉紅）</span>'
    + `<br/>邊曲折度 = 弧長÷弦長 = <b>${info.sinuosity.toFixed(2)}</b>（&gt;1.25 才挑）`
    + `<br/>此點 垂距÷弦長 = <b>${info.ratio.toFixed(2)}</b>（&gt;0.25 保留）`
    + '<br/><span style="color:#9ca3af;font-size:11px">曲折度：整條邊的弧長比兩端直線'
    + '（弦）長多少——越大越彎；虛線＝弦，實線＝DP 基線與垂距。</span>'
}
function showTip(e, html) {
  const el = tipEl.value
  if (!el) return
  el.innerHTML = html
  el.style.display = 'block'
  moveTip(e)
}
function moveTip(e) {
  const el = tipEl.value
  if (!el || el.style.display === 'none') return
  const [x, y] = pointer(e, host.value)
  el.style.left = `${x + 14}px`
  el.style.top = `${y + 14}px`
}
function hideTip() {
  if (tipEl.value) tipEl.value.style.display = 'none'
}

watch(() => layer.value?.sourceLayerId, render)
watch(rotated, render)
watch(skeletonized, render)
// Live style sync from the bound layer (Style tab sliders).
watch(
  () => [panelLayer.value?.strokeWidth, panelLayer.value?.radius, panelLayer.value?.opacity],
  applyStyle,
)
// Toggling station labels needs a re-render (add/remove text nodes).
watch(() => panelLayer.value?.showLabels, render)

onMounted(() => {
  // d3-zoom drives the inner <g> transform (wheel zoom + drag pan).
  zoomBehavior = zoom()
    .scaleExtent([0.5, 20])
    .on('zoom', (e) => {
      select(gEl.value).attr('transform', e.transform)
      applyZoomSizing(e.transform.k)
    })
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
          <button
            class="d3-rotate-btn"
            :class="{ active: skeletonized }"
            :disabled="!panelLayer"
            title="把路線圖拉直成示意骨架（再按一次還原）"
            @click="skeletonized = !skeletonized"
          >
            <Undo2 v-if="skeletonized" :size="14" />
            <GitFork v-else :size="14" />
            <span>{{ skeletonized ? '還原原形' : '骨架化' }}</span>
          </button>

          <button
            class="d3-rotate-btn"
            :class="{ active: rotated }"
            :disabled="!canRotate"
            :title="canRotate ? '' : '網路已對齊正南北，無需旋轉'"
            @click="rotated = !rotated"
          >
            <Undo2 v-if="rotated" :size="14" />
            <component :is="tilt > 0 ? RotateCcw : RotateCw" v-else :size="14" />
            <span>{{ rotated ? '回復原方向' : `依建議旋轉 ${Math.abs(tilt).toFixed(0)}°` }}</span>
          </button>

          <span class="d3-label">資料來源：</span>
          <span class="d3-source">
            {{ ownData ? `${layer?.name}（匯入 JSON）` : (sourceLayer?.name ?? layer?.sourceLayerId ?? '—') }}
          </span>
        </div>

        <div ref="host" class="d3-canvas">
          <svg ref="svgEl" class="d3-svg" @click="panelLayer && store.setSelectedFeature(panelLayer.id, null)">
            <g ref="gEl" />
          </svg>
          <div ref="tipEl" class="d3-tip" />
          <div v-if="loading" class="d3-hint">載入中…</div>
          <div v-else-if="loadError" class="d3-hint error">{{ loadError }}</div>
        </div>

        <AttributeTable
          v-if="store.ui.attributeTableOpen[layerId] && panelLayer"
          :layer="panelLayer"
          :owner-id="layerId"
        />
      </div>

      <StylePanel v-if="panelLayer" :layer="panelLayer" context="d3" />
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
.d3-label { font-size: 12.5px; color: hsl(var(--muted-foreground)); white-space: nowrap; margin-left: auto; }
.d3-source { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.d3-rotate-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  font-size: 12.5px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  color: hsl(var(--foreground));
  white-space: nowrap;
}
.d3-rotate-btn:hover:not(:disabled) { background: hsl(var(--accent)); }
.d3-rotate-btn.active {
  color: hsl(var(--primary));
  border-color: hsl(var(--primary) / 0.5);
  background: hsl(var(--primary) / 0.1);
}
.d3-rotate-btn:disabled { opacity: 0.45; cursor: default; }
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
.d3-svg :deep(text.st-label) {
  font-size: 9px;
  fill: #e5e7eb;
  stroke: #111827;
  stroke-width: 2.4px;
  paint-order: stroke;
  stroke-linejoin: round;
}
.d3-tip {
  position: absolute;
  display: none;
  z-index: 10;
  pointer-events: none;
  max-width: 260px;
  background: hsl(var(--popover));
  color: hsl(var(--popover-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  font-size: 12px;
  line-height: 1.5;
  padding: 8px 10px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.2);
}
</style>
