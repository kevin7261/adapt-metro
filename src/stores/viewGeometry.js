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

// 三個 computeCity* 的共用開場白：縮圖外框、站/線 feature、tilt、骨架、投影工廠。
function prepCity(geojson, opts) {
  const W = opts.W ?? 200
  const H = opts.H ?? 150
  const pad = opts.pad ?? 14
  const extPair = [[pad, pad], [W - pad, H - pad]]
  const extArr = [pad, pad, W - pad, H - pad]
  const stations = geojson.features.filter((f) => f.geometry?.type === 'Point')
  const lineFeats = geojson.features.filter((f) => f.geometry && f.geometry.type !== 'Point')
  const fitFC = { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : geojson.features }
  const tilt = computeOrientation(geojson).tilt
  const skeleton = buildConnectSkeleton(geojson)
  const projFor = (angle) => geoMercator().angle(angle).fitExtent(extPair, fitFC)
  return {
    W, H, pad, extPair, extArr, x0: pad, y0: pad, x1: W - pad, y1: H - pad,
    stations, lineFeats, fitFC, tilt, canRotate: Math.abs(tilt) >= 0.5, skeleton, projFor,
  }
}

// station（含黃色交叉點）的投影座標表：id → [x,y]。
function projByIdFor(projection, stations, skeleton) {
  const projById = new Map()
  for (const f of stations) {
    const p = projection(f.geometry.coordinates)
    if (p) projById.set(f.properties.station_id, p)
  }
  for (const c of skeleton.crossings ?? []) {
    const p = projection(c.coord)
    if (p) projById.set(c.id, p)
  }
  return projById
}

