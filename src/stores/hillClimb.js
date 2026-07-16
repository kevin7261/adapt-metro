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

// A segment counts as horizontal/vertical when exactly ONE coordinate matches
// (both matching = degenerate). Shared readout of the three post-pass tabs.
function countHV(pos, segs) {
  let n = 0
  for (const s of segs) {
    const A = pos.get(s.a), B = pos.get(s.b)
    if ((A[0] === B[0]) !== (A[1] === B[1])) n++
  }
  return n
}

function cyclicEqual(a, b) {
  if (a.length !== b.length) return false
  if (!a.length) return true
  const start = b.indexOf(a[0])
  if (start < 0) return false
  for (let i = 1; i < a.length; i++) if (a[i] !== b[(start + i) % b.length]) return false
  return true
}

// Movement machinery shared by the optimizer and the post-passes (直角爬山 /
// 軸對齊 / 整數規劃): neighbourhood lookups, the §5 hard rules and the mutating
// move primitive. Closes over the LIVE `pos`; cellOwner mirrors it.
function makeMover(pos, segs, inc, cols, rows) {
  const other = (s, u) => (s.a === u ? s.b : s.a)
  const nbrsOf = (v) => {
    const out = new Set()
    for (const si of inc.get(v)) out.add(other(segs[si], v))
    out.delete(v)
    return out
  }

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

  // Rigid translation of a vertex group by (dc,dr): internal relations are
  // fixed, so hard rules only apply across the moving/static boundary.
  // (Shared by the optimizer's cluster moves and the 直線縮減 post-pass.)
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

  function applyShift(comp, [dc, dr]) {
    for (const w of comp) {
      const [c, r] = pos.get(w)
      if (cellOwner.get(ckey(c, r)) === w) cellOwner.delete(ckey(c, r))
      pos.set(w, [c + dc, r + dr])
    }
    for (const w of comp) { const [c, r] = pos.get(w); cellOwner.set(ckey(c, r), w) }
  }

  return { other, nbrsOf, cellOwner, orderKey, validMove, applyMove, validShift, applyShift }
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

// The HC graph shared by the optimizer and the RWD drawing (rwdMap.js):
// vertices = cut points that own a grid cell, segments = cut-to-cut sub-spans
// of each skeleton edge, with the interior (black) station ids and a back-ref
// to the parent edge (for route colours / class downstream).
export function buildHcGraph(skeleton, cellOf) {
  const cls = skeleton.stationClass
  const pos = new Map() // id -> [c, r] (integers, mutated by the optimizer)
  const segs = []       // { a, b, routes:Set<routeId>, hops, interior:[id], edge }
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
      segs.push({
        a, b,
        routes: e.routes ?? new Set(),
        hops: cuts[s + 1] - cuts[s],
        interior: path.slice(cuts[s] + 1, cuts[s + 1]), // black ids, in a→b order
        edge: e,
      })
      inc.get(a).push(si)
      inc.get(b).push(si)
    }
  }
  return { pos, segs, inc }
}

export function buildHillClimb(skeleton, cellOf, cols, rows, opts = {}) {
  const W = { ...DEFAULT_W, ...(opts.weights ?? {}) }

  const { pos, segs, inc } = buildHcGraph(skeleton, cellOf)
  if (!pos.size || !segs.length) {
    return { cellAfter: pos, stats: { before: 0, after: 0, rounds: 0, moved: 0, clusterMoves: 0, idealHop: 1, hvBefore: 0, hvAfter: 0 } }
  }

  const { other, nbrsOf, cellOwner, orderKey, validMove, applyMove, validShift, applyShift } =
    makeMover(pos, segs, inc, cols, rows)
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
  // c_N2 + c_N5 per segment. |sin(kθ)| with 4 lobes = octilinear (paper); the
  // 直角爬山 post-pass sets opts.rect → 2 lobes, so only H/V are free and 45°
  // becomes the most expensive direction.
  const dirLobes = opts.rect ? 2 : 4
  function segCost(s) {
    const A = pos.get(s.a), B = pos.get(s.b)
    const dx = B[0] - A[0], dy = B[1] - A[1]
    const len = Math.hypot(dx, dy)
    const lenC = Math.abs(len / (s.hops * L) - 1)
    const octiC = len < 1e-9 ? 0 : Math.abs(Math.sin(dirLobes * Math.atan2(dy, dx)))
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

  // Hard rules (§5) + move primitive come from makeMover above.

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
  /* ---- main loop (Algorithm 1): per-vertex moves + cluster moves, cooling ---- */
  // Search rectangle shrinks each round. Cap at ±2 cells so stations don't
  // wander far from the schematic-grid input (paper used up to 8).
  const radii = opts.radii ?? [2, 1, 1]
  const vertIds = [...pos.keys()].sort()
  const before = totalFitness()
  const hvBefore = countHV(pos, segs)
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
    stats: {
      before, after, rounds, moved, clusterMoves, idealHop: L,
      verts: pos.size, segs: segs.length, hvBefore, hvAfter: countHV(pos, segs),
    },
  }
}

/* ==================== post-passes（三個後處理 tab） ====================
   All three take the finished hill-climbing layout (cellAfter) as their input
   and move coloured vertices SHORT distances to maximise the number of
   horizontal/vertical segments. Same return shape { cellAfter, stats };
   stats always carry hvBefore / hvAfter / segs / verts / moved. */

// Apply per-vertex target cells through the hard rules: sequential passes over
// the sorted ids; each vertex tries its full target first, then one axis at a
// time (a blocked diagonal move often succeeds axis-wise, or only after a
// blocking vertex has itself moved in a later pass). Deterministic. The
// targets assume simultaneous moves, so a partially applied solution can break
// more alignments than it lands — if the net H/V count got worse, the whole
// application is rolled back and the input layout kept.
function applyTargets(pos, M, targets, segs, maxPasses = 6) {
  const start = new Map([...pos].map(([id, p]) => [id, [p[0], p[1]]]))
  const hv0 = countHV(pos, segs)
  const ids = [...targets.keys()].sort()
  let passes = 0
  for (let p = 0; p < maxPasses; p++) {
    passes++
    let changed = false
    for (const v of ids) {
      const cur = pos.get(v)
      const t = targets.get(v)
      if (cur[0] === t[0] && cur[1] === t[1]) continue
      for (const P of [[t[0], t[1]], [t[0], cur[1]], [cur[0], t[1]]]) {
        if (P[0] === cur[0] && P[1] === cur[1]) continue
        if (!M.validMove(v, P)) continue
        M.applyMove(v, P)
        changed = true
        break
      }
    }
    if (!changed) break
  }
  if (countHV(pos, segs) < hv0) {
    for (const [id, p] of start) pos.set(id, [p[0], p[1]])
    return { moved: 0, passes, reverted: true }
  }
  let moved = 0
  for (const [id, p] of pos) {
    const s = start.get(id)
    if (s[0] !== p[0] || s[1] !== p[1]) moved++
  }
  return { moved, passes, reverted: false }
}

