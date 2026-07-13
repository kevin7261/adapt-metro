// RWD Maps（版面路網畫線）— see skill route-rwd-draw.
// Draw the hill-climbing 縮減網格 layout as a schematic of STRICT H/V/45° legs.
//
// 硬規則：八方向約束以「版面 pixel」為準 — the H/V/45° test is evaluated on the
// SVG plot coordinates, NOT on integer cell indices. Once column width ≠ row
// height (any non-square canvas/grid), a cell-space diagonal is no longer 45°
// on screen, so the polylines must be (re)built in pixel space. The caller
// therefore passes PIXEL positions and re-runs this after every remap/resize.
//
// Hard constraints (a candidate violating any is vetoed):
//   · legs are H / V / 45° only (±TOL px)
//   · no route overlap — collinear sharing, PARALLEL HUGGING (nearly the same
//     line with overlapping projection, gap < minGap) and SEGMENT CROSSINGS
//     all count; routes may only meet at shared node positions
//   · no leg may run over a foreign node (endpoint-in-other-line included)
//   · at most 2 bends; with conflict-free candidates available, an overlapping
//     path must never be chosen
//
// Candidate order (fewest bends first):
//   0 bends  straight S→T when it already is H / V / 45°
//   1 bend   45° diagonal to the shorter delta, then H/V to T;
//            pure L (H then V; V then H); mirror (H/V first, 45° last)
//   2 bends  45°–H–45° (|Δx|>|Δy|) or 45°–V–45° (|Δy|>|Δx|) with the middle
//            leg at 1/2 of the span, alternates at 1/4 and 3/4 for conflicts
//   last     the raw straight S→T (illegal direction) as the final fallback
//
// A LEGAL straight that conflicts (parallel edges between the same two nodes,
// or a corridor already claimed) gets detours too: parallel offsets (45° out,
// run alongside at 1 then 2 units, 45° back — small detour first), then the
// big 1-bend detours (45° triangle apex for H/V, L corners for 45° lines).
// If even those conflict the straight is drawn anyway → stats.forced.
//
// Soft pass (衝突消解後微調): swap a line's choice ONLY among conflict-free
// candidates with the SAME bend count AND the SAME number of 45° legs (never
// straightens a settled diagonal), maximizing straight continuation with
// same-route lines at shared nodes (straight-through scores best, sharp 45°
// worst). Two sweeps; swaps are counted in stats.swapped.
//
// Pure function; `pos` are pixel coordinates, `opts.unit` is the detour offset
// in pixels (the caller passes ~one grid cell), `opts.minGap` the parallel-
// hugging veto distance (default 0.35 × unit).

const Z = 1e-9        // exact-zero guard
const FAKE_BLOCK = { li: -1 } // blocker sentinel for non-line obstacles (nodes, X legs)

// Minimal binary min-heap over [key, ...payload] tuples.
function makeHeap() {
  const a = []
  return {
    get size() { return a.length },
    push(it) {
      a.push(it)
      let c = a.length - 1
      while (c > 0) {
        const p = (c - 1) >> 1
        if (a[p][0] <= a[c][0]) break
        const t = a[p]; a[p] = a[c]; a[c] = t; c = p
      }
    },
    pop() {
      const top = a[0], last = a.pop()
      if (a.length) {
        a[0] = last
        let p = 0
        for (;;) {
          const l = 2 * p + 1, r = l + 1
          let m = p
          if (l < a.length && a[l][0] < a[m][0]) m = l
          if (r < a.length && a[r][0] < a[m][0]) m = r
          if (m === p) break
          const t = a[p]; a[p] = a[m]; a[m] = t; p = m
        }
      }
      return top
    },
  }
}
const TOL = 0.75      // px — direction classification (≈45° within a pixel is 45°)
const OVER_TOL = 0.5  // px — collinear extents must share more than this
const END_TOL = 0.5   // px — contact this close to BOTH endpoints = shared node

const dist = (A, B) => Math.hypot(B[0] - A[0], B[1] - A[1])

// H / V / D+ (slope +1) / D- (slope -1) / X (illegal) — the two diagonal
// families live on different line sets, so they are separate classes.
function dirOf(A, B) {
  const dx = B[0] - A[0], dy = B[1] - A[1]
  if (Math.abs(dx) < Z && Math.abs(dy) < Z) return null
  if (Math.abs(dy) < TOL) return 'H'
  if (Math.abs(dx) < TOL) return 'V'
  if (Math.abs(Math.abs(dx) - Math.abs(dy)) < TOL) return dx * dy > 0 ? 'D+' : 'D-'
  return 'X'
}
// Which infinite line of its family a leg lies on (H: y, V: x, D+: y−x, D−: y+x).
const lineKey = (dir, P) =>
  dir === 'H' ? P[1] : dir === 'V' ? P[0] : dir === 'D+' ? P[1] - P[0] : P[1] + P[0]
// 1-D extent along the line (x for H/D±, y for V) for the overlap test.
const spanOf = (dir, A, B) => {
  const v = dir === 'V' ? [A[1], B[1]] : [A[0], B[0]]
  return v[0] <= v[1] ? v : [v[1], v[0]]
}

function legOf(A, B) {
  const dir = dirOf(A, B)
  if (!dir || dir === 'X') return null
  const [lo, hi] = spanOf(dir, A, B)
  return { dir, key: lineKey(dir, A), lo, hi, A, B }
}

// Perpendicular gap between two same-family lines (key units → px).
const perpGap = (p, q) =>
  (p.dir === 'H' || p.dir === 'V') ? Math.abs(p.key - q.key) : Math.abs(p.key - q.key) / Math.SQRT2

// Same family: collinear overlap OR parallel hugging (gap < minGap) with a
// shared projected extent beyond a point.
const legsHug = (p, q, minGap) =>
  p.dir === q.dir && perpGap(p, q) < minGap &&
  Math.min(p.hi, q.hi) - Math.max(p.lo, q.lo) > OVER_TOL

