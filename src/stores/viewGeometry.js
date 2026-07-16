// Pure geometry for the 8 Map Adjust views, headless (Node + browser).
//
// Mirrors D3Tab.vue's render() computation exactly — same projection, same
// skeleton/gridding stores, same node/edge colours — but returns lightweight
// geometry ({lines, dots, hl, grid}) instead of drawing with d3-selection, so
// the thumbnails in the Map Adjust gallery match the live Map Adjust tab.
//
// The 8 views (ids match D3Tab's VIEW_TABS):
//   original, rotated, skeleton, rotated-skeleton,
//   grid-orig-pre, grid-orig-post, grid-rot-pre, grid-rot-post
//
// d3-geo runs in Node (no DOM); the extent is a plain [W,H] we pass in instead
// of measuring a container. Everything downstream is a pure store function.
import { geoMercator, geoPath } from 'd3-geo'
import { computeOrientation } from './orientation.js'
import { buildConnectSkeleton } from './skeleton.js'
import { buildSchematicGrid, placeBlacks } from './schematicGrid.js'
import {
  buildHillClimb, buildHcGraph, iteratePost,
  movewiseStage, buildRectPolish, buildAxisAlign, buildAxisIlp,
  straightenCompactLoop,
} from './hillClimb.js'
import { buildRwdMap, mergeParallelSegs } from './rwdMap.js'

// Same palettes as D3Tab.vue.
const NODE_COLOR = { red: '#e11d48', blue: '#2563eb', black: '#ffffff', purple: '#a855f7', pink: '#ec4899', gray: '#9ca3af', yellow: '#eab308' }
const EDGE_HL = { coline: '#e11d48', loop: '#16a34a', parallel: '#2563eb' }
const MAX_OVERLAP = 6
const DASH = 5

// Geographic (original/rotated) station fill — matches the MapLibre tab's
// STATION_COLOR and D3Tab.stationColor: interchange red, terminus blue, else
// white. 用 is_interchange（正式拓撲轉乘），不用 lines>1——後者把多線共軌的中途站
// （非轉乘）也誤判成紅（NYC 尤甚）。
function stationColor(p) {
  if (p.is_interchange) return '#e11d48'
  if (p.is_terminus) return '#2563eb'
  return '#ffffff'
}

// Single colour → solid; overlap (≥2 DISTINCT colours) → interleaved dashes.
// Distinct-colour test (not route count) matches the skeleton's coline rule.
function strokesOf(routeColors, color, d) {
  const cols = (routeColors ?? []).slice(0, MAX_OVERLAP)
  if (new Set(cols).size >= 2) {
    const n = cols.length
    return cols.map((c, i) => ({ d, color: c, dash: `0 ${i * DASH} ${DASH} ${(n - 1 - i) * DASH}` }))
  }
  return [{ d, color: cols[0] ?? color ?? '#e11d48' }]
}

const coordKey = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`

// A line feature's polyline `d` at MOVED positions: map each station vertex via
// movedOf, and splice in any yellow crossing lying on a station→station segment.
// Features don't carry the synthetic crossing vertices, so without this the
// crossing's grid/HC cell is skipped and its yellow node floats off the line /
// the two routes stop meeting there. Non-station vertices (real track bends) have
// no cell → dropped (grid is schematic anyway).
function movedFeatD(f, coordId, movedOf, crossPts) {
  const crossOnSeg = (A, B) => {
    if (!crossPts.length) return []
    const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy
    if (L2 < 1e-18) return []
    const out = []
    for (const c of crossPts) {
      const ex = c.coord[0] - A[0], ey = c.coord[1] - A[1]
      if (Math.abs(dx * ey - dy * ex) > 1e-8) continue
      const t = (ex * dx + ey * dy) / L2
      if (t > 1e-3 && t < 1 - 1e-3) out.push({ t, id: c.id })
    }
    return out.sort((p, q) => p.t - q.t)
  }
  const segs = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]
  const parts = []
  for (const seg of segs) {
    let started = false, prevC = null
    for (const c of seg) {
      const id = coordId.get(coordKey(c))
      const p = id != null ? movedOf(id) : null
      if (!p) continue
      if (prevC) for (const x of crossOnSeg(prevC, c)) {
        const xp = movedOf(x.id)
        if (xp) parts.push(`L ${xp[0].toFixed(2)} ${xp[1].toFixed(2)}`)
      }
      parts.push(`${started ? 'L' : 'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`); started = true
      prevC = c
    }
  }
  return parts.join(' ')
}