// 迭代到不動點: feed a post-pass its own output until nothing moves (or the
// cap hits). One run is NOT a fixed point for any of the three — 直角爬山's
// radius schedule runs out before a no-improvement round, and 軸對齊/整數規劃
// create fresh alignment chances by moving (near-axis segments appear, the ±k
// window re-centres). 直角爬山 terminates by monotone fitness; the other two
// rely on the cap (measured: 2–12 iterations to converge, no cycles).
// Aggregated stats: hvBefore/before from the first run, hvAfter/after from the
// last, counters summed, moved = vertices that differ from the ORIGINAL input,
// plus { iters, iterCap, converged }.
export const POST_ITER_CAP = 20
export function iteratePost(build, skeleton, cells, cols, rows, opts = {}) {
  let cur = cells
  let iters = 0
  let first = null
  let last = null
  const acc = { rounds: 0, clusterMoves: 0, groupsH: 0, groupsV: 0, comps: 0, fallback: 0, passes: 0 }
  let reverted = false
  while (iters < POST_ITER_CAP) {
    const res = build(skeleton, cur, cols, rows, opts)
    iters++
    first ??= res.stats
    last = res.stats
    for (const k of Object.keys(acc)) {
      if (typeof res.stats[k] === 'number') acc[k] += res.stats[k]
    }
    reverted ||= !!res.stats.reverted
    cur = res.cellAfter
    if (!res.stats.moved) break
  }
  let moved = 0
  for (const [id, p] of cur) {
    const q = cells.get(id)
    if (q && (q[0] !== p[0] || q[1] !== p[1])) moved++
  }
  return {
    cellAfter: cur,
    stats: {
      ...last, ...acc, reverted,
      hvBefore: first.hvBefore, hvAfter: last.hvAfter,
      before: first.before, after: last.after, // rect fitness (undefined elsewhere)
      moved, iters, iterCap: POST_ITER_CAP, converged: last.moved === 0,
    },
  }
}

// ① 直角爬山: a second, short-radius hill-climbing polish with the direction
// criterion switched from octilinear |sin 4θ| to RECTILINEAR |sin 2θ| — 45°
// legs now cost as much as the worst direction, so segments get pulled onto
// horizontals/verticals wherever the hard rules allow. Criteria, hard rules
// and cluster moves are otherwise identical; the boosted weight compensates
// for the stricter 4-direction ideal.
export function buildRectPolish(skeleton, cells, cols, rows, opts = {}) {
  return buildHillClimb(skeleton, cells, cols, rows, {
    rect: true,
    radii: [2, 1, 1],
    weights: { octi: DEFAULT_W.octi * 3 },
    ...opts,
  })
}

// ② 軸對齊: orientation assignment + coordinate assignment. Per axis, every
// segment strictly closer to that axis (45° stays diagonal) and closable
// within maxShift votes its endpoints into one union-find group; each group
// aligns on the median member coordinate (L1-minimal total movement; members
// farther than maxShift drop out and the median re-settles). x and y are two
// independent 1-D problems; the merged targets then go through the SAME hard
// rules as the optimizer, so the result is always a valid layout (unreachable
// targets simply stay put).
export function buildAxisAlign(skeleton, cells, cols, rows, opts = {}) {
  const maxShift = opts.maxShift ?? 2
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) {
    return { cellAfter: pos, stats: { hvBefore: 0, hvAfter: 0, segs: 0, verts: pos.size, moved: 0, passes: 0, groupsH: 0, groupsV: 0 } }
  }
  const M = makeMover(pos, segs, inc, cols, rows)
  const hvBefore = countHV(pos, segs)

  const targets = new Map([...pos].map(([id, p]) => [id, [p[0], p[1]]]))
  const groups = [0, 0] // aligned groups per axis (0 = x/vertical, 1 = y/horizontal)
  for (const axis of [0, 1]) {
    const parent = new Map([...pos.keys()].map((id) => [id, id]))
    const find = (x) => {
      let r = x
      while (parent.get(r) !== r) r = parent.get(r)
      let c = x
      while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n }
      return r
    }
    for (const s of segs) {
      const A = pos.get(s.a), B = pos.get(s.b)
      const d = Math.abs(B[axis] - A[axis])              // must shrink to 0
      const dOther = Math.abs(B[1 - axis] - A[1 - axis]) // stays as the run
      if (d < dOther && d <= 2 * maxShift) {
        const ra = find(s.a), rb = find(s.b)
        if (ra !== rb) parent.set(ra, rb)
      }
    }
    const comp = new Map()
    for (const id of pos.keys()) {
      const r = find(id)
      if (!comp.has(r)) comp.set(r, [])
      comp.get(r).push(id)
    }
    for (const g of comp.values()) {
      if (g.length < 2) continue
      let members = g.slice().sort()
      for (;;) {
        const vals = members.map((id) => pos.get(id)[axis]).sort((x, y) => x - y)
        const med = vals[vals.length >> 1]
        const keep = members.filter((id) => Math.abs(pos.get(id)[axis] - med) <= maxShift)
        if (keep.length === members.length) {
          for (const id of members) targets.get(id)[axis] = med
          groups[axis]++
          break
        }
        if (keep.length < 2) break // group dissolved — everyone keeps their own
        members = keep
      }
    }
  }
  const { moved, passes, reverted } = applyTargets(pos, M, targets, segs)
  return {
    cellAfter: pos,
    stats: {
      hvBefore, hvAfter: countHV(pos, segs), segs: segs.length, verts: pos.size,
      moved, passes, reverted, groupsV: groups[0], groupsH: groups[1],
    },
  }
}

