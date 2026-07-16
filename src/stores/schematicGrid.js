// Schematic gridding (⑨) — see skill route-skeleton-grid.
// Snap a connect-skeleton to an integer grid. Coloured (non-black) points define
// columns/rows by rank; blue lines are SEPARATORS (they run between points,
// never through one) and every point sits at its cell's CENTRE.
//
// HARD RULE: a cell may hold at most ONE coloured point (incl. yellow crossings,
// which can be near-coincident). To guarantee this the grid is the DENSEST one:
// a separator sits between EVERY pair of distinct coordinates on each axis, so
// each distinct x → its own column and each distinct y → its own row. Truly
// coincident points (gap below EPS) are separated in the result by bumping to
// the nearest free cell. Pure function: `posById` are projected screen coords.

const EPS = 1e-6 // below this gap two coords count as coincident (unsplittable)

// A separator midway between every pair of adjacent DISTINCT values (densest).
function denseCuts(values) {
  const s = [...values].sort((a, b) => a - b)
  const cuts = []
  for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > EPS) cuts.push((s[i] + s[i - 1]) / 2)
  return cuts
}

const rankOf = (v, cuts) => {
  let r = 0
  for (const c of cuts) if (v > c) r++
  return r
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

// Spread each edge's interior black stations evenly along the straight run
// between consecutive cut points (endpoints + non-black interiors). Cut points
// must already be in posMap; a missing one is resolved via `snap(id)` when
// given (returns a position or null). Mutates posMap. Shared by the gridding
// (⑨) and the hill-climbing layout (②, src/stores/hillClimb.js).
export function placeBlacks(skeleton, posMap, snap) {
  const cls = skeleton.stationClass
  // 河流折點（黑點）照常在切點之間**拉直**——切點＝端點＋黃點（河流×metro 交叉）。故河流在
  // 相鄰黃點之間畫成直線（與 metro network 一樣），轉折點被拉直、不保留地理彎（使用者裁決）。
  for (const e of skeleton.edges) {
    const path = e.path
    const cuts = []
    for (let i = 0; i < path.length; i++) {
      if (i === 0 || i === path.length - 1 || cls.get(path[i]) !== 'black') cuts.push(i)
    }
    for (const i of cuts) {
      if (!posMap.has(path[i]) && snap) {
        const p = snap(path[i])
        if (p) posMap.set(path[i], p)
      }
    }
    for (let s = 0; s < cuts.length - 1; s++) {
      const a = cuts[s], b = cuts[s + 1]
      const A = posMap.get(path[a]), B = posMap.get(path[b])
      if (!A || !B) continue
      const k = b - a - 1
      for (let j = 1; j <= k; j++) {
        const t = j / (k + 1)
        posMap.set(path[a + j], [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t])
      }
    }
  }
}

export function buildSchematicGrid(skeleton, posById, extent) {
  const [x0, y0, x1, y1] = extent
  const cls = skeleton.stationClass

  // 河流節點（含端點）不定義格線、不被吸格——格網化只看黃點（交叉，非 river 節點）與地鐵站。
  const riverSet = new Set((skeleton.riverNodes || []).map((r) => r.id))
  const colored = [...cls].filter(([id, c]) => c !== 'black' && !riverSet.has(id) && posById.has(id)).map(([id]) => id)
  const pts = colored.map((id) => ({ id, x: posById.get(id)[0], y: posById.get(id)[1] }))
  const cutsX = denseCuts(pts.map((p) => p.x))
  const cutsY = denseCuts(pts.map((p) => p.y))

  // Unique cell per coloured point (bump only truly-coincident leftovers).
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
  // (rare black cut endpoints — e.g. a ring's pinned first station — snap by
  // rank via the fallback, and get a cell so downstream hill climbing sees them)
  placeBlacks(skeleton, posAfter, (id) => {
    if (!posById.has(id)) return null
    const [x, y] = posById.get(id)
    const c = rankOf(x, cutsX), r = rankOf(y, cutsY)
    if (!cellOf.has(id)) cellOf.set(id, [c, r])
    return [cx(c), cy(r)]
  })

  const seps = (n, o, step) => Array.from({ length: n + 1 }, (_, i) => o + i * step)
  return {
    posAfter,
    // BEFORE: separators at the real cut positions (always between points) + edges.
    // AFTER: uniform cell boundaries; every point sits at a cell centre.
    blueBefore: { xs: [x0, ...cutsX, x1], ys: [y0, ...cutsY, y1] },
    blueAfter: { xs: seps(cols, x0, cellW), ys: seps(rows, y0, cellH) },
    // integer cell per cut point — the hill-climbing layout (②) works in this
    // cell space and maps back through the same uniform cell centres.
    cellOf,
    cols, rows,
  }
}