// Draw a view from an explicit id→[x,y] position map: the SAME line features as
// the original/geographic drawing (single colour / interleaved co-line dashes),
// only with each vertex's station re-placed via posMap — so a moved view (格網化
// 後 / Hill Climbing) is the original network snapped to those positions, colours
// and co-line merging identical. Plus role-coloured station dots (+ yellow
// crossings). `sep` = optional blue grid separators.
function drawFromPos(skeleton, stations, lineFeats, posMap, sep) {
  const coordId = new Map()
  for (const f of stations) coordId.set(coordKey(f.geometry.coordinates), f.properties.station_id)
  const crossPts = skeleton.crossings ?? []
  const lines = []
  const hl = []
  for (const f of lineFeats) {
    const d = movedFeatD(f, coordId, (id) => posMap.get(id) ?? null, crossPts)
    if (d) for (const s of strokesOf(f.properties?.route_colors, null, d)) lines.push(s)
  }
  const dots = []
  for (const f of stations) {
    const p = posMap.get(f.properties.station_id)
    if (!p) continue
    dots.push({ x: +p[0].toFixed(1), y: +p[1].toFixed(1), fill: NODE_COLOR[skeleton.stationClass.get(f.properties.station_id)] ?? '#ffffff' })
  }
  for (const c of skeleton.crossings ?? []) {
    const p = posMap.get(c.id)
    if (!p) continue
    dots.push({ x: +p[0].toFixed(1), y: +p[1].toFixed(1), fill: NODE_COLOR.yellow })
  }
  const out = { lines, hl, dots }
  if (sep) out.grid = { xs: sep.xs.map((v) => +v.toFixed(1)), ys: sep.ys.map((v) => +v.toFixed(1)) }
  return out
}

/**
 * Compute all 8 Map Adjust views for one city's GeoJSON.
 * @param {object} geojson - a city system FeatureCollection
 * @param {object} [opts] - { W, H, pad } thumbnail extent (pixels)
 * @returns {{ W, H, tilt, canRotate, views: Record<string, object> }}
 */
