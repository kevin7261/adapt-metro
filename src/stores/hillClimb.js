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
// Local minima: cluster moves — overlength-edge components (§6.1) and bend
// (kink) clusters (§6.2); the optional dual-graph partition (§6.3) is omitted
// as the paper allows. Labels (§7) are out of
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
import { sharesRoute, isHV, isHVD } from './netUtil.js'

const ckey = (c, r) => `${c},${r}`

// union-find（兩段式路徑壓縮）——clusterComponents / lineComponents 共用。
// ids 可省略（之後用 add 懶初始化）。
function makeUnionFind(ids = []) {
  const parent = new Map()
  for (const id of ids) parent.set(id, id)
  const add = (v) => { if (!parent.has(v)) parent.set(v, v) }
  const find = (x) => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)
    let c = x
    while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n }
    return r
  }
  const union = (x, y) => { const a = find(x), b = find(y); if (a !== b) parent.set(a, b) }
  return { parent, add, find, union }
}
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

// A segment counts as horizontal/vertical when exactly ONE coordinate matches
// (both matching = degenerate; isHV 來自 netUtil). Shared readout of the three post-pass tabs.
// （export：paperAlign.js 的七條論文鏈也用同一套讀數。）
export function countHV(pos, segs) {
  let n = 0
  for (const s of segs) if (isHV(pos.get(s.a), pos.get(s.b))) n++
  return n
}
// 「H/V 或格對角 45°」對齊段數——LLM 對齊（applyLlmTargets）與 paperAlign.js 的
// 七條論文鏈（八方向系演算法）用它當接受準則，讓對角走向對到 45° 對角而非硬拉成
// H/V 樓梯（使用者規則）。rect/align/ilp 三個後處理仍用 countHV（純 H/V 最大化）。
export function countHVD(pos, segs) {
  let n = 0
  for (const s of segs) if (isHVD(pos.get(s.a), pos.get(s.b))) n++
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

// Movement machinery shared by the optimizer and the post-passes（②直角爬山
// 與 paperAlign.js 的其他論文鏈；retired 的軸對齊/整數規劃亦同）: neighbourhood lookups,
// the §5 hard rules and the mutating move primitive. Closes over the LIVE
// `pos`; cellOwner mirrors it.
export function makeMover(pos, segs, inc, cols, rows) {
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
    // ③′ 變形段完整檢查：剛性平移下，兩端同動（相對不變）與兩端全靜態的段
    // 都保持原相對幾何，唯一會「變形」的是恰一端在群集內的段。上面的檢查漏了
    // 三個組合（大邱重疊案 2026-07）：變形段吞掉**群集內**頂點（212 只看靜態
    // 頂點）、變形段×整體移動段、變形段×變形段（206 只比對純靜態段）。這裡
    // 對每條變形段補齊：不得吞任何頂點、不得與任何不共端點的段相交/共線重疊
    // （共端點的共線重疊由吞頂點檢查涵蓋——較短段的遠端必在較長段上）。
    for (let si = 0; si < segs.length; si++) {
      const s = segs[si]
      if (inC.has(s.a) === inC.has(s.b)) continue // 非變形段
      const A = at(s.a), B = at(s.b)
      for (const [w] of pos) {
        if (w === s.a || w === s.b) continue
        if (onSeg(at(w), A, B)) return false
      }
      for (let sj = 0; sj < segs.length; sj++) {
        if (sj === si) continue
        const t = segs[sj]
        if (!inC.has(t.a) && !inC.has(t.b)) continue // 純靜態已在 206 檢過
        if (t.a === s.a || t.a === s.b || t.b === s.a || t.b === s.b) continue
        if (segsIntersect(A, B, at(t.a), at(t.b))) return false
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
function compactGrid(cellAfter, cols, rows) {
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

// 縮減網格（硬規則把關版，大邱重疊案 2026-07）：移除一個空欄＝「右半平面整體
// 左移 1 格」——與群集平移是同一件事，跨縫的段會**變形**，純排名重編（上面的
// compactGrid）可能把點壓到別的段上、製造新交叉或共線重疊。這裡逐空欄/空列走
// validShift **同一套硬規則**（含 ③′ 變形段檢查）；會出事的空帶就**保留**
// （畫面多一條空帶、網格略大，但佈局永不劣化）。迭代到不動點（先拿掉別的
// 空帶後，原本被擋的可能變合法）。movewise／逐步驗證的每步後壓縮都走這裡。
function compactGridSafe(skeleton, cellAfter, cols, rows) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cellAfter)
  for (const [id, cell] of cellAfter) { // 圖外殘餘點也要跟著壓（維持全量 remap 語意）
    if (!pos.has(id)) { pos.set(id, [cell[0], cell[1]]); inc.set(id, []) }
  }
  const M = makeMover(pos, segs, inc, cols, rows)
  let nC = cols, nR = rows
  let changed = true
  for (let guard = 0; changed && guard < 8; guard++) {
    changed = false
    for (const axis of [0, 1]) {
      const used = new Set()
      for (const p of pos.values()) used.add(p[axis])
      const size = axis ? nR : nC
      for (let x = size - 1; x >= 0; x--) { // 由右/下往左/上，索引不互相干擾
        if (used.has(x)) continue
        const comp = []
        const inC = new Set()
        for (const [id, p] of pos) if (p[axis] > x) { comp.push(id); inC.add(id) }
        const d = axis ? [0, -1] : [-1, 0]
        if (comp.length && !M.validShift(comp, inC, d[0], d[1])) continue // 保留此空帶
        M.applyShift(comp, d)
        if (axis) nR--; else nC--
        changed = true
      }
    }
  }
  const out = new Map()
  for (const id of cellAfter.keys()) { const p = pos.get(id); out.set(id, [p[0], p[1]]) }
  return { cellAfter: out, cols: nC, rows: nR, removedCols: cols - nC, removedRows: rows - nR }
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

  /* ---- clusters (§6): overlength-edge components + bend clusters ---- */
  const overlength = (s) => segLen(s) > s.hops * L + 1e-9
  function overlengthClusters() {
    // §6.1 connected components over IDEAL-length edges; overlength edges separate
    const { find, union } = makeUnionFind(pos.keys())
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
  // §6.2 bend clusters: a degree-2 station whose two same-line neighbours u,w
  // leave it visibly off the u→w line is a "kink" — moving the kink station on
  // its own straightens the line (single moves get stuck because every other
  // criterion punishes them). Threshold = 22.5°, half the octilinear spacing
  // (the direction where c_N5's |sin 4θ| peaks, i.e. maximally off-grid).
  const KINK = Math.PI / 8
  function bendClusters() {
    const out = []
    for (const [v, list] of inc) {
      if (list.length !== 2) continue
      if (!sharesRoute(segs[list[0]].routes, segs[list[1]].routes)) continue
      const u = other(segs[list[0]], v), w = other(segs[list[1]], v)
      const pv = pos.get(v), pu = pos.get(u), pw = pos.get(w)
      if ((pw[0] === pu[0] && pw[1] === pu[1]) || (pv[0] === pu[0] && pv[1] === pu[1])) continue
      const base = Math.atan2(pw[1] - pu[1], pw[0] - pu[0])
      const toV = Math.atan2(pv[1] - pu[1], pv[0] - pu[0])
      let d = Math.abs(base - toV)
      if (d > Math.PI) d = TWO_PI - d
      if (d > KINK) out.push([v])
    }
    return out
  }
  // §6.3 partition clusters (dual-graph cut) are optional in the paper — omitted.
  const clusterComponents = () => [...overlengthClusters(), ...bendClusters()]

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
  // Paper table 4: max station move 8, 5 iterations; the search rectangle cools
  // by one cell per round (min 1). Convergence = a full round (stations +
  // clusters) that no longer lowers the total fitness. Labels (§7) are out of
  // scope here — this layer has no label positions to optimise.
  const maxMove = opts.maxMove ?? 8
  const maxRounds = opts.maxRounds ?? 5
  const vertIds = [...pos.keys()].sort()
  const before = totalFitness()
  const hvBefore = countHV(pos, segs)
  let rounds = 0, moved = 0, clusterMoves = 0
  let mT = before
  let R = maxMove
  for (let i = 0; i < maxRounds; i++) {
    rounds++
    let improved = false
    for (const v of vertIds) {
      const P = bestCandidate(v, R)
      if (P) { applyMove(v, P); moved++; improved = true }
    }
    for (const comp of clusterComponents()) {
      const d = bestClusterShift(comp, R)
      if (d) { applyShift(comp, d); clusterMoves++; improved = true }
    }
    R = Math.max(1, R - 1) // cooling
    if (!improved) break // a full round without improvement → converged
    const mNew = totalFitness()
    if (mNew >= mT) break // total fitness no longer decreasing → converged
    mT = mNew
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
// `count` = 對齊分數函式（預設 countHV＝純水平垂直；LLM 對齊與 paperAlign.js 傳
// countHVD＝含格對角 45°，讓對角走向對到斜線而非硬拉成 H/V 樓梯）。淨對齊分數
// 變差就整批退回。
export function applyTargets(pos, M, targets, segs, maxPasses = 6, count = countHV) {
  const start = new Map([...pos].map(([id, p]) => [id, [p[0], p[1]]]))
  const hv0 = count(pos, segs)
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
  if (count(pos, segs) < hv0) {
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
// cap hits). One run is NOT a fixed point for any pass — 直角爬山's radius
// schedule runs out before a no-improvement round, and the target-based
// passes create fresh alignment chances by moving (near-axis segments appear,
// the ±k window re-centres). 直角爬山 terminates by monotone fitness; the
// others rely on the cap (measured: 2–12 iterations to converge, no cycles).
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

// ②直角爬山（論文② Stott et al. 的直角變體；paperAlign.js 的 PAPER_KINDS 以
// kind 'rect' 掛載）: a second, short-radius hill-climbing polish with the direction
// criterion switched from octilinear |sin 4θ| to RECTILINEAR |sin 2θ| — 45°
// legs now cost as much as the worst direction, so segments get pulled onto
// horizontals/verticals wherever the hard rules allow. Criteria, hard rules
// and cluster moves are otherwise identical; the boosted weight compensates
// for the stricter 4-direction ideal.
export function buildRectPolish(skeleton, cells, cols, rows, opts = {}) {
  return buildHillClimb(skeleton, cells, cols, rows, {
    rect: true,
    weights: { octi: DEFAULT_W.octi * 3 },
    ...opts,
  })
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
function buildEndpointStraighten(skeleton, cells, cols, rows, opts = {}) {
  const limit = opts.limit ?? Infinity // 逐步驗證 子步驟：最多接受 limit 個移動
  const skip = opts.skip // 一遍掃描（movewiseSweep）中本輪已動過的點——跳過
  const movedIds = []
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) {
    return { cellAfter: pos, stats: { hvBefore: 0, hvAfter: 0, segs: segs.length, verts: pos.size, moved: 0, endpoints: 0, movedIds } }
  }
  const M = makeMover(pos, segs, inc, cols, rows)
  const hvBefore = countHV(pos, segs)
  const ids = [...pos.keys()].sort()
  let moved = 0
  for (const v of ids) {
    if (moved >= limit) break
    if (skip && skip.has(v)) continue
    const vsegs = inc.get(v).map((si) => segs[si])
    if (!vsegs.length) continue
    const pv = pos.get(v)
    const otherPos = (s) => pos.get(s.a === v ? s.b : s.a)
    const hvAt = (P) => vsegs.reduce((n, s) => n + (isHV(P, otherPos(s)) ? 1 : 0), 0)
    const cur = hvAt(pv)
    // Candidates: the four 1-cell unit moves — under the 1-cell cap
    // （使用者規則：端點移動每次移動不可超過 1 格，由此構造保證）, every
    // useful snap-onto-a-neighbour's-row/col candidate IS one of these, and
    // they additionally cover the length-improving moves (直線變長、斜線變短).
    const cand = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dc, dr]) => [pv[0] + dc, pv[1] + dr])
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
    for (const P of cand) {
      // 使用者規則：不得讓任一入射段的兩個顏色點橫跨超過 SPAN_CAP 格
      if (!vsegs.every((sg) => spanOk(pv, otherPos(sg), P, otherPos(sg)))) continue
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
      scored.push({ P, delta, cont: contScore(P), lenScore })
    }
    scored.sort((a, b) => b.delta - a.delta || b.cont - a.cont
      || b.lenScore - a.lenScore
      || a.P[0] - b.P[0] || a.P[1] - b.P[1])
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
// 網格合併.
function lineComponents(pos, segs, horiz) {
  const { parent, add, find, union } = makeUnionFind()
  for (const s of segs) {
    const A = pos.get(s.a), B = pos.get(s.b)
    const straight = horiz ? (A[1] === B[1] && A[0] !== B[0]) : (A[0] === B[0] && A[1] !== B[1])
    if (!straight) continue
    add(s.a); add(s.b)
    union(s.a, s.b)
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

// 使用者規則：任何移動不得讓「受影響段的兩個顏色點」橫跨超過 SPAN_CAP 格
// （Chebyshev：max(|dx|,|dy|)）——防止兩個顏色點之間的線被拉太長。本來就
// 超過上限的舊長段只准縮短或不變、不准再拉長（否則會把它們永久凍結）。
// 可由樣式 tab 設定（setSpanCap，預設 3 格）；離線腳本/畫廊用預設值。
let SPAN_CAP = 3
export function setSpanCap(n) {
  SPAN_CAP = Math.max(1, Math.round(+n) || 3)
}
const spanOf = (A, B) => Math.max(Math.abs(A[0] - B[0]), Math.abs(A[1] - B[1]))
const spanOk = (A0, B0, A1, B1) => {
  const ns = spanOf(A1, B1)
  return ns <= SPAN_CAP || ns <= spanOf(A0, B0)
}
// 剛體平移下所有邊界段（一端動、一端不動）的跨距檢查
function boundarySpanOk(pos, segs, inC, dc, dr) {
  for (const s of segs) {
    const ma = inC.has(s.a), mb = inC.has(s.b)
    if (ma === mb) continue
    const A = pos.get(s.a), B = pos.get(s.b)
    const A1 = ma ? [A[0] + dc, A[1] + dr] : A
    const B1 = mb ? [B[0] + dc, B[1] + dr] : B
    if (!spanOk(A, B, A1, B1)) return false
  }
  return true
}

// net H/V change of the BOUNDARY segments (one endpoint moving, one static)
// under a rigid shift of the inC vertex set — internal/static segments are
// unchanged, so this is the network-wide H/V delta. Shared by 直線縮減 and
// 網格合併.
function boundaryHvDelta(pos, segs, inC, dc, dr) {
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
  const skip = opts.skip // 一遍掃描中本輪已動過的線（以最小成員 id 識別）——跳過
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
      if (skip && skip.has(comp[0])) continue
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
        if (!boundarySpanOk(pos, segs, inC, dc, dr)) continue // 顏色點間不可拉超過 SPAN_CAP 格
        const hv = boundaryHvDelta(pos, segs, inC, dc, dr)
        if (hv < 0) continue // 整個 network 的直線（H/V 段）不可變少
        scored.push({ dc, dr, gain, hv })
      }
      scored.sort((a, b) => b.gain - a.gain || b.hv - a.hv
        || a.dc - b.dc || a.dr - b.dr)
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

// 網格合併（原「網格合併」）one sweep：把相鄰的 row 兩兩合併、col 兩兩合併。
// 合併 r|r+1 ＝「row > r 的所有點整體上移 1 格」（半平面剛體平移，row r+1 的
// 點落進 row r、其下全部跟著上移）——不留空列、自帶壓縮；col 同理左移。
// 合法性走 validShift **同一套硬規則**（不壓點、不新增交叉/路線重疊、象限與
// 邊環繞序不變＝拓撲不變——與端點移動/直線縮減同判準）。附帶性質：邊界段
// 跨距只縮不增、H/V 段只增不減（水平/垂直段不受影響、dy=1 的斜段會變水平、
// dy=1 的垂直段會因兩端撞格被 validShift 擋下）。掃描順序：rows 由上而下、
// cols 由左而右，每個邊界本遍試一次（合併成功即前進，兩兩配對不重複吃）；
// cursor 讓逐步驗證的小步跨點擊延續同一遍。
function gridMergeSweep(skeleton, cells, cols, rows, opts = {}) {
  const limit = opts.limit ?? Infinity
  let cursor = opts.cursor ? { ...opts.cursor } : { phase: 'row', idx: 0 }
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length || cursor.phase === 'done') {
    return { cellAfter: pos, cols, rows, merged: 0, mergedRows: 0, mergedCols: 0, cursor: { phase: 'done', idx: 0 }, movedIds: [], desc: [] }
  }
  const M = makeMover(pos, segs, inc, cols, rows)
  let nC = cols, nR = rows
  let mergedRows = 0, mergedCols = 0
  const desc = []
  const half = (ax, gt) => {
    const comp = []
    for (const [id, pnt] of pos) if (pnt[ax] > gt) comp.push(id)
    return comp.sort()
  }
  if (cursor.phase === 'row') {
    let r = cursor.idx
    while (r + 1 < nR && mergedRows + mergedCols < limit) {
      const comp = half(1, r)
      const inC = new Set(comp)
      if (comp.length && M.validShift(comp, inC, 0, -1)) {
        M.applyShift(comp, [0, -1])
        nR -= 1
        mergedRows++
        desc.push(`row ${r}｜${r + 1}`)
      }
      r += 1
    }
    cursor = r + 1 < nR ? { phase: 'row', idx: r } : { phase: 'col', idx: 0 }
  }
  if (cursor.phase === 'col') {
    let c = cursor.idx
    while (c + 1 < nC && mergedRows + mergedCols < limit) {
      const comp = half(0, c)
      const inC = new Set(comp)
      if (comp.length && M.validShift(comp, inC, -1, 0)) {
        M.applyShift(comp, [-1, 0])
        nC -= 1
        mergedCols++
        desc.push(`col ${c}｜${c + 1}`)
      }
      c += 1
    }
    cursor = c + 1 < nC ? { phase: 'col', idx: c } : { phase: 'done', idx: 0 }
  }
  return { cellAfter: pos, cols: nC, rows: nR, merged: mergedRows + mergedCols, mergedRows, mergedCols, cursor, movedIds: [], desc }
}

/* ==================== 逐移動壓縮（movewise） ====================
   使用者規則：取消獨立的縮減網格步驟——端點移動/直線縮減/網格合併的
   **每一個小步驟（單一移動）完成後就做縮減網格**。實作＝以 limit=1 反覆呼叫
   該階段的 pass，每個移動後立即 compactGrid，直到動不了；網格因此隨時緻密。
   所有吃這三個階段的地方（tabs／循環／RWD 底圖／llmGrid／畫廊）都走這裡。 */
const MOVEWISE_CAP = 5000 // 單一階段的移動數保險上限（遠大於實測）
const MOVEWISE_PASS = {
  endp: (sk, cells, cols, rows, skip) => {
    const r = buildEndpointStraighten(sk, cells, cols, rows, { limit: 1, skip })
    return { cellAfter: r.cellAfter, moved: r.stats.moved, pts: r.stats.moved, lines: 0, ids: r.stats.movedIds, key: r.stats.movedIds[0] }
  },
  line: (sk, cells, cols, rows, skip) => {
    const r = lineCompactPass(sk, cells, cols, rows, { limit: 1, skip })
    return { cellAfter: r.cellAfter, moved: r.moved, pts: 0, lines: r.moved, ids: r.movedIds, key: r.movedIds[0] }
  },
  // gather（網格合併）不在此表——半平面合併自帶壓縮，走 gridMergeSweep 專用路徑。
}
// 跑到該階段自己的不動點（同一元素可動多次）——tabs／循環的整段執行用。
export function movewiseStage(stage, skeleton, cells, cols, rows) {
  return movewiseCore(stage, skeleton, cells, cols, rows, null)
}

// 網格合併的 stage 驅動：single=true 只掃一遍（循環用）、否則掃到沒有可合併
// （網格合併 tab 用）。回傳形狀與其他階段一致（moved=合併次數；另附
// mergedRows/mergedCols）。
function gridMergeStage(skeleton, cells, cols, rows, opts = {}) {
  let comp = compactGridSafe(skeleton, cells, cols, rows)
  let cur = comp.cellAfter, nC = comp.cols, nR = comp.rows
  const fromCols = nC, fromRows = nR
  const g0 = buildHcGraph(skeleton, cur)
  const hvBefore = countHV(g0.pos, g0.segs)
  const verts = g0.pos.size, segsN = g0.segs.length
  let mergedRows = 0, mergedCols = 0, guard = 0
  while (guard++ < POST_ITER_CAP) {
    const r = gridMergeSweep(skeleton, cur, nC, nR)
    mergedRows += r.mergedRows
    mergedCols += r.mergedCols
    cur = r.cellAfter
    nC = r.cols
    nR = r.rows
    if (!r.merged || opts.single) break
  }
  const g1 = buildHcGraph(skeleton, cur)
  return {
    cellAfter: cur,
    cols: nC,
    rows: nR,
    stats: {
      hvBefore, hvAfter: countHV(g1.pos, g1.segs), segs: segsN, verts,
      moved: mergedRows + mergedCols, mergedRows, mergedCols,
      movedPts: mergedRows, movedLines: mergedCols, // 舊欄位相容（列/欄）
      converged: guard <= POST_ITER_CAP,
      fromCols, fromRows, cols: nC, rows: nR,
    },
  }
}

// 一遍掃描（使用者規則：循環與逐步驗證的每一步＝該演算法把**整個 network
// 跑一次**，不是跑到該演算法自己的不動點）：每個元素本輪最多動一次（動過的
// 進 visited、pass 以 skip 跳過）。visited 由呼叫端傳入（逐步驗證的小步跨
// 呼叫延續同一遍）。
function movewiseSweep(stage, skeleton, cells, cols, rows, visited = new Set()) {
  return movewiseCore(stage, skeleton, cells, cols, rows, visited)
}

// movewiseStage / movewiseSweep 的共用本體——唯二差異由 visited 決定：
// null＝跑到不動點（元素可重複動；gather 掃到沒有可合併），Set＝一遍掃描
// （動過進 visited、pass 以 skip 跳過；gather 只掃一遍 single:true）。
// 每一個移動後都立即 compactGrid（起點也先壓；上一階段輸出已緻密時是 no-op）。
function movewiseCore(stage, skeleton, cells, cols, rows, visited) {
  if (stage === 'gather') return gridMergeStage(skeleton, cells, cols, rows, visited ? { single: true } : {})
  let comp = compactGridSafe(skeleton, cells, cols, rows)
  let cur = comp.cellAfter, nC = comp.cols, nR = comp.rows
  const fromCols = nC, fromRows = nR
  const g0 = buildHcGraph(skeleton, cur)
  const hvBefore = countHV(g0.pos, g0.segs)
  const verts = g0.pos.size, segsN = g0.segs.length
  let moved = 0, movedPts = 0, movedLines = 0
  while (moved < MOVEWISE_CAP) {
    const r = MOVEWISE_PASS[stage](skeleton, cur, nC, nR, visited ?? undefined)
    if (!r.moved) break
    if (visited) visited.add(r.key)
    moved += r.moved
    movedPts += r.pts
    movedLines += r.lines
    comp = compactGridSafe(skeleton, r.cellAfter, nC, nR) // 每一個移動後立即縮減網格
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
   limit=1 的單一移動），順序 端點移動 → 直線縮減 → 網格合併；**每一步完成後
   立即縮減網格**（使用者規則：取消獨立的縮減網格階段，改成每步後都壓），
   所以畫面上的網格永遠是緻密的。某階段掃不動就自動換下一階段（同一鍵內
   跳過空階段），一輪三階段都沒動靜＝完成。
   狀態是純資料（cells/cols/rows/stage/round/steps/info），呼叫端自己保存。 */
const STEP_STAGE_LABEL = { endp: '端點移動', line: '直線縮減', gather: '網格合併' }
export function stepChainInit(skeleton, cells, cols, rows) {
  const comp = compactGridSafe(skeleton, cells, cols, rows) // 每步後都壓 → 起點也先壓
  return {
    cells: comp.cellAfter, cols: comp.cols, rows: comp.rows,
    stage: 'endp', round: 1, steps: 0, roundMoves: 0, done: false,
    lastStage: null, // 這一步執行的工作（endp/line/gather）——顯示在面板的階段 chips
    movedIds: [], // 這一步移動的點/線成員 id——畫布上以橘圈標示
    moves: [], // 這一步的前後比對 [{ id, from:[c,r], to:[c,r] }]（縮減後 rank 空間，可為半格）
    sweepVisited: [], // 目前這一遍掃描中已動過的元素 key（小步跨點擊延續同一遍）
    mergeCursor: null, // 網格合併這一遍掃到哪個邊界（{phase:'row'|'col', idx}；小步延續用）
    info: '按「下一步」開始——每步＝目前演算法把整個 network 掃一遍（每個移動後立即縮減網格），掃完換下一個：端點移動 → 直線縮減 → 網格合併 → 回到端點移動；三個都沒改動就停止',
  }
}
export function stepChainNext(skeleton, st, opts = {}) {
  if (st.done) return st
  const limit = opts.limit ?? Infinity // limit=1 ＝「下一小步」：只做一個點/線的移動
  const subTag = limit === 1 ? '（小步）' : ''
  let { cells, cols, rows, stage, round, steps, roundMoves } = st
  let sweepVisited = st.sweepVisited ?? []
  let mergeCursor = st.mergeCursor ?? null
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
    const comp = compactGridSafe(skeleton, next, cols, rows)
    const shrunk = comp.cols !== cols || comp.rows !== rows
    return {
      cells: comp.cellAfter, cols: comp.cols, rows: comp.rows,
      stage, round, steps: steps + 1, roundMoves, done: false, lastStage: stage,
      movedIds: ids, moves, sweepVisited, mergeCursor,
      info: infoBase + (shrunk ? `｜縮減網格 ${cols}×${rows} → ${comp.cols}×${comp.rows}` : ''),
    }
  }
  // 「下一步」＝目前演算法把整個 network 掃**一遍**（movewiseSweep，接續小步
  // 已走過的 sweepVisited），掃完就換下一個演算法（掃不動也換）——使用者規則：
  // 端點移動一遍 → 直線縮減一遍 → 網格合併一遍 → 回到端點移動。
  const NEXT_STAGE = { endp: 'line', line: 'gather', gather: 'endp' }
  const STAGE_INFO = {
    endp: (t) => `移動 ${t.moved} 點（水平垂直 ${t.hvBefore} → ${t.hvAfter}／${t.segs} 段）`,
    line: (t) => `移動 ${t.moved} 線`,
    gather: (t) => `合併 ${t.mergedRows ?? t.movedPts} 列＋${t.mergedCols ?? t.movedLines} 欄`,
  }
  for (let guard = 0; guard < 9; guard++) {
    if (stage === 'gather') {
      // 網格合併：小步＝合併下一個可合併的邊界（cursor 延續這一遍）；
      // 大步＝把這一遍剩下的邊界全掃完。半平面合併自帶壓縮。
      const r = gridMergeSweep(skeleton, cells, cols, rows,
        { limit: limit === 1 ? 1 : Infinity, cursor: mergeCursor ?? undefined })
      if (r.merged) {
        roundMoves += r.merged
        const isSub = limit === 1
        const info = isSub
          ? `第 ${round} 輪 · ${STEP_STAGE_LABEL.gather}${subTag}：合併 ${r.desc[0]}｜網格 ${cols}×${rows} → ${r.cols}×${r.rows}`
          : `第 ${round} 輪 · ${STEP_STAGE_LABEL.gather}（掃一遍）：合併 ${r.mergedRows} 列＋${r.mergedCols} 欄｜網格 ${cols}×${rows} → ${r.cols}×${r.rows}`
        if (isSub && r.cursor.phase !== 'done') {
          // 小步：這一遍還沒掃完——留在 gather、cursor 前進
          return { cells: r.cellAfter, cols: r.cols, rows: r.rows, stage, round, steps: steps + 1, roundMoves, done: false, lastStage: 'gather', movedIds: [], moves: [], sweepVisited, mergeCursor: r.cursor, info }
        }
        // 大步（或小步剛好掃完）：gather 是一輪的最後 → 進下一輪
        return { cells: r.cellAfter, cols: r.cols, rows: r.rows, stage: 'endp', round: round + 1, steps: steps + 1, roundMoves: 0, done: false, lastStage: 'gather', movedIds: [], moves: [], sweepVisited: [], mergeCursor: null, info }
      }
      // 這一遍沒有可合併 → 一輪結束
      if (!roundMoves) {
        return { cells, cols, rows, stage, round, steps, roundMoves, done: true, lastStage: null, movedIds: [], moves: [], sweepVisited: [], mergeCursor: null, info: `✔ 收斂完成——共 ${steps} 步、第 ${round} 輪三個演算法都沒有改動` }
      }
      round += 1
      roundMoves = 0
      stage = 'endp'
      sweepVisited = []
      mergeCursor = null
      continue
    }
    if (limit === 1) {
      // 小步：這一遍掃描中的下一個單一移動（動過的元素本輪不再動）
      const r = MOVEWISE_PASS[stage](skeleton, cells, cols, rows, new Set(sweepVisited))
      if (r.moved) {
        roundMoves += r.moved
        sweepVisited = [...sweepVisited, r.key]
        const mv = movesOf(cells, r.cellAfter, r.ids)
        const what = stage === 'endp' ? '移動 1 點' : '移動 1 線' // gather 已在上方分支處理，走到這只剩 endp/line
        return finalize(r.cellAfter, r.ids,
          `第 ${round} 輪 · ${STEP_STAGE_LABEL[stage]}${subTag}：${what}${coordTag(mv)}`)
      }
      // 這一遍掃完（剩下的元素都動不了）→ 換下一個演算法（下面共用推進邏輯）
    } else {
      // 大步：把這一遍掃完（接續小步的 sweepVisited），掃完換下一個演算法
      const visited = new Set(sweepVisited)
      const sw = movewiseSweep(stage, skeleton, cells, cols, rows, visited)
      if (sw.stats.moved) {
        roundMoves += sw.stats.moved
        const gridTag = sw.stats.fromCols !== sw.cols || sw.stats.fromRows !== sw.rows
          ? `｜縮減網格 ${sw.stats.fromCols}×${sw.stats.fromRows} → ${sw.cols}×${sw.rows}` : ''
        const doneStage = stage
        const nextStage = NEXT_STAGE[stage]
        const endOfRound = stage === 'gather'
        return {
          cells: sw.cellAfter, cols: sw.cols, rows: sw.rows,
          stage: nextStage, round: endOfRound ? round + 1 : round,
          steps: steps + 1, roundMoves: endOfRound ? 0 : roundMoves, done: false,
          lastStage: doneStage, movedIds: [], moves: [], sweepVisited: [], mergeCursor: null,
          info: `第 ${round} 輪 · ${STEP_STAGE_LABEL[doneStage]}（掃一遍）：${STAGE_INFO[doneStage](sw.stats)}${gridTag}`,
        }
      }
      // 這一遍沒有任何移動 → 換下一個演算法（下面共用推進邏輯）
    }
    // 推進：換下一個演算法（gather 的一輪結束邏輯在上面的特例處理）
    stage = NEXT_STAGE[stage]
    sweepVisited = []
    mergeCursor = null
  }
  return { cells, cols, rows, stage, round, steps, roundMoves, done: true, lastStage: null, movedIds: [], moves: [], sweepVisited: [], mergeCursor: null, info: `✔ 收斂完成——共 ${steps} 步、${round} 輪` }
}

// 端點移動+直線縮減+網格合併循環: each round runs the three MOVEWISE stages
// （每個階段自己迭代到不動點，且**每一個移動後都立即縮減網格**——縮減不再是
// 獨立步驟）until a round where NOTHING moves. Per-move compaction renumbers
// cells continuously, so hard-rule blocks (occlusion, landing on another
// vertex) shift and new moves keep opening up between stages/rounds.
// Straighten moves strictly grow H/V (bounded), line moves strictly shrink
// the (always-dense) grid (bounded below); gather slides are H/V-neutral, so
// POST_ITER_CAP rounds is the backstop against slide/median oscillation.
// 使用者規則（2026-07）：每輪＝三個演算法**各把整個 network 掃一遍**（一遍
// 掃描 movewiseSweep，非各自跑到不動點）——端點移動一遍 → 直線縮減一遍 →
// 網格合併一遍 → 回到端點移動；某一輪三個都沒有改動才停止。輪數因此比階段
// 固定點制多，上限放寬到 LOOP_ROUND_CAP。
const LOOP_ROUND_CAP = 200
export function straightenCompactLoop(skeleton, cells, cols, rows) {
  let cur = cells, nC = cols, nR = rows
  let rounds = 0, moved = 0, lineMoved = 0, gatherMoved = 0
  let hvBefore = null, last = null
  let converged = false
  while (rounds < LOOP_ROUND_CAP) {
    const endp = movewiseSweep('endp', skeleton, cur, nC, nR)
    const line = movewiseSweep('line', skeleton, endp.cellAfter, endp.cols, endp.rows)
    const gather = movewiseSweep('gather', skeleton, line.cellAfter, line.cols, line.rows)
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
      rounds, roundCap: LOOP_ROUND_CAP, converged,
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
  const hvdBefore = countHVD(pos, segs)
  const targets = new Map()
  for (const [id, t] of targetEntries) {
    if (!pos.has(id)) continue
    if (!Array.isArray(t) || !Number.isInteger(t[0]) || !Number.isInteger(t[1])) continue
    targets.set(id, [t[0], t[1]])
  }
  // LLM 對齊的接受準則＝H/V/對角 45°（countHVD），讓對角走向對到斜線而非 H/V 樓梯。
  const { moved, passes, reverted } = applyTargets(pos, M, targets, segs, 6, countHVD)
  return {
    cellAfter: pos,
    stats: {
      hvBefore, hvAfter: countHV(pos, segs),
      hvdBefore, hvdAfter: countHVD(pos, segs),
      segs: segs.length, verts: pos.size,
      moved, passes, reverted, proposed: targets.size,
    },
  }
}
