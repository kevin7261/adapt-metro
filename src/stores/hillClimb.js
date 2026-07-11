// Hill-climbing multicriteria layout (②, 爬山法) — see skill route-hillclimb.
// Stott, Rodgers et al. (2011), "Automatic Metro Map Layout Using Multicriteria
// Optimization", IEEE TVCG 17(1). Weighted multicriteria fitness + hill climbing
// on an INTEGER GRID, applied after the schematic gridding (⑨):
//
//   vertices  = the grid's cut points (all non-black skeleton nodes, incl.
//               yellow crossings) with their integer cells from buildSchematicGrid
//   segments  = the straight cut-to-cut sub-segments of each skeleton edge
//               (a multi-route corridor stays ONE segment with route metadata)
//   black through stations are NOT vertices — the caller re-spreads them along
//   the moved segments afterwards (placeBlacks in schematicGrid.js).
//
// Station criteria (paper eq. 1–5, lower = better): c_N1 angular resolution,
// c_N2 edge length, c_N3 balanced edge length (deg-2), c_N4 line straightness,
// c_N5 octilinearity. Hard rules (veto, §5): bounding area, relative position
// (quadrant), occlusions (cell/vertex-on-edge/edge crossings), edge ordering.
// Local minima: overlength-edge cluster moves (§6.1). Labels (§7) are out of
// scope — station labels here are a style toggle drawn after layout.
//
// Pure function in CELL SPACE: deterministic, input maps unchanged.

const TWO_PI = 2 * Math.PI

// Paper table 4 weights (Mexico City / Sydney), overridable via opts.weights.
const DEFAULT_W = {
  angular: 30000, // w_N1 角解析度
  length: 50,     // w_N2 邊長
  balanced: 45,   // w_N3 平衡邊長
  straight: 220,  // w_N4 線條平直
  octi: 9250,     // w_N5 八方向性
}

/* ---- exact integer geometry ---- */
const ckey = (c, r) => `${c},${r}`
// orientation of p→q→r: >0 ccw, <0 cw, 0 collinear (exact on integer cells)
const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
// p on closed segment a–b (requires collinearity)
const onSeg = (p, a, b) =>
  orient(a, b, p) === 0 &&
  Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
  Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
// segments a–b and c–d share ANY point (touching / collinear overlap included)
function segsIntersect(a, b, c, d) {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
      Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false
  const o1 = orient(a, b, c), o2 = orient(a, b, d)
  const o3 = orient(c, d, a), o4 = orient(c, d, b)
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
      ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true
  if (o1 === 0 && onSeg(c, a, b)) return true
  if (o2 === 0 && onSeg(d, a, b)) return true
  if (o3 === 0 && onSeg(a, c, d)) return true
  if (o4 === 0 && onSeg(b, c, d)) return true
  return false
}

const sharesRoute = (r1, r2) => {
  const [small, big] = r1.size <= r2.size ? [r1, r2] : [r2, r1]
  for (const id of small) if (big.has(id)) return true
  return false
}

// Post-pass (縮減網格 tab): drop every column/row that holds no coloured
// vertex. Cells are remapped by rank, so the relative order — and with it the
// network topology and every quadrant relation — is untouched; only the grid
// gets smaller (empty bands the hill climbing left behind disappear).
export function compactGrid(cellAfter, cols, rows) {
  const cells = [...cellAfter.values()]
  const usedC = [...new Set(cells.map((p) => p[0]))].sort((a, b) => a - b)
  const usedR = [...new Set(cells.map((p) => p[1]))].sort((a, b) => a - b)
  const mapC = new Map(usedC.map((c, i) => [c, i]))
  const mapR = new Map(usedR.map((r, i) => [r, i]))
  const out = new Map()
  for (const [id, [c, r]] of cellAfter) out.set(id, [mapC.get(c), mapR.get(r)])
  return {
    cellAfter: out,
    cols: usedC.length,
    rows: usedR.length,
    removedCols: cols - usedC.length,
    removedRows: rows - usedR.length,
  }
}

