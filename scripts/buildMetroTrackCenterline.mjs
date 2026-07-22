// Build per-system route CENTERLINES from the actual OSM track geometry.
//
// data/metro/metro-tracks/<system>.geojson holds the individual OSM track ways — a
// route typically has two parallel strands (up/down direction) plus crossovers
// and sidings. This derives ONE centreline per route: take the longest chained
// strand as an ordering BACKBONE, then shift every backbone sample PERPENDICULAR
// toward the local centre of the route's whole track point-cloud. That centres a
// single rail between both rails, and — crucially — makes an out-and-back strand
// (the two directions chained into one at a terminus) collapse onto the shared
// centreline (both traces land on the same line and overlap), instead of drawing
// the two rails as one zig-zag. Output mirrors the tracks tree under
// data/metro/metro-tracks-center/<system>.geojson — an optional map underlay shown on
// top of (not replacing) the raw tracks. It never touches data/metro/systems.
//
// Prereq: `npm run metro:buildtracks` (produces data/metro/tracks). Run with
// `npm run metro:buildcenterlines`.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

const BASE = join('data', 'metro')
const TRACKS = join(BASE, 'tracks')
const CENTER = join(BASE, 'tracks-center')

const SAMPLE_M = 10    // 沿骨幹的取樣間距（公尺）
const CLOUD_M = 6      // 軌道點雲的密度（每段補點間距）
const WINDOW_M = 25    // 局部置中的視窗半徑——需 > 軌距／站台寬，< 到鄰線的距離
const JOIN_EPS_M = 4   // 端點併接容差（把碎段串成長股當骨幹）
const SIMPLIFY_M = 6   // Douglas–Peucker 簡化容差
const M_PER_DEG = 111320

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  }))).flat()
}

// Local equirectangular projection (metres) around a system's mean latitude, so
// the geometry maths below is Euclidean and distances are ~metres.
function projector(lat0) {
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180)
  const ky = M_PER_DEG
  return { fwd: ([lon, lat]) => [lon * kx, lat * ky], inv: ([x, y]) => [x / kx, y / ky] }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const lengthOf = (line) => { let s = 0; for (let i = 1; i < line.length; i++) s += dist(line[i - 1], line[i]); return s }

// Greedily join lines whose endpoints coincide (within eps) into longer strands.
function mergeChains(lines, eps) {
  const segs = lines.map((l) => l.slice())
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < segs.length && !changed; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i], b = segs[j]
        const aS = a[0], aE = a[a.length - 1], bS = b[0], bE = b[b.length - 1]
        if (dist(aE, bS) <= eps) segs[i] = a.concat(b.slice(1))
        else if (dist(aE, bE) <= eps) segs[i] = a.concat(b.slice(0, -1).reverse())
        else if (dist(aS, bE) <= eps) segs[i] = b.concat(a.slice(1))
        else if (dist(aS, bS) <= eps) segs[i] = b.slice().reverse().concat(a.slice(1))
        else continue
        segs.splice(j, 1); changed = true; break
      }
    }
  }
  return segs
}

// Walk a polyline emitting a point every `step` metres (plus the final vertex).
function densify(line, step) {
  const out = []
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1]
    const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy)
    const n = Math.max(1, Math.round(d / step))
    for (let k = 0; k < n; k++) { const t = k / n; out.push([a[0] + dx * t, a[1] + dy * t]) }
  }
  out.push(line[line.length - 1])
  return out
}

function projSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  const qx = a[0] + dx * t, qy = a[1] + dy * t
  const ex = p[0] - qx, ey = p[1] - qy
  return { q: [qx, qy], d2: ex * ex + ey * ey }
}

// Uniform grid hash over a point cloud; query returns points within `r` of p.
// Cell size = query radius, so a 3×3 block of cells always covers the disc.
function buildGrid(points, cell) {
  const g = new Map()
  const key = (ix, iy) => ix + ',' + iy
  for (const p of points) {
    const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell))
    const arr = g.get(k); if (arr) arr.push(p); else g.set(k, [p])
  }
  return (p, r) => {
    const r2 = r * r, res = [], ix = Math.floor(p[0] / cell), iy = Math.floor(p[1] / cell)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const arr = g.get(key(ix + dx, iy + dy)); if (!arr) continue
      for (const q of arr) { const ex = q[0] - p[0], ey = q[1] - p[1]; if (ex * ex + ey * ey <= r2) res.push(q) }
    }
    return res
  }
}

