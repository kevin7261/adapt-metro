// Connect skeleton (骨架2) — see skill route-skeleton-connect.
// Topological contraction of the network: keeps the original geographic line
// shape (nothing is straightened / moved) and only CLASSIFIES nodes and edges.
// Nodes by graph degree: red (junction / route-change), blue (endpoint),
// black (through). Edges: coline (≥2 distinct colours) / loop / parallel / plain. Then
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
        name: r.route_name ?? '',
        color: r.route_color ?? '#e11d48',
        stations: (r.stations ?? []).map((s) => s.station_id).filter((id) => coord.has(id)),
      })
    }
  }

  // ② geometric crossings → synthetic YELLOW nodes, inserted into BOTH routes'
  // station sequences so the crossing splits the edges there (a shared vertex on
  // both polylines). Detect on the ORIGINAL polylines (interior of both segments,
  // t,u strictly in (0,1) → shared-station endpoints excluded), then splice.
  // Includes SAME-route self-crossings (a route that loops back over itself): the
  // b = a pass compares a route's non-adjacent segments against each other.
  const crossings = []        // { id, coord } for the renderer
  const crossIds = new Set()  // synthetic ids — forced 'yellow' after classification
  {
    const routeArr = [...routes.values()]
    const ptsOf = (rt) => rt.stations.map((id) => coord.get(id))
    const keyToId = new Map()
    const perRoute = new Map(routeArr.map((rt) => [rt, []])) // rt -> [{seg, t, id}]
    let xn = 0
    const segX = (p1, p2, p3, p4) => {
      const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1]
      const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1]
      const den = d1x * d2y - d1y * d2x
      if (Math.abs(den) < 1e-14) return null
      const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den
      const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den
      const E = 1e-6
      if (t <= E || t >= 1 - E || u <= E || u >= 1 - E) return null
      return { x: [p1[0] + t * d1x, p1[1] + t * d1y], t, u }
    }
    for (let a = 0; a < routeArr.length; a++) {
      const A = ptsOf(routeArr[a])
      for (let b = a; b < routeArr.length; b++) { // b = a → same-route self-crossings
        const B = ptsOf(routeArr[b])
        const self = a === b
        for (let i = 1; i < A.length; i++) {
          const aMinX = Math.min(A[i - 1][0], A[i][0]), aMaxX = Math.max(A[i - 1][0], A[i][0])
          const aMinY = Math.min(A[i - 1][1], A[i][1]), aMaxY = Math.max(A[i - 1][1], A[i][1])
          // self: start at i+2 so a segment is never tested against itself or its
          // vertex-sharing neighbour, and each self pair is tested once.
          for (let j = self ? i + 2 : 1; j < B.length; j++) {
            if (Math.min(B[j - 1][0], B[j][0]) > aMaxX || Math.max(B[j - 1][0], B[j][0]) < aMinX ||
                Math.min(B[j - 1][1], B[j][1]) > aMaxY || Math.max(B[j - 1][1], B[j][1]) < aMinY) continue
            const r = segX(A[i - 1], A[i], B[j - 1], B[j])
            if (!r) continue
            const key = `${r.x[0].toFixed(6)},${r.x[1].toFixed(6)}`
            let id = keyToId.get(key)
            if (!id) {
              id = `x${xn++}`
              keyToId.set(key, id); coord.set(id, r.x)
              crossings.push({ id, coord: r.x }); crossIds.add(id)
            }
            perRoute.get(routeArr[a]).push({ seg: i, t: r.t, id })
            perRoute.get(routeArr[b]).push({ seg: j, t: r.u, id })
          }
        }
      }
    }
    // splice synthetic ids into each route (descending seg index so earlier
    // segment positions stay valid; within a segment, ordered along it by t)
    for (const rt of routeArr) {
      const ins = perRoute.get(rt)
      if (!ins.length) continue
      const bySeg = new Map()
      for (const it of ins) { if (!bySeg.has(it.seg)) bySeg.set(it.seg, []); bySeg.get(it.seg).push(it) }
      for (const seg of [...bySeg.keys()].sort((p, q) => q - p)) {
        const ids = bySeg.get(seg).sort((p, q) => p.t - q.t).map((p) => p.id)
        const uniq = ids.filter((id, k) => k === 0 || id !== ids[k - 1])
        rt.stations.splice(seg, 0, ...uniq)
      }
    }
  }

  // NOTE: the skeleton is a pure TOPOLOGICAL contraction of the Metro Maps
  // network — it never adds edges/lines the original drawing doesn't have. An
  // earlier "express-over-local" step inserted skipped stations into express
  // routes to merge shared corridors (HK Airport Express + 東涌線), but that
  // fabricated junctions/edges (Sunny Bay became degree-3) and made the skeleton
  // show MORE lines than Metro Maps — wrong. Express/local that Metro Maps draws
  // as separate lines stay separate here. The pass/stop relation is surfaced for
  // display only (computePassThrough, 物件 tab); it does NOT touch the topology.

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
  // Geometric crossings are yellow skeleton nodes (override the degree rule) —
  // they split the edges they sit on.
  for (const id of crossIds) cls.set(id, 'yellow')
  const isNode = (id) => cls.get(id) !== 'black' // red/blue/yellow are skeleton nodes

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

  // Real folded geometry per adjacent-station pair, from the line features — so a
  // contracted edge can carry its TRUE geographic shape even where the polyline
  // holds NON-station vertices (a route running express over a corridor bends
  // along the real track; 見 SKILL 資料前提). Keyed by station pair; `from`
  // orients the stored coords. The edge-class highlight underlay is drawn from
  // this so it hugs the same curve as the line (drawing it from station points
  // would straighten express-skip legs and stick out from under the line).
  const geomByPair = new Map()
  {
    const keyOf = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`
    const stByCoord = new Map()
    for (const [id, c] of coord) stByCoord.set(keyOf(c), id)
    // Split each feature polyline at THIS route's STOPS — not at every station
    // vertex. An express feature's geometry runs THROUGH the intermediate
    // stations it skips (they're vertices but not stops), so its Strathfield→
    // Redfern edge must own the whole folded polyline through them, not a
    // straight chord. Per route: keep only vertices that are stops of that route.
    for (const f of geojson?.features ?? []) {
      if (!f.geometry || f.geometry.type === 'Point') continue
      const segs = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]
      for (const r of f.properties?.routes ?? []) {
        const stops = routes.get(r.route_id)?.stations
        if (!stops) continue
        const stopSet = new Set(stops.filter((id) => coord.has(id)))
        for (const seg of segs) {
          const stIdx = []
          for (let i = 0; i < seg.length; i++) {
            const id = stByCoord.get(keyOf(seg[i]))
            if (id != null && stopSet.has(id)) stIdx.push([i, id])
          }
          for (let k = 1; k < stIdx.length; k++) {
            const [i0, a] = stIdx[k - 1], [i1, b] = stIdx[k]
            const key = pk(a, b)
            if (!geomByPair.has(key)) geomByPair.set(key, { from: a, coords: seg.slice(i0, i1 + 1) })
          }
        }
      }
    }
  }
  const posAll = new Map(coord) // real stations + synthetic yellow-crossing coords
  for (const c of crossings) posAll.set(c.id, c.coord)
  for (const e of edges) {
    const g = []
    const push = (c) => { const l = g[g.length - 1]; if (!l || l[0] !== c[0] || l[1] !== c[1]) g.push(c) }
    for (let i = 1; i < e.path.length; i++) {
      const a = e.path[i - 1], b = e.path[i]
      const rec = geomByPair.get(pk(a, b))
      let leg
      if (rec) leg = rec.from === a ? rec.coords : [...rec.coords].reverse()
      else { const pa = posAll.get(a), pb = posAll.get(b); leg = pa && pb ? [pa, pb] : [] }
      for (const c of leg) push(c)
    }
    e.geom = g
  }

  // edge classification
  const pairCount = new Map() // "a|b" (non-loop) -> count of distinct edges
  for (const e of edges) if (e.a !== e.b) pairCount.set(pk(e.a, e.b), (pairCount.get(pk(e.a, e.b)) ?? 0) + 1)
  for (const e of edges) {
    // Colours of the routes on this edge. Co-line means ≥2 DISTINCT colours share
    // the stretch (drawn as interleaved dashes). Same-colour route_ids on one edge
    // are the SAME line (e.g. Singapore CCL's two route_ids for the Marina Bay↔
    // HarbourFront loop and the HarbourFront↔Dhoby Ghaut section) — NOT co-line;
    // classifying them coline drew the arc as offset parallels that broke at the
    // HarbourFront junction where they met the single-line closure. Matches the
    // metro map's distinct-colour rule (LayerTab `_nc`).
    e.routeColors = [...e.routes].map((id) => routes.get(id)?.color ?? '#e11d48')
    const distinctColors = new Set(e.routeColors).size
    if (distinctColors >= 2) e.cls = 'coline'
    else if (e.a === e.b) e.cls = 'loop'
    else if ((pairCount.get(pk(e.a, e.b)) ?? 0) >= 2) e.cls = 'parallel'
    else e.cls = 'plain'
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

  return { stationClass, edges, pinkInfo, crossings }
}

// Pass-through relation (物件 tab 用): a route whose track PASSES a station it
// doesn't stop at — an express skipping a local's stop (HK Airport Express
// passes 欣澳/荔景…). Same chord-proximity test the skeleton uses to merge
// express corridors, but exposed for display. Pure function. Returns:
//   stopByStation: Map<station_id, [{route_ref, route_name, route_color}]>  routes STOPPING here
//   passByStation: Map<station_id, [{route_ref, route_name, route_color}]>  routes PASSING here (no stop)
//   seqByRoute:    Map<route_id, [{station_id, station_name, pass}]>        merged station order, pass=通過不停
export function computePassThrough(geojson, opts = {}) {
  const PERP = opts.perp ?? 0.08
  const coord = new Map()
  const nameById = new Map()
  for (const f of geojson?.features ?? []) {
    if (f.geometry?.type === 'Point') {
      coord.set(f.properties.station_id, f.geometry.coordinates)
      nameById.set(f.properties.station_id, f.properties.station_name)
    }
  }
  const routes = new Map()
  for (const f of geojson?.features ?? []) {
    if (f.geometry?.type === 'Point') continue
    for (const r of f.properties?.routes ?? []) {
      if (!r.route_id || routes.has(r.route_id)) continue
      routes.set(r.route_id, {
        ref: r.route_ref, name: r.route_name, color: r.route_color,
        stations: (r.stations ?? []).map((s) => s.station_id).filter((id) => coord.has(id)),
      })
    }
  }
  const stationIds = [...coord.keys()]
  const stopByStation = new Map()
  const passByStation = new Map()
  const seqByRoute = new Map()
  const add = (map, key, val) => { if (!map.has(key)) map.set(key, []); map.get(key).push(val) }
  for (const [rid, rt] of routes) {
    const meta = { route_ref: rt.ref, route_name: rt.name, route_color: rt.color }
    for (const sid of new Set(rt.stations)) add(stopByStation, sid, meta)
    const stops = new Set(rt.stations)
    const seq = rt.stations.length
      ? [{ station_id: rt.stations[0], station_name: nameById.get(rt.stations[0]), pass: false }]
      : []
    for (let i = 1; i < rt.stations.length; i++) {
      const A = rt.stations[i - 1], B = rt.stations[i]
      const pA = coord.get(A), pB = coord.get(B)
      const dx = pB[0] - pA[0], dy = pB[1] - pA[1], len2 = dx * dx + dy * dy
      const mids = []
      if (len2 > 1e-18) {
        const chord = Math.sqrt(len2)
        for (const s of stationIds) {
          if (stops.has(s)) continue
          const P = coord.get(s)
          const t = ((P[0] - pA[0]) * dx + (P[1] - pA[1]) * dy) / len2
          if (t <= 0.02 || t >= 0.98) continue
          if (Math.hypot(P[0] - (pA[0] + t * dx), P[1] - (pA[1] + t * dy)) <= PERP * chord) mids.push({ s, t })
        }
        mids.sort((p, q) => p.t - q.t)
      }
      for (const m of mids) {
        seq.push({ station_id: m.s, station_name: nameById.get(m.s), pass: true })
        add(passByStation, m.s, meta)
      }
      seq.push({ station_id: B, station_name: nameById.get(B), pass: false })
    }
    seqByRoute.set(rid, seq)
  }
  return { stopByStation, passByStation, seqByRoute }
}
