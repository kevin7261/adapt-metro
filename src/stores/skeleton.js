// Connect skeleton (骨架2) — see skill route-skeleton-connect.
// Topological contraction of the network: keeps the original geographic line
// shape (nothing is straightened / moved) and only CLASSIFIES nodes and edges.
// Nodes by graph degree: red (junction / route-change), blue (endpoint),
// black (through). Edges: coline (≥2 routes) / loop / parallel / plain. Then
// purple cuts, pink bends and gray separators. Pure function: input unchanged.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x))

// Perpendicular distance from P to the infinite line through A,B (falls back to
// |P−A| when A,B coincide, e.g. a loop edge whose ends meet).
function perpToLine(P, A, B) {
  const dx = B[0] - A[0], dy = B[1] - A[1]
  const L = Math.hypot(dx, dy)
  if (L < 1e-12) return dist(P, A)
  return Math.abs((P[0] - A[0]) * dy - (P[1] - A[1]) * dx) / L
}

// Foot of the perpendicular from P onto the line A–B (clamped to A if A≈B).
function footOnLine(P, A, B) {
  const dx = B[0] - A[0], dy = B[1] - A[1]
  const L2 = dx * dx + dy * dy
  if (L2 < 1e-18) return [A[0], A[1]]
  const t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2
  return [A[0] + t * dx, A[1] + t * dy]
}

// Douglas–Peucker with a RELATIVE tolerance: keep the farthest interior point of
// pts[i0..i1] when its perpDist ÷ chord(A,B) > tol, then recurse each half.
// Scale-independent — only relative bendiness matters. Records each kept index
// with the sub-segment baseline it was measured against, in `kept` (Map).
function dpKeep(pts, i0, i1, tol, kept) {
  if (i1 <= i0 + 1) return
  const A = pts[i0], B = pts[i1]
  const base = dist(A, B)
  let maxD = -1, maxI = -1
  for (let i = i0 + 1; i < i1; i++) {
    const d = perpToLine(pts[i], A, B)
    if (d > maxD) { maxD = d; maxI = i }
  }
  if (maxI < 0) return
  const ratio = base > 1e-9 ? maxD / base : Infinity // coincident ends → always keep
  if (ratio > tol) {
    kept.set(maxI, { i0, i1, ratio })
    dpKeep(pts, i0, maxI, tol, kept)
    dpKeep(pts, maxI, i1, tol, kept)
  }
}