// Hill Climbing端點移動 — step 2 of the hc chain (HC → 端點移動 → 縮減網格;
// the hc 縮減網格 and the RWD base compact THIS output, while the other
// post-passes still branch off the raw HC result): EVERY coloured vertex
// (每個非白點 — endpoints, transfers, branches, crossings; white/black through
// stations are not vertices at all) may move so more of its incident segments
// become horizontal or vertical. Candidates = aligning one axis with each
// neighbour; a candidate is taken only when its NET H/V delta over the
// vertex's own segments is positive, so the global H/V count strictly grows
// (segments not incident to v are untouched — no revert needed). Each move is
// capped at ONE cell (使用者規則：移動不可超過 1 格)——遠處的對齊靠 movewise
// 的逐移動壓縮把距離拉近後、在後續移動慢慢完成. H/V 數不變的移動若能讓
// 「直線變長且斜線變短」也採納（使用者規則——典型是直線接斜線的轉折點，
// 沿直線方向推一格；兩者都要嚴格改善才動）. A currently
// straight (H/V) segment may only be BENT when the same move straightens a
// SAME-ROUTE segment in exchange (使用者規則：除非同名路線有拉直，否則不可
// 讓直線路段變少) — a net-positive move that sacrifices route X's straight
// leg to straighten route Y's is rejected. Each move still goes through the
// SAME §5 hard rules as the optimizer (makeMover): no new crossing, no
// landing on another segment or vertex, quadrant + edge-order preserved.
// Tie-breaks: bigger delta → continues a same-route H/V segment past the
// neighbour → smaller displacement. Runs under iteratePost — a move can
// unblock another vertex's move in the next iteration.
export function buildEndpointStraighten(skeleton, cells, cols, rows, opts = {}) {
  const limit = opts.limit ?? Infinity // 逐步驗證 子步驟：最多接受 limit 個移動
  const movedIds = []
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) {
    return { cellAfter: pos, stats: { hvBefore: 0, hvAfter: 0, segs: segs.length, verts: pos.size, moved: 0, endpoints: 0, movedIds } }
  }
  const M = makeMover(pos, segs, inc, cols, rows)
  const hvBefore = countHV(pos, segs)
  const isHV = (A, B) => (A[0] === B[0]) !== (A[1] === B[1])
  const ids = [...pos.keys()].sort()
  let moved = 0
  for (const v of ids) {
    if (moved >= limit) break
    const vsegs = inc.get(v).map((si) => segs[si])
    if (!vsegs.length) continue
    const pv = pos.get(v)
    const otherPos = (s) => pos.get(s.a === v ? s.b : s.a)
    const hvAt = (P) => vsegs.reduce((n, s) => n + (isHV(P, otherPos(s)) ? 1 : 0), 0)
    const cur = hvAt(pv)
    // Candidates: the four 1-cell unit moves — under the 1-cell cap, every
    // useful snap-onto-a-neighbour's-row/col candidate IS one of these, and
    // they additionally cover the length-improving moves (直線變長、斜線變短).
    const cand = new Map()
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const P = [pv[0] + dc, pv[1] + dr]
      cand.set(ckey(P[0], P[1]), P)
    }
    // 使用者規則的長度準則：v 入射段的（直線總長, 斜線總長）
    const lenOf = (P) => {
      let straight = 0, diag = 0
      for (const s of vsegs) {
        const pu = otherPos(s)
        const L = Math.hypot(P[0] - pu[0], P[1] - pu[1])
        if (isHV(P, pu)) straight += L
        else diag += L
      }
      return [straight, diag]
    }
    const [len0S, len0D] = lenOf(pv)
    // Tie-break: does an aligned segment continue straight into a same-route
    // H/V segment on the far side of its neighbour?
    const contScore = (P) => {
      let sc = 0
      for (const s of vsegs) {
        const u = s.a === v ? s.b : s.a
        const pu = pos.get(u)
        if (!isHV(P, pu)) continue
        const horiz = P[1] === pu[1]
        for (const si of inc.get(u)) {
          const t = segs[si]
          if (t === s || !sharesRoute(t.routes, s.routes)) continue
          const A = pos.get(t.a), B = pos.get(t.b)
          if (horiz ? (A[1] === B[1] && A[0] !== B[0]) : (A[0] === B[0] && A[1] !== B[1])) { sc++; break }
        }
      }
      return sc
    }
    // A bent segment must be paid for by a same-route segment straightening
    // in the same move; bending route X to straighten route Y is not allowed.
    const bendsPaid = (P) => {
      const gained = [], lost = []
      for (const s of vsegs) {
        const pu = otherPos(s)
        const before = isHV(pv, pu), after = isHV(P, pu)
        if (before && !after) lost.push(s)
        else if (!before && after) gained.push(s)
      }
      return lost.every((s) => gained.some((t) => sharesRoute(t.routes, s.routes)))
    }
    const scored = []
    for (const P of cand.values()) {
      const dist = Math.abs(P[0] - pv[0]) + Math.abs(P[1] - pv[1])
      if (dist > 1) continue // 使用者規則：端點移動每次移動不可超過 1 格
      const delta = hvAt(P) - cur
      let lenScore = 0
      if (delta > 0) {
        if (!bendsPaid(P)) continue
      } else if (delta === 0) {
        // 使用者規則（二擇一）：H/V 數不變，但這一步能——
        // (a) 讓「直線變長且斜線變短」（典型：直線接斜線的轉折點沿直線方向
        //     推一格；兩者都要嚴格改善），或
        // (b) v 是藍點（單一入射段）且「線變短」（把端點往鄰居收）。
        // 收斂：每步讓 (−H/V 數, 斜線長, 總長) 字典序嚴格下降——(a) 斜線長
        // 嚴格降、(b) 斜線長不增且總長嚴格降。
        const [s1, d1] = lenOf(P)
        const bendGain = s1 > len0S + 1e-9 && d1 < len0D - 1e-9
        const blueShorten = vsegs.length === 1 && s1 + d1 < len0S + len0D - 1e-9
        if (!bendGain && !blueShorten) continue
        if (!bendsPaid(P)) continue
        lenScore = bendGain ? (s1 - len0S) + (len0D - d1) : (len0S + len0D) - (s1 + d1)
      } else {
        continue // H/V 數不可變少
      }
      scored.push({ P, delta, cont: contScore(P), lenScore, dist })
    }
    scored.sort((a, b) => b.delta - a.delta || b.cont - a.cont
      || b.lenScore - a.lenScore
      || a.dist - b.dist || a.P[0] - b.P[0] || a.P[1] - b.P[1])
    for (const c of scored) {
      if (!M.validMove(v, c.P)) continue
      M.applyMove(v, c.P)
      moved++
      movedIds.push(v)
      break
    }
  }
  return {
    cellAfter: pos,
    stats: { hvBefore, hvAfter: countHV(pos, segs), segs: segs.length, verts: pos.size, moved, endpoints: pos.size, movedIds },
  }
}

