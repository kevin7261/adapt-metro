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
        stations: (r.stations ?? []).filter((s) => !s.pass).map((s) => s.station_id).filter((id) => coord.has(id)),
      })
    }
  }

  // ② geometric crossings → synthetic YELLOW nodes, inserted into BOTH routes'
  // station sequences so the crossing splits the edges there (a shared vertex on
  // both polylines). Detect on the ORIGINAL polylines (interior of both segments,
  // t,u strictly in (0,1) → shared-station endpoints excluded), then splice.
  // Includes SAME-route self-crossings (a route that loops back over itself): the
  // b = a pass compares a route's non-adjacent segments against each other.
  //
  // The station-CHORD (station→station straight line) is only a candidate filter:
  // two chords can cross where the REAL curved tracks don't (the chord shortcuts a
  // bend), yielding a yellow node on empty space and lifting the edge highlight off
  // the line. So every chord candidate is validated against the two routes' REAL
  // folded geometry between those stops — the crossing survives only if the tracks
  // actually intersect, and its coordinate is that EXACT real intersection (dead on
  // both lines). 使用者規則：沒交叉的地方不可出現黃點、算多少就是多少不可有偏差。
  const crossings = []        // { id, coord } for the renderer
  const crossIds = new Set()  // synthetic ids — forced 'yellow' after classification
  {
    const routeArr = [...routes.values()]
    const ptsOf = (rt) => rt.stations.map((id) => coord.get(id))
    const keyToId = new Map()
    const perRoute = new Map(routeArr.map((rt) => [rt, []])) // rt -> [{seg, t, id}]
    let xn = 0
    const pkc = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
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
    // Real folded geometry between each route's consecutive STOPS, from the line
    // features (coord holds no crossings yet). Keyed by route + unordered stop
    // pair. Used to confirm a chord candidate is a real track intersection.
    const keyOfC = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`
    const stByCoordC = new Map()
    for (const [id, c] of coord) stByCoordC.set(keyOfC(c), id)
    const realLeg = new Map()
    for (const f of geojson?.features ?? []) {
      if (!f.geometry || f.geometry.type === 'Point') continue
      const segs = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]
      for (const r of f.properties?.routes ?? []) {
        const rt = routes.get(r.route_id)
        if (!rt) continue
        const stopSet = new Set(rt.stations)
        for (const seg of segs) {
          const marks = []
          for (let i = 0; i < seg.length; i++) {
            const id = stByCoordC.get(keyOfC(seg[i]))
            if (id != null && stopSet.has(id)) marks.push([i, id])
          }
          for (let k = 1; k < marks.length; k++) {
            const [i0, sa] = marks[k - 1], [i1, sb] = marks[k]
            const kk = `${rt.id}|${pkc(sa, sb)}`
            if (!realLeg.has(kk)) realLeg.set(kk, seg.slice(Math.min(i0, i1), Math.max(i0, i1) + 1))
          }
        }
      }
    }
    // 每條 route 實際畫出的 feature 幾何（所有相鄰頂點段），用來驗證「交點是否真的落在
    // 畫出的線上」。跳站特快的站點弦（A→D 直線）不是畫出的線（feature 走 A→B→C→D，
    // 或沿共軌慢車走廊），其弦交點會浮在軌道外——NYC 快慢車共軌處尤甚。
    const routeGeom = new Map() // route_id -> [[p1,p2],…]
    for (const f of geojson?.features ?? []) {
      if (!f.geometry || f.geometry.type === 'Point') continue
      const segs = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]
      for (const r of f.properties?.routes ?? []) {
        if (!routes.has(r.route_id)) continue
        let arr = routeGeom.get(r.route_id)
        if (!arr) { arr = []; routeGeom.set(r.route_id, arr) }
        for (const seg of segs) for (let i = 1; i < seg.length; i++) arr.push([seg[i - 1], seg[i]])
      }
    }
    // 交點 p 是否落在 route rid 的某條畫出線段的 ~30 m 內（經度依緯度縮放）。
    const onRouteGeom = (p, rid) => {
      const arr = routeGeom.get(rid)
      if (!arr) return false
      const cosL = Math.cos(p[1] * Math.PI / 180)
      for (const [a2, b2] of arr) {
        const dx = (b2[0] - a2[0]) * cosL, dy = b2[1] - a2[1], L2 = dx * dx + dy * dy || 1e-18
        let t = (((p[0] - a2[0]) * cosL) * dx + ((p[1] - a2[1])) * dy) / L2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const ex = (p[0] - a2[0]) * cosL - t * dx, ey = (p[1] - a2[1]) - t * dy
        if (Math.hypot(ex, ey) * 111000 < 30) return true
      }
      return false
    }
    // Nearest real track intersection of two stop-to-stop legs (null if the real
    // tracks don't meet between those stops → the chord crossing is spurious).
    const realHit = (legA, legB, near) => {
      if (!legA || !legB) return null
      let best = null, bestD = Infinity
      for (let p = 1; p < legA.length; p++) {
        for (let q = 1; q < legB.length; q++) {
          const h = segX(legA[p - 1], legA[p], legB[q - 1], legB[q])
          if (!h) continue
          const d = Math.hypot(h.x[0] - near[0], h.x[1] - near[1])
          if (d < bestD) { bestD = d; best = h.x }
        }
      }
      return best
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
            // Confirm against the real tracks. Conservative: only DROP when we
            // have both real legs AND they provably don't meet (the chord
            // shortcut a bend → spurious node); when real geometry is present we
            // also relocate the node onto the EXACT real intersection. If a leg's
            // real geometry can't be extracted we can't disprove it, so keep the
            // chord candidate as before (never lose a real crossing to a gap).
            const legA = realLeg.get(`${routeArr[a].id}|${pkc(routeArr[a].stations[i - 1], routeArr[a].stations[i])}`)
            const legB = realLeg.get(`${routeArr[b].id}|${pkc(routeArr[b].stations[j - 1], routeArr[b].stations[j])}`)
            let cx = r.x
            if (legA && legB) {
              const rx = realHit(legA, legB, r.x)
              if (!rx) continue // proven spurious — real tracks don't cross here
              cx = rx // exact real intersection (dead on both lines)
            }
            // 黃點必在兩條線「實際畫出的 feature 幾何」上，否則是浮空的站點弦交點——丟棄。
            // 落實「同軌服務不互相穿越」（NYC 快慢車共軌：畫出來重疊、弦卻在軌外相交）。
            if (!onRouteGeom(cx, routeArr[a].id) || !onRouteGeom(cx, routeArr[b].id)) continue
            const key = `${cx[0].toFixed(6)},${cx[1].toFixed(6)}`
            let id = keyToId.get(key)
            if (!id) {
              id = `x${xn++}`
              keyToId.set(key, id); coord.set(id, cx)
              crossings.push({ id, coord: cx }); crossIds.add(id)
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
  const keyOf = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`
  const stByCoord = new Map()
  for (const [id, c] of coord) stByCoord.set(keyOf(c), id)
  const geomByPair = new Map()
  {
    // Split each feature polyline at THIS route's STOPS — not at every station
    // vertex. An express feature's geometry runs THROUGH the intermediate
    // stations it skips (they're vertices but not stops), so its Strathfield→
    // Redfern edge must own the whole folded polyline through them, not a
    // straight chord. Per route: keep only vertices that are stops of that route.
    // A synthetic crossing (yellow) is spliced into the route's stops but is an
    // INTERIOR point of a feature segment (an interpolated intersection, never a
    // polyline vertex). We locate it on the segment it lies on and cut there too,
    // so a leg ending at a crossing carries the REAL track up to the exact
    // crossing point — not a straight chord that lifts the edge highlight off the
    // curved line (使用者規則：算多少就是多少，不可有偏差).
    const paramOnSeg = (p, a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy
      if (L2 < 1e-18) return null
      const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2
      if (t <= 1e-9 || t >= 1 - 1e-9) return null // strictly interior of this segment
      const ex = p[0] - (a[0] + t * dx), ey = p[1] - (a[1] + t * dy)
      return ex * ex + ey * ey < 1e-12 ? t : null // and actually ON it (collinear)
    }
    for (const f of geojson?.features ?? []) {
      if (!f.geometry || f.geometry.type === 'Point') continue
      const segs = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]
      for (const r of f.properties?.routes ?? []) {
        const stops = routes.get(r.route_id)?.stations
        if (!stops) continue
        const stopSet = new Set(stops.filter((id) => coord.has(id)))
        const xOnRoute = [...new Set(stops.filter((id) => crossIds.has(id)))] // crossings on this route
        for (const seg of segs) {
          // Cut points along this polyline, ordered by real-valued position
          // `pos` (integer = at that vertex; fractional = interpolated on the
          // segment starting at floor(pos)). Real stops sit at vertices; crossings
          // are located on the segment interior they fall on.
          const cuts = []
          for (let i = 0; i < seg.length; i++) {
            const id = stByCoord.get(keyOf(seg[i]))
            if (id != null && stopSet.has(id) && !crossIds.has(id)) cuts.push({ pos: i, id, coord: seg[i] })
          }
          for (let i = 1; i < seg.length; i++) {
            for (const xid of xOnRoute) {
              const t = paramOnSeg(coord.get(xid), seg[i - 1], seg[i])
              if (t != null) cuts.push({ pos: (i - 1) + t, id: xid, coord: coord.get(xid) })
            }
          }
          cuts.sort((p, q) => p.pos - q.pos)
          for (let k = 1; k < cuts.length; k++) {
            const A = cuts[k - 1], B = cuts[k]
            if (A.id === B.id) continue
            const key = pk(A.id, B.id)
            if (geomByPair.has(key)) continue
            // Exact sub-polyline: crossing endpoint verbatim, then every real
            // vertex strictly between the two cuts, then the other endpoint.
            const coords = [A.coord.slice()]
            for (let v = Math.ceil(A.pos + 1e-9); v <= Math.floor(B.pos - 1e-9); v++) coords.push(seg[v])
            coords.push(B.coord.slice())
            geomByPair.set(key, { from: A.id, coords })
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
        stations: (r.stations ?? []).filter((s) => !s.pass).map((s) => s.station_id).filter((id) => coord.has(id)),
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
