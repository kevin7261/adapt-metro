import { pairKey, sharesRoute } from './netUtil.js'

// Included in D3Tab's in-memory RWD cache key. Bump whenever routing semantics
// change so Vite HMR cannot keep displaying polylines built by an old router.
export const RWD_ROUTER_REV = '2026-07-22-shape-freeze-v19'

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
//   4+ bends staircase 45°–H/V–45°–H/V–…–45°: split the diagonal into k 45°
//            risers with k-1 axis treads between them. The ONLY hard rule is
//            "a 45° must connect to an H/V" (no 45°→45° adjacency) — the NUMBER
//            of 45°/axis legs is NOT capped (user rule); k grows until risers or
//            treads drop below one grid cell (hard ceiling k≤10). k=3 also gets
//            mixed variants (…–H–…–V–… / …–V–…–H–…, shorter diagonals leaving
//            both an H and a V tread) for weaving around obstacles on both axes;
//            same-axis staircases (only 45° + one axis, cleaner) are tried first.
//            Bend-count priority still holds: more steps only when fewer conflict.
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

// 8 個方向族：H / V / D± (45°, slope ±1) / E± (22.5°, slope ±T22) / F± (67.5°,
// slope ±1/T22) / X (非法)。E/F 只在 16 方向的候選會產生；dirOf 一律判得出（族由
// pixel 斜率定，不需 dirs——由 candidates 依 dirs 決定產不產 22.5° 腿）。
const T22 = Math.tan(Math.PI / 8) // ≈0.414214 = tan22.5°；1/T22 = tan67.5°≈2.4142
const NORM_EF = Math.sqrt(1 + T22 * T22) // ≈1.08239，E/F 族 key→法向距離的除數
function dirOf(A, B) {
  const dx = B[0] - A[0], dy = B[1] - A[1]
  if (Math.abs(dx) < Z && Math.abs(dy) < Z) return null
  const ax = Math.abs(dx), ay = Math.abs(dy), pos = dx * dy > 0
  if (ay < TOL) return 'H'
  if (ax < TOL) return 'V'
  if (Math.abs(ax - ay) < TOL) return pos ? 'D+' : 'D-'
  if (Math.abs(ay - T22 * ax) < TOL) return pos ? 'E+' : 'E-' // slope ≈ ±T22（22.5°）
  if (Math.abs(ax - T22 * ay) < TOL) return pos ? 'F+' : 'F-' // slope ≈ ±1/T22（67.5°）
  return 'X'
}
// Which infinite line of its family a leg lies on. H:y V:x D+:y−x D−:y+x；
// E±:y∓T22·x（slope ±T22）；F±:x∓T22·y（slope ±1/T22）。
const lineKey = (dir, P) =>
  dir === 'H' ? P[1] : dir === 'V' ? P[0]
    : dir === 'D+' ? P[1] - P[0] : dir === 'D-' ? P[1] + P[0]
      : dir === 'E+' ? P[1] - T22 * P[0] : dir === 'E-' ? P[1] + T22 * P[0]
        : dir === 'F+' ? P[0] - T22 * P[1] : P[0] + T22 * P[1]
// 1-D extent along the line for the overlap test：較垂直的族（V/F±）用 y，其餘用 x。
const spanOf = (dir, A, B) => {
  const useY = dir === 'V' || dir === 'F+' || dir === 'F-'
  const v = useY ? [A[1], B[1]] : [A[0], B[0]]
  return v[0] <= v[1] ? v : [v[1], v[0]]
}

function legOf(A, B) {
  const dir = dirOf(A, B)
  if (!dir || dir === 'X') return null
  const [lo, hi] = spanOf(dir, A, B)
  return { dir, key: lineKey(dir, A), lo, hi, A, B }
}