export function computeCityViews(geojson, opts = {}) {
  const W = opts.W ?? 200
  const H = opts.H ?? 150
  const pad = opts.pad ?? 14
  const extPair = [[pad, pad], [W - pad, H - pad]]
  const extArr = [pad, pad, W - pad, H - pad]

  const stations = geojson.features.filter((f) => f.geometry?.type === 'Point')
  const lineFeats = geojson.features.filter((f) => f.geometry && f.geometry.type !== 'Point')
  const fitFC = { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : geojson.features }

  const tilt = computeOrientation(geojson).tilt
  const canRotate = Math.abs(tilt) >= 0.5
  const skeleton = buildConnectSkeleton(geojson)

  const projFor = (angle) => geoMercator().angle(angle).fitExtent(extPair, fitFC)

  const round = (p) => [+p[0].toFixed(1), +p[1].toFixed(1)]

  // Feature-geometry lines = the ORIGINAL metro-map drawing (single route = solid
  // colour, overlap = interleaved dashes). Shared by the geographic view AND every
  // view whose nodes stay at geographic positions (骨架 / 格網化前) — those must
  // look EXACTLY like 原始, so they draw the real folded polyline `path(f)`, never
  // station-point edges (which straighten express skips into chords across empty
  // space). Mirrors D3Tab.vue.
  const featureLines = (projection) => {
    const path = geoPath(projection)
    const out = []
    for (const f of lineFeats) {
      const d = path(f)
      if (d) for (const s of strokesOf(f.properties?.route_colors, null, d)) out.push(s)
    }
    return out
  }
  // 格網化後 draws the SAME features, only with each vertex's STATION re-placed
  // onto its grid cell (movedOf) — so 後 = 前 pixel-for-pixel, just snapped. Yellow
  // crossings on a station segment are spliced in (movedFeatD) so they don't float.
  const coordId = new Map()
  for (const f of stations) coordId.set(coordKey(f.geometry.coordinates), f.properties.station_id)
  const crossPts = skeleton.crossings ?? []
  const movedFeatureLines = (movedOf) => {
    const out = []
    for (const f of lineFeats) {
      const d = movedFeatD(f, coordId, movedOf, crossPts)
      if (d) for (const s of strokesOf(f.properties?.route_colors, null, d)) out.push(s)
    }
    return out
  }
  // Edge-class underlay along each edge's REAL folded geometry (e.geom) — hugs the
  // line's curve instead of straightening skips. Geographic views only.
  const geomHl = (projection) => {
    const out = []
    for (const e of skeleton.edges) {
      if (!EDGE_HL[e.cls] || !(e.geom?.length >= 2)) continue
      const parts = []
      e.geom.forEach((c, i) => { const p = projection(c); if (p) parts.push(`${i ? 'L' : 'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`) })
      if (parts.length >= 2) out.push({ d: parts.join(' '), color: EDGE_HL[e.cls] })
    }
    return out
  }

  // --- Geographic view (original metro-map drawing) ---
  function geoView(angle) {
    const projection = projFor(angle)
    const lines = featureLines(projection)
    const dots = []
    for (const f of stations) {
      const p = projection(f.geometry.coordinates)
      if (p) { const [x, y] = round(p); dots.push({ x, y, fill: stationColor(f.properties ?? {}) }) }
    }
    return { lines, dots }
  }

  // --- Skeleton + gridding bundle for one angle (pre + post share one grid) ---
  function skeletonBundle(angle, withGrid) {
    const projection = projFor(angle)
    const projById = new Map()
    for (const f of stations) {
      const p = projection(f.geometry.coordinates)
      if (p) projById.set(f.properties.station_id, p)
    }
    for (const c of skeleton.crossings ?? []) {
      const p = projection(c.coord)
      if (p) projById.set(c.id, p)
    }
    const grid = withGrid ? buildSchematicGrid(skeleton, projById, extArr) : null

    const buildAt = (post, sep) => {
      const geographic = !(grid && post) // nodes still at projById (骨架 / 格網化前)
      const posOf = (id) => (grid && post && grid.posAfter.get(id)) || projById.get(id)
      let lines, hl
      if (geographic) {
        // 骨架 / 格網化前 = 原始一模一樣的線（feature 幾何）＋沿 e.geom 的邊分類襯底。
        lines = featureLines(projection)
        hl = geomHl(projection)
      } else {
        // 格網化後 ＝ 跟格網化前畫**完全一樣的 feature**（同色、共線交錯），只是每個
        // 頂點的車站改對應到格子座標 → 後＝前的同一張圖、只搬到格子上。不再用骨架拓撲
        // 邊 edgeD（那會讓共線交錯樣式/合併方式跟前不同）。
        const movedOf = (id) => (grid && post && grid.posAfter.get(id)) || null
        lines = movedFeatureLines(movedOf)
        hl = []
      }
      const dots = []
      for (const f of stations) {
        const p = posOf(f.properties.station_id)
        if (!p) continue
        const [x, y] = round(p)
        dots.push({ x, y, fill: NODE_COLOR[skeleton.stationClass.get(f.properties.station_id)] ?? '#ffffff' })
      }
      for (const c of skeleton.crossings ?? []) {
        const p = posOf(c.id)
        if (!p) continue
        const [x, y] = round(p)
        dots.push({ x, y, fill: NODE_COLOR.yellow })
      }
      const out = { lines, hl, dots }
      if (sep) out.grid = { xs: sep.xs.map((v) => +v.toFixed(1)), ys: sep.ys.map((v) => +v.toFixed(1)) }
      return out
    }

    if (!withGrid) return { plain: buildAt(false, null) }
    return { pre: buildAt(false, grid.blueBefore), post: buildAt(true, grid.blueAfter) }
  }

  const skOrig = skeletonBundle(0, false)
  const skRot = skeletonBundle(canRotate ? tilt : 0, false)
  const gridOrig = skeletonBundle(0, true)
  const gridRot = skeletonBundle(canRotate ? tilt : 0, true)

  return {
    W,
    H,
    tilt,
    canRotate,
    views: {
      original: geoView(0),
      rotated: geoView(canRotate ? tilt : 0),
      skeleton: skOrig.plain,
      'rotated-skeleton': skRot.plain,
      'grid-orig-pre': gridOrig.pre,
      'grid-orig-post': gridOrig.post,
      'grid-rot-pre': gridRot.pre,
      'grid-rot-post': gridRot.post,
    },
  }
}

