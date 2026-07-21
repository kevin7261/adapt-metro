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
export function makeUnionFind(ids = []) {
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
export function compactGridSafe(skeleton, cellAfter, cols, rows) {
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

export {
  setSpanCap,
  movewiseStage,
  stepChainInit,
  stepChainNext,
  straightenCompactLoop,
} from './movewise.js'