export function buildHillClimb(skeleton, cellOf, cols, rows, opts = {}) {
  const W = { ...DEFAULT_W, ...(opts.weights ?? {}) }
  const cls = skeleton.stationClass

  /* ---- HC graph: cut points + cut-to-cut segments ---- */
  const pos = new Map() // id -> [c, r] (integers, mutated by moves)
  const segs = []       // { a, b, routes:Set<routeId>, hops }
  const inc = new Map() // id -> [segIndex]
  const addVert = (id) => {
    if (pos.has(id)) return true
    const cell = cellOf.get(id)
    if (!cell) return false
    pos.set(id, [cell[0], cell[1]])
    inc.set(id, [])
    return true
  }
  for (const e of skeleton.edges) {
    const path = e.path
    const cuts = []
    for (let i = 0; i < path.length; i++) {
      if (i === 0 || i === path.length - 1 || cls.get(path[i]) !== 'black') cuts.push(i)
    }
    for (let s = 0; s + 1 < cuts.length; s++) {
      const a = path[cuts[s]], b = path[cuts[s + 1]]
      if (a === b) continue // degenerate (tiny ring) — no usable direction
      if (!addVert(a) || !addVert(b)) continue
      const si = segs.length
      segs.push({ a, b, routes: e.routes ?? new Set(), hops: cuts[s + 1] - cuts[s] })
      inc.get(a).push(si)
      inc.get(b).push(si)
    }
  }
  if (!pos.size || !segs.length) {
    return { cellAfter: pos, stats: { before: 0, after: 0, rounds: 0, moved: 0, clusterMoves: 0, idealHop: 1 } }
  }

  const other = (s, u) => (s.a === u ? s.b : s.a)
  const nbrsOf = (v) => {
    const out = new Set()
    for (const si of inc.get(v)) out.add(other(segs[si], v))
    out.delete(v)
    return out
  }
  const segLen = (s) => {
    const A = pos.get(s.a), B = pos.get(s.b)
    return Math.hypot(B[0] - A[0], B[1] - A[1])
  }

  // Ideal length per station-hop (paper: l·g). The dense rank grid has no fixed
  // scale, so derive it from the input: median initial length-per-hop.
  const perHop = segs.map((s) => segLen(s) / s.hops).sort((x, y) => x - y)
  const L = opts.idealHop ??
    Math.min(8, Math.max(1, Math.round(perHop[perHop.length >> 1] || 1)))

  /* ---- criteria (all read `pos`) ---- */
  // c_N1: adjacent-edge angles at u should all equal 2π/degree
  function angularCost(u) {
    const pu = pos.get(u)
    const dirs = []
    for (const si of inc.get(u)) {
      const o = pos.get(other(segs[si], u))
      if (o[0] === pu[0] && o[1] === pu[1]) continue
      dirs.push(Math.atan2(o[1] - pu[1], o[0] - pu[0]))
    }
    if (dirs.length < 2) return 0
    dirs.sort((x, y) => x - y)
    const ideal = TWO_PI / dirs.length
    let m = 0
    for (let i = 0; i < dirs.length; i++) {
      const gap = i + 1 < dirs.length ? dirs[i + 1] - dirs[i] : dirs[0] + TWO_PI - dirs[i]
      m += Math.abs(ideal - gap)
    }
    return m
  }
  // c_N3: degree-2 stations want equally long incident edges
  function balancedCost(u) {
    const list = inc.get(u)
    if (list.length !== 2) return 0
    return Math.abs(segLen(segs[list[0]]) - segLen(segs[list[1]]))
  }
  // c_N4: same metro line should run straight through u (angle → π)
  function straightCost(u) {
    const list = inc.get(u)
    if (list.length < 2) return 0
    const pu = pos.get(u)
    const dir = (si) => {
      const o = pos.get(other(segs[si], u))
      return (o[0] === pu[0] && o[1] === pu[1]) ? null : Math.atan2(o[1] - pu[1], o[0] - pu[0])
    }
    let m = 0
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!sharesRoute(segs[list[i]].routes, segs[list[j]].routes)) continue
        const d1 = dir(list[i]), d2 = dir(list[j])
        if (d1 == null || d2 == null) continue
        let between = Math.abs(d1 - d2)
        if (between > Math.PI) between = TWO_PI - between
        m += Math.PI - between // 0 when collinear through
      }
    }
    return m
  }
  // c_N2 + c_N5 per segment
  function segCost(s) {
    const A = pos.get(s.a), B = pos.get(s.b)
    const dx = B[0] - A[0], dy = B[1] - A[1]
    const len = Math.hypot(dx, dy)
    const lenC = Math.abs(len / (s.hops * L) - 1)
    const octiC = len < 1e-9 ? 0 : Math.abs(Math.sin(4 * Math.atan2(dy, dx)))
    return W.length * lenC + W.octi * octiC
  }
  const nodeCost = (u) =>
    W.angular * angularCost(u) + W.balanced * balancedCost(u) + W.straight * straightCost(u)
  // Fitness of a vertex set: its node terms + every incident segment once.
  // Moving v only changes terms inside costOfSet({v} ∪ N(v)) — the incremental
  // evaluation the paper calls out as the key speed-up.
  function costOfSet(vset) {
    let m = 0
    const done = new Set()
    for (const u of vset) {
      m += nodeCost(u)
      for (const si of inc.get(u)) {
        if (!done.has(si)) { done.add(si); m += segCost(segs[si]) }
      }
    }
    return m
  }
  const localSet = (v) => new Set([v, ...nbrsOf(v)])
  function totalFitness() {
    let m = 0
    for (const u of pos.keys()) m += nodeCost(u)
    for (const s of segs) m += segCost(s)
    return m
  }

  /* ---- hard rules (§5) ---- */
  const cellOwner = new Map() // "c,r" -> vertex id
  for (const [id, [c, r]] of pos) cellOwner.set(ckey(c, r), id)

  // ④ edge ordering: cyclic sequence of incident segment ids around u by angle
  function orderKey(u, at) {
    const pu = at(u)
    const items = []
    for (const si of inc.get(u)) {
      const o = at(other(segs[si], u))
      if (o[0] === pu[0] && o[1] === pu[1]) continue
      items.push([Math.atan2(o[1] - pu[1], o[0] - pu[0]), si])
    }
    items.sort((p, q) => p[0] - q[0] || p[1] - q[1])
    return items.map((it) => it[1])
  }
  function cyclicEqual(a, b) {
    if (a.length !== b.length) return false
    if (!a.length) return true
    const start = b.indexOf(a[0])
    if (start < 0) return false
    for (let i = 1; i < a.length; i++) if (a[i] !== b[(start + i) % b.length]) return false
    return true
  }

  // All hard rules for moving single vertex v to P (does not mutate `pos`).
  function validMove(v, P) {
    const [c, r] = P
    // ① bounding area + one vertex per cell
    if (c < 0 || r < 0 || c >= cols || r >= rows) return false
    const owner = cellOwner.get(ckey(c, r))
    if (owner !== undefined && owner !== v) return false
    const cur = pos.get(v)
    const nbrs = nbrsOf(v)
    // ② relative position: stay in the same quadrant w.r.t. every neighbour
    // (a vertex on a quadrant boundary may enter either side → sign 0 is free)
    for (const u of nbrs) {
      const pu = pos.get(u)
      const dxo = cur[0] - pu[0], dyo = cur[1] - pu[1]
      const dxn = c - pu[0], dyn = r - pu[1]
      if ((dxo > 0 && dxn < 0) || (dxo < 0 && dxn > 0)) return false
      if ((dyo > 0 && dyn < 0) || (dyo < 0 && dyn > 0)) return false
    }
    const incSet = new Set(inc.get(v))
    // ③a occlusion: P must not land on somebody else's segment
    for (let si = 0; si < segs.length; si++) {
      if (incSet.has(si)) continue
      const s = segs[si]
      if (onSeg(P, pos.get(s.a), pos.get(s.b))) return false
    }
    // ③b/③c: v's re-routed segments must not swallow a vertex or cross an edge
    for (const u of nbrs) {
      const pu = pos.get(u)
      for (const [w, pw] of pos) {
        if (w === v || w === u) continue
        if (onSeg(pw, P, pu)) return false
      }
      for (let si = 0; si < segs.length; si++) {
        if (incSet.has(si)) continue
        const s = segs[si]
        if (s.a === u || s.b === u) continue // legitimately meet at u
        if (segsIntersect(P, pu, pos.get(s.a), pos.get(s.b))) return false
      }
    }
    // ④ edge ordering unchanged at v and at each neighbour
    const atCur = (id) => pos.get(id)
    const atNew = (id) => (id === v ? P : pos.get(id))
    for (const u of [v, ...nbrs]) {
      if (inc.get(u).length < 3) continue // ≤2 edges: order is always preserved
      if (!cyclicEqual(orderKey(u, atCur), orderKey(u, atNew))) return false
    }
    return true
  }

  function applyMove(v, P) {
    const cur = pos.get(v)
    if (cellOwner.get(ckey(cur[0], cur[1])) === v) cellOwner.delete(ckey(cur[0], cur[1]))
    pos.set(v, [P[0], P[1]])
    cellOwner.set(ckey(P[0], P[1]), v)
  }

  // Scan the (2R+1)² rectangle around v (paper: findLowestStationCriteria).
  // Cheap fitness first, expensive geometric hard rules only on improvements.
  function bestCandidate(v, R) {
    const cur = pos.get(v)
    const set = localSet(v)
    const base = costOfSet(set)
    let best = null, bestCost = base - 1e-9
    for (let dc = -R; dc <= R; dc++) {
      for (let dr = -R; dr <= R; dr++) {
        if (!dc && !dr) continue
        const P = [cur[0] + dc, cur[1] + dr]
        pos.set(v, P)
        const m = costOfSet(set)
        pos.set(v, cur)
        if (m >= bestCost) continue
        if (!validMove(v, P)) continue
        bestCost = m
        best = P
      }
    }
    return best
  }

  /* ---- overlength-edge clusters (§6.1) ---- */
  const overlength = (s) => segLen(s) > s.hops * L + 1e-9
  function clusterComponents() {
    // connected components over IDEAL-length edges; overlength edges separate
    const parent = new Map([...pos.keys()].map((id) => [id, id]))
    const find = (x) => {
      let r = x
      while (parent.get(r) !== r) r = parent.get(r)
      let c = x
      while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n }
      return r
    }
    const union = (x, y) => { const a = find(x), b = find(y); if (a !== b) parent.set(a, b) }
    for (const s of segs) if (!overlength(s)) union(s.a, s.b)
    const comps = new Map()
    for (const id of pos.keys()) {
      const root = find(id)
      if (!comps.has(root)) comps.set(root, [])
      comps.get(root).push(id)
    }
    // only proper sub-clusters (moving the whole graph is a no-op), capped for perf
    return [...comps.values()]
      .filter((c) => c.length < pos.size && c.length <= 200)
      .map((c) => c.sort())
  }

  // Rigid translation of a cluster by (dc,dr): internal relations are fixed, so
  // hard rules only apply across the moving/static boundary.
  function validShift(comp, inC, dc, dr) {
    for (const w of comp) {
      const [c, r] = pos.get(w)
      const nc = c + dc, nr = r + dr
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) return false
      const owner = cellOwner.get(ckey(nc, nr))
      if (owner !== undefined && !inC.has(owner)) return false
      for (const u of nbrsOf(w)) { // quadrant w.r.t. static neighbours
        if (inC.has(u)) continue
        const pu = pos.get(u)
        const dxo = c - pu[0], dyo = r - pu[1]
        const dxn = nc - pu[0], dyn = nr - pu[1]
        if ((dxo > 0 && dxn < 0) || (dxo < 0 && dxn > 0)) return false
        if ((dyo > 0 && dyn < 0) || (dyo < 0 && dyn > 0)) return false
      }
    }
    const at = (id) => {
      const p = pos.get(id)
      return inC.has(id) ? [p[0] + dc, p[1] + dr] : p
    }
    // occlusion across the boundary: every moved segment vs every static one
    for (let si = 0; si < segs.length; si++) {
      const s = segs[si]
      const movedS = inC.has(s.a) || inC.has(s.b)
      if (!movedS) continue
      const A = at(s.a), B = at(s.b)
      for (let sj = 0; sj < segs.length; sj++) {
        const t = segs[sj]
        if (inC.has(t.a) || inC.has(t.b)) continue // both moving or handled above
        if (t.a === s.a || t.a === s.b || t.b === s.a || t.b === s.b) continue
        if (segsIntersect(A, B, pos.get(t.a), pos.get(t.b))) return false
      }
      for (const [w, pw] of pos) { // static vertex swallowed by a moved segment
        if (inC.has(w) || w === s.a || w === s.b) continue
        if (onSeg(pw, A, B)) return false
      }
    }
    for (const w of comp) { // moved vertex landing on a static segment
      const pw = at(w)
      for (let si = 0; si < segs.length; si++) {
        const s = segs[si]
        if (inC.has(s.a) || inC.has(s.b)) continue
        if (onSeg(pw, pos.get(s.a), pos.get(s.b))) return false
      }
    }
    // edge ordering at every boundary vertex (both sides)
    const checked = new Set()
    for (const w of comp) {
      for (const u of nbrsOf(w)) {
        if (inC.has(u)) continue
        for (const x of [w, u]) {
          if (checked.has(x) || inc.get(x).length < 3) continue
          checked.add(x)
          if (!cyclicEqual(orderKey(x, (id) => pos.get(id)), orderKey(x, at))) return false
        }
      }
    }
    return true
  }

  function bestClusterShift(comp, R) {
    const inC = new Set(comp)
    // fitness changes only at the boundary: cluster verts with static neighbours
    // + those static neighbours (their node terms + incident segments)
    const evalSet = new Set()
    for (const w of comp) {
      for (const u of nbrsOf(w)) {
        if (inC.has(u)) continue
        evalSet.add(w)
        evalSet.add(u)
      }
    }
    if (!evalSet.size) return null // detached component — nothing to gain
    const shift = (dc, dr) => { for (const w of comp) { const p = pos.get(w); p[0] += dc; p[1] += dr } }
    const base = costOfSet(evalSet)
    let best = null, bestCost = base - 1e-9
    for (let dc = -R; dc <= R; dc++) {
      for (let dr = -R; dr <= R; dr++) {
        if (!dc && !dr) continue
        shift(dc, dr)
        const m = costOfSet(evalSet)
        shift(-dc, -dr)
        if (m >= bestCost) continue
        if (!validShift(comp, inC, dc, dr)) continue
        bestCost = m
        best = [dc, dr]
      }
    }
    return best
  }
  function applyShift(comp, [dc, dr]) {
    for (const w of comp) {
      const [c, r] = pos.get(w)
      if (cellOwner.get(ckey(c, r)) === w) cellOwner.delete(ckey(c, r))
      pos.set(w, [c + dc, r + dr])
    }
    for (const w of comp) { const [c, r] = pos.get(w); cellOwner.set(ckey(c, r), w) }
  }

  /* ---- main loop (Algorithm 1): per-vertex moves + cluster moves, cooling ---- */
  // Search rectangle shrinks each round (paper: max move 8, 5 iterations); big
  // graphs default to a smaller schedule to stay interactive.
  const radii = opts.radii ?? (pos.size > 300 ? [4, 3, 2, 1] : [8, 6, 4, 3, 2])
  const vertIds = [...pos.keys()].sort()
  const before = totalFitness()
  let rounds = 0, moved = 0, clusterMoves = 0
  for (const R of radii) {
    rounds++
    let improved = false
    for (const v of vertIds) {
      const P = bestCandidate(v, R)
      if (P) { applyMove(v, P); moved++; improved = true }
    }
    for (const comp of clusterComponents()) {
      const d = bestClusterShift(comp, Math.min(R, 3))
      if (d) { applyShift(comp, d); clusterMoves++; improved = true }
    }
    if (!improved) break // a full round without improvement → converged
  }
  const after = totalFitness()

  return {
    cellAfter: pos, // id -> [col,row]; caller maps to pixels + placeBlacks
    stats: { before, after, rounds, moved, clusterMoves, idealHop: L, verts: pos.size, segs: segs.length },
  }
}