// View id → 中文 label (the caption under each thumbnail). N° filled per city.
export function viewLabels(tilt) {
  const rot = `旋轉 ${Math.abs(tilt).toFixed(0)}°`
  return {
    original: '原始',
    rotated: rot,
    skeleton: '原始骨架化',
    'rotated-skeleton': `${rot}骨架化`,
    'grid-orig-pre': '原始格網化前',
    'grid-orig-post': '原始格網化後',
    'grid-rot-pre': `${rot}格網化前`,
    'grid-rot-post': `${rot}格網化後`,
  }
}

// Canonical order of the 8 views (matches D3Tab's VIEW_TABS).
export const VIEW_ORDER = [
  'original', 'rotated', 'skeleton', 'rotated-skeleton',
  'grid-orig-pre', 'grid-orig-post', 'grid-rot-pre', 'grid-rot-post',
]

/**
 * Compute the 8 Hill Climbing views for one city — the 4 HC-layer tabs
 * (格網化後 input → Hill Climbing → Hill Climbing端點移動 → Hill Climbing縮減網格)
 * for both variants (orig / rot). Mirrors D3Tab's hill-climbing chain:
 * schematic gridding → buildHillClimb on the integer cells → movewise
 * 端點移動 → 直線縮減 → 網格合併（每一個移動後都立即縮減網格——縮減不再是
 * 獨立步驟），mapping cells to pixel cell-centres and re-spreading black
 * through-stations (placeBlacks) each stage.
 * @returns {{ W, H, tilt, canRotate, views, stats }}
 */