// Integer cell → pixel cell-centre + uniform blue separators (same as D3Tab)。
// HC / RWD 兩處共用（RWD 另需 cw/ch，一併回傳、HC 拿到多餘欄位無害）。
const cellMapperFor = (x0, y0, x1, y1) => (nC, nR) => {
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

// 整數 cell 佈局 → 像素座標表＋黑點沿新邊放回（HC/RWD 各階段共用）。
function cellsToPos(cellAfter, cellPx, skeleton, snap) {
  const pos = new Map()
  for (const [id, cell] of cellAfter) pos.set(id, cellPx(cell))
  placeBlacks(skeleton, pos, snap)
  return pos
}

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

// 格網化後 / Hill Climbing / 縮減網格 / RWD 底圖的線 = skeleton **拓撲邊** 在搬移後
// 座標上畫（edgeD），不是逐頂點吸原始 feature 幾何。原因：feature 幾何含該路線
// 「只通過、不停靠」的 pass 站（如機場快綫實體軌道經 東涌／欣澳），這些站被吸到自己
// 路線（東涌綫）的格子、遠離本線停靠鏈 → 逐頂點畫會把線拉去繞經它們，讓白色直通站
// （機場）落在折角（香港機場站轉折 bug）。skeleton 邊的 path 已排除 pass 站、黃色
// 交叉點是邊端點 → 邊路徑穿過交叉、直通站沿邊內插保持共線、不繞行。共線多色交錯依
// e.routeColors（strokesOf），與 RWD／原始一致。posOf = id → [x,y]|null。
function edgeLinesFromPos(skeleton, posOf) {
  const lines = []
  for (const e of skeleton.edges) {
    const parts = []
    for (const id of e.path) {
      const p = posOf(id)
      if (!p) continue
      parts.push(`${parts.length ? 'L' : 'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`)
    }
    if (parts.length < 2) continue
    const d = parts.join(' ')
    for (const s of strokesOf(e.routeColors, e.color, d)) lines.push(s)
  }
  return lines
}

// Draw a moved view (格網化後 / Hill Climbing / 縮減網格) from an explicit
// id→[x,y] position map: skeleton TOPOLOGY edges at those positions
// (edgeLinesFromPos — single colour / interleaved co-line dashes), NOT raw feature
// geometry (which detours through pass-through stations; see edgeLinesFromPos).
// Plus role-coloured station dots (+ yellow crossings). `sep` = optional blue grid
// separators. (`lineFeats` kept in the signature for call-site symmetry.)
function drawFromPos(skeleton, stations, lineFeats, posMap, sep) {
  const lines = edgeLinesFromPos(skeleton, (id) => posMap.get(id) ?? null)
  const hl = [] // 移動後視圖不畫邊分類襯底（維持原本行為，共線僅靠交錯虛線表示）
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
  const { W, H, extArr, stations, lineFeats, tilt, canRotate, skeleton, projFor } = prepCity(geojson, opts)
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
    const projById = projByIdFor(projection, stations, skeleton)
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
        // 格網化後：節點已搬到格子 → 用 skeleton 拓撲邊畫（edgeLinesFromPos），不是
        // 逐頂點吸 feature 幾何。feature 幾何含該路線 pass 站（如機場快綫過東涌），會被
        // 吸到別線格子、把線拉去繞經、讓白色直通站落在折角（香港機場站 bug）。拓撲邊
        // 已排除 pass 站，直通站沿邊內插保持共線。共線多色交錯依 e.routeColors 不變。
        const movedOf = (id) => (grid && post && grid.posAfter.get(id)) || null
        lines = edgeLinesFromPos(skeleton, movedOf)
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
  const { W, H, extArr, x0, y0, x1, y1, stations, lineFeats, tilt, canRotate, skeleton, projFor } = prepCity(geojson, opts)
  const cellMapper = cellMapperFor(x0, y0, x1, y1)

  const views = {}
  const stats = {}
  for (const variant of ['orig', 'rot']) {
    const angle = variant === 'rot' && canRotate ? tilt : 0
    const projection = projFor(angle)
    const projById = projByIdFor(projection, stations, skeleton)
    const grid = buildSchematicGrid(skeleton, projById, extArr)
    const snap = (id) => grid.posAfter.get(id) ?? null

    // 1) 格網化後 — the HC layer's input tab (= Map Adjust's grid-*-post).
    const postPos = new Map(projById)
    for (const [id, p] of grid.posAfter) postPos.set(id, p)
    views[`grid-${variant}-post`] = drawFromPos(skeleton, stations, lineFeats, postPos, grid.blueAfter)

    // 2) Hill Climbing — optimize the integer cells, map to pixel cell-centres.
    const hc = buildHillClimb(skeleton, grid.cellOf, grid.cols, grid.rows)
    const m1 = cellMapper(grid.cols, grid.rows)
    const hcPos = cellsToPos(hc.cellAfter, m1.cellPx, skeleton, snap)
    views[`hc-${variant}`] = drawFromPos(skeleton, stations, lineFeats, hcPos, m1.sep)

    // 3) Hill Climbing端點移動 — the chain's first step (同 D3Tab):
    // movewise（每一個移動後立即縮減網格）——網格因此比 HC 視圖小，用自己的
    // cellMapper。
    const endp = movewiseStage('endp', skeleton, hc.cellAfter, grid.cols, grid.rows)
    const mEndp = cellMapper(endp.cols, endp.rows)
    const endpPos = cellsToPos(endp.cellAfter, mEndp.cellPx, skeleton, snap)
    views[`endp-${variant}`] = drawFromPos(skeleton, stations, lineFeats, endpPos, mEndp.sep)
    // 4) 鏈尾 — 直線縮減＋網格合併（都是 movewise：每一個移動後立即縮減
    // 網格），即 端點移動 → 直線縮減 → 網格合併 的完整鏈結果。
    const lined = movewiseStage('line', skeleton, endp.cellAfter, endp.cols, endp.rows)
    const comp = movewiseStage('gather', skeleton, lined.cellAfter, lined.cols, lined.rows)
    const m2 = cellMapper(comp.cols, comp.rows)
    const compPos = cellsToPos(comp.cellAfter, m2.cellPx, skeleton, snap)
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
  const { W, H, extArr, x0, y0, x1, y1, stations, lineFeats, tilt, canRotate, skeleton, projFor } = prepCity(geojson, opts)
  const projection = projFor(0) // gallery = 原始 variant
  const projById = projByIdFor(projection, stations, skeleton)
  const grid = buildSchematicGrid(skeleton, projById, extArr)
  const snap = (id) => grid.posAfter.get(id) ?? null
  const hc = buildHillClimb(skeleton, grid.cellOf, grid.cols, grid.rows)
  // Topology segments (from the original grid cellOf), parallel/same-track merged
  // — positions come from each compact layout below.
  const segs = mergeParallelSegs(buildHcGraph(skeleton, grid.cellOf).segs)
  const cellMapper = cellMapperFor(x0, y0, x1, y1)
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
  return { W, H, tilt, canRotate, views }
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
