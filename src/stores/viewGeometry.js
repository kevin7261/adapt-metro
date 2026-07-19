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
  buildRectPolish, buildAxisAlign, buildAxisIlp,
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

// 河流站點沒有白點（使用者）：骨架視圖只在分類為顯著點時畫（黑/灰不畫）；原始視圖一律不畫。
const riverDotVisible = (f, skeleton) => {
  if (!f.properties?.river) return true
  const c = skeleton?.stationClass?.get(f.properties.station_id)
  return !!c && c !== 'black' && c !== 'gray'
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
    for (const s of strokesOf(e.renderColors ?? e.routeColors, e.color, d)) lines.push(s)
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
    if (!riverDotVisible(f, skeleton)) continue // 河流無白點
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
      if (f.properties?.river) continue // 河流站點原始視圖不畫（河流沒有站圈）
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
        if (!riverDotVisible(f, skeleton)) continue // 河流無白點
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

/**
 * Compute the 12 Straighten（Hill Climbing）視圖畫廊 views for one city（使用者
 * 2026-07：原始＋旋轉 兩個 variant × 每 variant 6 個階段）。每 variant：
 *   1) 格網化後 — hillclimbing 的輸入佈局（= Map Adjust 的 grid-*-post）。
 *   2) Hill Climbing — 整數格多準則最佳化後。
 *   3–6) 4 個循環結果 — 每條鏈（基本 hc / 直角爬山 rect / 軸對齊 align /
 *        整數規劃 ilp）以 hc 結果為基底，先跑該鏈的後處理（rect/align/ilp
 *        迭代到不動點；hc 不做），再 straightenCompactLoop（端點移動＋直線縮減
 *        ＋網格合併循環到不動點，同 RWD 畫廊的 compact-{kind}）。
 * 旋轉 variant 用 canRotate ? tilt : 0 的投影（不可旋轉城市＝與原始相同）；
 * 黑點沿新段用 placeBlacks 放回（cellsToPos 內含）。
 * @returns {{ W, H, tilt, canRotate, views, stats }}
 */
export function computeCityHcViews(geojson, opts = {}) {
  const { W, H, extArr, x0, y0, x1, y1, stations, lineFeats, tilt, canRotate, skeleton, projFor } = prepCity(geojson, opts)
  const cellMapper = cellMapperFor(x0, y0, x1, y1)
  const POST = { hc: null, rect: buildRectPolish, align: buildAxisAlign, ilp: buildAxisIlp }

  const views = {}
  const stats = {}
  for (const variant of ['orig', 'rot']) {
    const angle = variant === 'rot' && canRotate ? tilt : 0
    const projection = projFor(angle)
    const projById = projByIdFor(projection, stations, skeleton)
    const grid = buildSchematicGrid(skeleton, projById, extArr)
    const snap = (id) => grid.posAfter.get(id) ?? null

    // 1) 格網化後 — the hillclimbing input（= Map Adjust's grid-*-post）.
    const postPos = new Map(projById)
    for (const [id, p] of grid.posAfter) postPos.set(id, p)
    views[`grid-post-${variant}`] = drawFromPos(skeleton, stations, lineFeats, postPos, grid.blueAfter)

    // 2) Hill Climbing — optimize the integer cells, map to pixel cell-centres.
    const hc = buildHillClimb(skeleton, grid.cellOf, grid.cols, grid.rows)
    const m1 = cellMapper(grid.cols, grid.rows)
    const hcPos = cellsToPos(hc.cellAfter, m1.cellPx, skeleton, snap)
    views[`hc-${variant}`] = drawFromPos(skeleton, stations, lineFeats, hcPos, m1.sep)
    stats[`hc-${variant}`] = { before: +(hc.stats?.before ?? 0).toFixed(1), after: +(hc.stats?.after ?? 0).toFixed(1) }

    // 3–6) 四個循環結果 — 每鏈 → 後處理（不動點）→ straightenCompactLoop（不動點）.
    for (const kind of ['hc', 'rect', 'align', 'ilp']) {
      const base = POST[kind]
        ? iteratePost(POST[kind], skeleton, hc.cellAfter, grid.cols, grid.rows).cellAfter
        : hc.cellAfter
      const comp = straightenCompactLoop(skeleton, base, grid.cols, grid.rows)
      const m = cellMapper(comp.cols, comp.rows)
      const compPos = cellsToPos(comp.cellAfter, m.cellPx, skeleton, snap)
      views[`loop-${kind}-${variant}`] = drawFromPos(skeleton, stations, lineFeats, compPos, m.sep)
      stats[`loop-${kind}-${variant}`] = { cols: comp.cols, rows: comp.rows }
    }
  }

  return { W, H, tilt, canRotate, views, stats }
}

// 視圖畫廊顯示順序（12 個）：原始 6（格網化後→Hill Climbing→4 循環）＋ 旋轉 6.
export const HC_VIEW_ORDER = [
  'grid-post-orig', 'hc-orig', 'loop-hc-orig', 'loop-rect-orig', 'loop-align-orig', 'loop-ilp-orig',
  'grid-post-rot', 'hc-rot', 'loop-hc-rot', 'loop-rect-rot', 'loop-align-rot', 'loop-ilp-rot',
]

// View id → 中文 caption for the HC 視圖畫廊（旋轉 variant 標「旋轉 N°」）.
export function hcViewLabels(tilt) {
  const rot = `旋轉 ${Math.abs(tilt).toFixed(0)}°`
  return {
    'grid-post-orig': '原始 · 格網化後',
    'hc-orig': '原始 · Hill Climbing',
    'loop-hc-orig': '原始 · Hill Climbing循環',
    'loop-rect-orig': '原始 · 直角爬山循環',
    'loop-align-orig': '原始 · 軸對齊循環',
    'loop-ilp-orig': '原始 · 整數規劃循環',
    'grid-post-rot': `${rot} · 格網化後`,
    'hc-rot': `${rot} · Hill Climbing`,
    'loop-hc-rot': `${rot} · Hill Climbing循環`,
    'loop-rect-rot': `${rot} · 直角爬山循環`,
    'loop-align-rot': `${rot} · 軸對齊循環`,
    'loop-ilp-rot': `${rot} · 整數規劃循環`,
    // LLM 對齊循環無離線預算（同 RWD 的 rwd-llm-*）——視圖畫廊顯示「尚未預算」，
    // 但仍需 caption；點擊即時計算。
    'loop-llm-orig': '原始 · LLM對齊循環',
    'loop-llm-rot': `${rot} · LLM對齊循環`,
  }
}

// The loop chain a Straighten gallery cell maps to ('rect'|'align'|'ilp'|'llm')；
// 剝掉 loop- 前綴與 -orig/-rot variant 後綴（同 rwdCellCompact 對 compact-/rwd-）。
export const loopCellCompact = (viewId) =>
  (viewId ?? '').replace(/^loop-/, '').replace(/-(orig|rot)$/, '') || 'rect'

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
    for (const s of strokesOf(e.renderColors ?? e.routeColors, e.color, d)) lines.push(s)
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

// Compute the 16 RWD Maps gallery views for one city（原始＋旋轉 兩 variant）：
// each variant × four 縮減網格 sources (基本 / 直角爬山 / 軸對齊 / 整數規劃) as
// both the compact grid AND its RWD 路網 redraw. Same pure stores the live RWD
// tab uses. 旋轉 variant 用 canRotate ? tilt : 0 的投影（不可旋轉城市＝與原始相同）。
export function computeCityRwdViews(geojson, opts = {}) {
  const { W, H, extArr, x0, y0, x1, y1, stations, lineFeats, tilt, canRotate, skeleton, projFor } = prepCity(geojson, opts)
  const cellMapper = cellMapperFor(x0, y0, x1, y1)
  const POST = { hc: null, rect: buildRectPolish, align: buildAxisAlign, ilp: buildAxisIlp }
  const views = {}
  for (const variant of ['orig', 'rot']) {
    const angle = variant === 'rot' && canRotate ? tilt : 0
    const projection = projFor(angle)
    const projById = projByIdFor(projection, stations, skeleton)
    const grid = buildSchematicGrid(skeleton, projById, extArr)
    const snap = (id) => grid.posAfter.get(id) ?? null
    const hc = buildHillClimb(skeleton, grid.cellOf, grid.cols, grid.rows)
    // Topology segments (from the original grid cellOf), parallel/same-track merged
    // — positions come from each compact layout below.
    const segs = mergeParallelSegs(buildHcGraph(skeleton, grid.cellOf).segs)
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
      views[`compact-${kind}-${variant}`] = drawFromPos(skeleton, stations, lineFeats, compPos, m.sep)
      // RWD 路網: strict H/V/45° redraw of that compact layout.
      const pxPos = new Map()
      for (const [id, cell] of comp.cellAfter) pxPos.set(id, m.cellPx(cell))
      const rwd = buildRwdMap(segs, pxPos, {
        unit: Math.min(m.cw, m.ch),
        lattice: { x0, y0, sx: m.cw / 2, sy: m.ch / 2, nx: comp.cols * 2 + 1, ny: comp.rows * 2 + 1 },
      })
      views[`rwd-${kind}-${variant}`] = drawRwd(skeleton, stations, rwd, m.sep)
    }
  }
  return { W, H, tilt, canRotate, views }
}