// Different families: segments may only touch endpoint-to-endpoint AND at a
// REAL NODE position (`isNodePt`) — a bend corner is a leg endpoint too, but
// two lines touching at a bend is still a visual crossing. Any other contact
// (proper crossing, endpoint inside the other leg) is a conflict.
function legsCross(p, q, isNodePt) {
  const A = p.A, B = p.B, C = q.A, D = q.B
  const r = [B[0] - A[0], B[1] - A[1]], s = [D[0] - C[0], D[1] - C[1]]
  const den = r[0] * s[1] - r[1] * s[0]
  if (Math.abs(den) < Z) return false // parallel — the hug test owns this case
  const t = ((C[0] - A[0]) * s[1] - (C[1] - A[1]) * s[0]) / den
  const u = ((C[0] - A[0]) * r[1] - (C[1] - A[1]) * r[0]) / den
  const lp = dist(A, B), lq = dist(C, D)
  const inT = t * lp > -END_TOL && (1 - t) * lp > -END_TOL
  const inU = u * lq > -END_TOL && (1 - u) * lq > -END_TOL
  if (!inT || !inU) return false // no contact within either segment
  const endT = Math.min(Math.abs(t), Math.abs(1 - t)) * lp
  const endU = Math.min(Math.abs(u), Math.abs(1 - u)) * lq
  if (!(endT < END_TOL && endU < END_TOL)) return true
  return !isNodePt(A[0] + t * r[0], A[1] + t * r[1]) // endpoint contact must sit ON a node
}

// P strictly inside leg A–B (endpoint contact excluded).
function pointOnLeg(P, leg) {
  if (Math.abs(lineKey(leg.dir, P) - leg.key) > OVER_TOL) return false
  const t = leg.dir === 'V' ? P[1] : P[0]
  return t > leg.lo + OVER_TOL && t < leg.hi - OVER_TOL
}

// Detours for a LEGAL straight line that conflicts with earlier polylines.
// Bend count has ABSOLUTE priority（使用者規則：直線 > 單折 > 雙折）— every
// 1-bend detour is tried before any 2-bend one, however large its displacement.
// `u` is the offset unit in pixels (~one grid cell).
function legalDetours(S, T, dir, u) {
  const dx = T[0] - S[0], dy = T[1] - S[1]
  const sx = Math.sign(dx), sy = Math.sign(dy)
  const ax = Math.abs(dx), ay = Math.abs(dy)
  const out = []
  if (dir === 'H') {
    // NO 1-bend detour exists for an H line without a 45°→45° corner (the
    // triangle apex) — and 45°轉45° is forbidden (user rule). 2 bends only:
    // parallel offsets (45° out, run alongside, 45° back).
    for (const d of [u, 2 * u]) {
      if (ax <= 2 * d) continue
      for (const e of [1, -1]) {
        out.push({ pts: [S, [S[0] + sx * d, S[1] + e * d], [T[0] - sx * d, S[1] + e * d], T], bends: 2 })
      }
    }
  } else if (dir === 'V') {
    for (const d of [u, 2 * u]) {
      if (ay <= 2 * d) continue
      for (const e of [1, -1]) {
        out.push({ pts: [S, [S[0] + e * d, S[1] + sy * d], [S[0] + e * d, T[1] - sy * d], T], bends: 2 })
      }
    }
  } else { // D+ / D-
    const m = (ax + ay) / 2
    // 1 bend: L corners
    out.push({ pts: [S, [T[0], S[1]], T], bends: 1 })
    out.push({ pts: [S, [S[0], T[1]], T], bends: 1 })
    // 2 bends: run alongside via a short H or V lead-in/out
    for (const d of [u, 2 * u]) {
      if (m <= d) continue
      out.push({ pts: [S, [S[0] + sx * d, S[1]], [T[0], T[1] - sy * d], T], bends: 2 })
      out.push({ pts: [S, [S[0], S[1] + sy * d], [T[0] - sx * d, T[1]], T], bends: 2 })
    }
  }
  return out
}

// All candidate polylines S→T, fewest bends first (see header).
function candidates(S, T, u) {
  const dx = T[0] - S[0], dy = T[1] - S[1]
  const ax = Math.abs(dx), ay = Math.abs(dy)
  const sx = Math.sign(dx), sy = Math.sign(dy)
  const out = []
  const straightDir = dirOf(S, T)
  if (!straightDir) {
    out.push({ pts: [S, T], bends: 0 })
    return out
  }
  if (straightDir !== 'X') {
    out.push({ pts: [S, T], bends: 0 })
    out.push(...legalDetours(S, T, straightDir, u))
    return out
  }
  const m = Math.min(ax, ay)
  // 單轉折。同折數內以「轉折角最大」優先（使用者規則：先180 再135 再90 再45）：
  // 45° 接直線的內角是 135°，兩個方向都排在內角只有 90° 的純 L 形之前。
  out.push({ pts: [S, [S[0] + sx * m, S[1] + sy * m], T], bends: 1 }) // 45° → H/V（內角135°）
  out.push({ pts: [S, [T[0] - sx * m, T[1] - sy * m], T], bends: 1 }) // H/V → 45°（內角135°）
  out.push({ pts: [S, [T[0], S[1]], T], bends: 1 }) // L: H → V（內角90°）
  out.push({ pts: [S, [S[0], T[1]], T], bends: 1 }) // L: V → H（內角90°）
  // 雙轉折：45–H–45（ax>ay）或 45–V–45（ay>ax），中段預設 1/2，替代 1/4、3/4
  for (const t of [0.5, 0.25, 0.75]) {
    const k = m * t
    const P1 = [S[0] + sx * k, S[1] + sy * k]
    const P2 = [T[0] - sx * (m - k), T[1] - sy * (m - k)]
    out.push({ pts: [S, P1, P2, T], bends: 2 })
  }
  // 兜底：原方向直線（非 H/V/45）
  out.push({ pts: [S, T], bends: 0, fallback: true })
  return out
}