function median(arr) {
  if (!arr.length) return 0
  const s = arr.slice().sort((a, b) => a - b), n = s.length
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

// Iterative Douglas–Peucker (iterative to avoid deep recursion on long lines).
function simplify(points, tol) {
  if (points.length < 3) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const tol2 = tol * tol
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()
    let idx = -1, md = -1
    for (let i = s + 1; i < e; i++) {
      const { d2 } = projSeg(points[i], points[s], points[e])
      if (d2 > md) { md = d2; idx = i }
    }
    if (md > tol2 && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]) }
  }
  const out = []
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i])
  return out
}

// One route's centreline. Backbone = longest chained strand (gives ordering);
// point cloud = every rail densified. Each backbone sample is shifted along its
// local normal by the MEDIAN perpendicular offset of the nearby cloud points, so
// it lands halfway between the two rails. Median (not mean) resists sidings and
// uneven point density. Works whatever the strand count, and folds an
// out-and-back strand onto its own centreline.
function centerlineOf(lines) {
  const merged = mergeChains(lines, JOIN_EPS_M).sort((a, b) => lengthOf(b) - lengthOf(a))
  if (!merged.length) return null
  const backbone = densify(merged[0], SAMPLE_M)
  if (backbone.length < 2) return null

  const cloud = []
  for (const l of lines) for (const p of densify(l, CLOUD_M)) cloud.push(p)
  const near = buildGrid(cloud, WINDOW_M)

  const centred = backbone.map((p, i) => {
    const a = backbone[Math.max(0, i - 1)], b = backbone[Math.min(backbone.length - 1, i + 1)]
    let tx = b[0] - a[0], ty = b[1] - a[1]
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl
    const nx = -ty, ny = tx // unit normal
    const pts = near(p, WINDOW_M)
    if (!pts.length) return p
    const off = median(pts.map((q) => (q[0] - p[0]) * nx + (q[1] - p[1]) * ny))
    return [p[0] + off * nx, p[1] + off * ny]
  })
  return simplify(centred, SIMPLIFY_M)
}

async function main() {
  let files = []
  try { files = (await walk(TRACKS)).filter((f) => f.endsWith('.geojson')) }
  catch (error) { if (error.code === 'ENOENT') { console.log('無 data/metro/tracks——先跑 metro:buildtracks'); return } throw error }

  const wanted = new Set()
  let written = 0
  for (const file of files) {
    const data = JSON.parse(await readFile(file, 'utf8'))
    const feats = data.features || []
    if (!feats.length) continue

    // Mean latitude → local metric frame for this system.
    let sumLat = 0, n = 0
    for (const f of feats) for (const c of f.geometry.coordinates) { sumLat += c[1]; n++ }
    const proj = projector(sumLat / n)

    // Group every way under each route ref it belongs to (a shared way joins
    // several routes). Keep the route's first non-empty colour for styling.
    const routes = new Map()
    for (const f of feats) {
      const xy = f.geometry.coordinates.map(proj.fwd)
      const color = f.properties?.route_colors?.[0]
      for (const ref of f.properties?.route_refs || []) {
        if (!routes.has(ref)) routes.set(ref, { lines: [], color: null })
        const r = routes.get(ref)
        r.lines.push(xy)
        if (!r.color && color) r.color = color
      }
    }

    const features = []
    for (const [ref, { lines, color }] of routes) {
      const center = centerlineOf(lines)
      if (!center || center.length < 2) continue
      features.push({
        type: 'Feature',
        properties: { route_ref: ref, route_color: color || '#64748b' },
        geometry: { type: 'LineString', coordinates: center.map(proj.inv) },
      })
    }
    if (!features.length) continue

    const out = join(CENTER, relative(TRACKS, file))
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, JSON.stringify({ type: 'FeatureCollection', features }))
    wanted.add(out)
    written += features.length
  }

  // Drop stale centreline files after a system changes identity / loses tracks.
  try {
    for (const file of await walk(CENTER)) {
      if (file.endsWith('.geojson') && !wanted.has(file)) await rm(file, { force: true })
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }

  console.log(`Wrote ${written} route centrelines for ${wanted.size} metro systems`)
}

main().catch((error) => { console.error(error); process.exit(1) })
