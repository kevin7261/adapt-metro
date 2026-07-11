// RWD Maps（版面路網畫線）— see skill route-rwd-draw.
// Draw the hill-climbing 縮減網格 layout as a schematic of STRICT H/V/45° legs.
//
// 硬規則：八方向約束以「版面 pixel」為準 — the H/V/45° test is evaluated on the
// SVG plot coordinates, NOT on integer cell indices. Once column width ≠ row
// height (any non-square canvas/grid), a cell-space diagonal is no longer 45°
// on screen, so the polylines must be (re)built in pixel space. The caller
// therefore passes PIXEL positions and re-runs this after every remap/resize.
//
// For every cut-to-cut segment generate candidate polylines sorted by bend
// count, pick the first one that neither overlaps another route collinearly
// nor runs over a foreign node, and re-spread the interior black stations
// along the CHOSEN polyline by arc length.
//
// Candidate order (fewest bends first):
//   0 bends  straight S→T when it already is H / V / 45° (±TOL px)
//   1 bend   45° diagonal to the shorter delta, then H/V to T;
//            pure L (H then V; V then H); mirror (H/V first, 45° last)
//   2 bends  45°–H–45° (|Δx|>|Δy|) or 45°–V–45° (|Δy|>|Δx|) with the middle
//            leg at 1/2 of the span, alternates at 1/4 and 3/4 for conflicts
//   last     the raw straight S→T (illegal direction) as the final fallback
//
// A LEGAL straight that conflicts (parallel edges between the same two nodes,
// or a corridor already claimed by an earlier polyline) gets detour candidates
// too: parallel offsets (45° out, run alongside at 1 then 2 units, 45° back —
// small detour first) and finally the big 1-bend detours (45° triangle apex
// for H/V, L corners for 45° lines). If even those conflict the straight is
// drawn anyway and counted in stats.forced.
//
// Leg direction test: Δy≈0 → H, Δx≈0 → V, |Δx|≈|Δy| → 45°, anything else X.
// Pure function; `pos` are pixel coordinates, `opts.unit` is the detour offset
// in pixels (the caller passes ~one grid cell).

const Z = 1e-9        // exact-zero guard
const TOL = 0.75      // px — direction classification (≈45° within a pixel is 45°)
const KEY_TOL = 0.5   // px — two legs count as the same line within this
const OVER_TOL = 0.5  // px — collinear extents must share more than this

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
  return { dir, key: lineKey(dir, A), lo, hi }
}

// Collinear overlap (same family, same line, shared extent beyond a point).
const legsOverlap = (p, q) =>
  p.dir === q.dir && Math.abs(p.key - q.key) < KEY_TOL &&
  Math.min(p.hi, q.hi) - Math.max(p.lo, q.lo) > OVER_TOL

// P strictly inside leg A–B (endpoint contact excluded).
function pointOnLeg(P, A, B, dir) {
  if (Math.abs(lineKey(dir, P) - lineKey(dir, A)) > KEY_TOL) return false
  const t = dir === 'V' ? P[1] : P[0]
  const [lo, hi] = spanOf(dir, A, B)
  return t > lo + OVER_TOL && t < hi - OVER_TOL
}

