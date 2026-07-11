// Schematic gridding (⑨) — see skill route-skeleton-grid.
// Snap a connect-skeleton to an integer grid. Coloured (non-black) points define
// columns/rows by rank; blue lines are SEPARATORS (they run between points,
// never through one) and every point sits at its cell's CENTRE.
//
// HARD RULE: a cell may hold at most ONE coloured point. Strategy: start from a
// COARSE banding (chain-clustering, 10 px) so the grid stays sparse, then SPLIT
// a band locally only where a cell actually holds two coloured points — the
// grid ends up "coarse + a few extra lines", not one-band-per-point dense.
// Truly coincident pairs (no gap on either axis) are separated in the post view
// by bumping to the nearest free cell. Pure function: `posById` are projected
// screen coords (rotation already baked in).

const EPS = 0.5 // px — below this two coords count as coincident

// Chain-cluster cut positions: a cut midway inside every gap > tol.
function chainCuts(sortedVals, tol) {
  const cuts = []
  for (let i = 1; i < sortedVals.length; i++) {
    if (sortedVals[i] - sortedVals[i - 1] > tol) cuts.push((sortedVals[i] + sortedVals[i - 1]) / 2)
  }
  return cuts
}

const rankOf = (v, cuts) => {
  let r = 0
  for (const c of cuts) if (v > c) r++
  return r
}

// Largest adjacent gap among sorted values: returns { gap, mid }.
function largestGap(vals) {
  const s = [...vals].sort((a, b) => a - b)
  let gap = 0, mid = 0
  for (let i = 1; i < s.length; i++) {
    const g = s[i] - s[i - 1]
    if (g > gap) { gap = g; mid = (s[i] + s[i - 1]) / 2 }
  }
  return { gap, mid }
}

// Nearest free cell to (c,r), expanding Chebyshev rings (minimal displacement).
function nearestFree(c, r, taken) {
  for (let rad = 1; rad < 4000; rad++) {
    let best = null, bd = Infinity
    for (let dc = -rad; dc <= rad; dc++) {
      for (let dr = -rad; dr <= rad; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
        const nc = c + dc, nr = r + dr
        if (nc < 0 || nr < 0 || taken.has(`${nc},${nr}`)) continue
        const d = dc * dc + dr * dr
        if (d < bd) { bd = d; best = [nc, nr] }
      }
    }
    if (best) return best
  }
  return [c, r]
}

export function buildSchematicGrid(skeleton, posById, extent) {
  const [x0, y0, x1, y1] = extent
  const TOL = 10 // px — coarse chain-clustering; splits below refine only where needed
  const cls = skeleton.stationClass

  const colored = [...cls].filter(([id, c]) => c !== 'black' && posById.has(id)).map(([id]) => id)
  const pts = colored.map((id) => ({ id, x: posById.get(id)[0], y: posById.get(id)[1] }))
  const cutsX = chainCuts(pts.map((p) => p.x).sort((a, b) => a - b), TOL)
  const cutsY = chainCuts(pts.map((p) => p.y).sort((a, b) => a - b), TOL)

  // Split bands until every cell holds ≤1 coloured point (coincident pairs are
  // left for the post-view bump). Each split adds ONE separator midway across
  // the widest gap inside the offending cell — grid stays as coarse as possible.
  for (let guard = 0; guard < 2000; guard++) {
    const cells = new Map()
    for (const p of pts) {
      const k = `${rankOf(p.x, cutsX)},${rankOf(p.y, cutsY)}`
      if (!cells.has(k)) cells.set(k, [])
      cells.get(k).push(p)
    }
    let split = false
    for (const group of cells.values()) {
      if (group.length < 2) continue
      const gx = largestGap(group.map((p) => p.x))
      const gy = largestGap(group.map((p) => p.y))
      if (gx.gap < EPS && gy.gap < EPS) continue // coincident — bump later
      if (gx.gap >= gy.gap) cutsX.push(gx.mid)
      else cutsY.push(gy.mid)
      cutsX.sort((a, b) => a - b); cutsY.sort((a, b) => a - b)
      split = true
      break // re-bucket from scratch after each split
    }
    if (!split) break
  }

  // Final unique cell per coloured point (bump only truly coincident leftovers).
  const taken = new Set()
  const cellOf = new Map()
  const ranked = pts.map((p) => ({ id: p.id, c: rankOf(p.x, cutsX), r: rankOf(p.y, cutsY) }))
  ranked.sort((A, B) => A.c - B.c || A.r - B.r || (A.id < B.id ? -1 : 1))
  for (const { id, c, r } of ranked) {
    let cc = c, rr = r
    if (taken.has(`${cc},${rr}`)) [cc, rr] = nearestFree(c, r, taken)
    taken.add(`${cc},${rr}`)
    cellOf.set(id, [cc, rr])
  }

  let maxC = cutsX.length, maxR = cutsY.length
  for (const [c, r] of cellOf.values()) { if (c > maxC) maxC = c; if (r > maxR) maxR = r }
  const cols = maxC + 1, rows = maxR + 1
  const cellW = (x1 - x0) / cols
  const cellH = (y1 - y0) / rows
  const cx = (c) => x0 + (c + 0.5) * cellW // cell centre
  const cy = (r) => y0 + (r + 0.5) * cellH

  const posAfter = new Map()
  for (const [id, [c, r]] of cellOf) posAfter.set(id, [cx(c), cy(r)])

  // each line: cut at coloured points, straighten + spread black evenly between
  for (const e of skeleton.edges) {
    const path = e.path
    const cuts = []
    for (let i = 0; i < path.length; i++) {
      if (i === 0 || i === path.length - 1 || cls.get(path[i]) !== 'black') cuts.push(i)
    }
    for (const i of cuts) {
      if (!posAfter.has(path[i]) && posById.has(path[i])) {
        const [x, y] = posById.get(path[i]) // rare: a black endpoint — snap by rank
        posAfter.set(path[i], [cx(rankOf(x, cutsX)), cy(rankOf(y, cutsY))])
      }
    }
    for (let s = 0; s < cuts.length - 1; s++) {
      const a = cuts[s], b = cuts[s + 1]
      const A = posAfter.get(path[a]), B = posAfter.get(path[b])
      if (!A || !B) continue
      const k = b - a - 1
      for (let j = 1; j <= k; j++) {
        const t = j / (k + 1)
        posAfter.set(path[a + j], [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t])
      }
    }
  }

  const seps = (n, o, step) => Array.from({ length: n + 1 }, (_, i) => o + i * step)
  return {
    posAfter,
    // BEFORE: the actual cut positions (always between points) + outer edges.
    // AFTER: uniform cell boundaries; points sit at cell centres.
    blueBefore: { xs: [x0, ...cutsX, x1], ys: [y0, ...cutsY, y1] },
    blueAfter: { xs: seps(cols, x0, cellW), ys: seps(rows, y0, cellH) },
    cols, rows,
  }
}
