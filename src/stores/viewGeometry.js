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
  buildHillClimb, buildHcGraph, iteratePost, countHV,
  straightenCompactLoop, setFrozen,
} from './hillClimb.js'
import { PAPER_KINDS, PAPER_BUILD, PAPER_ZH } from './paperAlign.js'
import { applyShapeGreens } from './paper/shape.js'
import { getShapePresets } from './paper/shapePresets.js'
import { buildRwdMap, mergeParallelSegs } from './rwdMap.js'
import { NODE_COLOR, EDGE_HL, stationColor, strokesOf as strokesOfShared } from '../lib/metroDraw.js'

// 離線可預算的鏈：hc ＋ 論文①〜⑧（PAPER_KINDS）。LLM 對齊另讀
// data/metro/straighten-llm/<city>.<variant>.json（由 route-llm-align / llmAlignBatch
// 預算），有檔且 fingerprint 相符才寫進 loop-llm-*／rwd-llm-*；否則畫廊顯示
// 「沒有資料」。HC 畫廊與 RWD 畫廊共用同一份清單與後處理映射。
const CHAIN_KINDS = ['hc', ...PAPER_KINDS.map((p) => p.kind)]
const CHAIN_POST = { hc: null, ...PAPER_BUILD }
const CHAIN_ZH = { hc: '基本', llm: 'LLM 對齊', ...PAPER_ZH }

// llmview 檔 → 可用的 cell Map（fingerprint 必須與目前 HC 一致，否則當缺檔）。
function llmCellsIfMatch(llmview, fingerprint) {
  if (!llmview?.cellAfter || !llmview.fingerprint) return null
  if (JSON.stringify(llmview.fingerprint) !== JSON.stringify(fingerprint)) return null
  return new Map(llmview.cellAfter.map(([id, c, r]) => [id, [c, r]]))
}

// llmshape 檔（LLM 成方結果）→ { cells, greens }；必須 square===true 且格網
// cols/rows 相符才用（成方 fingerprint＝verts/segs/cols/rows，無 hvStart）。
// square===false＝未正確成方 → null（畫廊「成方路線沒有算」）。
function shapeIfMatch(shape, grid) {
  const fp = shape?.fingerprint
  if (!shape?.cellAfter || !fp || shape.square !== true) return null
  if (fp.cols !== grid.cols || fp.rows !== grid.rows) return null
  return {
    cells: new Map(shape.cellAfter.map(([id, c, r]) => [id, [c, r]])),
    greens: shape.greens ?? [],
  }
}

// 成方凍結集：規定 ring 站＋各環路線邊上所有站＋綠折點（比照 D3Tab expandShapeMembers）。
function shapeFrozenSet(skeleton, cityId, greens) {
  const out = new Set((greens ?? []).map((g) => g.id))
  for (const p of (getShapePresets(cityId) ?? [])) {
    for (const id of (p.stations ?? [])) out.add(id)
    if (p.routeId && skeleton.edges) {
      for (const e of skeleton.edges) {
        if (e.routes?.has(p.routeId)) for (const id of e.path) out.add(id)
      }
    }
  }
  return out
}

// Single colour → solid; overlap (≥2 DISTINCT colours) → interleaved dashes.
// viewGeometry 用 color 欄位（縮圖 JSON）；D3Tab 用 stroke。
function strokesOf(routeColors, color, d) {
  return strokesOfShared(routeColors, color, d, { colorKey: 'color' })
}

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

// 河流站點沒有白點（使用者）：骨架視圖只在分類為顯著點時畫（黑不畫；灰＝依曲折度遞迴細分的
// 分隔點要畫）；原始視圖一律不畫。
const riverDotVisible = (f, skeleton) => {
  if (!f.properties?.river) return true
  const c = skeleton?.stationClass?.get(f.properties.station_id)
  return !!c && c !== 'black'
}