// Detours for a LEGAL straight line that conflicts with earlier polylines:
// parallel offsets first (smallest visual displacement), big 1-bend detours
// last. `u` is the offset unit in pixels (~one grid cell).
function legalDetours(S, T, dir, u) {
  const dx = T[0] - S[0], dy = T[1] - S[1]
  const sx = Math.sign(dx), sy = Math.sign(dy)
  const ax = Math.abs(dx), ay = Math.abs(dy)
  const out = []
  if (dir === 'H') {
    for (const d of [u, 2 * u]) {
      if (ax <= 2 * d) continue
      for (const e of [1, -1]) {
        out.push({ pts: [S, [S[0] + sx * d, S[1] + e * d], [T[0] - sx * d, S[1] + e * d], T], bends: 2 })
      }
    }
    for (const e of [1, -1]) out.push({ pts: [S, [S[0] + dx / 2, S[1] + e * ax / 2], T], bends: 1 })
  } else if (dir === 'V') {
    for (const d of [u, 2 * u]) {
      if (ay <= 2 * d) continue
      for (const e of [1, -1]) {
        out.push({ pts: [S, [S[0] + e * d, S[1] + sy * d], [S[0] + e * d, T[1] - sy * d], T], bends: 2 })
      }
    }
    for (const e of [1, -1]) out.push({ pts: [S, [S[0] + e * ay / 2, S[1] + dy / 2], T], bends: 1 })
  } else { // D+ / D- : run alongside via a short H or V lead-in/out, L corners last
    // A ±TOL-tolerated "45°" input can have ax ≠ ay; rebuild exact-45 diagonals
    // from the average so the detour legs are strictly diagonal on screen.
    const m = (ax + ay) / 2
    for (const d of [u, 2 * u]) {
      if (m <= d) continue
      out.push({ pts: [S, [S[0] + sx * d, S[1]], [T[0], T[1] - sy * d], T], bends: 2 })
      out.push({ pts: [S, [S[0], S[1] + sy * d], [T[0] - sx * d, T[1]], T], bends: 2 })
    }
    out.push({ pts: [S, [T[0], S[1]], T], bends: 1 })
    out.push({ pts: [S, [S[0], T[1]], T], bends: 1 })
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
  // 單轉折：45° 先走到與較短邊等長處再 H/V；純 L 形；鏡像（H/V 先、45° 收尾）
  out.push({ pts: [S, [S[0] + sx * m, S[1] + sy * m], T], bends: 1 })
  out.push({ pts: [S, [T[0], S[1]], T], bends: 1 }) // L: H → V
  out.push({ pts: [S, [S[0], T[1]], T], bends: 1 }) // L: V → H
  out.push({ pts: [S, [T[0] - sx * m, T[1] - sy * m], T], bends: 1 }) // H/V → 45°
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

// `pos` = Map<id, [x, y]> PIXEL positions of the (compact-grid) cut points.
// opts.unit = detour offset in pixels (default 12, callers pass ~a cell).
export function buildRwdMap(segs, pos, opts = {}) {
  const unit = opts.unit ?? 12
  const placed = [] // accepted legs of every routed segment
  const nodes = [...pos.entries()] // [id, [x,y]] — foreign-node test
  const lines = []
  // forced = a legal straight drawn although every candidate (incl. detours)
  // conflicted; fallback = an illegal direction that nothing could legalize.
  const stats = { straight: 0, single: 0, double: 0, fallback: 0, forced: 0, segs: 0 }

  const usable = segs.filter((s) => pos.has(s.a) && pos.has(s.b))
  // Longest corridors route first (they have the fewest workable alternatives);
  // stable tie-break keeps the result deterministic.
  const order = usable
    .map((s, i) => ({ s, i, len: dist(pos.get(s.a), pos.get(s.b)) }))
    .sort((p, q) => q.len - p.len || p.i - q.i)

  function conflicts(pts, seg) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const leg = legOf(pts[i], pts[i + 1])
      if (!leg) return true // X-direction leg → only the fallback may use it
      for (const p of placed) if (legsOverlap(leg, p)) return true
      for (const [id, P] of nodes) {
        if (id === seg.a || id === seg.b) continue
        if (pointOnLeg(P, pts[i], pts[i + 1], leg.dir)) return true
      }
    }
    return false
  }

  for (const { s } of order) {
    const S = pos.get(s.a), T = pos.get(s.b)
    const cands = candidates(S, T, unit)
    let chosen = null
    for (const c of cands) {
      if (c.fallback) continue // only ever taken when everything else conflicts
      if (!conflicts(c.pts, s)) { chosen = c; break }
    }
    if (!chosen) {
      // Nothing conflict-free: an illegal span falls back to its raw straight,
      // a legal span keeps its straight — either way it is drawn (and counted).
      chosen = cands.find((c) => c.fallback) ?? cands[0]
      if (!chosen.fallback) stats.forced++
    }
    stats.segs++
    if (chosen.fallback) stats.fallback++
    else if (chosen.bends === 0) stats.straight++
    else if (chosen.bends === 1) stats.single++
    else stats.double++
    for (let i = 0; i + 1 < chosen.pts.length; i++) {
      const leg = legOf(chosen.pts[i], chosen.pts[i + 1])
      if (leg) placed.push(leg)
    }
    lines.push({ seg: s, pts: chosen.pts, bends: chosen.bends, fallback: !!chosen.fallback })
  }

  // Interior black stations: j-th of k sits at arc-length fraction j/(k+1)
  // of the chosen polyline (a→b order matches seg.interior).
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