// 直線縮減 one sweep: move whole straight LINES so FEWER distinct columns +
// rows are occupied (= how small the later 縮減網格 can compact to) — the
// grid DIMENSIONS are untouched; in the chain this pass runs AFTER 端點移動
// and BEFORE 縮減網格. A "line" is a maximal collinear chain of horizontal (or
// vertical) segments stitched ACROSS intersection vertices — the connected
// component over same-axis straight segments, so transfers, branches and
// yellow crossings a line runs straight through move with it. Moves are
// PERPENDICULAR ONLY (使用者規則：水平線只能上下移、垂直線只能左右移):
// jumps onto the nearest occupied rows/columns (any distance; the input grid
// may be sparse, ±2 would reach nothing) plus ±1/±2 steps. A shift is
// accepted only when it STRICTLY shrinks the occupied column+row count,
// does NOT reduce the network-wide H/V segment count (only boundary segments
// change under a rigid shift, so their net delta must be ≥ 0 — 使用者規則:
// 移動後不可以讓整個 network 的直線變少), and passes the SAME rigid-shift
// hard rules as the optimizer's cluster moves (validShift: no new crossing/
// occlusion, quadrant + edge order preserved) — the network structure is
// untouched. Tie-breaks: bigger gain → bigger H/V gain on the boundary
// segments → smaller displacement.
// straight-line components per axis (union-find over same-axis straight
// segments), stitched across intersection vertices — shared by 直線縮減 and
// 中位集中.
function lineComponents(pos, segs, horiz) {
  const parent = new Map()
  const find = (x) => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)
    let c = x
    while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n }
    return r
  }
  for (const s of segs) {
    const A = pos.get(s.a), B = pos.get(s.b)
    const straight = horiz ? (A[1] === B[1] && A[0] !== B[0]) : (A[0] === B[0] && A[1] !== B[1])
    if (!straight) continue
    for (const v of [s.a, s.b]) if (!parent.has(v)) parent.set(v, v)
    const a = find(s.a), b = find(s.b)
    if (a !== b) parent.set(a, b)
  }
  const comps = new Map()
  for (const v of parent.keys()) {
    const root = find(v)
    if (!comps.has(root)) comps.set(root, [])
    comps.get(root).push(v)
  }
  return [...comps.values()].filter((c) => c.length >= 2 && c.length < pos.size)
    .map((c) => c.sort()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

// net H/V change of the BOUNDARY segments (one endpoint moving, one static)
// under a rigid shift of the inC vertex set — internal/static segments are
// unchanged, so this is the network-wide H/V delta. Shared by 直線縮減 and
// 中位集中.
function boundaryHvDelta(pos, segs, inC, dc, dr) {
  const isHV = (A, B) => (A[0] === B[0]) !== (A[1] === B[1])
  let d = 0
  for (const s of segs) {
    const ma = inC.has(s.a), mb = inC.has(s.b)
    if (ma === mb) continue
    const A = pos.get(s.a), B = pos.get(s.b)
    const A2 = ma ? [A[0] + dc, A[1] + dr] : A
    const B2 = mb ? [B[0] + dc, B[1] + dr] : B
    d += (isHV(A2, B2) ? 1 : 0) - (isHV(A, B) ? 1 : 0)
  }
  return d
}

function lineCompactPass(skeleton, cells, cols, rows, opts = {}) {
  const limit = opts.limit ?? Infinity // 逐步驗證 子步驟：最多接受 limit 個移動
  const movedIds = []
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  const empty = { cellAfter: pos, moved: 0, hvBefore: 0, hvAfter: 0, segs: segs.length, verts: pos.size, occBefore: [0, 0], occAfter: [0, 0], movedIds }
  if (!pos.size || !segs.length) return empty
  const M = makeMover(pos, segs, inc, cols, rows)
  const hvBefore = countHV(pos, segs)

  // occupied-coordinate counts per axis; distinct cols+rows = compacted size
  const count = [new Map(), new Map()]
  const recount = () => {
    for (const ax of [0, 1]) {
      count[ax].clear()
      for (const p of pos.values()) count[ax].set(p[ax], (count[ax].get(p[ax]) ?? 0) + 1)
    }
  }
  recount()
  const axisDistinctAfter = (memAt, ax, d) => {
    const occ = new Set()
    for (const [x, n] of count[ax]) if (n - (memAt.get(x) ?? 0) > 0) occ.add(x)
    for (const x of memAt.keys()) occ.add(x + d)
    return occ.size
  }
  const gainOf = (mems, dc, dr) => {
    let gain = 0
    for (const [ax, d] of [[0, dc], [1, dr]]) {
      if (!d) continue
      const memAt = new Map()
      for (const w of mems) { const x = pos.get(w)[ax]; memAt.set(x, (memAt.get(x) ?? 0) + 1) }
      gain += count[ax].size - axisDistinctAfter(memAt, ax, d)
    }
    return gain
  }
  const occBefore = [count[0].size, count[1].size]
  let moved = 0
  for (const horiz of [true, false]) {
    for (const comp of lineComponents(pos, segs, horiz)) {
      if (moved >= limit) break
      const inC = new Set(comp)
      // perpendicular moves only（水平線只能上下移、垂直線只能左右移），且
      // 一次只能移一格（使用者規則）——movewise 下網格隨時緻密，相鄰欄列必有
      // 佔用，逐格合併即可，不需要遠跳。
      const deltas = [-1, 1]
      const scored = []
      for (const d of deltas) {
        const [dc, dr] = horiz ? [0, d] : [d, 0]
        const gain = gainOf(comp, dc, dr)
        if (gain <= 0) continue // must strictly shrink the occupied cols+rows
        const hv = boundaryHvDelta(pos, segs, inC, dc, dr)
        if (hv < 0) continue // 整個 network 的直線（H/V 段）不可變少
        scored.push({ dc, dr, gain, hv, dist: Math.abs(dc) + Math.abs(dr) })
      }
      scored.sort((a, b) => b.gain - a.gain || b.hv - a.hv
        || a.dist - b.dist || a.dc - b.dc || a.dr - b.dr)
      for (const c of scored) {
        if (!M.validShift(comp, inC, c.dc, c.dr)) continue
        M.applyShift(comp, [c.dc, c.dr])
        recount()
        moved++
        movedIds.push(...comp)
        break
      }
    }
  }
  return {
    cellAfter: pos, moved, hvBefore, hvAfter: countHV(pos, segs),
    segs: segs.length, verts: pos.size,
    occBefore, occAfter: [count[0].size, count[1].size], movedIds,
  }
}

// （直線縮減整段掃描的 wrapper 已退役——所有下游改走 movewiseStage('line')：
// 每一個移動後立即縮減網格。單掃描 pass 本身保留給 movewise/逐步驗證 用。）

// 中位集中 one sweep — two move kinds, both TOWARD the median point (the
// yellow marker: per-axis median of every coloured vertex):
// ① ANY coloured vertex with AT MOST TWO incident segments, all on one axis
// (只有左右兩條水平段、或上下兩條垂直段——紅轉乘/紫切點若剛好躺在直線上也
// 算；藍端點只有一段，一定可動), slides ALONG that line — horizontal →
// left/right only (toward the median column); vertical → up/down only.
// Mixed axes (a real bend) or ≥3 segments (branches, yellow crossings)
// never move. Sliding keeps every incident segment straight. Each move goes
// through makeMover.validMove (no crossing/occlusion, quadrant + edge order
// preserved — a vertex can never slide past its neighbour).
// ② whole stitched straight LINES (lineComponents — same stitching as
// 直線縮減) shift PERPENDICULARLY toward the median: horizontal lines
// up/down toward the median row, vertical lines left/right. Guards: the
// network-wide H/V count must not drop (boundaryHvDelta ≥ 0), the occupied
// column/row count must not grow (else it would undo 直線縮減 and fight it
// in the loop), and the SAME validShift hard rules apply.
// Candidates are tried from the median-most valid cell back to the current.
function medianGatherPass(skeleton, cells, cols, rows, opts = {}) {
  const limit = opts.limit ?? Infinity // 逐步驗證 子步驟：最多接受 limit 個移動
  const movedIds = []
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return { cellAfter: pos, moved: 0, movedPts: 0, movedLines: 0, segs: segs.length, verts: pos.size, movedIds }
  const M = makeMover(pos, segs, inc, cols, rows)
  const median = (vals) => {
    const s = [...vals].sort((a, b) => a - b)
    const m = s.length >> 1
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  const ps = [...pos.values()]
  const med = [median(ps.map((p) => p[0])), median(ps.map((p) => p[1]))]
  const isAlong = (ax) => (A, B) => A[1 - ax] === B[1 - ax] && A[ax] !== B[ax]
  // ── ① 點：入射段 ≤2 且同軸的有色點（藍點必然只有一段）沿線往中位點滑動 ──
  let movedPts = 0
  const ids = [...pos.keys()].sort()
  for (const v of ids) {
    if (movedPts >= limit) break
    const vsegs = inc.get(v).map((si) => segs[si])
    if (!vsegs.length || vsegs.length > 2) continue // 只有左右/上下兩段（或藍點一段）可沿線滑
    const pv = pos.get(v)
    const otherPos = (s) => pos.get(s.a === v ? s.b : s.a)
    for (const ax of [0, 1]) {
      if (!vsegs.every((s) => isAlong(ax)(pv, otherPos(s)))) continue
      const dir = Math.sign(med[ax] - pv[ax])
      if (!dir) break
      // 一次只能移動一格（使用者規則）：朝中位點跨一步、且不越過中位點
      const x = pv[ax] + dir
      const bound = dir > 0 ? Math.floor(med[ax]) : Math.ceil(med[ax])
      if (dir > 0 ? x > bound : x < bound) break // 已貼著中位點——不再靠近
      // 藍點（單段）不得把線拉長——否則會和端點移動的「線變短就收」在循環
      // 裡拉鋸（往中位點但遠離鄰居的滑動放棄，收線方向優先）。
      const blueLonger = vsegs.length === 1
        && Math.abs(x - otherPos(vsegs[0])[ax]) >= Math.abs(pv[ax] - otherPos(vsegs[0])[ax])
      if (!blueLonger) {
        const P = ax ? [pv[0], x] : [x, pv[1]]
        if (M.validMove(v, P)) {
          M.applyMove(v, P)
          movedPts++
          movedIds.push(v)
        }
      }
      break // all segments lie on this axis — the other axis cannot also apply
    }
  }
  // ── ② 線：串起來的直線整條垂直於線往中位點移（水平線上下往中位列、垂直線
  // 左右往中位欄）。走 validShift 硬規則，且不減全網 H/V、不增加佔用欄列數
  // （否則會吐回直線縮減剛省下的欄列、和它在循環裡互相拉扯）。──
  const occCount = (ax) => {
    const m = new Map()
    for (const p of pos.values()) m.set(p[ax], (m.get(p[ax]) ?? 0) + 1)
    return m
  }
  let movedLines = 0
  for (const horiz of [true, false]) {
    const perpAx = horiz ? 1 : 0
    for (const comp of lineComponents(pos, segs, horiz)) {
      if (movedPts + movedLines >= limit) break
      const inC = new Set(comp)
      const at = pos.get(comp[0])[perpAx] // shared coordinate of the line
      const dir = Math.sign(med[perpAx] - at)
      if (!dir) continue
      // 一次只能移動一格（使用者規則）：朝中位點跨一步、且不越過中位點
      const x = at + dir
      const bound = dir > 0 ? Math.floor(med[perpAx]) : Math.ceil(med[perpAx])
      if (dir > 0 ? x > bound : x < bound) continue // 已貼著中位點
      const count = occCount(perpAx)
      const emptied = count.get(at) === comp.length // 原欄/列會被清空
      if (!count.has(x) && !emptied) continue // 會多佔一條欄/列 → 不移
      const [dc, dr] = horiz ? [0, x - at] : [x - at, 0]
      if (boundaryHvDelta(pos, segs, inC, dc, dr) < 0) continue // 全網直線不可變少
      if (!M.validShift(comp, inC, dc, dr)) continue
      M.applyShift(comp, [dc, dr])
      movedLines++
      movedIds.push(...comp)
    }
  }
  return { cellAfter: pos, moved: movedPts + movedLines, movedPts, movedLines, segs: segs.length, verts: pos.size, movedIds }
}

/* ==================== 逐移動壓縮（movewise） ====================
   使用者規則：取消獨立的縮減網格步驟——端點移動/直線縮減/中位集中的
   **每一個小步驟（單一移動）完成後就做縮減網格**。實作＝以 limit=1 反覆呼叫
   該階段的 pass，每個移動後立即 compactGrid，直到動不了；網格因此隨時緻密。
   所有吃這三個階段的地方（tabs／循環／RWD 底圖／llmGrid／畫廊）都走這裡。 */
const MOVEWISE_CAP = 5000 // 單一階段的移動數保險上限（遠大於實測）
const MOVEWISE_PASS = {
  endp: (sk, cells, cols, rows) => {
    const r = buildEndpointStraighten(sk, cells, cols, rows, { limit: 1 })
    return { cellAfter: r.cellAfter, moved: r.stats.moved, pts: r.stats.moved, lines: 0 }
  },
  line: (sk, cells, cols, rows) => {
    const r = lineCompactPass(sk, cells, cols, rows, { limit: 1 })
    return { cellAfter: r.cellAfter, moved: r.moved, pts: 0, lines: r.moved }
  },
  gather: (sk, cells, cols, rows) => {
    const r = medianGatherPass(sk, cells, cols, rows, { limit: 1 })
    return { cellAfter: r.cellAfter, moved: r.moved, pts: r.movedPts, lines: r.movedLines }
  },
}
export function movewiseStage(stage, skeleton, cells, cols, rows) {
  // 起點也先壓（上一階段輸出已緻密時是 no-op）
  let comp = compactGrid(cells, cols, rows)
  let cur = comp.cellAfter, nC = comp.cols, nR = comp.rows
  const fromCols = nC, fromRows = nR
  const g0 = buildHcGraph(skeleton, cur)
  const hvBefore = countHV(g0.pos, g0.segs)
  const verts = g0.pos.size, segsN = g0.segs.length
  let moved = 0, movedPts = 0, movedLines = 0
  while (moved < MOVEWISE_CAP) {
    const r = MOVEWISE_PASS[stage](skeleton, cur, nC, nR)
    if (!r.moved) break
    moved += r.moved
    movedPts += r.pts
    movedLines += r.lines
    comp = compactGrid(r.cellAfter, nC, nR) // 每一個移動後立即縮減網格
    cur = comp.cellAfter
    nC = comp.cols
    nR = comp.rows
  }
  const g1 = buildHcGraph(skeleton, cur)
  return {
    cellAfter: cur,
    cols: nC,
    rows: nR,
    stats: {
      hvBefore, hvAfter: countHV(g1.pos, g1.segs), segs: segsN, verts,
      moved, movedPts, movedLines, converged: moved < MOVEWISE_CAP,
      fromCols, fromRows, cols: nC, rows: nR,
    },
  }
}

/* ==================== 逐步驗證（逐步執行） ====================
   讓使用者一鍵一步看鏈怎麼收斂：每一步 = 目前階段的**一個單掃描**（或
   limit=1 的單一移動），順序 端點移動 → 直線縮減 → 中位集中；**每一步完成後
   立即縮減網格**（使用者規則：取消獨立的縮減網格階段，改成每步後都壓），
   所以畫面上的網格永遠是緻密的。某階段掃不動就自動換下一階段（同一鍵內
   跳過空階段），一輪三階段都沒動靜＝完成。
   狀態是純資料（cells/cols/rows/stage/round/steps/info），呼叫端自己保存。 */
const STEP_STAGE_LABEL = { endp: '端點移動', line: '直線縮減', gather: '中位集中' }
export function stepChainInit(cells, cols, rows) {
  const comp = compactGrid(cells, cols, rows) // 每步後都壓 → 起點也先壓
  return {
    cells: comp.cellAfter, cols: comp.cols, rows: comp.rows,
    stage: 'endp', round: 1, steps: 0, roundMoves: 0, done: false,
    lastStage: null, // 這一步執行的工作（endp/line/gather）——顯示在面板的階段 chips
    movedIds: [], // 這一步移動的點/線成員 id——畫布上以橘圈標示
    moves: [], // 這一步的前後比對 [{ id, from:[c,r], to:[c,r] }]（縮減後 rank 空間，可為半格）
    info: '按「下一步」開始——每步執行一個單掃描並立即縮減網格（順序：端點移動 → 直線縮減 → 中位集中）',
  }
}
export function stepChainNext(skeleton, st, opts = {}) {
  if (st.done) return st
  const limit = opts.limit ?? Infinity // limit=1 ＝「下一小步」：只做一個點/線的移動
  const subTag = limit === 1 ? '（小步）' : ''
  let { cells, cols, rows, stage, round, steps, roundMoves } = st
  // 前後比對：這一步每個移動元素的 from→to 格座標（移動當下、縮減前的座標）
  const movesOf = (prev, next, ids) => {
    const seen = new Set()
    const out = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const a = prev.get(id), b = next.get(id)
      if (a && b && (a[0] !== b[0] || a[1] !== b[1])) out.push({ id, from: [a[0], a[1]], to: [b[0], b[1]] })
    }
    return out
  }
  // 小步的訊息尾巴：單點顯示 (c,r)→(c,r)、整條線顯示位移向量＋成員數
  const coordTag = (mv) => {
    if (limit !== 1 || !mv.length) return ''
    if (mv.length === 1) return `｜(${mv[0].from[0]},${mv[0].from[1]}) → (${mv[0].to[0]},${mv[0].to[1]})`
    const dx = mv[0].to[0] - mv[0].from[0], dy = mv[0].to[1] - mv[0].from[1]
    return `｜整條線位移 (${dx},${dy})、${mv.length} 點`
  }
  // 每一步完成後立即縮減網格：新佈局壓縮、前後比對座標換算到縮減後的 rank
  // 空間（to 一定是佔用座標 → 整數 rank；from 的欄/列可能被清空 → 落在前後
  // 兩個保留 rank 之間的 -0.5 半格，畫圖用內插）。
  const finalize = (next, ids, infoBase) => {
    const usedC = [...new Set([...next.values()].map((p) => p[0]))].sort((a, b) => a - b)
    const usedR = [...new Set([...next.values()].map((p) => p[1]))].sort((a, b) => a - b)
    const rankOf = (v, used) => {
      let lo = 0, hi = used.length
      while (lo < hi) { const m = (lo + hi) >> 1; if (used[m] < v) lo = m + 1; else hi = m }
      return used[lo] === v ? lo : lo - 0.5
    }
    const moves = movesOf(cells, next, ids).map((m) => ({
      id: m.id,
      from: [rankOf(m.from[0], usedC), rankOf(m.from[1], usedR)],
      to: [rankOf(m.to[0], usedC), rankOf(m.to[1], usedR)],
    }))
    const comp = compactGrid(next, cols, rows)
    const shrunk = comp.cols !== cols || comp.rows !== rows
    return {
      cells: comp.cellAfter, cols: comp.cols, rows: comp.rows,
      stage, round, steps: steps + 1, roundMoves, done: false, lastStage: stage,
      movedIds: ids, moves,
      info: infoBase + (shrunk ? `｜縮減網格 ${cols}×${rows} → ${comp.cols}×${comp.rows}` : ''),
    }
  }
  // 「下一步」＝把目前階段用 movewise 跑到不動（每個移動後都壓縮，語意與
  // 正式 tabs／循環完全一致），跑完直接進下一階段；回傳整階段的統計。
  const bigStep = (stage2, nextStage, mkInfo) => {
    const r = movewiseStage(stage2, skeleton, cells, cols, rows)
    if (!r.stats.moved) return null
    roundMoves += r.stats.moved
    const gridTag = r.stats.fromCols !== r.cols || r.stats.fromRows !== r.rows
      ? `｜縮減網格 ${r.stats.fromCols}×${r.stats.fromRows} → ${r.cols}×${r.rows}` : ''
    return {
      cells: r.cellAfter, cols: r.cols, rows: r.rows,
      stage: nextStage, round, steps: steps + 1, roundMoves, done: false,
      lastStage: stage2, movedIds: [], moves: [],
      info: `第 ${round} 輪 · ${STEP_STAGE_LABEL[stage2]}：${mkInfo(r.stats)}${gridTag}`,
    }
  }
  for (let guard = 0; guard < 9; guard++) { // 同一鍵內最多跳過兩輪的空階段
    if (stage === 'endp') {
      if (limit === 1) {
        const res = buildEndpointStraighten(skeleton, cells, cols, rows, { limit: 1 })
        if (res.stats.moved) {
          roundMoves += res.stats.moved
          const mv = movesOf(cells, res.cellAfter, res.stats.movedIds)
          return finalize(res.cellAfter, res.stats.movedIds,
            `第 ${round} 輪 · ${STEP_STAGE_LABEL[stage]}${subTag}：移動 1 點（水平垂直 ${res.stats.hvBefore} → ${res.stats.hvAfter}／${res.stats.segs} 段）${coordTag(mv)}`)
        }
      } else {
        const big = bigStep('endp', 'line',
          (s) => `移動 ${s.moved} 點（水平垂直 ${s.hvBefore} → ${s.hvAfter}／${s.segs} 段）`)
        if (big) return big
      }
      stage = 'line'
    } else if (stage === 'line') {
      if (limit === 1) {
        const res = lineCompactPass(skeleton, cells, cols, rows, { limit: 1 })
        if (res.moved) {
          roundMoves += res.moved
          const mv = movesOf(cells, res.cellAfter, res.movedIds)
          return finalize(res.cellAfter, res.movedIds,
            `第 ${round} 輪 · ${STEP_STAGE_LABEL[stage]}${subTag}：移動 1 線${coordTag(mv)}`)
        }
      } else {
        const big = bigStep('line', 'gather', (s) => `移動 ${s.moved} 線`)
        if (big) return big
      }
      stage = 'gather'
    } else { // 'gather' — 一輪的最後一個階段
      if (limit === 1) {
        const res = medianGatherPass(skeleton, cells, cols, rows, { limit: 1 })
        if (res.moved) {
          roundMoves += res.moved
          const mv = movesOf(cells, res.cellAfter, res.movedIds)
          return finalize(res.cellAfter, res.movedIds,
            `第 ${round} 輪 · ${STEP_STAGE_LABEL[stage]}${subTag}：往中位點滑 ${res.movedPts} 點＋${res.movedLines} 線${coordTag(mv)}`)
        }
      } else {
        const big = bigStep('gather', 'endp', (s) => `往中位點滑 ${s.movedPts} 點＋${s.movedLines} 線`)
        if (big) { big.round = round + 1; big.roundMoves = 0; return big } // gather 是一輪的最後 → 下一階段順帶進下一輪
      }
      // 三階段都掃不動（網格每步都已壓縮）＝收斂
      if (!roundMoves) {
        return { cells, cols, rows, stage, round, steps, roundMoves, done: true, lastStage: null, movedIds: [], moves: [], info: `✔ 收斂完成——共 ${steps} 步、${round} 輪都動不了` }
      }
      stage = 'endp'
      round += 1
      roundMoves = 0
    }
  }
  return { cells, cols, rows, stage, round, steps, roundMoves, done: true, lastStage: null, movedIds: [], moves: [], info: `✔ 收斂完成——共 ${steps} 步、${round} 輪` }
}

// 端點移動+直線縮減+中位集中循環: each round runs the three MOVEWISE stages
// （每個階段自己迭代到不動點，且**每一個移動後都立即縮減網格**——縮減不再是
// 獨立步驟）until a round where NOTHING moves. Per-move compaction renumbers
// cells continuously, so hard-rule blocks (occlusion, landing on another
// vertex) shift and new moves keep opening up between stages/rounds.
// Straighten moves strictly grow H/V (bounded), line moves strictly shrink
// the (always-dense) grid (bounded below); gather slides are H/V-neutral, so
// POST_ITER_CAP rounds is the backstop against slide/median oscillation.
export function straightenCompactLoop(skeleton, cells, cols, rows) {
  let cur = cells, nC = cols, nR = rows
  let rounds = 0, moved = 0, lineMoved = 0, gatherMoved = 0
  let hvBefore = null, last = null
  let converged = false
  while (rounds < POST_ITER_CAP) {
    const endp = movewiseStage('endp', skeleton, cur, nC, nR)
    const line = movewiseStage('line', skeleton, endp.cellAfter, endp.cols, endp.rows)
    const gather = movewiseStage('gather', skeleton, line.cellAfter, line.cols, line.rows)
    rounds++
    hvBefore ??= endp.stats.hvBefore
    last = gather.stats
    moved += endp.stats.moved
    lineMoved += line.stats.moved
    gatherMoved += gather.stats.moved
    cur = gather.cellAfter
    nC = gather.cols
    nR = gather.rows
    if (!endp.stats.moved && !line.stats.moved && !gather.stats.moved) { converged = true; break }
  }
  return {
    cellAfter: cur,
    cols: nC,
    rows: nR,
    stats: {
      hvBefore, hvAfter: last.hvAfter,
      segs: last.segs, verts: last.verts, moved, lineMoved, gatherMoved,
      rounds, roundCap: POST_ITER_CAP, converged,
      fromCols: cols, fromRows: rows, cols: nC, rows: nR,
    },
  }
}

// ④ LLM 對齊 executor: the fourth post-pass. The TARGETS come from outside —
// an LLM session (scripts/llmAlign.mjs + skill route-llm-align) proposes them
// round by round; this function only does what the other three passes do after
// deciding: run every proposal through the SAME hard rules (applyTargets, incl.
// the net-HV revert) and report the stats. targetEntries: [[id,[c,r]], ...] —
// unknown ids are ignored, partial proposals are fine.
export function applyLlmTargets(skeleton, cells, cols, rows, targetEntries) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) {
    return { cellAfter: pos, stats: { hvBefore: 0, hvAfter: 0, segs: 0, verts: pos.size, moved: 0, passes: 0, reverted: false } }
  }
  const M = makeMover(pos, segs, inc, cols, rows)
  const hvBefore = countHV(pos, segs)
  const targets = new Map()
  for (const [id, t] of targetEntries) {
    if (!pos.has(id)) continue
    if (!Array.isArray(t) || !Number.isInteger(t[0]) || !Number.isInteger(t[1])) continue
    targets.set(id, [t[0], t[1]])
  }
  const { moved, passes, reverted } = applyTargets(pos, M, targets, segs)
  return {
    cellAfter: pos,
    stats: {
      hvBefore, hvAfter: countHV(pos, segs), segs: segs.length, verts: pos.size,
      moved, passes, reverted, proposed: targets.size,
    },
  }
}