// Integer cell → pixel cell-centre + uniform blue separators。
// stretch：欄／列各吃滿畫布（舊行為；格非正方 → 斜線看起來不像 45°）。
// square：格子強制正方、置中 letterbox——Straighten 畫廊／D3Tab 共用，避免
// 縮圖 4:3 與面板 3:2 把同一組 cell 拉成兩種形狀。
const cellMapperFor = (x0, y0, x1, y1, { square = false } = {}) => (nC, nR) => {
  const aw = x1 - x0, ah = y1 - y0
  if (!square) {
    const cw = aw / nC, ch = ah / nR
    return {
      cw, ch,
      cellPx: ([c, r]) => [x0 + (c + 0.5) * cw, y0 + (r + 0.5) * ch],
      sep: {
        xs: Array.from({ length: nC + 1 }, (_, i) => x0 + i * cw),
        ys: Array.from({ length: nR + 1 }, (_, i) => y0 + i * ch),
      },
    }
  }
  const u = Math.min(aw / nC, ah / nR)
  const sx0 = x0 + (aw - nC * u) / 2
  const sy0 = y0 + (ah - nR * u) / 2
  return {
    cw: u, ch: u,
    cellPx: ([c, r]) => [sx0 + (c + 0.5) * u, sy0 + (r + 0.5) * u],
    sep: {
      xs: Array.from({ length: nC + 1 }, (_, i) => sx0 + i * u),
      ys: Array.from({ length: nR + 1 }, (_, i) => sy0 + i * u),
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
 * Compute the Straighten 視圖畫廊 views for one city（原始＋旋轉 × 格網化後／
 * 可選 HC 參考圖／各鏈循環＋可選 LLM）。每 variant：
 *   1) 格網化後 — Map Adjust grid-*-post；直線演算法的唯一 base。
 *   2) Hill Climbing — 僅畫廊參考圖（不餵下游）。
 *   3–N) 各鏈循環 — 只讀 straighten-cells.loops（缺檔不畫）。
 *   LLM／形狀變體同：吃格網化後或成方 cells，不吃 HC。
 * @returns {{ W, H, tilt, canRotate, views, stats }}
 */
export function computeCityHcViews(geojson, opts = {}) {
  const { W, H, extArr, x0, y0, x1, y1, stations, lineFeats, tilt, canRotate, skeleton, projFor } = prepCity(geojson, opts)
  const views = {}
  const stats = {}
  // 畫廊預設＝版面網格（隨縮圖 W×H 拉伸，對齊 D3Tab 預設）。
  const cellMapperSq = cellMapperFor(x0, y0, x1, y1)
  for (const variant of ['orig', 'rot']) {
    const angle = variant === 'rot' && canRotate ? tilt : 0
    const projection = projFor(angle)
    const projById = projByIdFor(projection, stations, skeleton)
    const grid = buildSchematicGrid(skeleton, projById, extArr)
    const snap = (id) => grid.posAfter.get(id) ?? null
    const gridBase = grid.cellOf

    // 1) 格網化後 — 直線演算法 base（= Map Adjust's grid-*-post）.
    const postPos = new Map(projById)
    for (const [id, p] of grid.posAfter) postPos.set(id, p)
    views[`grid-post-${variant}`] = drawFromPos(skeleton, stations, lineFeats, postPos, grid.blueAfter)

    // 2) Hill Climbing — 畫廊參考圖 only（不餵①〜⑧／LLM／循環）。
    const hc = buildHillClimb(skeleton, gridBase, grid.cols, grid.rows)
    const m1 = cellMapperSq(grid.cols, grid.rows)
    const hcPos = cellsToPos(hc.cellAfter, m1.cellPx, skeleton, snap)
    views[`hc-${variant}`] = drawFromPos(skeleton, stations, lineFeats, hcPos, m1.sep)
    stats[`hc-${variant}`] = { before: +(hc.stats?.before ?? 0).toFixed(1), after: +(hc.stats?.after ?? 0).toFixed(1) }

    // 3–N) 各鏈循環 — **只畫 straighten-cells 預計算結果**（與 D3Tab 同一份）。
    // 缺檔不現場 bake——沒資料就不產出該視圖（視圖＝結果）。
    const cellsDoc = opts.cellsByVariant?.[variant]
    for (const kind of [...CHAIN_KINDS, 'llm']) {
      const key = `loop-${kind}-${variant}`
      const fromCells = cellsDoc?.loops?.[kind]
      if (fromCells?.cellAfter && fromCells.cols != null && fromCells.rows != null) {
        const cellAfter = new Map(fromCells.cellAfter.map(([id, c, r]) => [id, [c, r]]))
        const m = cellMapperSq(fromCells.cols, fromCells.rows)
        const compPos = cellsToPos(cellAfter, m.cellPx, skeleton, snap)
        views[key] = drawFromPos(skeleton, stations, lineFeats, compPos, m.sep)
        stats[key] = { cols: fromCells.cols, rows: fromCells.rows, fromCells: true }
      }
    }

    // 形狀變體：只畫 shapelike straighten-cells；缺檔不現場 bake。
    const shapeCellsDoc = opts.cellsByVariant?.[`${variant}-shape`]
    const shp = opts.cityId ? shapeIfMatch(opts.shapeByVariant?.[variant], grid) : null
    if (shapeCellsDoc?.loops) {
      const shSk = (shp?.greens?.length) ? applyShapeGreens(skeleton, shp.greens) : skeleton
      for (const kind of [...CHAIN_KINDS, 'llm']) {
        const key = `loop-${kind}-${variant}-shape`
        const fromCells = shapeCellsDoc.loops?.[kind]
        if (fromCells?.cellAfter && fromCells.cols != null && fromCells.rows != null) {
          const cellAfter = new Map(fromCells.cellAfter.map(([id, c, r]) => [id, [c, r]]))
          const m = cellMapperSq(fromCells.cols, fromCells.rows)
          const compPos = cellsToPos(cellAfter, m.cellPx, shSk, snap)
          views[key] = drawFromPos(shSk, stations, lineFeats, compPos, m.sep)
          stats[key] = { cols: fromCells.cols, rows: fromCells.rows, fromCells: true }
        }
      }
    }
  }

  return { W, H, tilt, canRotate, views, stats }
}