export function buildConnectSkeleton(geojson) {
  // stations
  const coord = new Map() // id -> [lng,lat]
  for (const f of geojson?.features ?? []) {
    if (f.geometry?.type === 'Point') coord.set(f.properties.station_id, f.geometry.coordinates)
  }
  // unique routes with ordered station-id sequences
  const routes = new Map() // route_id -> { id, color, stations:[id] }
  for (const f of geojson?.features ?? []) {
    if (f.geometry?.type === 'Point') continue
    for (const r of f.properties?.routes ?? []) {
      if (!r.route_id || routes.has(r.route_id)) continue
      routes.set(r.route_id, {
        id: r.route_id,
        color: r.route_color ?? '#e11d48',
        stations: (r.stations ?? []).map((s) => s.station_id).filter((id) => coord.has(id)),
      })
    }
  }

  // adjacency graph: neighbours + which routes traverse each undirected edge
  const nbr = new Map()        // id -> Set(neighbourId)
  const edgeRoutes = new Map() // "a|b" -> Set(routeId)
  const pk = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const touch = (id) => { if (!nbr.has(id)) nbr.set(id, new Set()) }
  for (const rt of routes.values()) {
    for (let i = 1; i < rt.stations.length; i++) {
      const a = rt.stations[i - 1], b = rt.stations[i]
      if (a === b) continue
      touch(a); touch(b)
      nbr.get(a).add(b); nbr.get(b).add(a)
      const k = pk(a, b)
      if (!edgeRoutes.has(k)) edgeRoutes.set(k, new Set())
      edgeRoutes.get(k).add(rt.id)
    }
  }

  // node class by degree (red / blue / black)
  const cls = new Map()
  for (const id of nbr.keys()) {
    const d = nbr.get(id).size
    if (d >= 3) { cls.set(id, 'red'); continue }
    if (d <= 1) { cls.set(id, 'blue'); continue }
    const [n1, n2] = [...nbr.get(id)]
    const r1 = edgeRoutes.get(pk(id, n1)), r2 = edgeRoutes.get(pk(id, n2))
    cls.set(id, setEq(r1, r2) ? 'black' : 'red')
  }
  const isNode = (id) => cls.get(id) !== 'black' // red/blue are skeleton nodes

  // contract degree-2 black chains into edges between nodes
  const edges = []
  const seen = new Set()
  const walk = (start, first) => {
    const path = [start, first]
    let prev = start, cur = first
    while (!isNode(cur)) {
      const nxt = [...nbr.get(cur)].find((x) => x !== prev)
      if (nxt == null || nxt === cur) break
      path.push(nxt); prev = cur; cur = nxt
      if (path.length > coord.size + 2) break // safety
    }
    return path
  }
  for (const id of nbr.keys()) {
    if (!isNode(id)) continue
    for (const n of nbr.get(id)) {
      const path = walk(id, n)
      const a = path[0], b = path[path.length - 1]
      const sig = a < b ? `${a}:${path.join(',')}` : `${b}:${[...path].reverse().join(',')}`
      if (seen.has(sig)) continue
      seen.add(sig)
      edges.push({ path, a, b, routes: edgeRoutes.get(pk(path[0], path[1])) ?? new Set(), color: '#e11d48' })
    }
  }
  // pure rings (no red/blue node in a component) — pin the first station as a node
  const covered = new Set()
  for (const e of edges) for (const id of e.path) covered.add(id)
  for (const rt of routes.values()) {
    const first = rt.stations[0]
    if (first == null || covered.has(first)) continue
    const path = [...rt.stations]
    if (path[0] !== path[path.length - 1]) path.push(path[0]) // close ring
    edges.push({ path, a: first, b: first, routes: new Set([rt.id]), color: rt.color })
    for (const id of path) covered.add(id)
  }

  // edge classification
  const pairCount = new Map() // "a|b" (non-loop) -> count of distinct edges
  for (const e of edges) if (e.a !== e.b) pairCount.set(pk(e.a, e.b), (pairCount.get(pk(e.a, e.b)) ?? 0) + 1)
  for (const e of edges) {
    if (e.routes.size >= 2) e.cls = 'coline'
    else if (e.a === e.b) e.cls = 'loop'
    else if ((pairCount.get(pk(e.a, e.b)) ?? 0) >= 2) e.cls = 'parallel'
    else e.cls = 'plain'
    // Colours of the routes on this edge — a co-line edge is drawn as their
    // interleaved dashes (same as the metro map's overlap), plain uses the first.
    e.routeColors = [...e.routes].map((id) => routes.get(id)?.color ?? '#e11d48')
    if (e.cls === 'plain') e.color = e.routeColors[0] ?? '#e11d48'
  }

  // final per-station class: start from node class; interior black stations of
  // each edge get pink (bends) / purple (cuts) / gray (over-long separators).
  const stationClass = new Map(cls)
  // Per pink station: the geometry used to pick it, for the hover reference lines.
  const pinkInfo = new Map()
  const arcAt = (path) => {
    const cum = [0]
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dist(coord.get(path[i - 1]), coord.get(path[i])))
    return cum
  }
  const nearestInteriorIndex = (path, cum, frac) => {
    const target = frac * cum[cum.length - 1]
    let best = -1, bd = Infinity
    for (let i = 1; i < path.length - 1; i++) {
      const d = Math.abs(cum[i] - target)
      if (d < bd) { bd = d; best = i }
    }
    return best
  }
  // Pink = representative bend, picked per edge in two gates:
  //   ① edge must be curvy enough: sinuosity = arcLength ÷ chord > PINK_SINUOSITY
  //      (loops have chord ≈ 0 → treated as extremely curvy). ≤ 1.25 → no pink.
  //   ② Douglas–Peucker with a relative tolerance keeps the bends: at each split
  //      the farthest point is kept when perpDist ÷ chord > PINK_DP_TOL.
  // A kept vertex is marked pink only if it is still a black (through) station.
  const PINK_SINUOSITY = 1.25
  const PINK_DP_TOL = 0.25
  for (const e of edges) {
    const { path } = e
    if (path.length < 3) continue
    const cum = arcAt(path)

    // ⑤ purple cuts
    if (e.cls === 'parallel') {
      const i = nearestInteriorIndex(path, cum, 0.5)
      if (i > 0) stationClass.set(path[i], 'purple')
    } else if (e.cls === 'loop') {
      for (const frac of [1 / 3, 2 / 3]) {
        const i = nearestInteriorIndex(path, cum, frac)
        if (i > 0) stationClass.set(path[i], 'purple')
      }
    }

    // ⑥ pink bends: sinuosity gate, then relative Douglas–Peucker.
    const pts = path.map((id) => coord.get(id))
    const chord = dist(pts[0], pts[pts.length - 1])
    const sinuosity = chord > 1e-9 ? cum[cum.length - 1] / chord : Infinity
    if (sinuosity > PINK_SINUOSITY) {
      const kept = new Map()
      dpKeep(pts, 0, pts.length - 1, PINK_DP_TOL, kept)
      for (const [i, info] of kept) {
        if (i > 0 && i < path.length - 1 && stationClass.get(path[i]) === 'black') {
          stationClass.set(path[i], 'pink')
          const A = pts[info.i0], B = pts[info.i1]
          pinkInfo.set(path[i], {
            chordA: pts[0], chordB: pts[pts.length - 1], // whole-edge chord (sinuosity)
            baseA: A, baseB: B, // DP sub-segment baseline this point was kept against
            pt: pts[i], foot: footOnLine(pts[i], A, B), // the point + its perpendicular foot
            sinuosity, ratio: info.ratio,
          })
        }
      }
    }

    // ⑥ gray separators: within each run of black between boundaries (nodes +
    // pink/purple), G = floor(N/5) grays, spread toward the middle.
    let runStart = 0
    for (let i = 1; i < path.length; i++) {
      const boundary = i === path.length - 1 || stationClass.get(path[i]) !== 'black'
      if (!boundary) continue
      const blacks = []
      for (let j = runStart + 1; j < i; j++) if (stationClass.get(path[j]) === 'black') blacks.push(j)
      const G = Math.floor(blacks.length / 5)
      for (let g = 1; g <= G; g++) {
        const idx = blacks[Math.round((g / (G + 1)) * (blacks.length - 1))]
        if (idx != null) stationClass.set(path[idx], 'gray')
      }
      runStart = i
    }
  }

  return { stationClass, edges, pinkInfo, yellow: [] }
}