// ③ 整數規劃: per-axis 0-1 integer program, solved EXACTLY. Every vertex
// incident to an alignable segment gets an offset variable in [-window,
// window]; objective = maximise the number of aligned segments with total
// displacement as tie-breaker; quadrant preservation (no sign flip) is a
// pairwise constraint. x and y are separable → two independent programs, each
// decomposing into connected components solved by spanning-tree DP; cycles are
// conditioned away on a small feedback vertex set (enumeration capped,
// otherwise that component falls back to "no move"). Cross-axis hard rules
// (occlusion, one-vertex-per-cell) cannot enter the separable program, so the
// combined targets go through the same hard-rule application as 軸對齊.
export function buildAxisIlp(skeleton, cells, cols, rows, opts = {}) {
  const k = opts.window ?? 2
  const REWARD = 1_000_000 // one alignment always beats any total displacement
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) {
    return { cellAfter: pos, stats: { hvBefore: 0, hvAfter: 0, segs: 0, verts: pos.size, moved: 0, passes: 0, comps: 0, fallback: 0 } }
  }
  const M = makeMover(pos, segs, inc, cols, rows)
  const hvBefore = countHV(pos, segs)

  // One axis = one integer program. Returns Map<id, offset> (missing = 0).
  function solveAxis(axis, limit) {
    // Variables: endpoints of alignable segments (strictly nearer this axis,
    // closable within ±k on both ends). Everything else is fixed (offset 0).
    const varSet = new Set()
    for (const s of segs) {
      const A = pos.get(s.a), B = pos.get(s.b)
      const d = Math.abs(B[axis] - A[axis])
      const dOther = Math.abs(B[1 - axis] - A[1 - axis])
      if (d < dOther && d <= 2 * k) { varSet.add(s.a); varSet.add(s.b) }
    }
    const out = { off: new Map(), comps: 0, fallback: 0 }
    if (!varSet.size) return out

    // Pair graph: every segment whose axis-gap could reach 0 or flip sign
    // within ±k and that touches a variable. Parallel segments on the same
    // vertex pair collapse into one pair with a summed alignment reward.
    const plist = [] // { a, b, du, reward } with a < b, du = pos[b] - pos[a]
    const pIdx = new Map()
    const adj = new Map() // id -> [pair index]
    for (const s of segs) {
      const dAB = pos.get(s.b)[axis] - pos.get(s.a)[axis]
      if (Math.abs(dAB) > 2 * k) continue // can neither flip nor close
      if (!varSet.has(s.a) && !varSet.has(s.b)) continue
      const [a, b] = s.a < s.b ? [s.a, s.b] : [s.b, s.a]
      const key = `${a}|${b}`
      if (!pIdx.has(key)) {
        pIdx.set(key, plist.length)
        plist.push({ a, b, du: pos.get(b)[axis] - pos.get(a)[axis], reward: 0 })
        if (!adj.has(a)) adj.set(a, [])
        if (!adj.has(b)) adj.set(b, [])
        adj.get(a).push(plist.length - 1)
        adj.get(b).push(plist.length - 1)
      }
      const dOther = Math.abs(pos.get(s.b)[1 - axis] - pos.get(s.a)[1 - axis])
      if (Math.abs(dAB) < dOther) plist[pIdx.get(key)].reward += REWARD
    }
    for (const list of adj.values()) list.sort((x, y) => x - y)

    // Offset domain per node; fixed nodes have the singleton {0}.
    const dom = new Map()
    for (const id of adj.keys()) {
      if (!varSet.has(id)) { dom.set(id, [0]); continue }
      const base = pos.get(id)[axis]
      const d = []
      for (let o = -k; o <= k; o++) if (base + o >= 0 && base + o < limit) d.push(o)
      dom.set(id, d)
    }
    // pair score for offsets (oa on p.a, ob on p.b): sign flip vetoes,
    // closing the gap earns the reward, movement is charged as unary below.
    const pairScore = (p, oa, ob) => {
      const dn = p.du + ob - oa
      if ((p.du > 0 && dn < 0) || (p.du < 0 && dn > 0)) return -Infinity
      return dn === 0 ? p.reward : 0
    }
    const unary = (o) => -Math.abs(o)

    // Connected components of the pair graph.
    const compSeen = new Set()
    const nodesSorted = [...adj.keys()].sort()
    for (const start of nodesSorted) {
      if (compSeen.has(start)) continue
      const nodes = []
      const stack = [start]
      compSeen.add(start)
      while (stack.length) {
        const u = stack.pop()
        nodes.push(u)
        for (const pi of adj.get(u)) {
          const p = plist[pi]
          const v = p.a === u ? p.b : p.a
          if (!compSeen.has(v)) { compSeen.add(v); stack.push(v) }
        }
      }
      nodes.sort()
      out.comps++

      // Spanning tree (BFS) + back edges → feedback vertex set to condition on.
      const treeAdj = new Map(nodes.map((id) => [id, []]))
      const backEdges = []
      const seen = new Set([nodes[0]])
      const queue = [nodes[0]]
      const usedPair = new Set()
      while (queue.length) {
        const u = queue.shift()
        for (const pi of adj.get(u)) {
          if (usedPair.has(pi)) continue
          usedPair.add(pi)
          const p = plist[pi]
          const v = p.a === u ? p.b : p.a
          if (seen.has(v)) { backEdges.push(pi); continue }
          seen.add(v)
          treeAdj.get(u).push({ v, pi })
          treeAdj.get(v).push({ v: u, pi })
          queue.push(v)
        }
      }
      const fb = []
      for (const pi of backEdges) {
        const p = plist[pi]
        if (fb.includes(p.a) || fb.includes(p.b)) continue
        // prefer a fixed endpoint (domain 1 → conditioning is free)
        fb.push(dom.get(p.a).length <= dom.get(p.b).length ? p.a : p.b)
      }
      let trials = 1
      for (const id of fb) trials *= dom.get(id).length
      if (trials > 3125 || trials * nodes.length > 2e6) { out.fallback++; continue } // stay put

      const fbSet = new Set(fb)
      // Forest = spanning tree minus the feedback vertices; every pair with a
      // conditioned endpoint becomes a unary term (or a constant, if both are).
      const fixedVal = new Map() // trial assignment of the feedback set
      const nodeUnary = (u, o) => {
        let sc = unary(o)
        for (const pi of adj.get(u)) {
          const p = plist[pi]
          const v = p.a === u ? p.b : p.a
          if (!fbSet.has(v)) continue
          const ov = fixedVal.get(v)
          sc += p.a === u ? pairScore(p, o, ov) : pairScore(p, ov, o)
          if (sc === -Infinity) return sc
        }
        return sc
      }
      let bestScore = -Infinity, bestOff = null
      const trialOff = new Map()
      const runTrial = () => {
        let total = 0
        trialOff.clear()
        for (const id of fb) {
          const o = fixedVal.get(id)
          total += unary(o)
          trialOff.set(id, o)
        }
        for (const pi of backEdges) { // fb–fb pairs score as constants
          const p = plist[pi]
          if (!fbSet.has(p.a) || !fbSet.has(p.b)) continue
          total += pairScore(p, fixedVal.get(p.a), fixedVal.get(p.b))
        }
        if (total === -Infinity) return
        // DP over each tree of the forest, rooted at its smallest id.
        const done = new Set(fb)
        for (const r of nodes) {
          if (done.has(r)) continue
          const dpOf = new Map()     // node -> score per domain index
          const choiceOf = new Map() // node -> per parent-domain-index best own index
          const orderStack = [[r, null]]
          const post = []
          while (orderStack.length) {
            const [u, par] = orderStack.pop()
            done.add(u)
            post.push([u, par])
            for (const { v } of treeAdj.get(u)) {
              if (v === par || fbSet.has(v)) continue
              orderStack.push([v, u])
            }
          }
          for (let i = post.length - 1; i >= 0; i--) {
            const [u, par] = post[i]
            const domU = dom.get(u)
            const dp = domU.map((o) => nodeUnary(u, o))
            for (const { v, pi } of treeAdj.get(u)) {
              if (v === par || fbSet.has(v)) continue
              const p = plist[pi]
              const domV = dom.get(v), dpv = dpOf.get(v)
              const pick = new Array(domU.length)
              for (let a = 0; a < domU.length; a++) {
                if (dp[a] === -Infinity) continue
                let best = -Infinity, bestJ = -1
                for (let j = 0; j < domV.length; j++) {
                  if (dpv[j] === -Infinity) continue
                  const ps = p.a === u ? pairScore(p, domU[a], domV[j]) : pairScore(p, domV[j], domU[a])
                  const sc = dpv[j] + ps
                  if (sc > best) { best = sc; bestJ = j }
                }
                dp[a] = bestJ < 0 ? -Infinity : dp[a] + best
                pick[a] = bestJ
              }
              choiceOf.set(`${u}|${v}`, pick)
            }
            dpOf.set(u, dp)
          }
          // pick the root's best offset, then walk the choices down
          const domR = dom.get(r), dpr = dpOf.get(r)
          let bi = -1, bv = -Infinity
          for (let a = 0; a < domR.length; a++) if (dpr[a] > bv) { bv = dpr[a]; bi = a }
          if (bi < 0) { total = -Infinity; break }
          total += bv
          const walk = [[r, null, bi]]
          while (walk.length) {
            const [u, par, ai] = walk.pop()
            trialOff.set(u, dom.get(u)[ai])
            for (const { v } of treeAdj.get(u)) {
              if (v === par || fbSet.has(v)) continue
              walk.push([v, u, choiceOf.get(`${u}|${v}`)[ai]])
            }
          }
        }
        if (total > bestScore) { bestScore = total; bestOff = new Map(trialOff) }
      }
      // odometer over the feedback set's domains (trials is small by the cap)
      const spin = (i) => {
        if (i === fb.length) { runTrial(); return }
        for (const o of dom.get(fb[i])) { fixedVal.set(fb[i], o); spin(i + 1) }
      }
      spin(0)
      if (bestOff) for (const [id, o] of bestOff) { if (o) out.off.set(id, o) }
    }
    return out
  }

  const sx = solveAxis(0, cols)
  const sy = solveAxis(1, rows)
  const targets = new Map()
  for (const [id, p] of pos) {
    targets.set(id, [p[0] + (sx.off.get(id) ?? 0), p[1] + (sy.off.get(id) ?? 0)])
  }
  const { moved, passes, reverted } = applyTargets(pos, M, targets, segs)
  return {
    cellAfter: pos,
    stats: {
      hvBefore, hvAfter: countHV(pos, segs), segs: segs.length, verts: pos.size,
      moved, passes, reverted, comps: sx.comps + sy.comps, fallback: sx.fallback + sy.fallback,
    },
  }
}