/**
 * 瀏覽器畫廊用：用 straighten-cells（與 D3Tab 同一份）覆寫 loop-* 縮圖。
 * 只重畫、不重跑演算法；有 cells 的鏈才覆寫。回傳覆寫筆數。
 */
export function patchHcGalleryFromCells(geojson, galleryDoc, cellsByVariant, opts = {}) {
  if (!geojson || !galleryDoc?.views || !cellsByVariant) return 0
  const { W, H, extArr, x0, y0, x1, y1, stations, lineFeats, tilt, canRotate, skeleton, projFor } =
    prepCity(geojson, { W: galleryDoc.W, H: galleryDoc.H, pad: opts.pad })
  // 預設版面網格（隨縮圖 W×H 拉伸，對齊 D3Tab 預設）。
  const cellMapper = cellMapperFor(x0, y0, x1, y1)
  let n = 0
  for (const [variantKey, cellsDoc] of Object.entries(cellsByVariant)) {
    if (!cellsDoc?.loops) continue
    const isShape = variantKey.endsWith('-shape')
    const variant = isShape ? variantKey.replace(/-shape$/, '') : variantKey
    if (variant !== 'orig' && variant !== 'rot') continue
    const angle = variant === 'rot' && canRotate ? tilt : 0
    const projection = projFor(angle)
    const projById = projByIdFor(projection, stations, skeleton)
    const grid = buildSchematicGrid(skeleton, projById, extArr)
    const snap = (id) => grid.posAfter.get(id) ?? null
    const greens = opts.shapeByVariant?.[variant]?.greens
    const sk = (isShape && greens?.length) ? applyShapeGreens(skeleton, greens) : skeleton
    for (const [kind, L] of Object.entries(cellsDoc.loops)) {
      if (!L?.cellAfter || L.cols == null || L.rows == null) continue
      const cellAfter = new Map(L.cellAfter.map(([id, c, r]) => [id, [c, r]]))
      const m = cellMapper(L.cols, L.rows)
      const pos = cellsToPos(cellAfter, m.cellPx, sk, snap)
      const key = `loop-${kind}-${variant}${isShape ? '-shape' : ''}`
      galleryDoc.views[key] = drawFromPos(sk, stations, lineFeats, pos, m.sep)
      if (!galleryDoc.stats) galleryDoc.stats = {}
      galleryDoc.stats[key] = { cols: L.cols, rows: L.rows, fromCells: true }
      n++
    }
  }
  return n
}