// Perpendicular gap between two same-family lines (key units → px).
const perpGap = (p, q) => {
  const d = Math.abs(p.key - q.key)
  if (p.dir === 'H' || p.dir === 'V') return d
  if (p.dir === 'D+' || p.dir === 'D-') return d / Math.SQRT2
  return d / NORM_EF // E±/F±（key 差 → 法向距離）
}

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
function legalDetours(S, T, dir, u, dirs = 8) {
  const dx = T[0] - S[0], dy = T[1] - S[1]
  const sx = Math.sign(dx), sy = Math.sign(dy)
  const ax = Math.abs(dx), ay = Math.abs(dy)
  const out = []
  const diag = dirs >= 8 // 8 方向以上才用 45° 出入的平行偏移；4 方向改純直角偏移。
  if (dir === 'H') {
    // NO 1-bend detour exists for an H line without a 45°→45° corner (the
    // triangle apex) — and 45°轉45° is forbidden (user rule). 2 bends only:
    // parallel offsets. 8 方向：45° 出、平行、45° 回；4 方向：V 出、平行、V 回（純直角）。
    for (const d of [u, 2 * u]) {
      if (ax <= 2 * d) continue
      for (const e of [1, -1]) {
        out.push(diag
          ? { pts: [S, [S[0] + sx * d, S[1] + e * d], [T[0] - sx * d, S[1] + e * d], T], bends: 2 }
          : { pts: [S, [S[0], S[1] + e * d], [T[0], S[1] + e * d], T], bends: 2 })
      }
    }
  } else if (dir === 'V') {
    for (const d of [u, 2 * u]) {
      if (ay <= 2 * d) continue
      for (const e of [1, -1]) {
        out.push(diag
          ? { pts: [S, [S[0] + e * d, S[1] + sy * d], [S[0] + e * d, T[1] - sy * d], T], bends: 2 }
          : { pts: [S, [S[0] + e * d, S[1]], [S[0] + e * d, T[1]], T], bends: 2 })
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

// Merge consecutive collinear H/V runs; drop zero-length points.
function mergeOrthoPts(pts) {
  if (!pts || pts.length < 2) return null
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    if (dist(pts[i], out[out.length - 1]) < Z) continue
    out.push(pts[i])
  }
  if (out.length < 2) return null
  const merged = [out[0]]
  for (let i = 1; i < out.length - 1; i++) {
    const d1 = dirOf(merged[merged.length - 1], out[i])
    const d2 = dirOf(out[i], out[i + 1])
    if (d1 && d2 && d1 === d2 && (d1 === 'H' || d1 === 'V')) continue
    merged.push(out[i])
  }
  merged.push(out[out.length - 1])
  for (let i = 1; i < merged.length; i++) {
    const d = dirOf(merged[i - 1], merged[i])
    if (d !== 'H' && d !== 'V') return null
  }
  return merged.length >= 2 ? merged : null
}

// 4 方向：把 8 方向候選裡的每條 45° 腿展開成 H/V（兩種順序都試），
// 分點公式完全沿用 8 方向；端點 S/T 不動 → 拓撲不變。
function expand45ToOrtho(pts45, vhFirst) {
  const raw = [pts45[0]]
  for (let i = 0; i + 1 < pts45.length; i++) {
    const A = pts45[i], B = pts45[i + 1]
    const d = dirOf(A, B)
    if (d === 'H' || d === 'V') {
      raw.push(B)
      continue
    }
    if (d !== 'D+' && d !== 'D-') return null
    const mid = vhFirst ? [A[0], B[1]] : [B[0], A[1]] // V→H 或 H→V
    if (dist(A, mid) > Z) raw.push(mid)
    raw.push(B)
  }
  return mergeOrthoPts(raw)
}

// All candidate polylines S→T, fewest bends first (see header).
// dirs = 允許的線方向數：4（只 H/V）| 8（+45°，預設）| 16（+22.5°）。優先序永遠是
// H/V > 45° > 22.5°；dirs 只決定「允許到哪一級」。4 方向不產任何 45° 候選（對角段
// 只 L／純直角繞行）；16 方向另加 22.5° 候選（見下，dirs>=16 段）。
function candidates(S, T, u, dirs = 8) {
  const dx = T[0] - S[0], dy = T[1] - S[1]
  const ax = Math.abs(dx), ay = Math.abs(dy)
  const sx = Math.sign(dx), sy = Math.sign(dy)
  const out = []
  let straightDir = dirOf(S, T)
  // Even an exact 22.5°/67.5° endpoint pair must first try the complete
  // H/V/45° family. Keep its direct skew line as a deferred candidate instead
  // of returning early from the direct-line branch.
  const deferredSkewStraight = dirs >= 16
    && (straightDir === 'E+' || straightDir === 'E-' || straightDir === 'F+' || straightDir === 'F-')
  if (deferredSkewStraight) straightDir = 'X'
  // 16 方向以下：22.5° 直線（E±/F±）非法 → 當對角段折（用 45°／L）。
  if (dirs < 16 && (straightDir === 'E+' || straightDir === 'E-' || straightDir === 'F+' || straightDir === 'F-')) straightDir = 'X'
  // 4 方向：45° 直線（D±）也非法 → 當對角段折（走 'X' 分支用 L）。
  if (dirs < 8 && (straightDir === 'D+' || straightDir === 'D-')) straightDir = 'X'
  if (!straightDir) {
    out.push({ pts: [S, T], bends: 0 })
    return out
  }
  if (straightDir !== 'X') {
    out.push({ pts: [S, T], bends: 0 })
    out.push(...legalDetours(S, T, straightDir, u, dirs))
    return out
  }
  const m = Math.min(ax, ay)
  // 單轉折。同折數內以「轉折角最大」優先（使用者規則：先180 再135 再90 再45）：
  // 45° 接直線的內角是 135°，兩個方向都排在內角只有 90° 的純 L 形之前。
  if (dirs >= 8) {
    out.push({ pts: [S, [S[0] + sx * m, S[1] + sy * m], T], bends: 1 }) // 45° → H/V（內角135°）
    out.push({ pts: [S, [T[0] - sx * m, T[1] - sy * m], T], bends: 1 }) // H/V → 45°（內角135°）
  }
  out.push({ pts: [S, [T[0], S[1]], T], bends: 1 }) // L: H → V（內角90°）
  out.push({ pts: [S, [S[0], T[1]], T], bends: 1 }) // L: V → H（內角90°）

  // 8 方向雙折／多折的「骨架點列」（含 45°）。4 方向會把它們展開成純 H/V；
  // 8/16 方向直接採用。分點公式兩邊共用 → 計算方式一致，只是 45↔VH。
  const diagSkels = []
  // 雙轉折 (a) 45–H–45 / 45–V–45：中段 50%／25%／75%。
  for (const t of [0.5, 0.25, 0.75]) {
    const k = m * t
    const P1 = [S[0] + sx * k, S[1] + sy * k]
    const P2 = [T[0] - sx * (m - k), T[1] - sy * (m - k)]
    diagSkels.push([S, P1, P2, T])
  }
  // 雙轉折 (b) H–45–H / V–45–V。
  {
    const horiz = ax > ay
    const axisTot = Math.abs(ax - ay)
    for (const t of [0.5, 0.25, 0.75]) {
      const h1 = axisTot * t
      const P1 = horiz ? [S[0] + sx * h1, S[1]] : [S[0], S[1] + sy * h1]
      const P2 = [P1[0] + sx * m, P1[1] + sy * m]
      diagSkels.push([S, P1, P2, T])
    }
  }
  // 三轉折混合（使用者案例 vh-45-vh-45）：axis–45–axis–45 與 45–axis–45–axis。
  // 雙折的軸腿只能貼在起訖兩排；這一族把「中間那條軸腿」抬到中間列/欄
  // （45 riser 分點 rf）、軸腿再分 hf——兩排走廊都被佔用時的唯一三折解。
  {
    const horiz = ax > ay
    const A = Math.abs(ax - ay)
    if (A > Z && m > Z) {
      const axisLeg = (P, len) => (horiz ? [P[0] + sx * len, P[1]] : [P[0], P[1] + sy * len])
      const diagLeg = (P, len) => [P[0] + sx * len, P[1] + sy * len]
      for (const rf of [0.5, 0.25, 0.75]) {
        const r1 = m * rf
        for (const hf of [0.5, 0.25, 0.75]) {
          const h1 = A * hf, h2 = A - h1
          { // axis–45–axis–45
            const P1 = axisLeg(S, h1)
            const P2 = diagLeg(P1, r1)
            const P3 = axisLeg(P2, h2)
            diagSkels.push([S, P1, P2, P3, T])
          }
          { // 45–axis–45–axis
            const P1 = diagLeg(S, r1)
            const P2 = axisLeg(P1, h1)
            const P3 = diagLeg(P2, m - r1)
            diagSkels.push([S, P1, P2, P3, T])
          }
        }
      }
    }
  }
  // 四轉折階梯 45–H/V–45–H/V–45（同軸＋混合）。
  {
    const horiz = ax > ay
    const a = m / 3
    const axisTotal = Math.abs(ax - ay)
    for (const [f1, f2] of [[0.5, 0.5], [0.25, 0.75], [0.75, 0.25]]) {
      const b1 = axisTotal * f1, b2 = axisTotal * f2
      const P1 = [S[0] + sx * a, S[1] + sy * a]
      const P2 = horiz ? [P1[0] + sx * b1, P1[1]] : [P1[0], P1[1] + sy * b1]
      const P3 = [P2[0] + sx * a, P2[1] + sy * a]
      const P4 = horiz ? [P3[0] + sx * b2, P3[1]] : [P3[0], P3[1] + sy * b2]
      diagSkels.push([S, P1, P2, P3, P4, T])
    }
    for (const gf of [0.25, 1 / 6]) {
      const g = m * gf
      const h = ax - 3 * g, v = ay - 3 * g
      if (h <= 0 || v <= 0) continue
      const D1 = [S[0] + sx * g, S[1] + sy * g]
      const H2 = [D1[0] + sx * h, D1[1]]
      const HD3 = [H2[0] + sx * g, H2[1] + sy * g]
      const HV4 = [HD3[0], HD3[1] + sy * v]
      diagSkels.push([S, D1, H2, HD3, HV4, T])
      const V2 = [D1[0], D1[1] + sy * v]
      const VD3 = [V2[0] + sx * g, V2[1] + sy * g]
      const VH4 = [VD3[0] + sx * h, VD3[1]]
      diagSkels.push([S, D1, V2, VD3, VH4, T])
    }
  }
  // 交替階梯一般化（使用者規則：vh-45 / 45-vh 重覆幾次**不設限**，只要能正確畫、
  // 折數最少的合法候選勝出）——45° 腿與軸腿任意次交替，四種頭尾組合都生成：
  // 45…45（斜多一條）、axis…axis（軸多一條）、45…axis 與 axis…45（等數兩種順序）。
  // 均勻分點（≤4 折的家族已在上面帶 50/25/75 分點變體）；折數不用預先偏好，
  // pickBest 的「衝突最少 → 折數最少」自然收斂到最短的合法交替。
  {
    const A2 = Math.abs(ax - ay)
    const step = Math.max(u, 1e-6)
    const horiz = ax > ay
    const axisLeg2 = (P, len) => (horiz ? [P[0] + sx * len, P[1]] : [P[0], P[1] + sy * len])
    const diagLeg2 = (P, len) => [P[0] + sx * len, P[1] + sy * len]
    const build = (kD, kA, diagFirst) => {
      if (kD < 1 || kA < 1 || Math.abs(kD - kA) > 1) return
      if (m / kD < step || A2 / kA < step) return // 腿短於一格＝畫不出，跳過
      const pts = [S]
      let P = S, d = 0, a = 0, useDiag = diagFirst
      while (d < kD || a < kA) {
        if (useDiag && d < kD) { P = diagLeg2(P, m / kD); d++ }
        else if (!useDiag && a < kA) { P = axisLeg2(P, A2 / kA); a++ }
        else return // 交替排不下去（頭尾組合與腿數不相容）
        pts.push(P)
        useDiag = !useDiag
      }
      pts[pts.length - 1] = T
      diagSkels.push(pts)
    }
    for (let legs = 5; legs <= 21; legs++) { // legs-1 = 折數 4..20，由幾何 step 自然封頂
      const hi = Math.ceil(legs / 2), lo = Math.floor(legs / 2)
      if (legs % 2) {
        build(hi, lo, true)  // 45 開頭、45 結尾（斜腿多一條）
        build(lo, hi, false) // axis 開頭、axis 結尾（軸腿多一條）
      } else {
        build(hi, lo, true)  // 45 開頭、axis 結尾
        build(hi, lo, false) // axis 開頭、45 結尾
      }
    }
  }

  if (dirs < 8) {
    // 4 方向與 8/16 用**同一組骨架**（雙折 50/25/75、四折/多折階梯），唯一差別是
    // 每條 45° 腿展開成 H/V（兩種順序都試）。判斷方式三個方向級完全一致。
    const seen = new Set()
    const batch = []
    const pushCand = (pts, zRank) => {
      const m2 = mergeOrthoPts(pts)
      if (!m2) return
      const key = m2.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join('|')
      if (seen.has(key)) return
      seen.add(key)
      batch.push({ pts: m2, bends: m2.length - 2, zRank })
    }
    // 標準 Z 字（真正的 2 折，分點 50%→25%→75%）：V–tΔy–H–V 與 H–tΔx–V–H。
    // 45° 腿展開共用同一個 vhFirst 旗標時產不出這種「混合順序」形（會多一折成
    // 階梯），所以直接生成——這正是「有重疊就移到 25%/75%」要用的形。
    for (const [zi, t] of [0.5, 0.25, 0.75].entries()) {
      const ys = S[1] + dy * t
      pushCand([S, [S[0], ys], [T[0], ys], T], zi) // V–H–V
      const xs = S[0] + dx * t
      pushCand([S, [xs, S[1]], [xs, T[1]], T], zi) // H–V–H
    }
    for (const [i, sk] of diagSkels.entries()) {
      const zRank = i < 6 ? i % 3 : Infinity // 0=50%, 1=25%, 2=75%（雙折家族）
      for (const vhFirst of [true, false]) {
        const pts = expand45ToOrtho(sk, vhFirst)
        if (!pts) continue
        const key = pts.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join('|')
        if (seen.has(key)) continue
        seen.add(key)
        batch.push({ pts, bends: pts.length - 2, zRank })
      }
    }
    // 展開＋合併後折數可能與骨架順序不同 → 依折數（同折數依 50/25/75）重排，
    // 維持「候選由少折到多折」的全域約定（jointReroutePairs 靠它提早 break）。
    batch.sort((a, b) => a.bends - b.bends || (a.zRank < b.zRank ? -1 : a.zRank > b.zRank ? 1 : 0))
    out.push(...batch)
  } else {
    for (const [i, pts] of diagSkels.entries()) {
      // 50%/25%/75% only ranks the double-bend families; single-bend 45°/L
      // keep zRank unset (Infinity) and win on fewer bends when clean.
      const zRank = i < 6 ? i % 3 : Infinity
      out.push({ pts, bends: pts.length - 2, zRank })
    }
  }
  // 22.5° 族候選（僅 16 方向，且**排在所有 45° 候選之後**）：使用者規則「能用 45 就
  // 不用 22.5/67.5」——嚴格方向級優先於折數，要窮盡所有 45° 畫法（單/雙/多折）都衝突
  // 才降到 22.5°。斜段用 E(22.5°)／F(67.5°)、另一段軸向補，讓段用更貼近真實角度的斜線
  // （45° 全被佔/畫不出時的替代，如黃線案）。斜段與軸段有軸向隔開，不構成斜轉斜。
  if (dirs >= 16) {
    const s = ay / ax
    const pushSkew = (t) => { // slope t：s>t → 斜(走 ax)＋V 補；s<t → 斜(走 ay)＋H 補
      if (Math.abs(s - t) < 1e-9) return // 恰為該斜角＝直線，已在直線分支
      // skew:true 標記 22.5° 級候選——降折/軟調整不得把 45 級「降折」到 22.5 級
      // （使用者規則：能 45 就不用 22.5，方向級優先於折數）。
      if (s > t) {
        const yd = sy * t * ax
        out.push({ pts: [S, [T[0], S[1] + yd], T], bends: 1, skew: true }) // 斜 → V
        out.push({ pts: [S, [S[0], T[1] - yd], T], bends: 1, skew: true }) // V → 斜
      } else {
        const xd = sx * ay / t
        out.push({ pts: [S, [S[0] + xd, T[1]], T], bends: 1, skew: true }) // 斜 → H
        out.push({ pts: [S, [T[0] - xd, S[1]], T], bends: 1, skew: true }) // H → 斜
      }
    }
    pushSkew(T22)     // 22.5°（E 族）
    pushSkew(1 / T22) // 67.5°（F 族）
    // 22.5° 雙折家族（斜–軸–斜／軸–斜–軸，分點 50/25/75）＋ 45°＋22.5° 混合家族
    // （45–軸–斜／斜–軸–45，使用者規則：同一條路可以 45 與 22.5 組合）。所有斜腿
    // 仍以軸向隔開（斜轉斜禁止），全部標 skew:true——同衝突數時 45 級照樣優先，
    // 但「有 45＋22.5 的畫法可以不重疊」時不再被迫貼線／繞遠／forced。
    const FSPLIT = [0.5, 0.25, 0.75]
    // 每條腿都要長過方向判定容差（TOL），否則次像素腿會被 dirOf 誤判成 H/V。
    const MINLEG = 2 * TOL
    const pushMix = (pts, fi) => {
      for (let i = 0; i + 1 < pts.length; i++) {
        if (Math.abs(pts[i + 1][0] - pts[i][0]) + Math.abs(pts[i + 1][1] - pts[i][1]) < MINLEG) return
      }
      out.push({ pts, bends: pts.length - 2, skew: true, zRank: fi })
    }
    for (const t of [T22, 1 / T22]) {
      const eFull = ay / t      // skew 腿走完全部 Δy 所需的 x 前進量（配 H 補）
      const hRest = ax - eFull  // H 剩餘（>0 才可行）
      const vRest = ay - t * ax // V 剩餘（skew 腿走完全部 Δx，>0 才可行）
      for (const [fi, f] of FSPLIT.entries()) {
        if (hRest > Z) {
          const e1 = eFull * f // 斜–H–斜：兩條同族斜腿分掉 eFull、H 在中間
          const P1 = [S[0] + sx * e1, S[1] + sy * t * e1]
          pushMix([S, P1, [P1[0] + sx * hRest, P1[1]], T], fi)
          const h1 = hRest * f // H–斜–H：斜腿一條走完、H 分兩端
          const Q1 = [S[0] + sx * h1, S[1]]
          pushMix([S, Q1, [Q1[0] + sx * eFull, Q1[1] + sy * ay], T], fi)
        }
        if (vRest > Z) {
          const x1 = ax * f // 斜–V–斜
          const P1 = [S[0] + sx * x1, S[1] + sy * t * x1]
          pushMix([S, P1, [P1[0], P1[1] + sy * vRest], T], fi)
          const v1 = vRest * f // V–斜–V
          const Q1 = [S[0], S[1] + sy * v1]
          pushMix([S, Q1, [Q1[0] + sx * ax, Q1[1] + sy * t * ax], T], fi)
        }
        // 45＋22.5 混合：45 腿走 d（兩軸各 d）、斜腿補另一斜量、軸向腿隔在中間。
        const d = Math.min(ax, ay) * f
        { // H 補：45 與斜腿合力走完 Δy，剩餘 Δx 給 H
          const e = (ay - d) / t, h = ax - d - e
          if (d > Z && e > Z && h > Z) {
            const A1 = [S[0] + sx * d, S[1] + sy * d] // 45–H–斜
            pushMix([S, A1, [A1[0] + sx * h, A1[1]], T], fi)
            const B1 = [S[0] + sx * e, S[1] + sy * t * e] // 斜–H–45
            pushMix([S, B1, [B1[0] + sx * h, B1[1]], T], fi)
          }
        }
        { // V 補：45 與斜腿合力走完 Δx，剩餘 Δy 給 V
          const e = ax - d, v = ay - d - t * e
          if (d > Z && e > Z && v > Z) {
            const A1 = [S[0] + sx * d, S[1] + sy * d] // 45–V–斜
            pushMix([S, A1, [A1[0], A1[1] + sy * v], T], fi)
            const B1 = [S[0] + sx * e, S[1] + sy * t * e] // 斜–V–45
            pushMix([S, B1, [B1[0], B1[1] + sy * v], T], fi)
          }
        }
      }
    }
    if (deferredSkewStraight) out.push({ pts: [S, T], bends: 0, skew: true })
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

// Collapse lines that the IMPORTED NETWORK draws on the SAME track into ONE line
// with every route's colour interleaved — instead of the router offsetting them
// into separate parallel lines (使用者裁決：跟匯入的 network 一樣，重疊就一條).
// Two mechanisms, both keyed on the real imported geometry, never on official-map
// semantics:
//   (A) same two cut nodes — an express/direct edge + a local that stops between,
//       or any lines sharing both endpoints.
//   (B) geometry overlap — an express edge whose whole real track (edge.geom)
//       lies on a CHAIN of other edges' tracks even though it skips an interior
//       junction (so it doesn't share both endpoints). The express physically
//       runs the same rails, just without stopping, so the network draws it on
//       that track; RWD must too. A geometric gate (max deviation < TAU) keeps a
//       genuinely different corridor — kilometres away — from ever being merged.
// The most-detailed edge (longest path) carries the geometry; absorbed edges'
// routes/colours union onto EVERY segment of it (whole chain renders interleaved)
// and their own segments drop. Pure — builds fresh edge objects, never mutates
// the skeleton; segment order preserved (the router is order-sensitive).
export function mergeParallelSegs(segs) {
  const pk = pairKey
  const edges = []
  const edgeSeen = new Set()
  for (const s of segs) { const e = s.edge; if (e && !edgeSeen.has(e)) { edgeSeen.add(e); edges.push(e) } }

  // Per surviving edge: accumulated routes/colours (starts from its own); plus a
  // drop set and a rebuild map from original edge → its merged replacement.
  const accum = new Map() // edge -> { routes:Set, colors:[] }
  for (const e of edges) accum.set(e, { routes: new Set(e.routes ?? []), colors: [...(e.routeColors ?? [])] })
  const dropped = new Set()
  const absorb = (from, into) => { // fold `from`'s routes/colours into `into`
    const a = accum.get(into)
    for (const r of (from.routes ?? [])) a.routes.add(r)
    for (const c of (from.routeColors ?? [])) a.colors.push(c)
  }
  const stations = (e) => (e.path?.length ?? 2)

  // (A) same-endpoint groups: longest path is the rep, others fold into it.
  const byPair = new Map()
  for (const e of edges) {
    if (e.a === e.b) continue // loops are their own class, never merged
    const k = pk(e.a, e.b)
    if (!byPair.has(k)) byPair.set(k, [])
    byPair.get(k).push(e)
  }
  for (const group of byPair.values()) {
    if (group.length < 2) continue
    const rep = group.reduce((best, e) => (stations(e) > stations(best) ? e : best), group[0])
    const repSt = new Set(rep.path ?? [])
    for (const e of group) {
      if (e === rep) continue
      // Coverage guard: never absorb an edge that has a station the rep lacks —
      // dropping its segment would leave that station with NO line through it
      // (a separate line sharing endpoints but with its own stops, e.g. a metro
      // running the same corridor as suburban rail). Merge only truly-redundant
      // twins (a direct express whose stops are all on the local).
      if (!(e.path ?? []).every((id) => repSt.has(id))) continue
      absorb(e, rep); dropped.add(e)
    }
  }

  // (B) geometry-overlap absorption (express over a junction on the same rails).
  const ptSegD = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-18
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2
    t = t < 0 ? 0 : t > 1 ? 1 : t
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
  }
  const maxDev = (A, B) => { // max distance of A's vertices to polyline B
    if (!A || !B || A.length < 1 || B.length < 2) return Infinity
    let m = 0
    for (const p of A) { let d = Infinity; for (let i = 1; i < B.length; i++) d = Math.min(d, ptSegD(p, B[i - 1], B[i])); if (d > m) m = d }
    return m
  }
  // ~10m in degrees. Routes sharing a track reuse the SAME imported polyline
  // (deviation ≈ 0); even closely parallel-but-separate tracks sit further apart
  // than this, so a tight gate merges only true same-rail overlaps.
  const TAU = 1e-4
  const live = edges.filter((e) => !dropped.has(e) && e.a !== e.b && (e.geom?.length ?? 0) >= 2)
  const connects = (es, a, b) => { // do edges `es` link a to b?
    const g = new Map(); const t = (id) => { if (!g.has(id)) g.set(id, []); return g.get(id) }
    for (const e of es) { t(e.a).push(e.b); t(e.b).push(e.a) }
    const q = [a], seen = new Set([a])
    while (q.length) { const n = q.shift(); if (n === b) return true; for (const m of (g.get(n) ?? [])) if (!seen.has(m)) { seen.add(m); q.push(m) } }
    return false
  }
  // Candidate express E → the chain of other edges lying fully on E's track.
  const chains = []
  for (const E of live) {
    // Each chain edge must lie ON E's track (its whole geom within TAU of E's).
    // NOT the reverse: E (the express) is LONGER than any single piece, so it
    // extends past each — coverage is instead guaranteed by connects()+stations.
    const chain = live.filter((x) => x !== E && maxDev(x.geom, E.geom) < TAU)
    if (!chain.length || !connects(chain, E.a, E.b)) continue
    const chainStations = new Set(); for (const x of chain) for (const id of (x.path ?? [])) chainStations.add(id)
    if (chainStations.size <= stations(E)) continue // E must be the sparser (express) side
    // Coverage guard (critical): every station of E must already sit on the
    // chain, or dropping E orphans it. A line that shares rails but has its OWN
    // stops (Sydney Metro over the suburban corridor) fails this and stays
    // separate — geometry overlap alone must never merge distinct lines.
    if (!(E.path ?? []).every((id) => chainStations.has(id))) continue
    chains.push({ E, chain })
  }
  // Absorb fewest-station (most express) first; skip if the chain hit a dropped edge.
  chains.sort((p, q) => stations(p.E) - stations(q.E))
  for (const { E, chain } of chains) {
    if (dropped.has(E) || chain.some((x) => dropped.has(x))) continue
    for (const x of chain) absorb(E, x)
    dropped.add(E)
  }

  // Rebuild: drop absorbed edges' segments; give survivors a merged edge object
  // (coline when it now carries ≥2 distinct colours → strokesOf interleaves).
  const mergedOf = new Map()
  for (const e of edges) {
    if (dropped.has(e)) continue
    const a = accum.get(e)
    if (a.colors.length === (e.routeColors?.length ?? 0) && a.routes.size === (e.routes?.size ?? 0)) continue // unchanged
    const cls = new Set(a.colors).size >= 2 ? 'coline' : (e.cls ?? 'plain')
    mergedOf.set(e, { ...e, routes: a.routes, routeColors: a.colors, cls, color: a.colors[0] ?? e.color })
  }
  if (!dropped.size && !mergedOf.size) return segs
  const out = []
  for (const s of segs) {
    if (dropped.has(s.edge)) continue
    const merged = mergedOf.get(s.edge)
    out.push(merged ? { ...s, routes: merged.routes, edge: merged } : s)
  }
  return out
}

// `pos` = Map<id, [x, y]> PIXEL positions of the (compact-grid) cut points.
// opts.unit = detour offset in pixels; opts.minGap = parallel-hug veto (px);
// opts.lattice = { x0, y0, sx, sy, nx, ny } half-cell routing lattice for the
// A* fallback (node centres sit on odd indices).
// opts.frozenIds = Set<id>：成方護欄 members——兩端皆在集內且目前為 H/V 的段強制直線、
// 不繞行／不 A*（方形邊永遠保持方形）。
export function buildRwdMap(segs, pos, opts = {}) {
  // 負或 0 的 unit（暫態面板尺寸算出的負 cell 寬）會讓 minGap ≤ 0 → legsHug 永遠
  // false，貼線／共線防護整個失效。取絕對值兜底，routing 幾何仍成立。
  const unit = Math.abs(opts.unit ?? 12) || 12
  const dirsN = opts.dirs ?? 8 // 允許的線方向數 4/8/16（見 candidates）
  const minGap = opts.minGap ?? unit * 0.35
  const frozenIds = opts.frozenIds instanceof Set && opts.frozenIds.size ? opts.frozenIds : null
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
  const stats = { straight: 0, single: 0, double: 0, multi: 0, rerouted: 0, fallback: 0, forced: 0, colinear: 0, swapped: 0, squeezed: 0, straightened: 0, diag45: 0, restarts: 0, segs: 0 }

  // A self-crossing loop (a single line's tracks physically cross, e.g. Naples
  // Line 1's Vomero hairpin) is emitted by buildHcGraph as the SAME cycle in both
  // directions — every loop edge appears twice with swapped endpoints. Drawing
  // both puts two identical polylines on the same track, which the router then
  // offsets into a tangled double outline. Draw each loop edge once: the twin is
  // redundant geometry (same routes/colours), so dropping it loses nothing and
  // lets the cycle render as one clean ring.
  const seenLoop = new Set()
  const usable = segs.filter((s) => {
    if (!(pos.has(s.a) && pos.has(s.b))) return false
    if (s.edge?.cls !== 'loop') return true
    const k = s.a < s.b ? `${s.a}|${s.b}` : `${s.b}|${s.a}`
    if (seenLoop.has(k)) return false
    seenLoop.add(k)
    return true
  })
  // Rule 0 / 鐵律：a CLEAN direct corridor (conflictCount === 0) has absolute
  // precedence and is locked. A straight that already overlaps / crosses is
  // NOT locked — later 50%/25%/75% or other candidates must resolve it.
  // 22.5°/67.5° is never a reserved corridor. Within each class, longest
  // corridors still route first; the stable tie-break keeps the result
  // deterministic.
  const order = usable
    .map((s, i) => {
      const S = pos.get(s.a), T = pos.get(s.b)
      const d = dirOf(S, T)
      const straight = d && d !== 'X' &&
        // 22.5°/67.5° is never a reserved direct corridor: 16-direction
        // routing must first prove every H/V/45° candidate conflicts.
        (d !== 'E+' && d !== 'E-' && d !== 'F+' && d !== 'F-') &&
        (dirsN >= 8 || (d !== 'D+' && d !== 'D-'))
      // 成方邊：兩端凍結＋目前 H/V → 強制直線（保持方形四邊）
      const shapeLock = !!(frozenIds && frozenIds.has(s.a) && frozenIds.has(s.b)
        && (d === 'H' || d === 'V'))
      return { s, i, len: dist(S, T), straight, shapeLock }
    })
    .sort((p, q) => Number(q.shapeLock) - Number(p.shapeLock)
      || Number(q.straight) - Number(p.straight) || q.len - p.len || p.i - q.i)

  /* ---- 節點旋轉系統（使用者鐵律）：點接的線的 360° 環狀順序不可變。
     參考序＝縮減網格輸入的弦方向（pos 直連角）。畫出的折線在節點的「出線方向」
     可以偏轉（H/V/45° 吸附本來就會轉角度），但同一節點上所有已畫線的環狀順序
     必須與參考序一致——順序一變，兩條線就在節點旁互換位置＝拓撲改變。---- */
  const segsAtNodeRef = new Map() // nodeId -> [{ seg, ref }]（依輸入弦角排序）
  for (const s of usable) {
    if (s.a === s.b) continue // loop 兩端同點——順序檢查不適用
    const A = pos.get(s.a), B = pos.get(s.b)
    const addRef = (n, P, Q) => {
      if (!segsAtNodeRef.has(n)) segsAtNodeRef.set(n, [])
      segsAtNodeRef.get(n).push({ seg: s, ref: Math.atan2(Q[1] - P[1], Q[0] - P[0]) })
    }
    addRef(s.a, A, B); addRef(s.b, B, A)
  }
  for (const list of segsAtNodeRef.values()) list.sort((p, q) => p.ref - q.ref)
  const lineOfSeg = new Map() // seg -> line（routeAll 開頭重建）
  const awayAngleOf = (seg, pts, nodeId) => {
    const [P, Q] = seg.a === nodeId ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]]
    return Math.atan2(Q[1] - P[1], Q[0] - P[0])
  }
  // seg 以 pts 畫時是否打亂任一端節點的環狀順序。override: Map<seg,pts>（聯合重算
  // 一對線時、另一條的擬定形狀）；還沒畫或被拆（legs 空）的線不參與。出線角完全
  // 相同（貼線／共線雙生）視為平手、不算違規。
  function orderViolation(seg, pts, override) {
    if (seg.a === seg.b) return false
    for (const nodeId of [seg.a, seg.b]) {
      const list = segsAtNodeRef.get(nodeId)
      if (!list || list.length < 3) continue // 2 條線沒有環狀順序可言
      const ds = []
      for (const e of list) {
        let p = null
        if (e.seg === seg) p = pts
        else if (override && override.has(e.seg)) p = override.get(e.seg)
        else {
          const L = lineOfSeg.get(e.seg)
          if (L && L.legs.length) p = L.pts
        }
        if (p) ds.push(awayAngleOf(e.seg, p, nodeId))
      }
      if (ds.length < 3) continue
      // 依參考序排好的出線角必須「環狀遞增」＝繞一圈至多一次下降。
      let desc = 0
      for (let k = 0; k < ds.length; k++) {
        if (ds[(k + 1) % ds.length] < ds[k] - 1e-9) desc++
      }
      if (desc > 1) return true
    }
    return false
  }

  // Number of hard-rule violations of a candidate against the placed legs
  // (hug / cross / node-on-leg). 0 = clean; Infinity = an illegal X leg.
  // crossOnly=true（共線救援，使用者規則：萬不得已可以共線、但新交叉絕對不可）：
  // 放寬同族「共線/貼線」(legsHug)，只算交叉(legsCross)與壓點(pointOnLeg)。
  // lenient=true：最後兜底用——壓站/超過 25% 重疊不再回 Infinity，改成大額罰分，
  // 讓「最不壞」的候選仍被畫出（隱形線會讓白點浮空，比殘留衝突更糟）。
  function conflictCount(pts, seg, placed, crossOnly = false, lenient = false) {
    const legs = legsOfPts(pts)
    if (legs.length !== pts.length - 1) return Infinity // X leg → fallback only
    let n = 0, overlap = 0
    let crossPts = null // ownerLineIdx -> Set(交點座標)：同一對線最多交叉一次
    const pathLen = pts.slice(1).reduce((sum, P, i) => sum + dist(pts[i], P), 0)
    for (const leg of legs) {
      for (const p of placed) {
        if (leg.dir === p.dir && legsHug(leg, p, minGap)) {
          const ov = Math.min(leg.hi, p.hi) - Math.max(leg.lo, p.lo)
          if (ov > OVER_TOL) overlap += ov
          if (!crossOnly) n++
        }
        else if (legsCross(leg, p, isNodePt)) {
          n++
          // 記下與這條線的交點（去重：跨在對方轉角上會被相鄰兩腿各報一次）。
          const r = [leg.B[0] - leg.A[0], leg.B[1] - leg.A[1]]
          const s2 = [p.B[0] - p.A[0], p.B[1] - p.A[1]]
          const den = r[0] * s2[1] - r[1] * s2[0]
          let key = 'touch'
          if (Math.abs(den) > Z) {
            const t = ((p.A[0] - leg.A[0]) * s2[1] - (p.A[1] - leg.A[1]) * s2[0]) / den
            key = `${Math.round((leg.A[0] + t * r[0]) * 2)},${Math.round((leg.A[1] + t * r[1]) * 2)}`
          }
          crossPts ??= new Map()
          const owner = p.li ?? -1
          const set = crossPts.get(owner) ?? new Set()
          set.add(key)
          crossPts.set(owner, set)
        }
      }
      for (const [id, P] of nodes) {
        if (id === seg.a || id === seg.b) continue
        // A route running through a foreign station changes topology; never
        // acceptable — except as the very last lenient fallback (huge penalty).
        if (pointOnLeg(P, leg)) { if (lenient) n += 100; else return Infinity }
      }
    }
    // 同一對線最多交叉一次（使用者規則）：一對線出現第二個交點是硬違規，
    // 不是「多一個衝突」。lenient 兜底時每多一個交點記大額罰分。
    if (crossPts) for (const set of crossPts.values()) {
      if (set.size > 1) { if (lenient) n += 50 * (set.size - 1); else return Infinity }
    }
    // Accumulated shared-track length above 25% of this segment's own drawn
    // path is a major error, not just one more conflict.
    if (overlap > pathLen * 0.25 + OVER_TOL) { if (lenient) n += 50; else return Infinity }
    return n
  }

  // 同族貼線的投影重疊總長（px）——衝突「數」相同時的次要鍵：選重疊最短的候選
  // （使用者規則：路線重疊越少越好、重疊線越短越好，這些是重大錯誤）。交叉/壓點是
  // 硬錯誤、由 conflictCount 的計數優先排除，不計入這裡的長度。
  function overlapLen(pts, placed, gap = minGap) {
    const legs = legsOfPts(pts)
    if (legs.length !== pts.length - 1) return Infinity
    let len = 0
    for (const leg of legs) {
      for (const p of placed) {
        if (leg.dir === p.dir && perpGap(leg, p) < gap) {
          const ov = Math.min(leg.hi, p.hi) - Math.max(leg.lo, p.lo)
          if (ov > OVER_TOL) len += ov
        }
      }
    }
    return len
  }
  // 軟共線長度：用一格距離看「幾乎同走廊」的平行重疊（硬衝突門檻以外仍要越短越好）。
  const softOverlapLen = (pts, placed) => overlapLen(pts, placed, unit)
  // 近距貼線長度（使用者：視覺上的貼線也是「重疊」）：間距**小於半格**的平行併走。
  // minGap（硬貼線 0.35u）抓不到 0.35u–0.5u 的視覺貼近；但**恰好半格（0.5u）是
  // 半格 lattice／平行偏移的合法設計間距**，不能算貼線——門檻取 0.45u（嚴格介於
  // 0.35 與 0.5 之間）：只抓「比合法半格更近」的併走。曾取 0.55u 把半格也算進去，
  // 結果台北 16 方向把離別線半格的正常 45 形當貼線、無故降去 22.5（使用者：明明
  // 不用 22.5 卻用 22.5）。這條在 pickBest 排在 45/22.5 取捨**之前**（「右邊可以
  // 用 22.5 解決重疊卻沒有」＝45 形貼著別條線跑、完全不貼線的 22.5 卻輸在方向級
  // 偏好）。
  const nearOverlapLen = (pts, placed) => overlapLen(pts, placed, unit * 0.45)

  // 候選路徑總長（px）——「線要越短越好」的 tie-break 用。
  const pathLenOf = (pts) => {
    let L = 0
    for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i])
    return L
  }

  // 單一共用選線器（pass 1 與衝突重掃都用同一個優先序，使用者的簡單概念）：
  // ①衝突最少 → ②近距貼線最短（重疊要越少越好——視覺上的貼線也是重疊）→
  // ③45 優於 22.5°（skew）→ ④折數最少（盡量直線）→ ⑤共線重疊最短
  // （4 方向為了不重疊，25%/75% 可因此蓋過 50%）→ ⑥分點 50%→25%→75% →
  // ⑦軟共線最短 → ⑧路徑總長最短（線要越短越好，使用者規則——放在最弱一階：
  // 其他準則全平手時才挑較短的繞行；放前面會翻動既有裁決、實測東京 JR forced 變多）。
  // 22.5°/67.5° 候選**一律參與競爭**（使用者規則：明明有 22.5 的畫法不重疊就要用）——
  // 衝突數與近距貼線都在 skew 之前：零衝突的 22.5° 贏過重疊**或貼線**的 45°；
  // 兩者都乾淨時仍 45° 優先。straight=true 時套 Rule 0：零衝突直線立即勝出。
  // lenient=true 是最後兜底（壓站／超過 25% 重疊改記大額罰分，不再直接淘汰）。
  function pickBest(cands, seg, placed, straight = false, lenient = false) {
    let chosen = null, chosenKeys = null, chosenN = Infinity
    const T2 = OVER_TOL // 近距貼線／路徑總長的比較容差（浮點）；其餘鍵沿用嚴格比較
    const TOLS = [0, T2, 0, 0, 0, 0, 0, T2] // n, near, skew, bends, hard, zRank, soft, len
    const beats = (a, b) => {
      for (let k = 0; k < a.length; k++) {
        if (a[k] < b[k] - TOLS[k]) return true
        if (a[k] > b[k] + TOLS[k]) return false
      }
      return false
    }
    for (const c of cands) {
      if (c.fallback) continue
      let n = conflictCount(c.pts, seg, placed, false, lenient)
      if (n === Infinity) continue
      // 鐵律：不可打亂節點的環狀順序。lenient 兜底時記大額罰分（仍要畫出東西）。
      if (orderViolation(seg, c.pts)) { if (!lenient) continue; n += 200 }
      if (straight && c.bends === 0 && !c.skew && n === 0) // Rule 0: clean direct corridor
        return { chosen: c, chosenN: 0 }
      const keys = [
        n,
        nearOverlapLen(c.pts, placed),
        c.skew ? 1 : 0,
        c.bends,
        overlapLen(c.pts, placed),
        c.bends >= 2 ? (c.zRank ?? Infinity) : Infinity,
        softOverlapLen(c.pts, placed),
        pathLenOf(c.pts),
      ]
      if (!chosenKeys || beats(keys, chosenKeys)) { chosen = c; chosenKeys = keys; chosenN = n }
    }
    return { chosen, chosenN }
  }

  /* ---- lattice A* fallback (絕不交叉): when no bounded-bend candidate is
     conflict-free, route rectilinearly (H/V steps — still legal directions) on
     the half-cell lattice, only through space free of placed legs and nodes.
     Crossing-free BY CONSTRUCTION; bends may exceed 2 (turn-penalized).
     A cheap flood probe runs first: if T is UNREACHABLE (the other lines wall
     S or T into a closed face — Jordan), it fails fast and reports WHICH lines
     form the wall via failInfo.blockers (fuel for rip-up-and-reroute). ---- */
  function routeLattice(S, T, seg, placed, failInfo, gapOverride, allowColinear = false) {
    // 三個方向級同一套判斷：4 方向也用 A* 救援，只是 45° macro／對角步進
    // 都關閉（見下方 dirsN >= 8 門檻）→ 純直角佈線。
    const lat = opts.lattice
    if (!lat) return null
    const gap = gapOverride ?? minGap // hug distance (salvage pass squeezes it)
    const { x0, y0, sx, sy, nx, ny } = lat
    const toI = (x) => Math.round((x - x0) / sx)
    const toJ = (y) => Math.round((y - y0) / sy)
    const atP = (i, j) => [x0 + i * sx, y0 + j * sy]
    const si = toI(S[0]), sj = toJ(S[1]), ti = toI(T[0]), tj = toJ(T[1])
    if (Math.min(si, sj, ti, tj) < 0 || si >= nx || ti >= nx || sj >= ny || tj >= ny) return null
    // 大環繞禁止（使用者規則：只能在最短路線附近尋找可能性）——A* 與 flood 預檢都
    // 限制在 S–T 走廊窗（bbox 外擴 LOCAL_PAD px）內，且路徑總成本（長度＋轉折罰）
    // 不得超過 maxCost。超出＝視為無路：flood 會回報走廊內的「牆」線 → rip-up 拆牆
    // 局部改畫；再不行走共線救援/forced。絕不畫出繞整張圖的環繞線。
    const LOCAL_PAD = 3 * unit
    const iLo = Math.max(0, Math.min(si, ti) - Math.ceil(LOCAL_PAD / sx))
    const iHi = Math.min(nx - 1, Math.max(si, ti) + Math.ceil(LOCAL_PAD / sx))
    const jLo = Math.max(0, Math.min(sj, tj) - Math.ceil(LOCAL_PAD / sy))
    const jHi = Math.min(ny - 1, Math.max(sj, tj) + Math.ceil(LOCAL_PAD / sy))
    const inWin = (i, j) => i >= iLo && i <= iHi && j >= jLo && j <= jHi
    const maxCost = 3 * (Math.abs(T[0] - S[0]) + Math.abs(T[1] - S[1])) + 8 * unit
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
            // allowColinear（共線救援）: 放寬同族貼線 legsHug，交叉 legsCross 照擋。
            if (leg.dir === p.dir) { if (!allowColinear && legsHug(leg, p, gap)) return p }
            else if (legsCross(leg, p, isNodePt)) return p
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
      if (dirsN < 8) return [] // 4 方向禁 45° 斜出/斜入 macro（A* 純直角接 lattice）
      const out = [] // { i, j, mid: [pts between node and lattice pt], len }
      for (const da of [1, 2, 3, 4]) {
        for (const db of [1, 2, 3, 4]) {
          for (const sxn of [1, -1]) {
            for (const syn of [1, -1]) {
              const gi = pi + sxn * da, gj = pj + syn * db
              if (gi < 0 || gj < 0 || gi >= nx || gj >= ny) continue
              if (!inWin(gi, gj)) continue // 走廊窗外的 macro 出入口不用（大環繞禁止）
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
    if (dirsN >= 8 && Math.abs(sx - sy) < 1e-9) FLOOD_DIRS.push([1, 1], [1, -1], [-1, 1], [-1, -1])
    const blockers = new Map() // line index -> hit count（走廊內撞到的牆線）
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
      while (fq.size) {
        const [, i, j] = fq.pop()
        if (targets.has(i * ny + j)) { reached = true; break }
        for (const [dx, dy] of FLOOD_DIRS) {
          const ni = i + dx, nj = j + dy
          if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
          if (!inWin(ni, nj)) continue // 走廊窗外不探（與 A* 同界，牆線照樣記入 blockers）
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
    if (dirsN >= 8 && Math.abs(sx - sy) < 1e-9) {
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
        if (!inWin(ni, nj)) continue // 走廊窗外不走（大環繞禁止）
        if (blockedPt.has(ni * ny + nj) && !(ni === ti && nj === tj)) continue
        const nk = skey(ni, nj, nd)
        const cost = gk + step + (nd !== d ? TURN : 0)
        if (cost > maxCost) continue // 成本上限：繞太遠＝無路，交給 rip-up/共線救援
        if (cost >= (g.get(nk) ?? Infinity)) continue
        if (!legFree(atP(i, j), atP(ni, nj))) continue
        g.set(nk, cost)
        from.set(nk, k)
        heap.push([cost + h(ni, nj), nk, ni, nj, nd])
      }
    }
    // A* 沒找到（含成本上限/轉折狀態限制下的失敗）：把 flood 撞到的走廊牆線
    // 回報給 rip-up——flood 可達但 A* 放棄時，牆就是逼路徑繞遠的那些線。
    if (goal == null) {
      if (failInfo && blockers.size) failInfo.blockers = blockers
      return null
    }
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
    if (w.lockedStraight) return null // Rule 0: never bend an eligible direct corridor.
    const S2 = pos.get(w.seg.a), T2 = pos.get(w.seg.b)
    const placedW = placedOf(wi)
    const candsW = candidates(S2, T2, unit, dirsN)
    // 乾淨候選之中依 pickBest 同一優先序取捨：近距貼線最短 → 45 優於 22.5 → 折數
    // 最少（候選本身已 bend-ordered）。「右邊可以用 22.5 解決重疊」＝零貼線的 22.5
    // 要贏過貼著別條線跑的 45。
    {
      let best = null, bestNear = Infinity, bestSkew = 1
      for (const c of candsW) {
        if (c.fallback) continue
        if (orderViolation(w.seg, c.pts)) continue // 環狀順序鐵律
        if (conflictCount(c.pts, w.seg, placedW) !== 0) continue
        const near = nearOverlapLen(c.pts, placedW)
        const skew = c.skew ? 1 : 0
        if (near < bestNear - OVER_TOL
          || (near < bestNear + OVER_TOL && skew < bestSkew)) {
          best = c; bestNear = Math.min(near, bestNear); bestSkew = skew
          if (near <= OVER_TOL && !skew) break // 不貼線的 45 級＝最優，提早收
        }
      }
      if (best) return { pts: best.pts, bends: best.bends, routed: false }
    }
    const r = routeLattice(S2, T2, w.seg, placedW)
    if (!r || orderViolation(w.seg, r)) return null
    return { pts: r, bends: r.length - 2, routed: true }
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
    const tryRip = (wallIdxs) => {
      const walls = wallIdxs.map((wi) => lines[wi]).filter((w) => w && !w.fallback && !w.lockedStraight)
      if (walls.length !== wallIdxs.length) return false
      const saves = [snapLine(L), ...walls.map(snapLine)]
      const undo = () => {
        Object.assign(L, saves[0])
        walls.forEach((w, i) => Object.assign(w, saves[i + 1]))
      }
      for (const w of walls) w.legs = [] // rip up
      const mine = routeLattice(pos.get(L.seg.a), pos.get(L.seg.b), L.seg, placedOf(li))
      if (!mine || orderViolation(L.seg, mine)) { undo(); return false }
      L.pts = mine
      L.legs = legsOfPts(mine)
      L.bends = mine.length - 2
      L.routed = true
      L.forced = false
      for (const w of walls) { // re-route each wall with L (and prior walls) placed
        const done = rerouteAround(w, lines.indexOf(w)) // 同一套：先乾淨候選、再 A* 兜底
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

  // placedOf 的雙排除版：跳過兩個索引（聯合重算一對交錯線時，兩條都要先拆掉）。
  const placedExcept = (i, j) => {
    const out = []
    for (let k = 0; k < lines.length; k++) {
      if (k === i || k === j) continue
      for (const lg of lines[k].legs) { lg.li = k; out.push(lg) }
    }
    return out
  }

  // 兩條線是否「真的交錯」（不同族的腿相交＝絕不允許的 legsCross；同族貼線是共線、
  // 不算交錯）。共用節點處的端點對端點交會由 legsCross 自身豁免。
  const linesCross = (A, B) => {
    for (const la of A.legs) {
      for (const lb of B.legs) {
        if (la.dir !== lb.dir && legsCross(la, lb, isNodePt)) return true
      }
    }
    return false
  }

  const applyCand = (L, c) => {
    L.pts = c.pts; L.legs = c.legs; L.bends = c.bends
    L.routed = false; L.fallback = false; L.forced = false
  }

  // 仍彼此交叉的線對枚舉（bbox 先篩、再 legsCross）。**與 forced 旗標完全脫鉤**
  // （使用者規則：出現交叉就要確認兩條線有沒有不交叉的畫法）——曾以「兩條都
  // forced」當入場條件，漏掉最常見的「先畫時乾淨、被後畫的 forced 線壓過」交叉對。
  function crossingPairs() {
    const bb = lines.map((L) => {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
      for (const p of L.pts) {
        if (p[0] < x1) x1 = p[0]; if (p[0] > x2) x2 = p[0]
        if (p[1] < y1) y1 = p[1]; if (p[1] > y2) y2 = p[1]
      }
      return [x1, y1, x2, y2]
    })
    const out = []
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        if (bb[i][0] > bb[j][2] || bb[j][0] > bb[i][2] || bb[i][1] > bb[j][3] || bb[j][1] > bb[i][3]) continue
        if (linesCross(lines[i], lines[j])) out.push([i, j])
      }
    }
    return out
  }

  // 成對 rip（交叉對的最後聯合手段）：拆掉對方、A* 畫自己、對方 rerouteAround
  // 繞回（兩種順序都試），兩條都乾淨才提交——bounded-bend 組合放不下時，這是
  // 「兩條線到底有沒有不交叉畫法」的實質驗證。
  // 交叉是最高級錯誤：對方若是鎖定直線也**解鎖讓路**（殘留交叉比彎線更糟）——
  // 但直線自己不當 F（不主動 A* 繞遠），只在當 W 時被動繞；繞完仍是乾淨直線才保留鎖。
  function jointRipPair(i, j) {
    const tryOrder = (fi, si) => {
      const F = lines[fi], W = lines[si]
      if (F.lockedStraight) return false // 直線不主動繞，只能當被讓路的 W
      const saves = [snapLine(F), snapLine(W)]
      const wasLocked = W.lockedStraight
      const undo = () => {
        Object.assign(F, saves[0]); Object.assign(W, saves[1])
        W.lockedStraight = wasLocked
      }
      W.legs = [] // rip the partner
      const r = routeLattice(pos.get(F.seg.a), pos.get(F.seg.b), F.seg, placedOf(fi))
      if (!r || orderViolation(F.seg, r)) { undo(); return false }
      F.pts = r; F.legs = legsOfPts(r); F.bends = r.length - 2; F.routed = true; F.forced = false
      W.lockedStraight = false // 暫時解鎖（rerouteAround 不動鎖定直線）
      const done = rerouteAround(W, si)
      if (!done) { undo(); return false }
      W.pts = done.pts; W.legs = legsOfPts(done.pts); W.bends = done.bends
      W.routed = done.routed; W.forced = false
      W.lockedStraight = wasLocked && done.bends === 0 && !done.routed // 仍是乾淨直線才保留鎖
      return true
    }
    return tryOrder(i, j) || tryOrder(j, i)
  }

  // 交錯的兩條線一起重新計算（使用者規則：畫了線會交錯就要 2 條線重新計算）——
  // 個別重掃把另一條當固定、互相擋時解不開；這裡把彼此交叉的兩條「同時拆掉」，
  // 聯合搜兩者的 bounded-bend 候選組合，取「兩條都乾淨（含彼此不交叉）且總轉折數
  // 最少」的一組（折數絕對優先照舊）。組合有上限（每條前 JOINT_CAP 個候選）避免
  // 爆炸。deep=true（重掃後的那輪）時組合無解再升級 jointRipPair（A* 成對拆繞）；
  // 仍失敗才交給下游 restart/窄縫/共線/forced。
  function jointReroutePairs(deep = false) {
    const JOINT_CAP = 16
    const prep = (S, T, seg, placed) => {
      // 22.5 級照樣入列，但**方向級優先於折數**（使用者規則：能 45 就不用 22.5）——
      // 依 (skew, bends) 排序：所有 45 級在前、22.5 級殿後。曾只依折數排＋只比總
      // 折數，22.5 單折會贏過乾淨的 45 雙折（台北藍線案 2026-07-20）。
      return candidates(S, T, unit, dirsN)
        .filter((c) => !c.fallback)
        .sort((a, b) => (a.skew ? 1 : 0) - (b.skew ? 1 : 0) || a.bends - b.bends)
        .slice(0, JOINT_CAP)
        .map((c) => ({ pts: c.pts, bends: c.bends, skew: !!c.skew, legs: legsOfPts(c.pts) }))
        .filter((c) => c.legs.length === c.pts.length - 1)
    }
    let improved = false
    for (const [i, j] of crossingPairs()) {
      const A = lines[i], B = lines[j]
      if (A.fallback || B.fallback) continue
      if (!linesCross(A, B)) continue // 本輪稍早的重算可能已解掉
      if (A.lockedStraight || B.lockedStraight) {
        // 鎖定直線 × forced 的交叉對：bounded-bend 組合不動直線，直接進成對 rip
        // ——唯一能（被動）解鎖直線的交叉手段。淺輪不動（維持既有裁決成本）。
        if (deep && jointRipPair(i, j)) improved = true
        continue
      }
      {
        const placed = placedExcept(i, j) // 其餘所有線固定，只重算 A、B
        // 先各自篩出「對其他線乾淨」的候選（含節點壓點檢查），再組合時只需驗 A↔B。
        const candA = prep(pos.get(A.seg.a), pos.get(A.seg.b), A.seg, placed)
          .filter((c) => conflictCount(c.pts, A.seg, placed) === 0)
        if (!candA.length) continue
        const candB = prep(pos.get(B.seg.a), pos.get(B.seg.b), B.seg, placed)
          .filter((c) => conflictCount(c.pts, B.seg, placed) === 0)
        if (!candB.length) continue
        // 組合目標＝(skew 腿數, 總折數) 字典序——方向級優先於折數（能 45 就不用
        // 22.5），同方向級才比總折數最少。
        let best = null, bestSkew = Infinity, bestBends = Infinity
        for (const cA of candA) {
          for (const cB of candB) {
            const sk = (cA.skew ? 1 : 0) + (cB.skew ? 1 : 0)
            const tot = cA.bends + cB.bends
            if (sk > bestSkew || (sk === bestSkew && tot >= bestBends)) continue
            if (conflictCount(cA.pts, A.seg, cB.legs) !== 0) continue
            // 環狀順序鐵律：兩條同時換形狀——各自檢查時把對方的擬定形狀帶進去。
            if (orderViolation(A.seg, cA.pts, new Map([[B.seg, cB.pts]]))
              || orderViolation(B.seg, cB.pts, new Map([[A.seg, cA.pts]]))) continue
            best = { cA, cB }; bestSkew = sk; bestBends = tot
          }
        }
        if (best) { applyCand(A, best.cA); applyCand(B, best.cB); improved = true; continue }
      }
      // bounded-bend 組合無解 → deep 輪升級成對 rip＋A*（拆掉對方讓 A* 開路、
      // 對方繞回，兩種順序、全乾淨才提交）。
      if (deep && jointRipPair(i, j)) improved = true
    }
    return improved
  }

  /* ---- one routing attempt: pass 1 (bend-ordered, veto) + conflict sweeps
     with the A* fallback. `priority` segments route FIRST (see below). ---- */
  function routeAll(priority) {
    lines.length = 0
    lineOfSeg.clear()
    const pushLine = (o) => { lines.push(o); lineOfSeg.set(o.seg, o) }
    const noRoute = new Set() // segs whose A* already failed this attempt
    // Keep direct corridors ahead even during restart-with-priority.  A restart
    // may promote a trapped bent line, but it must not steal a straight
    // corridor merely because that line happened to be trapped in the prior
    // attempt.
    const ordered = [
      ...order.filter((o) => o.shapeLock),
      ...order.filter((o) => !o.shapeLock && o.straight && priority.has(o.s)),
      ...order.filter((o) => !o.shapeLock && o.straight && !priority.has(o.s)),
      ...order.filter((o) => !o.shapeLock && !o.straight && priority.has(o.s)),
      ...order.filter((o) => !o.shapeLock && !o.straight && !priority.has(o.s)),
    ]
    for (const { s, straight, shapeLock } of ordered) {
      const S = pos.get(s.a), T = pos.get(s.b)
      // 成方邊：永遠畫 S→T 直線並鎖定——不得繞行／A*／重掃改彎（保持方形）。
      if (shapeLock) {
        const pts = [S, T]
        const placed = placedOf(-1)
        const n = conflictCount(pts, s, placed, false, true)
        pushLine({
          seg: s, pts, bends: 0, fallback: false, forced: n > 0,
          lockedStraight: true, shapeLock: true, legs: legsOfPts(pts),
        })
        continue
      }
      const cands = candidates(S, T, unit, dirsN)
      const placed = placedOf(-1)
      // 簡單優先序（使用者規則）：①衝突最少 → ②45 優於 22.5 → ③折數最少（盡量直線）
      // → ④共線重疊最短（4 方向可因此讓 25%/75% 蓋過 50%）→ ⑤分點 50%→25%→75%。
      // 22.5° 候選同場競爭：零衝突的 22.5° 贏過重疊的 45°、同分仍 45° 優先。
      // Rule 0：只有零衝突的直線才鎖定；有重疊的直線改走 50%/Z，絕不能鎖死重疊。
      let picked = pickBest(cands, s, placed, straight)
      // Every candidate hit a hard veto（壓站／>25% 重疊）→ lenient rescan：仍要
      // 畫出「最不壞」的形狀並標殘留衝突。隱形線會讓白點浮空，比殘留衝突更糟。
      if (!picked.chosen) picked = pickBest(cands, s, placed, false, true)
      const { chosen, chosenN } = picked
      if (!chosen) { // only possible if even the raw fallback has an X leg
        pushLine({ seg: s, pts: [S, T], bends: 0, fallback: true, forced: true, legs: legsOfPts([S, T]) })
        continue
      }
      // Priority segments are the previously-trapped ones — if even now no
      // candidate is clean, let A* carve a corridor while the plane is open.
      if (chosenN > 0 && priority.has(s)) {
        const routed = routeLattice(S, T, s, placed)
        if (routed && !orderViolation(s, routed)) {
          pushLine({ seg: s, pts: routed, bends: routed.length - 2, routed: true, legs: legsOfPts(routed) })
          continue
        }
      }
      pushLine({
        seg: s, pts: chosen.pts, bends: chosen.bends,
        fallback: !!chosen.fallback, forced: chosenN > 0 && !chosen.fallback,
        // Only lock a straight that is actually clean — never lock an overlap,
        // and never lock a 22.5°/67.5° corridor.
        lockedStraight: straight && chosen.bends === 0 && chosenN === 0 && !chosen.fallback && !chosen.skew,
        legs: legsOfPts(chosen.pts),
      })
    }
    // 交錯的成對線先「兩條一起重算」（使用者規則）：優先於下方個別重掃升級到 A*——
    // 乾淨的 bounded-bend 組合勝過把單條 A* 繞成 squiggle。解不掉的才進重掃。
    if (!opts.fast) for (let r = 0; r < 3 && jointReroutePairs(); r++);
    // conflict-reduction sweeps: retry every line still in conflict (both
    // parties of a crossing qualify) — min-conflict candidate first, then the
    // A* lattice router (clean by construction when it succeeds).
    for (let sweep = 0; sweep < 4; sweep++) {
      let improved = false, dirty = 0
      for (let li = 0; li < lines.length; li++) {
        const L = lines[li]
        if (L.fallback || L.lockedStraight) continue // Rule 0: only other lines may move.
        const placed = placedOf(li)
        const curN = conflictCount(L.pts, L.seg, placed)
        if (curN === 0) { L.forced = false; continue }
        const S = pos.get(L.seg.a), T = pos.get(L.seg.b)
        // 消衝突重掃：與 pass 1 同一個 pickBest 優先序。
        const sweepCands = candidates(S, T, unit, dirsN)
        const picked = pickBest(sweepCands, L.seg, placed)
        let best = null, bestN = curN
        if (picked.chosen && picked.chosenN < curN) { best = picked.chosen; bestN = picked.chosenN }
        if (bestN > 0 && !noRoute.has(L.seg)) {
          const failInfo = {}
          const routed0 = routeLattice(S, T, L.seg, placed, failInfo)
          // A* 路徑同樣受環狀順序鐵律約束——打亂節點順序的路徑視同無路。
          const routed = routed0 && !orderViolation(L.seg, routed0) ? routed0 : null
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
    // 個別重掃後仍互相交錯的成對線：兩條一起重算（使用者規則）。deep=true——
    // bounded-bend 組合無解時升級成對 rip＋A*。可能一次解一對、有連鎖 → 迭代到
    // 不再改善（上限 3 輪）。動畫中間幀（fast）跳過換每幀夠快。
    if (!opts.fast) for (let r = 0; r < 3 && jointReroutePairs(true); r++);
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
    // Locked direct corridors are deliberately never renegotiated. If two of
    // them are geometrically incompatible, retrying cannot improve the layout.
    const bad = lines.filter((L) => L.forced && !L.lockedStraight)
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
    if (!L.forced || L.lockedStraight) continue
    const r = routeLattice(pos.get(L.seg.a), pos.get(L.seg.b), L.seg, placedOf(li), null, minGap * 0.6)
    if (r && !orderViolation(L.seg, r)) {
      L.pts = r
      L.legs = legsOfPts(r)
      L.bends = r.length - 2
      L.routed = true
      L.forced = false
      L.squeezed = true
      stats.squeezed++
    }
  }

  // 共線救援（使用者規則：萬不得已可以共線，在真的找不到更佳解時；但新的交叉絕對
  // 不可）: 窄縫都救不回的段，放寬「共線/平行貼線」再試——**交叉 legsCross 與壓點
  // pointOnLeg 照樣絕禁**。先試 bounded-bend 候選（crossOnly，依折數）、再試 A*
  // （allowColinear）。畫得出＝與他線共線但不交叉（勝過殘留交叉 forced）。標 colinear。
  if (!opts.fast) for (let li = 0; li < lines.length; li++) {
    const L = lines[li]
    if (!L.forced || L.lockedStraight) continue
    const S = pos.get(L.seg.a), T = pos.get(L.seg.b)
    const placed = placedOf(li)
    let done = false
    // 交叉/壓點照禁（crossOnly）；在所有「只剩共線」的候選中選**重疊線最短**的那個
    // （使用者規則：萬不得已可以共線，但重疊越短越好——重疊是重大錯誤）。候選依折數
    // 排序，同重疊長度時仍取折數最少者（只在嚴格更短時才替換）。
    let bestC = null, bestLen = Infinity
    for (const c of candidates(S, T, unit, dirsN)) {
      if (c.fallback) continue
      if (orderViolation(L.seg, c.pts)) continue // 環狀順序鐵律
      if (conflictCount(c.pts, L.seg, placed, true) !== 0) continue
      const len = overlapLen(c.pts, placed)
      if (len < bestLen) { bestC = c; bestLen = len; if (len === 0) break }
    }
    if (bestC) {
      L.pts = bestC.pts; L.legs = legsOfPts(bestC.pts); L.bends = bestC.bends
      L.forced = false; L.colinear = true; stats.colinear++; done = true
    }
    if (done) continue
    const r = routeLattice(S, T, L.seg, placed, null, minGap, true)
    if (r && !orderViolation(L.seg, r)) {
      L.pts = r; L.legs = legsOfPts(r); L.bends = r.length - 2; L.routed = true
      L.forced = false; L.colinear = true; stats.colinear++
    }
  }

  /* ---- pass 2 (soft, 衝突消解後微調): same-bends / same-45°-count swaps that
     improve straight continuation with same-route lines at shared nodes ---- */
  // sharesRoute 來自 netUtil（與 hillClimb 同一份）。
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
  // 畫完仍有共線重疊的段（含 A*／共線救援的多折階梯）：在**同折數或更少折**的
  // 兄弟候選（50%↔25%↔75% 分點、VH↔HV 順序、階梯→Z）之間再試一次——交叉／壓點
  // 不得增加、衝突不得增加、硬共線必須嚴格變短。三個方向級同一套判斷；實務上
  // 主要在 4 方向發揮（使用者規則：畫出來有重疊就試著移到 25%/75% 減少重疊）。
  function overlapReducePass() {
    for (let sweep = 0; sweep < 3; sweep++) {
      let improved = false
      for (let li = 0; li < lines.length; li++) {
        const L = lines[li]
        if (L.fallback || L.lockedStraight || L.bends <= 0) continue
        const placed = placedOf(li)
        const curHard = overlapLen(L.pts, placed)
        const curNear = nearOverlapLen(L.pts, placed)
        if (curHard <= OVER_TOL && curNear <= OVER_TOL) continue
        const curN = conflictCount(L.pts, L.seg, placed, false, true)
        const curCross = conflictCount(L.pts, L.seg, placed, true, true)
        const S = pos.get(L.seg.a), T = pos.get(L.seg.b)
        const T2 = OVER_TOL
        let best = null, bestHard = curHard, bestNear = curNear, bestBends = L.bends
        for (const c of candidates(S, T, unit, dirsN)) {
          if (c.fallback || c.bends > L.bends) continue
          // 22.5 級候選可入場（使用者規則：有 22.5 的畫法能不重疊就要用）——但要
          // 「嚴格更短的硬重疊或近距貼線」才換得掉 45 級形狀，同分仍留在 45 級。
          // 交叉與壓點另計：絕不可用「較短的重疊」換來新的交叉。
          if (orderViolation(L.seg, c.pts)) continue // 環狀順序鐵律
          const cross = conflictCount(c.pts, L.seg, placed, true, true)
          if (cross === Infinity || cross > curCross) continue
          const n = conflictCount(c.pts, L.seg, placed, false, true)
          if (n === Infinity || n > curN) continue
          const hard = overlapLen(c.pts, placed)
          if (hard > curHard + T2) continue // 縮貼線不得換來更長的硬重疊
          const near = nearOverlapLen(c.pts, placed)
          if (hard < bestHard - T2
            || (hard < bestHard + T2 && near < bestNear - T2)
            || (hard < bestHard + T2 && near < bestNear + T2 && c.bends < bestBends
              && (hard < curHard - T2 || near < curNear - T2))) {
            best = c; bestHard = Math.min(hard, bestHard); bestNear = Math.min(near, bestNear); bestBends = c.bends
          }
        }
        if (best) {
          L.pts = best.pts
          L.legs = legsOfPts(best.pts)
          L.bends = best.bends
          L.routed = false
          L.forced = conflictCount(L.pts, L.seg, placed) > 0
          stats.swapped++
          improved = true
        }
      }
      if (!improved) break
    }
  }

  function softPass() {
    for (let sweep = 0; sweep < 3; sweep++) {
      let improved = false
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i]
        if (L.fallback || L.forced || L.routed || L.lockedStraight) continue // direct corridors are immutable
        const S = pos.get(L.seg.a), T = pos.get(L.seg.b)
        const curSkew = L.legs?.some((g) => g.dir[0] === 'E' || g.dir[0] === 'F')
        const alts = candidates(S, T, unit, dirsN).filter((c) =>
          !c.fallback && c.bends === L.bends && !(c.skew && !curSkew)) // 不從 45 級換到 22.5 級
        if (alts.length < 2) continue
        const placed = placedOf(i)
        let best = null, bestScore = contScore(L, L.pts) + 1e-6
        for (const c of alts) {
          const m = contScore(L, c.pts)
          if (m <= bestScore) continue
          if (orderViolation(L.seg, c.pts)) continue // 環狀順序鐵律
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
        if (L.fallback || L.forced || L.bends <= 0 || L.lockedStraight) continue
        const S = pos.get(L.seg.a), T = pos.get(L.seg.b)
        const placed = placedOf(li)
        let adopted = false
        const ripsToTry = []
        const curSkew = L.legs?.some((g) => g.dir[0] === 'E' || g.dir[0] === 'F')
        const curSoft = softOverlapLen(L.pts, placed)
        for (const c of candidates(S, T, unit, dirsN)) {
          if (c.fallback || c.bends >= L.bends) continue
          if (c.skew && !curSkew) continue // 使用者規則：不把 45 級「降折」到 22.5 級
          if (orderViolation(L.seg, c.pts)) continue // 環狀順序鐵律
          const info = conflictLines(c.pts, L.seg, placed)
          if (info.count === 0) {
            // Rule 0：成真直線一律可降。其餘不得為了少折而把共線變長（保住 50／25／75）。
            if (c.bends > 0 && softOverlapLen(c.pts, placed) > curSoft + 1e-6) continue
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
          if (walls.some((wi) => !lines[wi] || lines[wi].fallback || lines[wi].forced || lines[wi].lockedStraight)) continue
          const before = L.bends + walls.reduce((s, wi) => s + lines[wi].bends, 0)
          const saves = [snapLine(L), ...walls.map((wi) => snapLine(lines[wi]))]
          const undo = () => {
            Object.assign(L, saves[0])
            walls.forEach((wi, k) => Object.assign(lines[wi], saves[k + 1]))
          }
          for (const wi of walls) lines[wi].legs = [] // rip the blockers up
          if (conflictCount(c.pts, L.seg, placedOf(li)) > 0) { undo(); continue }
          // 非直線降折不得換來更長共線（與直接降折同一護欄）
          if (c.bends > 0 && softOverlapLen(c.pts, placedOf(li)) > curSoft + 1e-6) { undo(); continue }
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
          // 使用者鐵律「只要可以直線就一定是直線」：若這條因此變成**直線**(c.bends===0)，
          // 且沒有犧牲任何原本就是直線的擋路線（絕不 un-straighten 別人），則總折數
          // 「不增加」即可採用（不必嚴格下降）——讓已經彎的鄰線多彎一點來成全這條的
          // 直線。其餘情況仍要求總折數嚴格下降。（不 un-straighten 直線 → 直線數嚴格
          // 遞增 → 收斂。）
          const ripsStraight = walls.some((wi, k) => saves[k + 1].bends === 0)
          // 鐵律「只要可以直線就一定是直線」：目標是直線(c.bends===0)且不犧牲任何原本
          // 就是直線的擋路線時，**不設折數預算**——擋路的彎線要多彎幾折都得讓（收斂：
          // 直線數嚴格遞增、直線絕不被 un-straighten）。非直線目標仍要求總折數嚴格下降。
          const budgetOk = (c.bends === 0 && !ripsStraight) || after < before
          if (!ok || !budgetOk) { undo(); continue }
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
      const curNear = nearOverlapLen(L.pts, placed)
      for (const c of cands45) {
        if (orderViolation(L.seg, c.pts)) continue // 環狀順序鐵律
        if (conflictCount(c.pts, L.seg, placed) > 0) continue
        if (nearOverlapLen(c.pts, placed) > curNear + OVER_TOL) continue // 不得新添貼線
        L.pts = c.pts
        L.legs = legsOfPts(c.pts)
        stats.diag45++
        break
      }
    }
  }

  /* ---- A* 樓梯 → 45°（destairPass）：非正方版面的 A* 只能走 H/V 步（斜步在
     pixel 上不是 45°），救援出來的路徑是直角樓梯——違反「對角走向用 45°、直角
     樓梯禁止」。後處理：把每條 A* 畫的線裡「連續 H/V 交替、≥2 個直角轉折」的
     樓梯子段抓出來，用同一套 8/16 方向候選（含 45° 腿，pixel 空間）在子段兩端點
     之間重畫再接回原線——折數不得增加、必須含斜腿或嚴格少折、整條線零衝突、
     貼線不得變長、環狀順序不變、拼接處不得出現斜轉斜。全部乾淨才換。 ---- */
  function findStairRuns(pts) {
    const ds = []
    for (let i = 0; i + 1 < pts.length; i++) ds.push(dirOf(pts[i], pts[i + 1]))
    const runs = [] // [legLo, legHi]：腿 legLo..legHi 交替 H/V，直角轉折數 = legHi−legLo
    let a = -1
    for (let i = 0; i <= ds.length; i++) {
      const hv = i < ds.length && (ds[i] === 'H' || ds[i] === 'V')
      const ok = hv && (a < 0 || i === a || ds[i] !== ds[i - 1])
      if (ok) { if (a < 0) a = i; continue }
      if (a >= 0 && i - 1 - a >= 2) runs.push([a, i - 1])
      a = hv ? i : -1
    }
    return runs
  }
  function destairPass() {
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li]
      if (!L.routed || L.fallback || L.forced || L.squeezed || L.colinear) continue
      for (let guard = 0; guard < 8; guard++) {
        const pts = L.pts
        const placed = placedOf(li)
        const curNear = nearOverlapLen(pts, placed)
        let swapped = false
        for (const [a, b] of findStairRuns(pts)) {
          const A = pts[a], B = pts[b + 1]
          const runBends = b - a
          const head = pts.slice(0, a + 1), tail = pts.slice(b + 1)
          for (const c of candidates(A, B, unit, dirsN)) {
            if (c.fallback || c.skew || c.bends > runBends) continue
            const hasDiag = c.pts.some((P, i) => i > 0 && (dirOf(c.pts[i - 1], P) ?? 'X')[0] === 'D')
            if (!hasDiag && c.bends >= runBends) continue // 純 H/V 同折數＝還是樓梯，不換
            const raw = [...head, ...c.pts.slice(1, -1), ...tail]
            const merged = [raw[0]] // 拼接處同向腿合併（折數才數得對）
            for (let i = 1; i < raw.length - 1; i++) {
              if (dist(raw[i], merged[merged.length - 1]) < Z) continue
              const d1 = dirOf(merged[merged.length - 1], raw[i])
              const d2 = dirOf(raw[i], raw[i + 1])
              if (d1 && d2 && d1 === d2 && d1 !== 'X') continue
              merged.push(raw[i])
            }
            merged.push(raw[raw.length - 1])
            const legs = legsOfPts(merged)
            if (legs.length !== merged.length - 1) continue
            let diagAdj = false // 斜轉斜禁止（含拼接邊界）
            for (let k = 1; k < legs.length; k++) {
              const d1 = legs[k - 1].dir, d2 = legs[k].dir
              if (d1 !== 'H' && d1 !== 'V' && d2 !== 'H' && d2 !== 'V' && d1 !== d2) { diagAdj = true; break }
            }
            if (diagAdj) continue
            if (merged.length - 2 > L.bends) continue // 整條線折數不得增加
            if (orderViolation(L.seg, merged)) continue
            if (conflictCount(merged, L.seg, placed) !== 0) continue
            if (nearOverlapLen(merged, placed) > curNear + OVER_TOL) continue
            L.pts = merged
            L.legs = legs
            L.bends = merged.length - 2
            stats.diag45++
            swapped = true
            break
          }
          if (swapped) break // 換過一段 → 這條線重掃（run 索引已失效）
        }
        if (!swapped) break
      }
    }
  }

  /* ---- 22.5 → 45 升級（deskewPass，使用者規則：能 45 就不用 22.5、方向級優先
     於折數）：22.5 是「當下 45 全衝突」時的暫時解；衝突消解後走廊常已空出來，但
     降折與軟調整都不會「增折換方向級」，22.5 一畫就永遠留著。收尾每輪重試：任何
     含 22.5/67.5 腿的線，只要存在**乾淨的 45 級候選**（零衝突、近距貼線與硬重疊
     都不得變長、環狀順序不變），就換成其中折數最少的——折數可以增加（方向級優先
     於折數）。貼線護欄保住既有裁決：45 形要貼著別條線跑時仍保留不貼線的 22.5。 ---- */
  function deskewPass() {
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li]
      if (L.fallback || L.forced) continue
      if (!L.legs?.some((g) => g.dir[0] === 'E' || g.dir[0] === 'F')) continue
      const placed = placedOf(li)
      const curNear = nearOverlapLen(L.pts, placed)
      const curHard = overlapLen(L.pts, placed)
      let best = null
      for (const c of candidates(pos.get(L.seg.a), pos.get(L.seg.b), unit, dirsN)) {
        if (c.fallback || c.skew) continue
        if (best && c.bends >= best.bends) continue // 候選未依折數全排序 → 自行追最少折
        if (conflictCount(c.pts, L.seg, placed) !== 0) continue
        if (orderViolation(L.seg, c.pts)) continue
        if (nearOverlapLen(c.pts, placed) > curNear + OVER_TOL) continue
        if (overlapLen(c.pts, placed) > curHard + OVER_TOL) continue
        best = c
      }
      if (best) {
        L.pts = best.pts
        L.legs = legsOfPts(best.pts)
        L.bends = best.bends
        L.routed = false
        if (L.colinear) { L.colinear = false; stats.colinear-- } // 升級後已全乾淨
        stats.diag45++
      }
    }
  }

  // 〔A* 樓梯轉 45 → 22.5 升回 45 → 順接軟調整 → 壓短共線 → 降折到定點 → L→45〕
  // 跑兩輪：每一步挪動走廊後都可能冒出新的可直線/可順接/可縮共線機會；
  // 續接分數不降 → 拓撲連續方向不變。
  if (!opts.fast) for (let phase = 0; phase < 2; phase++) {
    if (dirsN >= 8) destairPass() // A* 直角樓梯 → 45°（非正方版面救援路徑的後處理）
    if (dirsN >= 16) deskewPass() // 走廊空出來的 22.5 段升回 45 級（能 45 就不用 22.5）
    overlapReducePass() // 有重疊的段先試同折數的 25%/75% 分點把重疊縮短
    softPass() // 同顏色路線盡量直線相接（所有方向級都適用）
    bendReductionToFixpoint() // 盡量直線：能少折且不多重疊就少折
    if (dirsN >= 8) l45Pass() // 4 方向禁 45°——不做 L→45 軟調整（否則會冒出 45° 腿）
  }

  // dev 診斷（window.__rwdAudit）：畫完後逐線重算殘餘衝突，找「有衝突卻沒標 forced」
  // 的洩漏（哪個 pass 沒把旗標寫對／沒檢查就搬線）。
  if (typeof window !== 'undefined' && window.__rwdAudit) {
    stats._audit = lines.map((L, i) => {
      const n = conflictCount(L.pts, L.seg, placedOf(i), false, true)
      const ov = orderViolation(L.seg, L.pts)
      if (!(n > 0 || L.forced || ov)) return null
      return { i, n, ov, f: !!L.forced, lk: !!L.lockedStraight, col: !!L.colinear, rt: !!L.routed, b: L.bends, seg: `${L.seg.a}~${L.seg.b}` }
    }).filter(Boolean)
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

  // interior 白點放回＋自動隱藏（與 routing 完全獨立的收尾段，見 placeWhiteStops）。
  const { posAfter, hidden, globalT } = placeWhiteStops(lines, pos, opts)

  return { lines, posAfter, stats, hidden, hiddenMaxT: globalT >= 0 ? globalT : null }
}

/* ---- interior 白點（直通站）: 第 j/(k+1) 弧長處放回（a→b order = seg.interior）。
     自動隱藏白點（opts.hideStops）——**站距決定全域 cutoff、全圖一致**（使用者裁決）：
     ① 逐段找「讓該段均分後站距 ≥ opts.minStopPx 所需的最小 weight 差門檻」（站距夠寬鬆的
        段需求為 −1，不需刪）；全域 cutoff T = 各段需求的**最大值**。
     ② 全圖任何白點只要其左右 link 的 weight 差 |左−右| ≤ T 就一律隱藏——這樣「刪到 ≤ T」
        與畫面完全一致（寬鬆段的低差白點也一起消失、標籤合併取 max）。
     彩色錨點（a/b）是拓撲錨點不可刪；保留的白點沿弧長**重新均分**。
   hidden：被藏白點 id；globalT = cutoff T（供讀數）。
   buildRwdMap 的收尾段——只讀 routing 結果（lines[].pts）與 opts，不碰 routing 狀態。---- */
function placeWhiteStops(lines, pos, opts) {
  const posAfter = new Map(pos)
  const hidden = new Set()
  const minStopPx = opts.minStopPx ?? 5
  const wOf = opts.linkWeight || (() => 1)
  // 每條線預先算好弧長與各白點 weight 差。
  const meta = lines.map((L) => {
    const ids = L.seg.interior
    const cum = [0]
    for (let i = 1; i < L.pts.length; i++) cum.push(cum[i - 1] + dist(L.pts[i - 1], L.pts[i]))
    const chain = [L.seg.a, ...ids, L.seg.b]
    const diffs = ids.map((id, j) => Math.abs(wOf(chain[j], chain[j + 1]) - wOf(chain[j + 1], chain[j + 2])))
    return { L, ids, cum, total: cum[cum.length - 1], diffs }
  })
  // ① 全域 cutoff T：各段「達到最小站距所需的最小門檻」取最大。
  let globalT = -1
  if (opts.hideStops && minStopPx > 0) {
    for (const { ids, total, diffs } of meta) {
      if (!ids.length || total / (ids.length + 1) >= minStopPx) continue // 夠寬鬆，不需刪
      const maxD = Math.max(...diffs)
      let T = 0
      while (T <= maxD && total / (diffs.filter((d) => d > T).length + 1) < minStopPx) T++
      globalT = Math.max(globalT, T)
    }
  }
  // ② 全圖依 T 隱藏 + 放回座標。
  for (const { L, ids, cum, total, diffs } of meta) {
    if (!ids.length) continue
    const keep = globalT >= 0 ? ids.filter((_, j) => diffs[j] > globalT) : ids
    if (globalT >= 0) for (let j = 0; j < ids.length; j++) if (diffs[j] <= globalT) hidden.add(ids[j])
    const at = (frac) => {
      const target = frac * total
      let i = 1
      while (i < cum.length - 1 && cum[i] < target) i++
      const segLen = cum[i] - cum[i - 1]
      const t = segLen > Z ? (target - cum[i - 1]) / segLen : 0
      const A = L.pts[i - 1], B = L.pts[i]
      return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]
    }
    for (let j = 1; j <= ids.length; j++) posAfter.set(ids[j - 1], at(j / (ids.length + 1))) // 原位（含被藏者）
    const m = keep.length
    for (let j = 1; j <= m; j++) posAfter.set(keep[j - 1], at(j / (m + 1))) // 保留者重新均分
  }

  return { posAfter, hidden, globalT }
}