export function computeCityHcViews(geojson, opts = {}) {
  const W = opts.W ?? 200
  const H = opts.H ?? 150
  const pad = opts.pad ?? 14
  const extPair = [[pad, pad], [W - pad, H - pad]]
  const extArr = [pad, pad, W - pad, H - pad]
  const x0 = pad, y0 = pad, x1 = W - pad, y1 = H - pad

  const stations = geojson.features.filter((f) => f.geometry?.type === 'Point')
  const lineFeats = geojson.features.filter((f) => f.geometry && f.geometry.type !== 'Point')
  const fitFC = { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : geojson.features }

  const tilt = computeOrientation(geojson).tilt
  const canRotate = Math.abs(tilt) >= 0.5
  const skeleton = buildConnectSkeleton(geojson)
  const projFor = (angle) => geoMercator().angle(angle).fitExtent(extPair, fitFC)

  // Integer cell → pixel cell-centre + uniform blue separators (same as D3Tab).
  const cellMapper = (nC, nR) => {
    const cw = (x1 - x0) / nC
    const ch = (y1 - y0) / nR
    return {
      cellPx: ([c, r]) => [x0 + (c + 0.5) * cw, y0 + (r + 0.5) * ch],
      sep: {
        xs: Array.from({ length: nC + 1 }, (_, i) => x0 + i * cw),
        ys: Array.from({ length: nR + 1 }, (_, i) => y0 + i * ch),
      },
    }
  }

  const views = {}
  const stats = {}
  for (const variant of ['orig', 'rot']) {
    const angle = variant === 'rot' && canRotate ? tilt : 0
    const projection = projFor(angle)
    const projById = new Map()
    for (const f of stations) {
      const p = projection(f.geometry.coordinates)
      if (p) projById.set(f.properties.station_id, p)
    }
    for (const c of skeleton.crossings ?? []) {
      const p = projection(c.coord)
      if (p) projById.set(c.id, p)
    }
    const grid = buildSchematicGrid(skeleton, projById, extArr)
    const snap = (id) => grid.posAfter.get(id) ?? null

    // 1) 格網化後 — the HC layer's input tab (= Map Adjust's grid-*-post).
    const postPos = new Map(projById)
    for (const [id, p] of grid.posAfter) postPos.set(id, p)
    views[`grid-${variant}-post`] = drawFromPos(skeleton, stations, lineFeats, postPos, grid.blueAfter)

    // 2) Hill Climbing — optimize the integer cells, map to pixel cell-centres.
    const hc = buildHillClimb(skeleton, grid.cellOf, grid.cols, grid.rows)
    const m1 = cellMapper(grid.cols, grid.rows)
    const hcPos = new Map()
    for (const [id, cell] of hc.cellAfter) hcPos.set(id, m1.cellPx(cell))
    placeBlacks(skeleton, hcPos, snap)
    views[`hc-${variant}`] = drawFromPos(skeleton, stations, lineFeats, hcPos, m1.sep)

    // 3) Hill Climbing端點移動 — the chain's first step (同 D3Tab):
    // movewise（每一個移動後立即縮減網格）——網格因此比 HC 視圖小，用自己的
    // cellMapper。
    const endp = movewiseStage('endp', skeleton, hc.cellAfter, grid.cols, grid.rows)
    const mEndp = cellMapper(endp.cols, endp.rows)
    const endpPos = new Map()
    for (const [id, cell] of endp.cellAfter) endpPos.set(id, mEndp.cellPx(cell))
    placeBlacks(skeleton, endpPos, snap)
    views[`endp-${variant}`] = drawFromPos(skeleton, stations, lineFeats, endpPos, mEndp.sep)
    // 4) 鏈尾 — 直線縮減＋網格合併（都是 movewise：每一個移動後立即縮減
    // 網格），即 端點移動 → 直線縮減 → 網格合併 的完整鏈結果。
    const lined = movewiseStage('line', skeleton, endp.cellAfter, endp.cols, endp.rows)
    const comp = movewiseStage('gather', skeleton, lined.cellAfter, lined.cols, lined.rows)
    const m2 = cellMapper(comp.cols, comp.rows)
    const compPos = new Map()
    for (const [id, cell] of comp.cellAfter) compPos.set(id, m2.cellPx(cell))
    placeBlacks(skeleton, compPos, snap)
    views[`compact-${variant}`] = drawFromPos(skeleton, stations, lineFeats, compPos, m2.sep)

    stats[variant] = {
      before: +(hc.stats?.before ?? 0).toFixed(1),
      after: +(hc.stats?.after ?? 0).toFixed(1),
      rounds: hc.stats?.rounds ?? 0,
      moved: hc.stats?.moved ?? 0,
      fromCols: grid.cols,
      fromRows: grid.rows,
      cols: comp.cols,
      rows: comp.rows,
    }
  }

  return { W, H, tilt, canRotate, views, stats }
}

// The 8 Hill Climbing views, in display order: variant (原始/旋轉) × stage.
export const HC_VIEW_ORDER = [
  'grid-orig-post', 'hc-orig', 'endp-orig', 'compact-orig',
  'grid-rot-post', 'hc-rot', 'endp-rot', 'compact-rot',
]