// 視圖畫廊顯示順序：每 variant 格網化後→Hill Climbing→各鏈循環（含 LLM）原始組＋旋轉組。
export const HC_VIEW_ORDER = ['orig', 'rot'].flatMap((v) => [
  `grid-post-${v}`, `hc-${v}`, ...CHAIN_KINDS.map((k) => `loop-${k}-${v}`), `loop-llm-${v}`,
])

// View id → 中文 caption for the HC 視圖畫廊（旋轉 variant 標「旋轉 N°」）.
export function hcViewLabels(tilt) {
  const rot = `旋轉 ${Math.abs(tilt).toFixed(0)}°`
  const out = {
    'grid-post-orig': '原始 · 格網化後',
    'hc-orig': '原始 · Hill Climbing',
    'grid-post-rot': `${rot} · 格網化後`,
    'hc-rot': `${rot} · Hill Climbing`,
  }
  for (const kind of [...CHAIN_KINDS, 'llm']) {
    // 視圖畫廊 Straighten 縮圖＝循環後（loop-*），標籤明示「循環後」。
    out[`loop-${kind}-orig`] = `原始 · ${CHAIN_ZH[kind]}循環後`
    out[`loop-${kind}-rot`] = `${rot} · ${CHAIN_ZH[kind]}循環後`
    // 形狀變體（原始-形狀／旋轉-形狀）——每條鏈都有形狀版（缺檔顯示「成方路線沒有算」）。
    out[`loop-${kind}-orig-shape`] = `原始-形狀 · ${CHAIN_ZH[kind]}循環後`
    out[`loop-${kind}-rot-shape`] = `${rot}-形狀 · ${CHAIN_ZH[kind]}循環後`
  }
  return out
}

// The loop chain a Straighten gallery cell maps to （PAPER_KINDS 之一或 'llm'）；
// 剝掉 loop- 前綴與 -orig/-rot variant 後綴（同 rwdCellCompact 對 compact-/rwd-）。
export const loopCellCompact = (viewId) =>
  (viewId ?? '').replace(/^loop-/, '').replace(/-(orig|rot)(-shape)?$/, '') || 'rect'

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

// 從循環結果（cellAfter＋cols/rows）畫 compact＋RWD 一對視圖。
// 版面網格（隨 W×H 拉伸）；形狀變體傳 frozenIds（shapeLock，同 D3Tab）。
function bakeRwdPair(views, {
  kind, variant, shapeSuffix, sk, stations, lineFeats, segs, snap,
  cellAfter, cols, rows, cellMapper, x0, y0, frozenIds = null,
}) {
  const m = cellMapper(cols, rows)
  const compPos = cellsToPos(cellAfter, m.cellPx, sk, snap)
  const suffix = `${kind}-${variant}${shapeSuffix}`
  views[`compact-${suffix}`] = drawFromPos(sk, stations, lineFeats, compPos, m.sep)
  const pxPos = new Map()
  for (const [id, cell] of cellAfter) pxPos.set(id, m.cellPx(cell))
  const rwd = buildRwdMap(segs, pxPos, {
    unit: Math.min(m.cw, m.ch),
    lattice: { x0: m.sep.xs[0], y0: m.sep.ys[0], sx: m.cw / 2, sy: m.ch / 2, nx: cols * 2 + 1, ny: rows * 2 + 1 },
    ...(frozenIds ? { frozenIds } : {}),
  })
  views[`rwd-${suffix}`] = drawRwd(sk, stations, rwd, m.sep)
}

function loopCellsFromDoc(cellsDoc, kind) {
  const L = cellsDoc?.loops?.[kind]
  if (!L?.cellAfter || L.cols == null || L.rows == null) return null
  return {
    cellAfter: new Map(L.cellAfter.map(([id, c, r]) => [id, [c, r]])),
    cols: L.cols,
    rows: L.rows,
  }
}

