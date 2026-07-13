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
import { buildHillClimb, compactGrid } from './hillClimb.js'

// Same palettes as D3Tab.vue.
const NODE_COLOR = { red: '#e11d48', blue: '#2563eb', black: '#ffffff', purple: '#a855f7', pink: '#ec4899', gray: '#9ca3af', yellow: '#eab308' }
const EDGE_HL = { coline: '#e11d48', loop: '#16a34a', parallel: '#2563eb' }
const MAX_OVERLAP = 6
const DASH = 5

// Geographic (original/rotated) station fill — matches D3Tab.stationColor:
// transfer (lines>1) red, terminus blue, else white.
function stationColor(p) {
  if (Array.isArray(p.lines) && p.lines.length > 1) return '#e11d48'
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

// Draw a view from an explicit id→[x,y] position map: the SAME line features as
// the original/geographic drawing (single colour / interleaved co-line dashes),
// only with each vertex's station re-placed via posMap — so a moved view (格網化
// 後 / Hill Climbing) is the original network snapped to those positions, colours
// and co-line merging identical. Plus role-coloured station dots (+ yellow
// crossings). `sep` = optional blue grid separators.
function drawFromPos(skeleton, stations, lineFeats, posMap, sep) {
  const coordKey = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`
  const coordId = new Map()
  for (const f of stations) coordId.set(coordKey(f.geometry.coordinates), f.properties.station_id)
  const lines = []
  const hl = []
  for (const f of lineFeats) {
    const segs = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]
    const parts = []
    for (const seg of segs) {
      let started = false
      for (const c of seg) {
        const id = coordId.get(coordKey(c))
        const p = id != null ? posMap.get(id) : null
        if (!p) continue
        parts.push(`${started ? 'L' : 'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`); started = true
      }
    }
    const d = parts.join(' ')
    if (d) for (const s of strokesOf(f.properties?.route_colors, f.properties?.route_color, d)) lines.push(s)
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
      if (d) for (const s of strokesOf(f.properties?.route_colors, f.properties?.route_color, d)) out.push(s)
    }
    return out
  }
  // 格網化後 draws the SAME features, only with each vertex's STATION re-placed
  // onto its grid cell (movedOf) — so 後 = 前 pixel-for-pixel, just snapped.
  const coordKey = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`
  const coordId = new Map()
  for (const f of stations) coordId.set(coordKey(f.geometry.coordinates), f.properties.station_id)
  const movedFeatureLines = (movedOf) => {
    const out = []
    for (const f of lineFeats) {
      const segs = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]
      const parts = []
      for (const seg of segs) {
        let started = false
        for (const c of seg) {
          const id = coordId.get(coordKey(c))
          const p = id != null ? movedOf(id) : null
          if (!p) continue
          parts.push(`${started ? 'L' : 'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`); started = true
        }
      }
      const d = parts.join(' ')
      if (d) for (const s of strokesOf(f.properties?.route_colors, f.properties?.route_color, d)) out.push(s)
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
 * Compute the 6 Hill Climbing views for one city — the 3 HC-layer tabs
 * (格網化後 input → Hill Climbing → 縮減網格) for both variants (orig / rot).
 * Mirrors D3Tab's hill-climbing pipeline: schematic gridding → buildHillClimb
 * on the integer cells → compactGrid, mapping cells to pixel cell-centres and
 * re-spreading black through-stations (placeBlacks) each stage.
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

    // 3) 縮減網格 — drop colour-free rows/cols, re-map over the smaller grid.
    const comp = compactGrid(hc.cellAfter, grid.cols, grid.rows)
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

// The 6 Hill Climbing views, in display order: variant (原始/旋轉) × stage.
export const HC_VIEW_ORDER = [
  'grid-orig-post', 'hc-orig', 'compact-orig',
  'grid-rot-post', 'hc-rot', 'compact-rot',
]

// View id → 中文 caption for the HC gallery. N° filled per city.
export function hcViewLabels(tilt) {
  const rot = `旋轉 ${Math.abs(tilt).toFixed(0)}°`
  return {
    'grid-orig-post': '原始 · 格網化後',
    'hc-orig': '原始 · Hill Climbing',
    'compact-orig': '原始 · 縮減網格',
    'grid-rot-post': `${rot} · 格網化後`,
    'hc-rot': `${rot} · Hill Climbing`,
    'compact-rot': `${rot} · 縮減網格`,
  }
}
