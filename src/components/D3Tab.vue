<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { geoMercator, geoPath } from 'd3-geo'
import { select, pointer } from 'd3-selection'
import { zoom, zoomIdentity } from 'd3-zoom'
import { useMapStore } from '../stores/mapStore'
import { layerData } from '../stores/layerData'
import { computeOrientation } from '../stores/orientation'
import { buildConnectSkeleton } from '../stores/skeleton'
import { buildSchematicGrid, placeBlacks } from '../stores/schematicGrid'
import { buildHillClimb, compactGrid, buildHcGraph } from '../stores/hillClimb'
import { buildRwdMap } from '../stores/rwdMap'
import StylePanel from './StylePanel.vue'
import AttributeTable from './AttributeTable.vue'

// Dockview panel props: { params: { layerId }, api, containerApi }
const props = defineProps({ params: { type: Object, required: true } })

const store = useMapStore()
const layerId = props.params.params.layerId
const panelApi = props.params.api
const layer = computed(() => store.layers.find((l) => l.id === layerId) ?? null)

// A Hill Climbing view (layer group Hill Climbing) reuses this tab: its source
// is a Map Adjust (d3) layer whose 格網化後 layout it optimizes — the variant
// ('orig' | 'rot') picks which of the city's two grid-post layouts is the input.
// An RWD Maps view chains one step further: its source is a Hill Climbing layer
// whose 縮減網格 layout it redraws with strict H/V/45° polylines.
const isHC = computed(() => layer.value?.type === 'hillclimb')
const isRWD = computed(() => layer.value?.type === 'rwd')
const needsHC = computed(() => isHC.value || isRWD.value)
// The hillclimb layer in the chain: the layer itself (HC view) or its source (RWD).
const hcLayer = computed(() =>
  isHC.value ? layer.value
    : isRWD.value ? store.layers.find((l) => l.id === layer.value?.sourceLayerId) ?? null
      : null)
const hcVariant = computed(() => (hcLayer.value?.variant === 'rot' ? 'rot' : 'orig'))
const hcD3Layer = computed(() =>
  hcLayer.value ? store.layers.find((l) => l.id === hcLayer.value.sourceLayerId) ?? null : null)

// Metro layers currently in the panel — the loadable sources.
const metroLayers = computed(() => store.layers.filter((l) => l.type === 'metro'))
// The metro layer this view draws — Info/Style/Object and the attribute table
// are bound to it, exactly like the MapLibre tab. Hill Climbing / RWD views
// resolve through their d3 layer to that view's metro source.
const sourceLayer = computed(() => {
  const srcId = needsHC.value ? hcD3Layer.value?.sourceLayerId : layer.value?.sourceLayerId
  return metroLayers.value.find((l) => l.id === srcId) ?? null
})
// A file-imported view owns its data (stored under its own id in layerData);
// panels and styling then bind to the d3 layer itself instead of a source layer.
const ownData = computed(() => !!layerData[layerId])
const panelLayer = computed(() => {
  if (ownData.value) return layer.value
  if (needsHC.value && hcD3Layer.value && layerData[hcD3Layer.value.id]) return hcD3Layer.value
  return sourceLayer.value
})

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
// 4 view modes as tabs; rotated / skeletonized are derived from the mode.
// (See skill route-skeleton-connect for the skeleton — keeps the geographic
// shape, only classifies nodes/edges; nothing is moved.)
// Map Adjust view modes (tabs). Grid modes ('grid-*') do the schematic gridding
// (⑨, see skill route-skeleton-grid); the rest are original/rotated/skeleton.
// A Hill Climbing view has just 2 tabs: the grid-post input and the optimized
// layout ('hc', ②, see skill route-hillclimb) — rotation comes from its variant.
const mode = ref(isRWD.value ? 'rwd' : isHC.value ? 'hc' : 'original')
// Modes that need the hill-climbing result ('rwd' builds on its 縮減網格).
const hcMode = computed(() => ['hc', 'hc-compact', 'rwd'].includes(mode.value))
// 縮減網格: after hill climbing, drop empty (colour-free) grid rows/columns —
// smaller grid, identical topology (rank order preserved by compactGrid).
// RWD views sit on the compact grid in BOTH of their tabs.
const hcCompact = computed(() => mode.value === 'hc-compact' || isRWD.value)
// RWD 路網: redraw the compact layout with strict H/V/45° legs (rwdMap.js).
const rwdMode = computed(() => mode.value === 'rwd')
const rotated = computed(() =>
  needsHC.value ? hcVariant.value === 'rot' : /(^rotated|-rot-)/.test(mode.value))
