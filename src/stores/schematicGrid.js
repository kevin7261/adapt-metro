// Schematic gridding (⑨) — see skill route-skeleton-grid.
// Snap a connect-skeleton to an integer grid: the coloured (non-black) points
// define the columns/rows by RANK of their x/y (equidistant — real distances are
// dropped); every line is cut at coloured points; endpoints snap to the grid;
// black (through) points are spread evenly back along each straightened sub-edge.
// HARD RULE: no grid cell may hold two coloured points — collisions are bumped to
// the nearest free cell. Pure function: `posById` are already-projected screen coords.

// Cluster sorted values within `tol`, returning each cluster's mean (ascending).
function cluster(values, tol) {
  const sorted = [...values].sort((a, b) => a - b)
  const out = []
  let bucket = []
  for (const v of sorted) {
    if (bucket.length && v - bucket[bucket.length - 1] > tol) {
      out.push(bucket.reduce((s, x) => s + x, 0) / bucket.length)
      bucket = []
    }
    bucket.push(v)
  }
  if (bucket.length) out.push(bucket.reduce((s, x) => s + x, 0) / bucket.length)
  return out
}

// Nearest index in an ascending array.
function nearestIdx(arr, v) {
  let best = 0, bd = Infinity
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i] - v)
    if (d < bd) { bd = d; best = i }
  }
  return best
}

// Nearest free cell to (c,r) not in `taken`, searched in expanding Chebyshev
// rings so a bumped point moves as little as possible.
function nearestFree(c, r, taken) {
  for (let rad = 1; rad < 4000; rad++) {
    let best = null, bd = Infinity
    for (let dc = -rad; dc <= rad; dc++) {
      for (let dr = -rad; dr <= rad; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue // ring only
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
  const TOL = 10 // px — points within this on an axis share a column/row
  const cls = skeleton.stationClass

  const colored = [...cls].filter(([id, c]) => c !== 'black' && posById.has(id)).map(([id]) => id)
  const xsCol = cluster(colored.map((id) => posById.get(id)[0]), TOL)
  const ysRow = cluster(colored.map((id) => posById.get(id)[1]), TOL)
  const colOf = (x) => nearestIdx(xsCol, x)
  const rowOf = (y) => nearestIdx(ysRow, y)

  // Assign a UNIQUE integer cell to each coloured point (≤1 coloured per cell).
  const taken = new Set()
  const cellOf = new Map()
  const ranked = colored.map((id) => ({ id, c: colOf(posById.get(id)[0]), r: rowOf(posById.get(id)[1]) }))
  ranked.sort((A, B) => A.c - B.c || A.r - B.r || (A.id < B.id ? -1 : 1))
  for (const { id, c, r } of ranked) {
    let cc = c, rr = r
    if (taken.has(`${cc},${rr}`)) [cc, rr] = nearestFree(c, r, taken)
    taken.add(`${cc},${rr}`)
    cellOf.set(id, [cc, rr])
  }

  // grid size AFTER collision resolution
  let maxC = 0, maxR = 0
  for (const [c, r] of cellOf.values()) { if (c > maxC) maxC = c; if (r > maxR) maxR = r }
  const cellW = (x1 - x0) / Math.max(maxC, 1)
  const cellH = (y1 - y0) / Math.max(maxR, 1)
  const cx = (c) => x0 + c * cellW
  const cy = (r) => y0 + r * cellH

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
        posAfter.set(path[i], [cx(colOf(x)), cy(rowOf(y))])
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

  const range = (n) => Array.from({ length: n + 1 }, (_, i) => i)
  return {
    posAfter,
    // blue separator lines: BEFORE at real coords (rank preview), AFTER a full
    // integer grid (0..maxC columns, 0..maxR rows) after collision resolution
    blueBefore: { xs: xsCol, ys: ysRow },
    blueAfter: { xs: range(maxC).map(cx), ys: range(maxR).map(cy) },
    cols: maxC + 1, rows: maxR + 1,
  }
}