const legsOfPts = (pts) => {
  const out = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const leg = legOf(pts[i], pts[i + 1])
    if (leg) out.push(leg)
  }
  return out
}

// `pos` = Map<id, [x, y]> PIXEL positions of the (compact-grid) cut points.
// opts.unit = detour offset in pixels; opts.minGap = parallel-hug veto (px);
// opts.lattice = { x0, y0, sx, sy, nx, ny } half-cell routing lattice for the
// A* fallback (node centres sit on odd indices).
export function buildRwdMap(segs, pos, opts = {}) {
  const unit = opts.unit ?? 12
  const minGap = opts.minGap ?? unit * 0.35
  const nodes = [...pos.entries()] // [id, [x,y]] — foreign-node test
  // Node-position lookup (0.5px buckets) — legsCross may only exempt
  // endpoint-to-endpoint contact when it happens AT one of these.
  const nodeKeys = new Set()
  for (const P of pos.values()) nodeKeys.add(`${Math.round(P[0] * 2)}:${Math.round(P[1] * 2)}`)
  const isNodePt = (x, y) => nodeKeys.has(`${Math.round(x * 2)}:${Math.round(y * 2)}`)
  const lines = []
  // rerouted = lines the A* lattice router re-drew to kill a residual crossing
  // (may exceed 2 bends); forced = STILL in conflict after even that (should be
  // 0 — only a lattice-router failure leaves one); fallback = an illegal
  // direction nothing could legalize; swapped = soft continuation swaps.
  const stats = { straight: 0, single: 0, double: 0, multi: 0, rerouted: 0, fallback: 0, forced: 0, swapped: 0, squeezed: 0, straightened: 0, diag45: 0, restarts: 0, segs: 0 }

  const usable = segs.filter((s) => pos.has(s.a) && pos.has(s.b))
  // Longest corridors route first (they have the fewest workable alternatives);
  // stable tie-break keeps the result deterministic.
  const order = usable
    .map((s, i) => ({ s, i, len: dist(pos.get(s.a), pos.get(s.b)) }))
    .sort((p, q) => q.len - p.len || p.i - q.i)

  // Number of hard-rule violations of a candidate against the placed legs
  // (hug / cross / node-on-leg). 0 = clean; Infinity = an illegal X leg.
  function conflictCount(pts, seg, placed) {
    const legs = legsOfPts(pts)
    if (legs.length !== pts.length - 1) return Infinity // X leg → fallback only
    let n = 0
    for (const leg of legs) {
      for (const p of placed) {
        if (leg.dir === p.dir ? legsHug(leg, p, minGap) : legsCross(leg, p, isNodePt)) n++
      }
      for (const [id, P] of nodes) {
        if (id === seg.a || id === seg.b) continue
        if (pointOnLeg(P, leg)) n++
      }
    }
    return n
  }

  /* ---- lattice A* fallback (絕不交叉): when no bounded-bend candidate is
     conflict-free, route rectilinearly (H/V steps — still legal directions) on
     the half-cell lattice, only through space free of placed legs and nodes.
     Crossing-free BY CONSTRUCTION; bends may exceed 2 (turn-penalized).
     A cheap flood probe runs first: if T is UNREACHABLE (the other lines wall
     S or T into a closed face — Jordan), it fails fast and reports WHICH lines
     form the wall via failInfo.blockers (fuel for rip-up-and-reroute). ---- */
  function routeLattice(S, T, seg, placed, failInfo, gapOverride) {
    const lat = opts.lattice
    if (!lat) return null
    const gap = gapOverride ?? minGap // hug distance (salvage pass squeezes it)
    const { x0, y0, sx, sy, nx, ny } = lat
    const toI = (x) => Math.round((x - x0) / sx)
    const toJ = (y) => Math.round((y - y0) / sy)
    const atP = (i, j) => [x0 + i * sx, y0 + j * sy]
    const si = toI(S[0]), sj = toJ(S[1]), ti = toI(T[0]), tj = toJ(T[1])
    if (Math.min(si, sj, ti, tj) < 0 || si >= nx || ti >= nx || sj >= ny || tj >= ny) return null
    const blockedPt = new Set() // other nodes' lattice points
    for (const [id, P] of nodes) {
      if (id === seg.a || id === seg.b) continue
      blockedPt.add(toI(P[0]) * ny + toJ(P[1]))
    }
    // spatial buckets of placed legs (padded by minGap) → fast per-step tests
    const BW = Math.max(sx, sy) * 6
    const buckets = new Map()
    for (const p of placed) {
      const x1 = Math.min(p.A[0], p.B[0]) - minGap, x2 = Math.max(p.A[0], p.B[0]) + minGap
      const y1 = Math.min(p.A[1], p.B[1]) - minGap, y2 = Math.max(p.A[1], p.B[1]) + minGap
      for (let bx = Math.floor(x1 / BW); bx <= Math.floor(x2 / BW); bx++) {
        for (let by = Math.floor(y1 / BW); by <= Math.floor(y2 / BW); by++) {
          const k = bx * 100003 + by
          if (!buckets.has(k)) buckets.set(k, [])
          buckets.get(k).push(p)
        }
      }
    }
    const blockerOf = (A, B) => {
      const leg = legOf(A, B)
      if (!leg) return FAKE_BLOCK
      const bx1 = Math.floor((Math.min(A[0], B[0]) - minGap) / BW), bx2 = Math.floor((Math.max(A[0], B[0]) + minGap) / BW)
      const by1 = Math.floor((Math.min(A[1], B[1]) - minGap) / BW), by2 = Math.floor((Math.max(A[1], B[1]) + minGap) / BW)
      for (let bx = bx1; bx <= bx2; bx++) {
        for (let by = by1; by <= by2; by++) {
          for (const p of buckets.get(bx * 100003 + by) ?? []) {
            if (leg.dir === p.dir ? legsHug(leg, p, gap) : legsCross(leg, p, isNodePt)) return p
          }
        }
      }
      // Only MACRO legs (longer than a half-step) can sweep over a node — a
      // half-step's interior contains no lattice point, so skip the O(nodes)
      // scan on the A* hot path.
      if (leg.hi - leg.lo > Math.max(sx, sy) + 1e-6) {
        for (const [id, P] of nodes) {
          if (id === seg.a || id === seg.b) continue
          if (pointOnLeg(P, leg)) return FAKE_BLOCK
        }
      }
      return null
    }
    const legFree = (A, B) => !blockerOf(A, B)
    // 45° macro connectors (diag + axis, 1 bend) between a node and the lattice
    // points up to 2 cells away — the escape hatch when every rectilinear
    // half-step at a hub is already occupied by a same-family leg.
    function macros(P, pi, pj) {
      const out = [] // { i, j, mid: [pts between node and lattice pt], len }
      for (const da of [1, 2, 3, 4]) {
        for (const db of [1, 2, 3, 4]) {
          for (const sxn of [1, -1]) {
            for (const syn of [1, -1]) {
              const gi = pi + sxn * da, gj = pj + syn * db
              if (gi < 0 || gj < 0 || gi >= nx || gj >= ny) continue
              if (blockedPt.has(gi * ny + gj)) continue
              const G = atP(gi, gj)
              const ax = Math.abs(G[0] - P[0]), ay = Math.abs(G[1] - P[1])
              const t = Math.min(ax, ay)
              const D = [P[0] + sxn * t, P[1] + syn * t]
              const pureDiag = Math.abs(ax - ay) < TOL
              if (!legFree(P, pureDiag ? G : D)) continue
              if (!pureDiag && !legFree(D, G)) continue
              out.push({
                i: gi, j: gj,
                mid: pureDiag ? [] : [D],
                len: dist(P, D) + (pureDiag ? 0 : dist(D, G)),
                bendy: pureDiag ? 0 : 1,
              })
            }
          }
        }
      }
      return out
    }
    const TURN = 2 * unit
    const macS = macros(S, si, sj)
    const macT = macros(T, ti, tj)
    // portals: lattice points that can 45°-macro INTO T. dirIdx = the entry
    // path's FIRST leg direction (for the 45°→45° corner ban at the join).
    const portal = new Map() // i*ny+j -> { mid, len, dirIdx }
    for (const m of macT) {
      const k = m.i * ny + m.j
      const G = atP(m.i, m.j)
      const firstB = m.mid.length ? m.mid[m.mid.length - 1] : T // G→D→T (or G→T)
      const entry = { mid: [...m.mid].reverse(), len: m.len + m.bendy * TURN, dirIdx: -1, G, firstB }
      if (!portal.has(k) || portal.get(k).len > entry.len) portal.set(k, entry)
    }
    // Directed flood probe FROM T TOWARD S (best-first on Manhattan distance,
    // positions only — the same move set and reachability as the A* below):
    // open space hits S quickly, a walled-off pocket exhausts quickly, and the
    // legs the frontier bumped into name the wall lines for rip-up.
    const FLOOD_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    if (Math.abs(sx - sy) < 1e-9) FLOOD_DIRS.push([1, 1], [1, -1], [-1, 1], [-1, -1])
    {
      const targets = new Set([si * ny + sj])
      for (const m of macS) targets.add(m.i * ny + m.j)
      const seen = new Set()
      const fq = makeHeap()
      const dTo = (i, j) => Math.abs(si - i) * sx + Math.abs(sj - j) * sy
      const seed = (i, j) => {
        const k = i * ny + j
        if (!seen.has(k)) { seen.add(k); fq.push([dTo(i, j), i, j]) }
      }
      seed(ti, tj)
      for (const m of macT) seed(m.i, m.j)
      let reached = false
      const blockers = new Map() // line index -> hit count
      while (fq.size) {
        const [, i, j] = fq.pop()
        if (targets.has(i * ny + j)) { reached = true; break }
        for (const [dx, dy] of FLOOD_DIRS) {
          const ni = i + dx, nj = j + dy
          if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
          const k = ni * ny + nj
          if (seen.has(k)) continue
          if (blockedPt.has(k) && !targets.has(k)) continue
          const b = blockerOf(atP(i, j), atP(ni, nj))
          if (b) {
            if (b.li >= 0) blockers.set(b.li, (blockers.get(b.li) ?? 0) + 1)
            continue
          }
          seen.add(k)
          fq.push([dTo(ni, nj), ni, nj])
        }
      }
      if (!reached) {
        if (failInfo) failInfo.blockers = blockers
        return null
      }
    }
    // Weighted A* over (i, j, incoming-dir): px cost + turn penalty; any clean
    // path beats none, so the inflated heuristic (faster, near-greedy) is fine.
    // On a SQUARE lattice (sx === sy) diagonal steps are exact 45° — 8 moves.
    const W = 1.4
    const DIRS = [[1, 0, sx], [-1, 0, sx], [0, 1, sy], [0, -1, sy]]
    if (Math.abs(sx - sy) < 1e-9) {
      const dl = sx * Math.SQRT2
      DIRS.push([1, 1, dl], [1, -1, dl], [-1, 1, dl], [-1, -1, dl])
    }
    const ND = DIRS.length
    const skey = (i, j, d) => (i * ny + j) * ND + d
    const dirIdxOf = (A, B) => {
      const ddx = Math.sign(B[0] - A[0]), ddy = Math.sign(B[1] - A[1])
      return DIRS.findIndex((D) => D[0] === ddx && D[1] === ddy)
    }
    for (const e of portal.values()) e.dirIdx = dirIdxOf(e.G, e.firstB)
    const g = new Map(), from = new Map()
    const heap = makeHeap() // [f, key, i, j, d]
    const h = (i, j) => (Math.abs(ti - i) * sx + Math.abs(tj - j) * sy) * W
    // seeds: plain rectilinear exits + 45° macro exits from S
    const seedMid = new Map() // stateKey -> mid pts (between S and that lattice pt)
    for (let d = 0; d < ND; d++) { g.set(skey(si, sj, d), 0); heap.push([h(si, sj), skey(si, sj, d), si, sj, d]) }
    for (const m of macS) {
      // Seed with the macro's TRUE landing direction so the 45°→45° corner ban
      // below sees the diagonal leg (fallback: axis dirs when it has no index).
      const G = atP(m.i, m.j)
      const lastA = m.mid.length ? m.mid[m.mid.length - 1] : S
      const landDir = dirIdxOf(lastA, G)
      for (const d of landDir >= 0 ? [landDir] : [0, 1, 2, 3]) {
        const k = skey(m.i, m.j, d)
        const cost = m.len + m.bendy * TURN
        if (cost >= (g.get(k) ?? Infinity)) continue
        g.set(k, cost)
        seedMid.set(k, m.mid)
        heap.push([cost + h(m.i, m.j), k, m.i, m.j, d])
      }
    }
    let goal = null, goalEntry = null, pops = 0
    while (heap.size && pops < 400000) {
      const [, k, i, j, d] = heap.pop()
      pops++
      const gk = g.get(k)
      if (i === ti && j === tj) { goal = k; goalEntry = null; break }
      const pk = portal.get(i * ny + j)
      if (pk && !(i === si && j === sj) &&
          !(d >= 4 && pk.dirIdx >= 4 && pk.dirIdx !== d)) { // no 45°→45° at the join
        goal = k
        goalEntry = pk
        break
      }
      for (let nd = 0; nd < ND; nd++) {
        if (d >= 4 && nd >= 4 && nd !== d) continue // 45°轉45° forbidden (user rule)
        const [dx, dy, step] = DIRS[nd]
        const ni = i + dx, nj = j + dy
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
        if (blockedPt.has(ni * ny + nj) && !(ni === ti && nj === tj)) continue
        const nk = skey(ni, nj, nd)
        const cost = gk + step + (nd !== d ? TURN : 0)
        if (cost >= (g.get(nk) ?? Infinity)) continue
        if (!legFree(atP(i, j), atP(ni, nj))) continue
        g.set(nk, cost)
        from.set(nk, k)
        heap.push([cost + h(ni, nj), nk, ni, nj, nd])
      }
    }
    if (opts.debug) console.log(`[rwd A*] pops=${pops} goal=${goal != null}`)
    if (goal == null) return null
    // reconstruct lattice chain, prepend seed mid pts, append portal entry + T
    const idx = []
    let head = goal
    for (let k = goal; k !== undefined; k = from.get(k)) { head = k; idx.push([Math.floor(k / ND / ny), Math.floor(k / ND) % ny]) }
    idx.reverse()
    const chain = idx.map(([i, j]) => atP(i, j))
    const pts = [S, ...(seedMid.get(head) ?? []), ...chain.filter((p) => dist(p, S) > Z && dist(p, T) > Z)]
    if (goalEntry) pts.push(...goalEntry.mid)
    pts.push(T)
    // merge collinear runs (same H/V/D family and line) into single legs
    const merged = [pts[0]]
    for (let i = 1; i < pts.length - 1; i++) {
      const d1 = dirOf(merged[merged.length - 1], pts[i])
      const d2 = dirOf(pts[i], pts[i + 1])
      if (d1 && d2 && d1 === d2 && d1 !== 'X') continue
      if (dist(pts[i], merged[merged.length - 1]) < Z) continue
      merged.push(pts[i])
    }
    merged.push(pts[pts.length - 1])
    return merged.length >= 2 ? merged : null
  }

  const placedOf = (skipIdx) => {
    const out = []
    for (let i = 0; i < lines.length; i++) {
      if (i === skipIdx) continue
      for (const lg of lines[i].legs) {
        lg.li = i // owner tag — lets the flood probe name the wall lines
        out.push(lg)
      }
    }
    return out
  }

  const snapLine = (X) => ({ pts: X.pts, legs: X.legs, bends: X.bends, routed: X.routed, forced: X.forced })

  // Re-route line w around the CURRENT layout: cleanest bounded-bend candidate
  // first, the A* lattice router as backup. null = no clean shape exists.
  function rerouteAround(w, wi) {
    const S2 = pos.get(w.seg.a), T2 = pos.get(w.seg.b)
    const placedW = placedOf(wi)
    for (const c of candidates(S2, T2, unit)) {
      if (c.fallback) continue
      if (conflictCount(c.pts, w.seg, placedW) === 0) return { pts: c.pts, bends: c.bends, routed: false }
    }
    const r = routeLattice(S2, T2, w.seg, placedW)
    return r ? { pts: r, bends: r.length - 2, routed: true } : null
  }

  // Like conflictCount but names WHICH lines block（協商式拉直要知道找誰讓路）.
  // other = a blocker that cannot be negotiated away (node on leg, X leg).
  function conflictLines(pts, seg, placed) {
    const legs = legsOfPts(pts)
    if (legs.length !== pts.length - 1) return { count: Infinity, lines: new Set(), other: true }
    let count = 0, other = false
    const ls = new Set()
    for (const leg of legs) {
      for (const p of placed) {
        if (leg.dir === p.dir ? legsHug(leg, p, minGap) : legsCross(leg, p, isNodePt)) {
          count++
          if (p.li >= 0) ls.add(p.li)
          else other = true
        }
      }
      for (const [id, P] of nodes) {
        if (id === seg.a || id === seg.b) continue
        if (pointOnLeg(P, leg)) { count++; other = true }
      }
    }
    return { count, lines: ls, other }
  }

  // Rip-up & reroute（PCB 佈線手法）: L is walled in by the lines the flood
  // probe hit. Tear the busiest wall(s) down, route L through the opening,
  // then re-route each wall line around L. Commit only if EVERYONE ends clean.
  function ripUpAndRoute(L, li, blockers) {
    const snap = snapLine
    const tryRip = (wallIdxs) => {
      const walls = wallIdxs.map((wi) => lines[wi]).filter((w) => w && !w.fallback)
      if (walls.length !== wallIdxs.length) return false
      const saves = [snap(L), ...walls.map(snap)]
      const undo = () => {
        Object.assign(L, saves[0])
        walls.forEach((w, i) => Object.assign(w, saves[i + 1]))
      }
      for (const w of walls) w.legs = [] // rip up
      const mine = routeLattice(pos.get(L.seg.a), pos.get(L.seg.b), L.seg, placedOf(li))
      if (!mine) { undo(); return false }
      L.pts = mine
      L.legs = legsOfPts(mine)
      L.bends = mine.length - 2
      L.routed = true
      L.forced = false
      for (const w of walls) { // re-route each wall with L (and prior walls) placed
        const wi = lines.indexOf(w)
        const S2 = pos.get(w.seg.a), T2 = pos.get(w.seg.b)
        const placedW = placedOf(wi)
        let done = null
        for (const c of candidates(S2, T2, unit)) {
          if (c.fallback) continue
          if (conflictCount(c.pts, w.seg, placedW) === 0) { done = { pts: c.pts, bends: c.bends, routed: false }; break }
        }
        if (!done) {
          const r = routeLattice(S2, T2, w.seg, placedW)
          if (r) done = { pts: r, bends: r.length - 2, routed: true }
        }
        if (!done) { undo(); return false }
        w.pts = done.pts
        w.legs = legsOfPts(done.pts)
        w.bends = done.bends
        w.routed = done.routed
        w.forced = false
      }
      return true
    }
    const ranked = [...blockers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((e) => e[0])
    for (const wi of ranked) if (tryRip([wi])) return true
    for (let a = 0; a < ranked.length; a++) { // two walls jointly sealing the face
      for (let b = a + 1; b < ranked.length; b++) {
        if (tryRip([ranked[a], ranked[b]])) return true
      }
    }
    return false
  }

  /* ---- one routing attempt: pass 1 (bend-ordered, veto) + conflict sweeps
     with the A* fallback. `priority` segments route FIRST (see below). ---- */
  function routeAll(priority) {
    lines.length = 0
    const noRoute = new Set() // segs whose A* already failed this attempt
    const ordered = [
      ...order.filter((o) => priority.has(o.s)),
      ...order.filter((o) => !priority.has(o.s)),
    ]
    for (const { s } of ordered) {
      const S = pos.get(s.a), T = pos.get(s.b)
      const cands = candidates(S, T, unit)
      const placed = placedOf(-1)
      // First conflict-FREE candidate wins (bend order). If none exists, keep
      // H/V/45° legality and take the candidate with the FEWEST violations;
      // the off-angle raw straight is a last resort only when there is no
      // legal-direction candidate at all (degenerate spans).
      let chosen = null, chosenN = Infinity
      for (const c of cands) {
        if (c.fallback) continue
        const n = conflictCount(c.pts, s, placed)
        if (n === 0) { chosen = c; chosenN = 0; break }
        if (n < chosenN) { chosen = c; chosenN = n }
      }
      if (!chosen) chosen = cands.find((c) => c.fallback) ?? cands[0]
      // Priority segments are the previously-trapped ones — if even now no
      // candidate is clean, let A* carve a corridor while the plane is open.
      if (chosenN > 0 && priority.has(s)) {
        const routed = routeLattice(S, T, s, placed)
        if (routed) {
          lines.push({ seg: s, pts: routed, bends: routed.length - 2, routed: true, legs: legsOfPts(routed) })
          continue
        }
      }
      lines.push({
        seg: s, pts: chosen.pts, bends: chosen.bends,
        fallback: !!chosen.fallback, forced: chosenN > 0 && !chosen.fallback,
        legs: legsOfPts(chosen.pts),
      })
    }
    // conflict-reduction sweeps: retry every line still in conflict (both
    // parties of a crossing qualify) — min-conflict candidate first, then the
    // A* lattice router (clean by construction when it succeeds).
    for (let sweep = 0; sweep < 4; sweep++) {
      let improved = false, dirty = 0
      for (let li = 0; li < lines.length; li++) {
        const L = lines[li]
        if (L.fallback) continue
        const placed = placedOf(li)
        const curN = conflictCount(L.pts, L.seg, placed)
        if (curN === 0) { L.forced = false; continue }
        const S = pos.get(L.seg.a), T = pos.get(L.seg.b)
        let best = null, bestN = curN
        for (const c of candidates(S, T, unit)) {
          if (c.fallback) continue
          const n = conflictCount(c.pts, L.seg, placed)
          if (n < bestN) { best = c; bestN = n; if (n === 0) break }
        }
        if (bestN > 0 && !noRoute.has(L.seg)) {
          const failInfo = {}
          const routed = routeLattice(S, T, L.seg, placed, failInfo)
          if (routed) {
            best = { pts: routed, bends: routed.length - 2, routed: true }
            bestN = 0
          } else {
            noRoute.add(L.seg)
            if (failInfo.blockers?.size && ripUpAndRoute(L, li, failInfo.blockers)) {
              improved = true
              continue // L (and the wall) already updated in place
            }
          }
        }
        if (best) {
          L.pts = best.pts
          L.legs = legsOfPts(best.pts)
          L.bends = best.bends
          L.routed = !!best.routed
          L.forced = bestN > 0
          improved = true
        }
        if (bestN > 0) dirty++
      }
      if (!improved || !dirty) break
    }
  }

  /* ---- restart-with-priority（negotiation rerouting）: a segment that stays
     FORCED was WALLED IN — the lines routed before it enclosed its endpoint in
     a face the target is not on, and then NO crossing-free path exists at all
     (Jordan). Re-run the whole routing with the trapped segments FIRST: they
     get clean corridors while the plane is still open, and the former walls
     (routed later) bend around them instead. ---- */
  const priority = new Set()
  for (let round = 0; ; round++) {
    routeAll(priority)
    stats.restarts = round
    // 動畫中間幀（opts.fast）只跑一次 routeAll——過渡是暫態，不需完美無交叉，
    // 略過多輪重排／rip-up／救援／軟調整，換每幀夠快（最後一幀走完整品質）。
    if (opts.fast) break
    const bad = lines.filter((L) => L.forced)
    if (!bad.length || round >= 6) break
    let grew = false
    for (const L of bad) {
      if (!priority.has(L.seg)) { priority.add(L.seg); grew = true }
    }
    if (!grew) break // same offenders as last round — no progress possible
  }

  // Last-ditch salvage（窄縫）: for the very few segments with NO clean route
  // at normal spacing, try once more with the hug distance squeezed to 60% —
  // closer parallels, but crossings stay absolutely forbidden.
  if (!opts.fast) for (let li = 0; li < lines.length; li++) {
    const L = lines[li]
    if (!L.forced) continue
    const r = routeLattice(pos.get(L.seg.a), pos.get(L.seg.b), L.seg, placedOf(li), null, minGap * 0.6)
    if (r) {
      L.pts = r
      L.legs = legsOfPts(r)
      L.bends = r.length - 2
      L.routed = true
      L.forced = false
      L.squeezed = true
      stats.squeezed++
    }
  }

  /* ---- pass 2 (soft, 衝突消解後微調): same-bends / same-45°-count swaps that
     improve straight continuation with same-route lines at shared nodes ---- */
  const sharesRoute = (r1, r2) => {
    for (const id of r1) if (r2.has(id)) return true
    return false
  }
  // Unit direction AWAY from the node along a polyline's end.
  function awayDir(L, nodeId) {
    const pts = L.seg.a === nodeId ? L.pts : [...L.pts].reverse()
    const d = dist(pts[0], pts[1])
    if (d < Z) return null
    return [(pts[1][0] - pts[0][0]) / d, (pts[1][1] - pts[0][1]) / d]
  }
  const atNode = new Map() // nodeId -> [lineIdx]
  lines.forEach((L, i) => {
    for (const id of [L.seg.a, L.seg.b]) {
      if (!atNode.has(id)) atNode.set(id, [])
      atNode.get(id).push(i)
    }
  })
  // Straight-through with a same-route neighbour scores +1 (away-directions
  // opposite), a 45° kink −0.707; overlapping direction −1.
  function contScore(L, pts) {
    let score = 0
    const probe = { ...L, pts }
    for (const nodeId of [L.seg.a, L.seg.b]) {
      const my = awayDir(probe, nodeId)
      if (!my) continue
      for (const oi of atNode.get(nodeId) ?? []) {
        const O = lines[oi]
        if (O === L || !sharesRoute(L.seg.routes, O.seg.routes)) continue
        const their = awayDir(O, nodeId)
        if (!their) continue
        score += -(my[0] * their[0] + my[1] * their[1])
      }
    }
    return score
  }
  // 使用者規則：**同名路線盡量不轉折**——same-BEND swaps (any leg family) that
  // maximize straight continuation with same-route lines at shared nodes. Bend
  // count stays fixed (絕對優先序不動)，只重擺形狀讓路線穿過節點連成直線。
  function softPass() {
    for (let sweep = 0; sweep < 3; sweep++) {
      let improved = false
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i]
        if (L.fallback || L.forced || L.routed) continue // routed shapes are bespoke
        const S = pos.get(L.seg.a), T = pos.get(L.seg.b)
        const alts = candidates(S, T, unit).filter((c) =>
          !c.fallback && c.bends === L.bends)
        if (alts.length < 2) continue
        const placed = placedOf(i)
        let best = null, bestScore = contScore(L, L.pts) + 1e-6
        for (const c of alts) {
          const m = contScore(L, c.pts)
          if (m <= bestScore) continue
          if (conflictCount(c.pts, L.seg, placed) > 0) continue
          best = c
          bestScore = m
        }
        if (best) {
          L.pts = best.pts
          L.legs = legsOfPts(best.pts)
          stats.swapped++
          improved = true
        }
      }
      if (!improved) break
    }
  }

  /* ---- bend reduction（使用者規則：可直線就直線，直線 > 單折 > 雙折——
     不會有可以直線的沒畫直線）: retry every bent line with strictly fewer
     bends (straight first) and adopt the first conflict-free one; runs TO A
     FIXPOINT, so at exit NO line still has a conflict-free lower-bend shape.
     NEGOTIATED straightening（使用者規則：讓擋路的線調整、這條變直）: when the
     lower-bend shape is blocked by 1–2 other LINES only, rip them up, adopt
     the straighter shape, and re-route the blockers around it — commit only
     if everyone ends clean AND the TOTAL bend count strictly drops (never
     straighten yourself by bending someone else even more). ---- */
  function bendReductionToFixpoint() {
    for (let sweep = 0; sweep < 20; sweep++) {
      let improved = false
      for (let li = 0; li < lines.length; li++) {
        const L = lines[li]
        if (L.fallback || L.forced || L.bends <= 0) continue
        const S = pos.get(L.seg.a), T = pos.get(L.seg.b)
        const placed = placedOf(li)
        let adopted = false
        const ripsToTry = []
        for (const c of candidates(S, T, unit)) {
          if (c.fallback || c.bends >= L.bends) continue
          const info = conflictLines(c.pts, L.seg, placed)
          if (info.count === 0) {
            L.pts = c.pts
            L.legs = legsOfPts(c.pts)
            L.bends = c.bends
            L.routed = false
            L.squeezed = false
            stats.straightened++
            improved = true
            adopted = true
            break
          }
          if (!info.other && info.lines.size <= 2) ripsToTry.push({ c, walls: [...info.lines] })
        }
        if (adopted) continue
        for (const { c, walls } of ripsToTry) {
          if (walls.some((wi) => !lines[wi] || lines[wi].fallback || lines[wi].forced)) continue
          const before = L.bends + walls.reduce((s, wi) => s + lines[wi].bends, 0)
          const saves = [snapLine(L), ...walls.map((wi) => snapLine(lines[wi]))]
          const undo = () => {
            Object.assign(L, saves[0])
            walls.forEach((wi, k) => Object.assign(lines[wi], saves[k + 1]))
          }
          for (const wi of walls) lines[wi].legs = [] // rip the blockers up
          if (conflictCount(c.pts, L.seg, placedOf(li)) > 0) { undo(); continue }
          L.pts = c.pts
          L.legs = legsOfPts(c.pts)
          L.bends = c.bends
          L.routed = false
          L.squeezed = false
          let ok = true
          for (const wi of walls) { // blockers bend around the straightened line
            const done = rerouteAround(lines[wi], wi)
            if (!done) { ok = false; break }
            const w = lines[wi]
            w.pts = done.pts
            w.legs = legsOfPts(done.pts)
            w.bends = done.bends
            w.routed = done.routed
            w.forced = false
          }
          const after = c.bends + walls.reduce((s, wi) => s + lines[wi].bends, 0)
          if (!ok || after >= before) { undo(); continue } // 總折數必須嚴格下降
          stats.straightened++
          improved = true
          break
        }
      }
      if (!improved) break
    }
  }

  /* ---- L→45（使用者最終規則）: a pure horizontal+vertical corner turns one
     side into 45° when that does not overlap any other line. The side whose
     node CONTINUES a same-route 45° leg in the same direction wins, so the
     diagonal reads as one line flowing through the node. ---- */
  const isAxis = (d) => d === 'H' || d === 'V'
  function l45Pass() {
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li]
      if (L.fallback || L.forced || L.pts.length !== 3) continue
      const d1 = dirOf(L.pts[0], L.pts[1]), d2 = dirOf(L.pts[1], L.pts[2])
      if (!isAxis(d1) || !isAxis(d2) || d1 === d2) continue // not a pure L corner
      const S = pos.get(L.seg.a), T = pos.get(L.seg.b)
      const dx = T[0] - S[0], dy = T[1] - S[1]
      const sx = Math.sign(dx), sy = Math.sign(dy)
      const m = Math.min(Math.abs(dx), Math.abs(dy))
      if (m < Z) continue
      // continuation score at a node for a 45° leg leaving along unit vector v:
      // a same-route neighbour leaving along −v (straight through) is the prize.
      const contAt = (nodeId, v) => {
        let s = 0
        for (const oi of atNode.get(nodeId) ?? []) {
          const O = lines[oi]
          if (O === L || !sharesRoute(L.seg.routes, O.seg.routes)) continue
          const u = awayDir(O, nodeId)
          if (!u) continue
          const du = dirOf([0, 0], [u[0] * 10, u[1] * 10])
          if (du !== 'D+' && du !== 'D-') continue // 只認鄰段的 45° 腿
          s += u[0] * v[0] + u[1] * v[1] < -0.9 ? 2 : 0.5 // 同方向連起來優先
        }
        return s
      }
      const dl = Math.hypot(sx * m, sy * m)
      const cands45 = [
        { pts: [S, [S[0] + sx * m, S[1] + sy * m], T], score: contAt(L.seg.a, [sx * m / dl, sy * m / dl]) },
        { pts: [S, [T[0] - sx * m, T[1] - sy * m], T], score: contAt(L.seg.b, [-sx * m / dl, -sy * m / dl]) },
      ].sort((a, b) => b.score - a.score)
      // 使用者規則：L→45 是最後一步、能改就改（不重疊即轉）；兩個變體間以
      // 「同路線同方向 45° 鄰段」優先，其次整體續接分數。
      cands45.forEach((c) => { c.cont = contScore(L, c.pts) })
      cands45.sort((a, b) => b.score - a.score || b.cont - a.cont)
      const placed = placedOf(li)
      for (const c of cands45) {
        if (conflictCount(c.pts, L.seg, placed) > 0) continue
        L.pts = c.pts
        L.legs = legsOfPts(c.pts)
        stats.diag45++
        break
      }
    }
  }

  // 〔順接軟調整 → 降折到定點 → L→45〕跑兩輪：每一步挪動走廊後都可能冒出
  // 新的可直線/可順接機會，回頭再撿一次，保證「不會有可以直線的沒畫直線」
  // 且「同名路線盡量不轉折」。
  if (!opts.fast) for (let phase = 0; phase < 2; phase++) {
    softPass()
    bendReductionToFixpoint()
    l45Pass()
  }

  for (const L of lines) {
    stats.segs++
    if (L.fallback) stats.fallback++
    else if (L.routed) { stats.rerouted++; if (L.bends >= 3) stats.multi++; else if (L.bends === 2) stats.double++; else if (L.bends === 1) stats.single++; else stats.straight++ }
    else if (L.bends === 0) stats.straight++
    else if (L.bends === 1) stats.single++
    else if (L.bends === 2) stats.double++
    else stats.multi++
    if (L.forced) stats.forced++
  }

  /* ---- interior black stations: j-th of k sits at arc-length fraction
     j/(k+1) of the FINAL polyline (a→b order matches seg.interior) ---- */
  const posAfter = new Map(pos)
  for (const L of lines) {
    const ids = L.seg.interior
    if (!ids.length) continue
    const cum = [0]
    for (let i = 1; i < L.pts.length; i++) cum.push(cum[i - 1] + dist(L.pts[i - 1], L.pts[i]))
    const total = cum[cum.length - 1]
    for (let j = 1; j <= ids.length; j++) {
      const target = (j / (ids.length + 1)) * total
      let i = 1
      while (i < cum.length - 1 && cum[i] < target) i++
      const segLen = cum[i] - cum[i - 1]
      const t = segLen > Z ? (target - cum[i - 1]) / segLen : 0
      const A = L.pts[i - 1], B = L.pts[i]
      posAfter.set(ids[j - 1], [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t])
    }
  }

  return { lines, posAfter, stats }
}
