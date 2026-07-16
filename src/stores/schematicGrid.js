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

// ---- 吸附後修復（大邱重疊案 2026-07）：排名吸附是逐軸獨立的排名變換，會扭曲
// 相對幾何——地理上不共線的三點可能吸附後恰好共線（點壓到別的段上／兩段共線
// 重疊），不相交的兩段可能吸附後相交。這裡在整數格空間偵測 壓點/交叉/共線重疊，
// 把肇事點外移到「最近的、能讓全域違規數嚴格下降」的空格（與撞格 bump 同性質：
// 犧牲一點排名位置換取正確性），迭代到全零或無法改善。下游爬山鏈的硬規則保證
// 「只減不增」，輸入全零 ⇒ 全程零重疊。 ----
const orient2 = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
const onSeg2 = (p, a, b) => orient2(a, b, p) === 0 &&
  Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
  Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
function segsIntersect2(a, b, c, d) {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
      Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false
  const o1 = orient2(a, b, c), o2 = orient2(a, b, d)
  const o3 = orient2(c, d, a), o4 = orient2(c, d, b)
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
      ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true
  if (o1 === 0 && onSeg2(c, a, b)) return true
  if (o2 === 0 && onSeg2(d, a, b)) return true
  if (o3 === 0 && onSeg2(a, c, d)) return true
  if (o4 === 0 && onSeg2(b, c, d)) return true
  return false
}

// 骨架每條邊在彩色切點切開的小段（與 placeBlacks／buildHcGraph 同一套切法），
// 只收兩端都有格子的段。
function cutSegs(skeleton, cellOf) {
  const cls = skeleton.stationClass
  const segs = []
  for (const e of skeleton.edges) {
    const path = e.path
    const cuts = []
    for (let i = 0; i < path.length; i++) {
      if (i === 0 || i === path.length - 1 || cls.get(path[i]) !== 'black') cuts.push(i)
    }
    for (let s = 0; s + 1 < cuts.length; s++) {
      const a = path[cuts[s]], b = path[cuts[s + 1]]
      if (a === b || !cellOf.has(a) || !cellOf.has(b)) continue
      segs.push({ a, b })
    }
  }
  return segs
}

// 全域違規清單：{ ids:[肇事候選點] }——VTX-ON（點壓段）、CROSS（交叉）、
// OVERLAP（共線重疊；含共端點延伸重疊——由「較短段遠端壓在較長段上」以 VTX-ON 呈現）。
function collectViolations(cellOf, segs) {
  const out = []
  const eq = (p, q) => p[0] === q[0] && p[1] === q[1]
  for (let i = 0; i < segs.length; i++) {
    const A = cellOf.get(segs[i].a), B = cellOf.get(segs[i].b)
    for (let j = i + 1; j < segs.length; j++) {
      const t = segs[j]
      if (t.a === segs[i].a || t.a === segs[i].b || t.b === segs[i].a || t.b === segs[i].b) continue
      const C = cellOf.get(t.a), D = cellOf.get(t.b)
      if (eq(A, C) || eq(A, D) || eq(B, C) || eq(B, D)) continue // 同格＝撞格層處理
      if (segsIntersect2(A, B, C, D)) out.push({ ids: [segs[i].a, segs[i].b, t.a, t.b] })
    }
  }
  for (const [id, P] of cellOf) {
    for (const s of segs) {
      if (s.a === id || s.b === id) continue
      if (onSeg2(P, cellOf.get(s.a), cellOf.get(s.b))) out.push({ ids: [id, s.a, s.b] })
    }
  }
  return out
}