// View id → 中文 caption for the HC gallery. N° filled per city.
export function hcViewLabels(tilt) {
  const rot = `旋轉 ${Math.abs(tilt).toFixed(0)}°`
  return {
    'grid-orig-post': '原始 · 格網化後',
    'hc-orig': '原始 · Hill Climbing',
    'endp-orig': '原始 · Hill Climbing端點移動',
    'compact-orig': '原始 · 直線縮減＋網格合併',
    'grid-rot-post': `${rot} · 格網化後`,
    'hc-rot': `${rot} · Hill Climbing`,
    'endp-rot': `${rot} · Hill Climbing端點移動`,
    'compact-rot': `${rot} · 直線縮減＋網格合併`,
  }
}

// ---- RWD Maps gallery: 4 縮減網格變體 × (縮減網格 | RWD 路網) = 8 views ----
// The polyline `pts` (pixel) of one routed segment → an SVG path string.
function rwdPtsD(pts) {
  return pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ')
}

// Serialize one RWD result (buildRwdMap output) like drawFromPos: interleaved
// co-line strokes per routed segment, edge-class / residual-conflict highlight
// underlay, and role-coloured station dots re-placed onto the polylines
// (posAfter). Mirrors D3Tab.vue's RWD branch.
function drawRwd(skeleton, stations, rwd, sep) {
  const lines = []
  const hl = []
  for (const L of rwd.lines) {
    const e = L.seg.edge
    const d = rwdPtsD(L.pts)
    for (const s of strokesOf(e.routeColors, e.color, d)) lines.push(s)
    if (L.forced) hl.push({ d, color: '#f59e0b' })
    else if (EDGE_HL[e.cls]) hl.push({ d, color: EDGE_HL[e.cls] })
  }
  const dots = []
  for (const f of stations) {
    const p = rwd.posAfter.get(f.properties.station_id)
    if (!p) continue
    dots.push({ x: +p[0].toFixed(1), y: +p[1].toFixed(1), fill: NODE_COLOR[skeleton.stationClass.get(f.properties.station_id)] ?? '#ffffff' })
  }
  for (const c of skeleton.crossings ?? []) {
    const p = rwd.posAfter.get(c.id)
    if (!p) continue
    dots.push({ x: +p[0].toFixed(1), y: +p[1].toFixed(1), fill: NODE_COLOR.yellow })
  }
  const out = { lines, hl, dots }
  if (sep) out.grid = { xs: sep.xs.map((v) => +v.toFixed(1)), ys: sep.ys.map((v) => +v.toFixed(1)) }
  return out
}