// Compute the RWD Maps gallery views for one city（原始＋旋轉 兩 variant）：
// each variant × 縮減網格 sources（基本 hc ＋ 論文①〜⑧的八條鏈 ＋ 可選 LLM）
// as both the compact grid AND its RWD 路網 redraw.
// **只畫 straighten-cells 的 loops**（與 D3Tab 同一份）；缺檔不現場循環。
// opts.cellsByVariant / shapeByVariant / cityId。
export function computeCityRwdViews(geojson, opts = {}) {
  const { W, H, extArr, x0, y0, x1, y1, stations, lineFeats, tilt, canRotate, skeleton, projFor } = prepCity(geojson, opts)
  // 預設版面網格（隨縮圖 W×H 拉伸，對齊 D3Tab 預設）。
  const cellMapper = cellMapperFor(x0, y0, x1, y1)
  const views = {}
  for (const variant of ['orig', 'rot']) {
    const angle = variant === 'rot' && canRotate ? tilt : 0
    const projection = projFor(angle)
    const projById = projByIdFor(projection, stations, skeleton)
    const grid = buildSchematicGrid(skeleton, projById, extArr)
    const snap = (id) => grid.posAfter.get(id) ?? null
    const gridBase = grid.cellOf
    const segs = mergeParallelSegs(buildHcGraph(skeleton, gridBase).segs)
    const cellsDoc = opts.cellsByVariant?.[variant]

    for (const kind of [...CHAIN_KINDS, 'llm']) {
      const fromCells = loopCellsFromDoc(cellsDoc, kind)
      if (!fromCells) continue
      bakeRwdPair(views, {
        kind, variant, shapeSuffix: '', sk: skeleton, stations, lineFeats, segs, snap,
        ...fromCells, cellMapper, x0, y0,
      })
    }

    // 形狀變體：只畫 shapelike cells。
    const shapeCellsDoc = opts.cellsByVariant?.[`${variant}-shape`]
    const shp = opts.cityId ? shapeIfMatch(opts.shapeByVariant?.[variant], grid) : null
    if (shapeCellsDoc?.loops) {
      const shSk = (shp?.greens?.length) ? applyShapeGreens(skeleton, shp.greens) : skeleton
      const frozen = opts.cityId
        ? shapeFrozenSet(shSk, opts.cityId, shp?.greens ?? opts.shapeByVariant?.[variant]?.greens ?? [])
        : new Set()
      const baseCells = shp?.cells ?? gridBase
      const shSegs = mergeParallelSegs(buildHcGraph(shSk, baseCells).segs)
      const shSnap = (id) => grid.posAfter.get(id) ?? null
      for (const kind of [...CHAIN_KINDS, 'llm']) {
        const fromCells = loopCellsFromDoc(shapeCellsDoc, kind)
        if (!fromCells) continue
        bakeRwdPair(views, {
          kind, variant, shapeSuffix: '-shape', sk: shSk, stations, lineFeats,
          segs: shSegs, snap: shSnap, ...fromCells, cellMapper, x0, y0, frozenIds: frozen,
        })
      }
    }
  }
  return { W, H, tilt, canRotate, views }
}

/**
 * 瀏覽器畫廊用：用 straighten-cells 重畫 RWD Maps 的 compact-*／rwd-* 縮圖
 *（與點進去 D3Tab 同一份循環結果）。有 cells 的鏈才覆寫。回傳覆寫筆數。
 */