// 只數「涉及 v」的違規（v 自己壓段、v 的鄰接段被壓/相交）。移動 v 不影響
// 其他違規 ⇒ 局部數嚴格下降 ⇔ 全域數嚴格下降——candidate 評分用這個，
// 避免每個候選格都 O(E²) 全域重算。
function countLocal(v, cellOf, segs, inc) {
  const eq = (p, q) => p[0] === q[0] && p[1] === q[1]
  let n = 0
  const P = cellOf.get(v)
  const mine = inc.get(v) ?? []
  const mineSet = new Set(mine)
  for (const s of segs) { // v 壓到非鄰接段
    if (s.a === v || s.b === v) continue
    if (onSeg2(P, cellOf.get(s.a), cellOf.get(s.b))) n++
  }
  for (const si of mine) { // v 的鄰接段 vs 其他段、其他點
    const s = segs[si]
    const A = cellOf.get(s.a), B = cellOf.get(s.b)
    for (let sj = 0; sj < segs.length; sj++) {
      if (mineSet.has(sj) || sj === si) continue
      const t = segs[sj]
      if (t.a === s.a || t.a === s.b || t.b === s.a || t.b === s.b) continue
      const C = cellOf.get(t.a), D = cellOf.get(t.b)
      if (eq(A, C) || eq(A, D) || eq(B, C) || eq(B, D)) continue
      if (segsIntersect2(A, B, C, D)) n++
    }
    for (const [w, pw] of cellOf) {
      if (w === s.a || w === s.b) continue
      if (onSeg2(pw, A, B)) n++
    }
  }
  return n
}

// 修復迴圈：每輪取第一個違規，依序試每個肇事點的環狀外移（Chebyshev 半徑 1–6、
// 同半徑取位移最小），接受第一個讓違規數**嚴格下降**且不撞格的移動；
// 一輪全部試不動就停（殘留數回報給呼叫端）。確定性（無亂數）。
function repairOcclusions(skeleton, cellOf, taken) {
  const segs = cutSegs(skeleton, cellOf)
  if (!segs.length) return 0
  const inc = new Map()
  segs.forEach((s, i) => {
    if (!inc.has(s.a)) inc.set(s.a, [])
    if (!inc.has(s.b)) inc.set(s.b, [])
    inc.get(s.a).push(i)
    inc.get(s.b).push(i)
  })
  const key = (c, r) => `${c},${r}`
  for (let guard = 0; guard < 200; guard++) {
    const vio = collectViolations(cellOf, segs)
    if (!vio.length) return 0
    let moved = false
    const { ids } = vio[0]
    outer: for (const v of ids) {
      const [c0, r0] = cellOf.get(v)
      const before = countLocal(v, cellOf, segs, inc)
      if (!before) continue // 此肇事者其實無局部違規（另一端才是）
      for (let rad = 1; rad <= 6; rad++) {
        let best = null, bd = Infinity
        for (let dc = -rad; dc <= rad; dc++) {
          for (let dr = -rad; dr <= rad; dr++) {
            if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
            const nc = c0 + dc, nr = r0 + dr
            if (nc < 0 || nr < 0 || taken.has(key(nc, nr))) continue
            cellOf.set(v, [nc, nr]) // 試移
            const n = countLocal(v, cellOf, segs, inc)
            cellOf.set(v, [c0, r0])
            const d = dc * dc + dr * dr
            if (n < before && d < bd) { bd = d; best = [nc, nr] }
          }
        }
        if (best) {
          taken.delete(key(c0, r0))
          taken.add(key(best[0], best[1]))
          cellOf.set(v, best)
          moved = true
          break outer
        }
      }
    }
    if (!moved) return vio.length // 卡住：回報殘留數（不劣化、保持現狀）
  }
  return collectViolations(cellOf, segs).length
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

  // 河流已是**資料層的一般網路路線**（站級 Point＋route feature，見 buildLandmarkCombined）
  // ——這裡零特例：河流的端點/匯流/轉折站與地鐵站一樣定義格線、進 cellOf、被爬山最佳化。
  const colored = [...cls].filter(([id, c]) => c !== 'black' && posById.has(id)).map(([id]) => id)
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

  // 稀有黑切點（環線釘住的首站等）先給格子——修復步驟才看得到與下游爬山法
  // （buildHcGraph）完全相同的段圖；placeBlacks 的 fallback 因此變 no-op。
  {
    const clsAll = skeleton.stationClass
    for (const e of skeleton.edges) {
      const path = e.path
      for (let i = 0; i < path.length; i++) {
        if (!(i === 0 || i === path.length - 1 || clsAll.get(path[i]) !== 'black')) continue
        const id = path[i]
        if (cellOf.has(id) || !posById.has(id)) continue
        const [x, y] = posById.get(id)
        cellOf.set(id, [rankOf(x, cutsX), rankOf(y, cutsY)])
      }
    }
  }

  // 吸附後修復：消除排名吸附造成的 壓點/交叉/共線重疊（見上；全零或卡住為止）。
  repairOcclusions(skeleton, cellOf, taken)

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