// The 16 RWD gallery views: 原始 8（縮減網格 | RWD 路網 ×4 源）＋ 旋轉 8.
export const RWD_VIEW_ORDER = [
  'compact-hc-orig', 'rwd-hc-orig',
  'compact-rect-orig', 'rwd-rect-orig',
  'compact-align-orig', 'rwd-align-orig',
  'compact-ilp-orig', 'rwd-ilp-orig',
  'compact-hc-rot', 'rwd-hc-rot',
  'compact-rect-rot', 'rwd-rect-rot',
  'compact-align-rot', 'rwd-align-rot',
  'compact-ilp-rot', 'rwd-ilp-rot',
]

// View id → 中文 caption for the RWD gallery（旋轉 variant 標「旋轉 N°」）.
export function rwdViewLabels(tilt) {
  const rot = `旋轉 ${Math.abs(tilt).toFixed(0)}°`
  return {
    'compact-hc-orig': '原始 · Hill Climbing循環縮減網格',
    'rwd-hc-orig': '原始 · Hill Climbing循環 · RWD 路網',
    'compact-rect-orig': '原始 · 直角爬山循環縮減網格',
    'rwd-rect-orig': '原始 · 直角爬山循環 · RWD 路網',
    'compact-align-orig': '原始 · 軸對齊循環縮減網格',
    'rwd-align-orig': '原始 · 軸對齊循環 · RWD 路網',
    'compact-ilp-orig': '原始 · 整數規劃循環縮減網格',
    'rwd-ilp-orig': '原始 · 整數規劃循環 · RWD 路網',
    'compact-hc-rot': `${rot} · Hill Climbing循環縮減網格`,
    'rwd-hc-rot': `${rot} · Hill Climbing循環 · RWD 路網`,
    'compact-rect-rot': `${rot} · 直角爬山循環縮減網格`,
    'rwd-rect-rot': `${rot} · 直角爬山循環 · RWD 路網`,
    'compact-align-rot': `${rot} · 軸對齊循環縮減網格`,
    'rwd-align-rot': `${rot} · 軸對齊循環 · RWD 路網`,
    'compact-ilp-rot': `${rot} · 整數規劃循環縮減網格`,
    'rwd-ilp-rot': `${rot} · 整數規劃循環 · RWD 路網`,
    // LLM 對齊無預算縮圖（需即時計算）——僅提供標籤給視圖畫廊的代表格。
    'rwd-llm-orig': '原始 · LLM 對齊 · RWD 路網',
    'rwd-llm-rot': `${rot} · LLM 對齊 · RWD 路網`,
  }
}
// The compact source a gallery cell maps to ('hc'|'rect'|'align'|'ilp')；剝掉
// compact-/rwd- 前綴與 -orig/-rot variant 後綴。
export const rwdCellCompact = (viewId) =>
  (viewId ?? '').replace(/^(compact|rwd)-/, '').replace(/-(orig|rot)$/, '') || 'hc'
// The variant a gallery cell maps to ('orig'|'rot').
export const rwdCellVariant = (viewId) => (/-rot$/.test(viewId ?? '') ? 'rot' : 'orig')