export function patchRwdGalleryFromCells(geojson, galleryDoc, cellsByVariant, opts = {}) {
  if (!geojson || !galleryDoc?.views || !cellsByVariant) return 0
  const { W, H, extArr, x0, y0, x1, y1, stations, lineFeats, tilt, canRotate, skeleton, projFor } =
    prepCity(geojson, { W: galleryDoc.W, H: galleryDoc.H, pad: opts.pad })
  // 預設版面網格（隨縮圖 W×H 拉伸，對齊 D3Tab 預設）。
  const cellMapper = cellMapperFor(x0, y0, x1, y1)
  let n = 0
  for (const [variantKey, cellsDoc] of Object.entries(cellsByVariant)) {
    if (!cellsDoc?.loops) continue
    const isShape = variantKey.endsWith('-shape')
    const variant = isShape ? variantKey.replace(/-shape$/, '') : variantKey
    if (variant !== 'orig' && variant !== 'rot') continue
    const angle = variant === 'rot' && canRotate ? tilt : 0
    const projection = projFor(angle)
    const projById = projByIdFor(projection, stations, skeleton)
    const grid = buildSchematicGrid(skeleton, projById, extArr)
    const snap = (id) => grid.posAfter.get(id) ?? null
    const greens = opts.shapeByVariant?.[variant]?.greens
    const sk = (isShape && greens?.length) ? applyShapeGreens(skeleton, greens) : skeleton
    const frozen = isShape && opts.cityId
      ? shapeFrozenSet(sk, opts.cityId, greens ?? [])
      : null
    // segs 拓撲：形狀用成方 base（有 greens 的 sk）；一般用格網化後。
    const baseForSegs = isShape && opts.shapeByVariant?.[variant]
      ? shapeIfMatch(opts.shapeByVariant[variant], grid)?.cells ?? grid.cellOf
      : grid.cellOf
    const segs = mergeParallelSegs(buildHcGraph(sk, baseForSegs).segs)
    if (frozen) setFrozen({ ringIds: [...frozen], members: frozen })
    try {
      for (const [kind, L] of Object.entries(cellsDoc.loops)) {
        if (!L?.cellAfter || L.cols == null || L.rows == null) continue
        const cellAfter = new Map(L.cellAfter.map(([id, c, r]) => [id, [c, r]]))
        bakeRwdPair(galleryDoc.views, {
          kind, variant, shapeSuffix: isShape ? '-shape' : '',
          sk, stations, lineFeats, segs, snap,
          cellAfter, cols: L.cols, rows: L.rows, cellMapper, x0, y0,
          frozenIds: frozen,
        })
        n += 2 // compact-* ＋ rwd-*
      }
    } finally { if (frozen) setFrozen(null) }
  }
  return n
}

// The RWD gallery views: 每 variant（原始→旋轉→形狀）× 每鏈（縮減網格 | RWD 路網）含 LLM。
export const RWD_VIEW_ORDER = ['orig', 'rot'].flatMap((v) =>
  [...CHAIN_KINDS, 'llm'].flatMap((k) => [
    `compact-${k}-${v}`, `rwd-${k}-${v}`,
    `compact-${k}-${v}-shape`, `rwd-${k}-${v}-shape`,
  ]))

// View id → 中文 caption for the RWD gallery（旋轉 variant 標「旋轉 N°」）.
export function rwdViewLabels(tilt) {
  const rot = `旋轉 ${Math.abs(tilt).toFixed(0)}°`
  const out = {}
  for (const kind of [...CHAIN_KINDS, 'llm']) {
    out[`compact-${kind}-orig`] = `原始 · ${CHAIN_ZH[kind]}循環縮減網格`
    out[`rwd-${kind}-orig`] = `原始 · ${CHAIN_ZH[kind]}循環 · RWD 路網`
    out[`compact-${kind}-rot`] = `${rot} · ${CHAIN_ZH[kind]}循環縮減網格`
    out[`rwd-${kind}-rot`] = `${rot} · ${CHAIN_ZH[kind]}循環 · RWD 路網`
    // 形狀變體（原始-形狀／旋轉-形狀）——每條鏈都有形狀版（缺檔顯示「成方路線沒有算」）。
    out[`compact-${kind}-orig-shape`] = `原始-形狀 · ${CHAIN_ZH[kind]}循環縮減網格`
    out[`rwd-${kind}-orig-shape`] = `原始-形狀 · ${CHAIN_ZH[kind]}循環 · RWD 路網`
    out[`compact-${kind}-rot-shape`] = `${rot}-形狀 · ${CHAIN_ZH[kind]}循環縮減網格`
    out[`rwd-${kind}-rot-shape`] = `${rot}-形狀 · ${CHAIN_ZH[kind]}循環 · RWD 路網`
  }
  return out
}
// The compact source a gallery cell maps to （'hc' 或 PAPER_KINDS 之一）；剝掉
// compact-/rwd- 前綴與 -orig/-rot(-shape) variant 後綴。
export const rwdCellCompact = (viewId) =>
  (viewId ?? '').replace(/^(compact|rwd)-/, '').replace(/-(orig|rot)(-shape)?$/, '') || 'hc'
// The variant a gallery cell maps to ('orig'|'rot'|'orig-shape'|'rot-shape').
export const rwdCellVariant = (viewId) => {
  const v = viewId ?? ''
  if (/-orig-shape$/.test(v)) return 'orig-shape'
  if (/-rot-shape$/.test(v)) return 'rot-shape'
  return /-rot$/.test(v) ? 'rot' : 'orig'
}