// Compute the 8 RWD Maps gallery views for one city (原始 variant): each of the
// four 縮減網格 sources (基本 / 直角爬山 / 軸對齊 / 整數規劃) as both the compact
// grid AND its RWD 路網 redraw. Same pure stores the live RWD tab uses.
export function computeCityRwdViews(geojson, opts = {}) {
  const W = opts.W ?? 200
  const H = opts.H ?? 150
  const pad = opts.pad ?? 14
  const extPair = [[pad, pad], [W - pad, H - pad]]
  const extArr = [pad, pad, W - pad, H - pad]
  const x0 = pad, y0 = pad, x1 = W - pad, y1 = H - pad

  const stations = geojson.features.filter((f) => f.geometry?.type === 'Point')
  const lineFeats = geojson.features.filter((f) => f.geometry && f.geometry.type !== 'Point')
  const fitFC = { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : geojson.features }

  const tilt = computeOrientation(geojson).tilt
  const skeleton = buildConnectSkeleton(geojson)
  const projection = geoMercator().angle(0).fitExtent(extPair, fitFC) // gallery = 原始 variant
  const projById = new Map()
  for (const f of stations) { const p = projection(f.geometry.coordinates); if (p) projById.set(f.properties.station_id, p) }
  for (const c of skeleton.crossings ?? []) { const p = projection(c.coord); if (p) projById.set(c.id, p) }
  const grid = buildSchematicGrid(skeleton, projById, extArr)
  const snap = (id) => grid.posAfter.get(id) ?? null
  const hc = buildHillClimb(skeleton, grid.cellOf, grid.cols, grid.rows)
  // Topology segments (from the original grid cellOf), parallel/same-track merged
  // — positions come from each compact layout below.
  const segs = mergeParallelSegs(buildHcGraph(skeleton, grid.cellOf).segs)
  const cellMapper = (nC, nR) => {
    const cw = (x1 - x0) / nC, ch = (y1 - y0) / nR
    return {
      cw, ch,
      cellPx: ([c, r]) => [x0 + (c + 0.5) * cw, y0 + (r + 0.5) * ch],
      sep: {
        xs: Array.from({ length: nC + 1 }, (_, i) => x0 + i * cw),
        ys: Array.from({ length: nR + 1 }, (_, i) => y0 + i * ch),
      },
    }
  }
  const POST = { hc: null, rect: buildRectPolish, align: buildAxisAlign, ilp: buildAxisIlp }
  const views = {}
  for (const kind of ['hc', 'rect', 'align', 'ilp']) {
    // 每條鏈（同 D3Tab 的 RWD）：該鏈結果 → 端點移動＋直線縮減＋網格合併＋縮減網格
    // **循環到不動點**（straightenCompactLoop——使用者 2026-07 裁決 RWD 要選
    // 端+直+中+縮 循環的那個結果，不是單趟鏈）。
    const base = POST[kind]
      ? iteratePost(POST[kind], skeleton, hc.cellAfter, grid.cols, grid.rows).cellAfter
      : hc.cellAfter
    const comp = straightenCompactLoop(skeleton, base, grid.cols, grid.rows)
    const m = cellMapper(comp.cols, comp.rows)
    // 縮減網格: original network snapped to the compact cells (per-feature).
    const compPos = new Map()
    for (const [id, cell] of comp.cellAfter) compPos.set(id, m.cellPx(cell))
    placeBlacks(skeleton, compPos, snap)
    views[`compact-${kind}`] = drawFromPos(skeleton, stations, lineFeats, compPos, m.sep)
    // RWD 路網: strict H/V/45° redraw of that compact layout.
    const pxPos = new Map()
    for (const [id, cell] of comp.cellAfter) pxPos.set(id, m.cellPx(cell))
    const rwd = buildRwdMap(segs, pxPos, {
      unit: Math.min(m.cw, m.ch),
      lattice: { x0, y0, sx: m.cw / 2, sy: m.ch / 2, nx: comp.cols * 2 + 1, ny: comp.rows * 2 + 1 },
    })
    views[`rwd-${kind}`] = drawRwd(skeleton, stations, rwd, m.sep)
  }
  return { W, H, tilt, canRotate: Math.abs(tilt) >= 0.5, views }
}

// The 8 RWD gallery views, in display order: 縮減網格 | RWD 路網 per compact source.
export const RWD_VIEW_ORDER = [
  'compact-hc', 'rwd-hc',
  'compact-rect', 'rwd-rect',
  'compact-align', 'rwd-align',
  'compact-ilp', 'rwd-ilp',
]

// View id → 中文 caption for the RWD gallery.
export const RWD_VIEW_LABELS = {
  'compact-hc': 'Hill Climbing循環縮減網格',
  'rwd-hc': 'Hill Climbing循環縮減網格 · RWD 路網',
  'compact-rect': '直角爬山循環縮減網格',
  'rwd-rect': '直角爬山循環縮減網格 · RWD 路網',
  'compact-align': '軸對齊循環縮減網格',
  'rwd-align': '軸對齊循環縮減網格 · RWD 路網',
  'compact-ilp': '整數規劃循環縮減網格',
  'rwd-ilp': '整數規劃循環縮減網格 · RWD 路網',
}
// The compact source a gallery cell maps to ('hc'|'rect'|'align'|'ilp').
export const rwdCellCompact = (viewId) => (viewId ?? '').replace(/^(compact|rwd)-/, '') || 'hc'