const skeletonized = computed(() => mode.value.includes('skeleton') || mode.value.startsWith('grid-'))
const gridMode = computed(() => needsHC.value || mode.value.startsWith('grid-'))
const gridPost = computed(() => needsHC.value || mode.value.endsWith('post'))
const canRotate = computed(() => Math.abs(tilt.value) >= 0.5)

// Heavy bits precomputed ONCE per dataset so switching tabs is instant: the
// dominant-axis tilt, the connect skeleton (topology, rotation-independent) and
// the hill-climbing cells (rank-based → extent-independent, pixels re-derived).
let cacheData = null
let cachedSkeleton = null
let cachedHC = null
let cachedHCCompact = null
let cachedRWD = null // virtual-canvas routing — isotropic rescale on resize
const hcBusy = ref(false)
const hcStats = ref(null)
const hcCompactStats = ref(null) // { fromCols, fromRows, cols, rows }
const rwdStats = ref(null)       // { straight, single, double, fallback, segs }
const rotLabel = computed(() => `旋轉 ${Math.abs(tilt.value).toFixed(0)}°`)
const VIEW_TABS = computed(() => {
  if (isRWD.value) {
    return [
      { id: 'hc-compact', label: '縮減網格' },
      { id: 'rwd', label: 'RWD 路網' },
    ]
  }
  if (isHC.value) {
    return [
      { id: 'grid-post', label: hcVariant.value === 'rot' ? `${rotLabel.value}格網化後` : '原始格網化後' },
      { id: 'hc', label: 'Hill Climbing' },
      { id: 'hc-compact', label: '縮減網格' },
    ]
  }
  return [
    { id: 'original', label: '原始' },
    { id: 'rotated', label: rotLabel.value, rot: true },
    { id: 'skeleton', label: '原始骨架化' },
    { id: 'rotated-skeleton', label: `${rotLabel.value}骨架化`, rot: true },
    { id: 'grid-orig-pre', label: '原始格網化前' },
    { id: 'grid-orig-post', label: '原始格網化後' },
    { id: 'grid-rot-pre', label: `${rotLabel.value}格網化前`, rot: true },
    { id: 'grid-rot-post', label: `${rotLabel.value}格網化後`, rot: true },
  ]
})
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
  if (needsHC.value) {
    // Hill Climbing / RWD → (HC layer →) Map Adjust layer → its data (own or metro).
    if (isRWD.value && !hcLayer.value) {
      if (layer.value?.sourceLayerId) loadError.value = '來源 Hill Climbing 圖層已被移除，請重新選擇'
      return null
    }
    const d3l = hcD3Layer.value
    if (!d3l) {
      if (hcLayer.value?.sourceLayerId) loadError.value = '來源 Map Adjust 圖層已被移除，請重新選擇'
      return null
    }
    if (layerData[d3l.id]) return layerData[d3l.id]
  }
  const src = sourceLayer.value
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
// render() is async (data fetch + HC busy-hint delay) and gets re-triggered
// while in flight (mount + ResizeObserver, mode switches) — without a guard
// both passes would append and everything is drawn twice. Each render takes a
// sequence number and bails after every await if a newer render has started.
let renderSeq = 0
async function render() {
  const svg = svgEl.value, g = gEl.value, el = host.value
  if (!svg || !g || !el) return
  const seq = ++renderSeq
  const sel = select(g)
  sel.selectAll('*').remove()
  loadError.value = null

  const data = await sourceData()
  if (seq !== renderSeq) return // superseded — the newer render draws
  if (!data) return

  const w = el.clientWidth || 600
  const h = el.clientHeight || 400
  const stations = data.features.filter((f) => f.geometry.type === 'Point')
  const lineFeats = data.features.filter((f) => f.geometry.type !== 'Point')

  // Precompute tilt + skeleton once per dataset (rotation-independent), so the
  // four view tabs only re-draw (fast) — never recompute — when switched.
  if (data !== cacheData) {
    cacheData = data
    tilt.value = computeOrientation(data).tilt
    cachedSkeleton = buildConnectSkeleton(data)
    cachedHC = null
    cachedHCCompact = null
    cachedRWD = null
    hcStats.value = null
    hcCompactStats.value = null
    rwdStats.value = null
  }

  const projection = geoMercator()
    .angle(rotated.value ? tilt.value : 0)
    .fitExtent(
      [[24, 24], [w - 24, h - 24]],
      { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : data.features },
    )
  const path = geoPath(projection)
  const P = (c) => projection(c)

  // Skeleton is the basis for both skeleton and grid views. Grid views override
  // each station's position: grid-pre = original projected, grid-post = snapped.
  const sk = (skeletonized.value || gridMode.value) ? cachedSkeleton : null
  const projById = new Map(stations.map((f) => [f.properties.station_id, P(f.geometry.coordinates)]))
  // Synthetic crossing (yellow) nodes are not real stations — feed their coords
  // to the grid + edge drawing so split edges and gridding resolve them.
  for (const c of sk?.crossings ?? []) projById.set(c.id, P(c.coord))
  const grid = gridMode.value ? buildSchematicGrid(cachedSkeleton, projById, [24, 24, w - 24, h - 24]) : null
  // Hill Climbing (②, see skill route-hillclimb): optimize the grid CELLS once
  // per dataset — cells are rank-based, so a resize only changes the pixel
  // mapping below, never the layout. Blacks are re-spread along the new runs.
  // 縮減網格 tab additionally drops colour-free rows/columns (compactGrid) —
  // fewer cells over the same extent, so everything spreads out.
  let hcPos = null, hcBlue = null, rwdLines = null
  if (grid && needsHC.value && hcMode.value) {
    if (!cachedHC) {
      hcBusy.value = true
      await new Promise((r) => setTimeout(r, 30)) // let the busy hint paint first
      if (seq !== renderSeq) { hcBusy.value = false; return } // superseded
      cachedHC = buildHillClimb(cachedSkeleton, grid.cellOf, grid.cols, grid.rows)
      hcBusy.value = false
    }
    hcStats.value = cachedHC.stats
    let cells = cachedHC.cellAfter, nC = grid.cols, nR = grid.rows
    if (hcCompact.value) {
      if (!cachedHCCompact) cachedHCCompact = compactGrid(cachedHC.cellAfter, grid.cols, grid.rows)
      cells = cachedHCCompact.cellAfter
      nC = cachedHCCompact.cols
      nR = cachedHCCompact.rows
      hcCompactStats.value = { fromCols: grid.cols, fromRows: grid.rows, cols: nC, rows: nR }
    }
    const cw = (w - 48) / nC, ch = (h - 48) / nR
    const cellPx = ([c, r]) => [24 + (c + 0.5) * cw, 24 + (r + 0.5) * ch]
    if (rwdMode.value) {
      // RWD 路網: 八方向約束以「版面 pixel」為準。The polylines are built ONCE in
      // a FIXED VIRTUAL canvas (1200×800) and mapped to the real canvas with an
      // ISOTROPIC scale + letterbox — uniform scaling preserves exact 45°, so
      // the layout is stable across resizes and the heavy routing never reruns.
      // The interior blacks already sit ON the polylines (no placeBlacks here).
      if (!cachedRWD) {
        hcBusy.value = true
        await new Promise((r) => setTimeout(r, 30))
        if (seq !== renderSeq) { hcBusy.value = false; return } // superseded
        // SQUARE virtual cells (24px): ample routing space regardless of grid
        // size, and the cell diagonal is exactly 45° — the isotropic screen
        // mapping below preserves both.
        const VCELL = 24
        const VW = nC * VCELL, VH = nR * VCELL
        const vcw = VCELL, vch = VCELL
        const vPos = new Map()
        for (const [id, p] of cells) vPos.set(id, [24 + (p[0] + 0.5) * vcw, 24 + (p[1] + 0.5) * vch])
        cachedRWD = {
          ...buildRwdMap(buildHcGraph(cachedSkeleton, grid.cellOf).segs, vPos, {
            unit: Math.min(vcw, vch),
            lattice: { x0: 24, y0: 24, sx: vcw / 2, sy: vch / 2, nx: nC * 2 + 1, ny: nR * 2 + 1 },
          }),
          VW, VH,
        }
        hcBusy.value = false
      }
      rwdStats.value = cachedRWD.stats
      // isotropic virtual→screen transform (centred letterbox)
      const sf = Math.min((w - 48) / cachedRWD.VW, (h - 48) / cachedRWD.VH)
      const ox = 24 + ((w - 48) - cachedRWD.VW * sf) / 2
      const oy = 24 + ((h - 48) - cachedRWD.VH * sf) / 2
      const V = (p) => [ox + (p[0] - 24) * sf, oy + (p[1] - 24) * sf]
      hcPos = new Map()
      for (const [id, p] of cachedRWD.posAfter) hcPos.set(id, V(p))
      rwdLines = cachedRWD.lines.map((L) => ({ ...L, px: L.pts.map(V) }))
      hcBlue = {
        xs: Array.from({ length: nC + 1 }, (_, i) => ox + i * (cachedRWD.VW / nC) * sf),
        ys: Array.from({ length: nR + 1 }, (_, i) => oy + i * (cachedRWD.VH / nR) * sf),
      }
    } else {
      hcPos = new Map()
      for (const [id, p] of cells) hcPos.set(id, cellPx(p))
      placeBlacks(cachedSkeleton, hcPos, (id) => grid.posAfter.get(id) ?? null)
      hcBlue = {
        xs: Array.from({ length: nC + 1 }, (_, i) => 24 + i * cw),
        ys: Array.from({ length: nR + 1 }, (_, i) => 24 + i * ch),
      }
    }
  }
  const posOf = (id) =>
    (hcPos && hcPos.get(id)) || (grid && gridPost.value && grid.posAfter.get(id)) || projById.get(id)
  const MAX_OVERLAP = 6, DASH = 5 // overlap interleaved-dash pattern (screen px)
  // 'black' = untouched through station → keep the normal white fill; only the
  // specially-marked nodes get a colour. All keep the dark border (set below).
  const NODE_COLOR = { red: '#e11d48', blue: '#2563eb', black: '#ffffff', purple: '#a855f7', pink: '#ec4899', gray: '#9ca3af', yellow: '#eab308' }
  // Edge-class colours are drawn as a BOTTOM HIGHLIGHT (underlay) — NOT the line
  // colour. The line itself is always the original metro-map rendering.
  const EDGE_HL = { coline: '#e11d48', loop: '#16a34a', parallel: '#2563eb' }
  const EDGE_LABEL = { coline: '共線合併', loop: '環線', parallel: '頭尾共點', plain: '一般' }

  let lineData, stationData, highlightData = []
  if (sk) {
    const edgeD = (pathIds) => pathIds
      .map((id, i) => { const [x, y] = posOf(id); return `${i ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}` })
      .join(' ')
    // Line = original metro-map drawing: single route → solid route colour,
    // overlap (≥2 routes) → interleaved route-colour dashes.
    const strokesOf = (e, d, html) => {
      const cols = (e.routeColors ?? []).slice(0, MAX_OVERLAP)
      if (cols.length >= 2) {
        const n = cols.length
        return cols.map((color, i) => ({
          d, stroke: color, html,
          dash: `0 ${i * DASH} ${DASH} ${(n - 1 - i) * DASH}`,
        }))
      }
      return [{ d, stroke: cols[0] ?? e.color ?? '#e11d48', html }]
    }
    if (rwdLines) {
      // RWD 路網: one polyline per cut-to-cut segment (H/V/45° legs), coloured
      // like its parent skeleton edge; the tooltip reports the bend count.
      const ptsD = (px) => px
        .map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`)
        .join(' ')
      lineData = rwdLines.flatMap((L) => {
        const e = L.seg.edge
        const html = `${EDGE_LABEL[e.cls]}（${e.routes.size} 線）· `
          + (L.fallback ? '兜底直線（非 H/V/45°）' : `轉折 ${L.bends}`)
          + (L.routed ? ' · A* 繞行（避開交叉）' : '')
          + (L.forced ? '<br/><span style="color:#f59e0b">殘留衝突：連 A* 繞行也找不到無交叉路徑</span>' : '')
        return strokesOf(e, ptsD(L.px), html)
      })
      // Residual-conflict segments glow amber so leftover crossings explain
      // themselves; otherwise the usual edge-class underlay.
      highlightData = rwdLines
        .filter((L) => L.forced || EDGE_HL[L.seg.edge.cls])
        .map((L) => ({ d: ptsD(L.px), color: L.forced ? '#f59e0b' : EDGE_HL[L.seg.edge.cls] }))
    } else {
      lineData = sk.edges.flatMap((e) =>
        strokesOf(e, edgeD(e.path), `${EDGE_LABEL[e.cls]}（${e.routes.size} 線）`))
      // Bottom highlight: one translucent underlay per classified edge.
      highlightData = sk.edges.filter((e) => EDGE_HL[e.cls]).map((e) => ({ d: edgeD(e.path), color: EDGE_HL[e.cls] }))
    }
    stationData = stations.map((f) => {
      const [x, y] = posOf(f.properties.station_id)
      return { x, y, props: f.properties, fill: NODE_COLOR[sk.stationClass.get(f.properties.station_id)] ?? '#ffffff' }
    })
    // synthetic yellow crossing nodes (not real stations)
    for (const c of sk.crossings ?? []) {
      const p = posOf(c.id)
      if (p) stationData.push({ x: p[0], y: p[1], props: { station_id: c.id, station_name: '路線交叉點' }, fill: NODE_COLOR.yellow })
    }
  } else {
    lineData = lineFeats.map((f) => ({ d: path(f), stroke: f.properties.route_color ?? '#e11d48', props: f.properties }))
    stationData = stations.map((f) => {
      const [x, y] = P(f.geometry.coordinates)
      return { x, y, props: f.properties, fill: stationColor(f.properties) }
    })
  }

  // Bottom-to-top: the blue schematic grid at the very bottom, then edge-class
  // highlight underlay, lines, pink reference lines (hover), and stations on top.
  const gridG = sel.append('g').attr('class', 'grid-layer').style('pointer-events', 'none')
  const highlightG = sel.append('g').attr('class', 'hl-layer')
  const linesG = sel.append('g').attr('class', 'lines-layer')
  const refG = sel.append('g').attr('class', 'ref-layer').style('pointer-events', 'none')
  const stationsG = sel.append('g').attr('class', 'stations-layer')

  // Schematic gridding: blue SEPARATOR lines (they run between cells — never
  // through a point) + integer cell coordinates centred in each band (column
  // indices along the bottom, row indices down the left).
  if (grid) {
    const b = hcBlue ?? (gridPost.value ? grid.blueAfter : grid.blueBefore)
    for (const x of b.xs) {
      gridG.append('line').attr('x1', x).attr('y1', 24).attr('x2', x).attr('y2', h - 24)
        .attr('stroke', '#3b82f6').attr('stroke-width', 0.7).attr('stroke-opacity', 0.55)
    }
    for (const y of b.ys) {
      gridG.append('line').attr('x1', 24).attr('y1', y).attr('x2', w - 24).attr('y2', y)
        .attr('stroke', '#3b82f6').attr('stroke-width', 0.7).attr('stroke-opacity', 0.55)
    }
    for (let c = 0; c < b.xs.length - 1; c++) {
      gridG.append('text').attr('class', 'grid-axis')
        .attr('x', (b.xs[c] + b.xs[c + 1]) / 2).attr('y', h - 10)
        .attr('text-anchor', 'middle').text(c)
    }
    for (let r = 0; r < b.ys.length - 1; r++) {
      gridG.append('text').attr('class', 'grid-axis')
        .attr('x', 12).attr('y', (b.ys[r] + b.ys[r + 1]) / 2)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'central').text(r)
    }
  }

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
      .attr('class', 'ref-foot')
      .attr('cx', P(info.foot)[0]).attr('cy', P(info.foot)[1])
      .attr('r', 2 / zk).attr('fill', '#ec4899')
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
      if (info) { if (!gridMode.value) drawRef(info); showTip(e, pinkHtml(d.props, info)) }
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

// Compact fitness numbers for the Hill Climbing stats readout.
const fmtFit = (x) => (x >= 10000 ? `${(x / 1000).toFixed(1)}k` : Math.round(x).toString())

watch(() => layer.value?.sourceLayerId, () => { cacheData = null; render() })
watch(mode, render)
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
  <div class="ma-tab">
    <div class="tab-body">
      <div class="map-col">
        <div class="ma-toolbar">
          <div class="view-tabs" role="tablist">
            <button
              v-for="t in VIEW_TABS"
              :key="t.id"
              class="view-tab"
              :class="{ active: mode === t.id }"
              role="tab"
              :aria-selected="mode === t.id"
              :disabled="!panelLayer || (t.rot && !canRotate)"
              :title="t.rot && !canRotate ? '網路已對齊正南北，無需旋轉' : ''"
              @click="mode = t.id"
            >{{ t.label }}</button>
          </div>

          <!-- Hill Climbing: multicriteria fitness before → after (lower = better) -->
          <span v-if="isHC && hcMode && hcStats" class="hc-stats">
            適應度 {{ fmtFit(hcStats.before) }} → {{ fmtFit(hcStats.after) }}
            · {{ hcStats.rounds }} 輪 · 移動 {{ hcStats.moved }} 站<template
              v-if="hcStats.clusterMoves"> · {{ hcStats.clusterMoves }} 群集</template><template
              v-if="hcCompact && hcCompactStats"> · 網格
              {{ hcCompactStats.fromCols }}×{{ hcCompactStats.fromRows }} →
              {{ hcCompactStats.cols }}×{{ hcCompactStats.rows }}</template>
          </span>

          <!-- RWD 路網: how each segment got routed (H/V/45° bend histogram) -->
          <span v-if="isRWD && rwdMode && rwdStats" class="hc-stats">
            {{ rwdStats.segs }} 段 · 直線 {{ rwdStats.straight }} · 單折 {{ rwdStats.single }}
            · 雙折 {{ rwdStats.double }}<template v-if="rwdStats.multi">
              · 多折 {{ rwdStats.multi }}</template><template v-if="rwdStats.rerouted">
              · 繞行 {{ rwdStats.rerouted }}</template><template v-if="rwdStats.swapped">
              · 順接調整 {{ rwdStats.swapped }}</template><template v-if="rwdStats.squeezed">
              · 窄縫 {{ rwdStats.squeezed }}</template><template v-if="rwdStats.fallback">
              · 兜底 {{ rwdStats.fallback }}</template><template v-if="rwdStats.forced">
              · 殘留衝突 {{ rwdStats.forced }}</template><template v-if="hcCompactStats"> · 網格
              {{ hcCompactStats.cols }}×{{ hcCompactStats.rows }}</template>
          </span>

          <span class="ma-label">資料來源：</span>
          <span class="ma-source">
            {{ ownData ? `${layer?.name}（匯入 JSON）`
              : isRWD ? (hcLayer ? `${hcLayer.name}（縮減網格）` : (layer?.sourceLayerId ?? '—'))
              : isHC ? (hcD3Layer ? `${hcD3Layer.name}（${hcVariant === 'rot' ? '旋轉' : '原始'}格網化後）` : (layer?.sourceLayerId ?? '—'))
              : (sourceLayer?.name ?? layer?.sourceLayerId ?? '—') }}
          </span>
        </div>

        <div ref="host" class="ma-canvas">
          <svg ref="svgEl" class="ma-svg" @click="panelLayer && store.setSelectedFeature(panelLayer.id, null)">
            <g ref="gEl" />
          </svg>
          <div ref="tipEl" class="ma-tip" />
          <div v-if="loading" class="ma-hint">載入中…</div>
          <div v-else-if="hcBusy" class="ma-hint">爬山最佳化中…（多準則適應度 + 硬規則掃描）</div>
          <div v-else-if="loadError" class="ma-hint error">{{ loadError }}</div>
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
.ma-tab {
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
.ma-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid hsl(var(--border));
  flex-shrink: 0;
}
.ma-label { font-size: 12.5px; color: hsl(var(--muted-foreground)); white-space: nowrap; margin-left: auto; }
/* Hill Climbing fitness readout (before → after, 越低越好) */
.hc-stats {
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ma-source { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 4 view tabs: 原始 / 旋轉 / 原始骨架化 / 旋轉骨架化 */
.view-tabs { display: inline-flex; gap: 4px; }
.view-tab {
  height: 26px;
  padding: 0 12px;
  font-size: 12.5px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
.view-tab:hover:not(:disabled) { background: hsl(var(--accent)); color: hsl(var(--foreground)); }
.view-tab.active {
  color: hsl(var(--primary));
  font-weight: 600;
  border-color: hsl(var(--primary) / 0.55);
  background: hsl(var(--primary) / 0.12);
}
.view-tab:disabled { opacity: 0.4; cursor: default; }
.ma-canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.ma-svg { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; }
.ma-svg:active { cursor: grabbing; }
.ma-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: hsl(var(--muted-foreground));
  pointer-events: none;
}
.ma-hint.error { color: hsl(var(--destructive)); }
/* Strokes stay a constant screen width regardless of the zoom transform, so
   lines/borders/reference lines never thicken when zooming (dot radius & label
   size are counter-scaled in JS). */
.ma-svg :deep(g path),
.ma-svg :deep(g line),
.ma-svg :deep(g circle) { vector-effect: non-scaling-stroke; }
.ma-svg :deep(text.grid-axis) { fill: #3b82f6; font-size: 9px; font-weight: 600; }
.ma-svg :deep(text.st-label) {
  font-size: 9px;
  fill: #e5e7eb;
  stroke: #111827;
  stroke-width: 2.4px;
  paint-order: stroke;
  stroke-linejoin: round;
}
.ma-tip {
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
