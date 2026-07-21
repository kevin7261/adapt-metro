// 論文 Shape-Guided §6 Grid Alignment（Batik et al. 2022 §6 + Bast Octi 改編）
// 輸入＝§5 mixed 佈局（已近形）；把引導形 P（本庫＝正方）織入整數格，
// 先 route C_shape（沿 P），再 route C_octo（八方向最短路徑）。
// 多彎路徑以綠色控制點（中間 sink）表示——對應 Octi 折線中的格點。
//
// 加速（不改論文流程）：A*+binary heap、先試直線/L、候選收斂、少 UI yield。

import { SECTOR_VEC, cyc8, sectorOf } from './_shared.js'

const ckey = (c, r) => `${c},${r}`
const BEND = [Infinity, 2, 1.5, 1, 0]
const C_HOP_HV = 0
const C_HOP_DIAG = 0.5
const C_SHAPE_HOP = 0.05
const R_CAND = 2 // 論文 r≈3；mixed 已近形用 2 夠且快很多
const R_SHAPE = 2
const MAX_PAIR_TRIES = 12 // 每邊最多試幾組候選對（由近到遠）

/** 論文 D1：不當交叉計數（與 shape.js 同義） */
function segIntersect(A, B, C, D) {
  const orient = (p, q, r) => {
    const v = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1])
    if (Math.abs(v) < 1e-12) return 0
    return v > 0 ? 1 : 2
  }
  const onSeg = (p, q, r) =>
    Math.min(p[0], r[0]) - 1e-12 <= q[0] && q[0] <= Math.max(p[0], r[0]) + 1e-12
    && Math.min(p[1], r[1]) - 1e-12 <= q[1] && q[1] <= Math.max(p[1], r[1]) + 1e-12
  const o1 = orient(A, B, C), o2 = orient(A, B, D)
  const o3 = orient(C, D, A), o4 = orient(C, D, B)
  if (o1 !== o2 && o3 !== o4) return true
  if (o1 === 0 && onSeg(A, C, B)) return true
  if (o2 === 0 && onSeg(A, D, B)) return true
  if (o3 === 0 && onSeg(C, A, D)) return true
  if (o4 === 0 && onSeg(C, B, D)) return true
  return false
}
function improperCrossCount(posMap, segs) {
  let n = 0
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    const A = posMap.get(s.a), B = posMap.get(s.b)
    if (!A || !B) continue
    for (let j = i + 1; j < segs.length; j++) {
      const t = segs[j]
      if (s.a === t.a || s.a === t.b || s.b === t.a || s.b === t.b) continue
      const C = posMap.get(t.a), D = posMap.get(t.b)
      if (!C || !D) continue
      if (segIntersect(A, B, C, D)) n++
    }
  }
  return n
}

/* ---------- 小根堆（A* open） ---------- */
function heapPush(h, node) {
  h.push(node)
  let i = h.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (h[p].f <= h[i].f) break
    ;[h[p], h[i]] = [h[i], h[p]]
    i = p
  }
}
function heapPop(h) {
  if (!h.length) return null
  const top = h[0]
  const last = h.pop()
  if (!h.length) return top
  h[0] = last
  let i = 0
  for (;;) {
    let l = i * 2 + 1, r = l + 1, s = i
    if (l < h.length && h[l].f < h[s].f) s = l
    if (r < h.length && h[r].f < h[s].f) s = r
    if (s === i) break
    ;[h[i], h[s]] = [h[s], h[i]]
    i = s
  }
  return top
}

function squarePerimeter(box) {
  const { minX, minY, maxX, maxY } = box
  const cells = []
  for (let x = minX; x < maxX; x++) cells.push([x, minY])
  for (let y = minY; y < maxY; y++) cells.push([maxX, y])
  for (let x = maxX; x > minX; x--) cells.push([x, maxY])
  for (let y = maxY; y > minY; y--) cells.push([minX, y])
  return cells
}

function perimeterWalk(box, A, B) {
  const peri = squarePerimeter(box)
  const ia = peri.findIndex((p) => p[0] === A[0] && p[1] === A[1])
  const ib = peri.findIndex((p) => p[0] === B[0] && p[1] === B[1])
  if (ia < 0 || ib < 0) return null
  const n = peri.length
  const cw = []
  for (let k = ia; ; k = (k + 1) % n) {
    cw.push(peri[k])
    if (k === ib) break
    if (cw.length > n) return null
  }
  const ccw = []
  for (let k = ia; ; k = (k - 1 + n) % n) {
    ccw.push(peri[k])
    if (k === ib) break
    if (ccw.length > n) return null
  }
  return cw.length <= ccw.length ? cw : ccw
}

function bendCells(path) {
  if (!path || path.length < 2) return path ? path.slice() : []
  const out = [path[0]]
  for (let i = 1; i + 1 < path.length; i++) {
    const a = path[i - 1], b = path[i], c = path[i + 1]
    const d1 = sectorOf(b[0] - a[0], b[1] - a[1])
    const d2 = sectorOf(c[0] - b[0], c[1] - b[1])
    if (d1 !== d2) out.push(b)
  }
  out.push(path[path.length - 1])
  return out
}

/** 格線上從 A→B 是否暢通（不含端點；blocked 不可踩） */
function lineClear(A, B, blocked, sk, gk) {
  const dx = Math.sign(B[0] - A[0]), dy = Math.sign(B[1] - A[1])
  const steps = Math.max(Math.abs(B[0] - A[0]), Math.abs(B[1] - A[1]))
  if (!steps) return [A]
  // 必須是八方向
  if (dx && dy && Math.abs(B[0] - A[0]) !== Math.abs(B[1] - A[1])) return null
  if (!dx && !dy) return [A]
  const path = [A]
  let x = A[0], y = A[1]
  for (let i = 0; i < steps; i++) {
    x += dx; y += dy
    const k = ckey(x, y)
    if (blocked.has(k) && k !== gk && k !== sk) return null
    path.push([x, y])
  }
  return path
}

/** 先試直線／L 形（多數邊可秒過，免 A*） */
function tryFastPath(A, B, blocked) {
  const sk = ckey(A[0], A[1]), gk = ckey(B[0], B[1])
  const direct = lineClear(A, B, blocked, sk, gk)
  if (direct) return direct
  // 兩種 L
  for (const M of [[B[0], A[1]], [A[0], B[1]]]) {
    if (M[0] === A[0] && M[1] === A[1]) continue
    if (M[0] === B[0] && M[1] === B[1]) continue
    const mk = ckey(M[0], M[1])
    if (blocked.has(mk)) continue
    const p1 = lineClear(A, M, blocked, sk, mk)
    if (!p1) continue
    const p2 = lineClear(M, B, blocked, mk, gk)
    if (!p2) continue
    return p1.concat(p2.slice(1))
  }
  return null
}

/**
 * A* 八方向（狀態＝格＋來向）。heuristic＝Chebyshev（可採納下界）。
 */
function astarPath(start, goal, cols, rows, blocked, shapeSet, {
  preferShape = false, maxExpand = 12000,
} = {}) {
  const sk = ckey(start[0], start[1])
  const gk = ckey(goal[0], goal[1])
  if (sk === gk) return [start]

  const hEst = (c, r) => Math.max(Math.abs(goal[0] - c), Math.abs(goal[1] - r)) * 0.25

  const open = []
  const best = new Map()
  const prev = new Map()
  const push = (c, r, dir, g, from) => {
    const k = `${c},${r},${dir}`
    const old = best.get(k)
    if (old != null && old <= g + 1e-12) return
    best.set(k, g)
    if (from) prev.set(k, from)
    heapPush(open, { c, r, dir, g, f: g + hEst(c, r) })
  }
  push(start[0], start[1], -1, 0, null)

  let expands = 0
  while (open.length && expands < maxExpand) {
    const cur = heapPop(open)
    expands++
    const ck = `${cur.c},${cur.r},${cur.dir}`
    if (best.get(ck) < cur.g - 1e-12) continue
    if (cur.c === goal[0] && cur.r === goal[1]) {
      // 重建
      const path = []
      let k = ck
      while (k) {
        const parts = k.split(',')
        path.push([+parts[0], +parts[1]])
        const p = prev.get(k)
        if (!p) break
        k = `${p.c},${p.r},${p.dir}`
      }
      path.reverse()
      const uniq = [path[0]]
      for (let i = 1; i < path.length; i++) {
        const a = uniq[uniq.length - 1], b = path[i]
        if (a[0] !== b[0] || a[1] !== b[1]) uniq.push(b)
      }
      return uniq
    }
    for (let d = 0; d < 8; d++) {
      const [dc, dr] = SECTOR_VEC[d]
      const nc = cur.c + dc, nr = cur.r + dr
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const nk = ckey(nc, nr)
      if (blocked.has(nk) && nk !== gk && nk !== sk) continue
      let hop = (d % 2 === 0) ? C_HOP_HV : C_HOP_DIAG
      if (shapeSet.has(nk) && shapeSet.has(ckey(cur.c, cur.r))) hop = C_SHAPE_HOP
      else if (preferShape && !shapeSet.has(nk)) hop += 8
      let bend = 0
      if (cur.dir >= 0) {
        const delta = cyc8(cur.dir, d)
        bend = BEND[delta]
        if (!Number.isFinite(bend)) continue
      }
      push(nc, nr, d, cur.g + hop + bend, { c: cur.c, r: cur.r, dir: cur.dir })
    }
  }
  return null
}

function routePath(A, B, cols, rows, blocked, shapeSet, opts) {
  const fast = tryFastPath(A, B, blocked)
  if (fast) return fast
  return astarPath(A, B, cols, rows, blocked, shapeSet, opts)
}

function ldegMap(segs, inc) {
  const m = new Map()
  for (const [v, list] of inc) {
    const rs = new Set()
    for (const si of list) for (const r of segs[si].routes) rs.add(r)
    m.set(v, rs.size)
  }
  return m
}

function orderEdges(segs, inc) {
  const ldeg = ldegMap(segs, inc)
  const order = []
  const state = new Map()
  for (const s of segs) {
    if (!state.has(s.a)) state.set(s.a, 'U')
    if (!state.has(s.b)) state.set(s.b, 'U')
  }
  const byLdeg = (a, b) => (ldeg.get(b) || 0) - (ldeg.get(a) || 0)
    || String(a).localeCompare(String(b))
  const segBetween = new Map()
  segs.forEach((s, si) => {
    for (const k of [`${s.a}|${s.b}`, `${s.b}|${s.a}`]) {
      if (!segBetween.has(k)) segBetween.set(k, [])
      segBetween.get(k).push(si)
    }
  })
  const taken = new Set()
  for (;;) {
    const un = [...state].filter(([, st]) => st === 'U').map(([id]) => id).sort(byLdeg)
    if (!un.length) break
    state.set(un[0], 'D')
    for (;;) {
      const dang = [...state].filter(([, st]) => st === 'D').map(([id]) => id).sort(byLdeg)
      if (!dang.length) break
      const vd = dang[0]
      const nbrs = new Set()
      for (const si of (inc.get(vd) || [])) {
        const s = segs[si]
        nbrs.add(s.a === vd ? s.b : s.a)
      }
      for (const u of [...nbrs].filter((x) => state.get(x) === 'U').sort(byLdeg)) {
        for (const si of segBetween.get(`${vd}|${u}`) ?? []) {
          if (!taken.has(si)) { taken.add(si); order.push(si) }
        }
        state.set(u, 'D')
      }
      state.set(vd, 'P')
    }
  }
  for (let si = 0; si < segs.length; si++) if (!taken.has(si)) order.push(si)
  return order
}

function placeWOnSquare(mixed, cutIds, cols, rows) {
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ring.push(id)
  }
  if (ring.length < 4) return null
  const pts = ring.map((id) => mixed.get(id)).filter(Boolean)
  if (pts.length < ring.length) return null
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length
  const n = ring.length
  const q = Math.floor(n / 4)
  const rem = n % 4
  const sizes = [0, 1, 2, 3].map((i) => q + (i < rem ? 1 : 0))
  if (sizes.some((s) => s < 1)) return null
  let side = Math.max(Math.max(...sizes), 2)
  const fit = (s) => {
    let minX = Math.round(cx - s / 2), minY = Math.round(cy - s / 2)
    let maxX = minX + s, maxY = minY + s
    if (minX < 0) { maxX -= minX; minX = 0 }
    if (minY < 0) { maxY -= minY; minY = 0 }
    if (maxX >= cols) { const d = maxX - (cols - 1); minX = Math.max(0, minX - d); maxX = minX + s }
    if (maxY >= rows) { const d = maxY - (rows - 1); minY = Math.max(0, minY - d); maxY = minY + s }
    if (maxX >= cols || maxY >= rows) return null
    return { minX, minY, maxX, maxY, side: s }
  }
  let box = null
  for (let s = side; s <= Math.min(cols, rows) - 1; s++) {
    box = fit(s)
    if (box) break
  }
  if (!box) return null

  const corners = [
    [box.minX, box.minY], [box.maxX, box.minY],
    [box.maxX, box.maxY], [box.minX, box.maxY],
  ]
  const cornerIdx = [0]
  let acc = 0
  for (let i = 0; i < 3; i++) {
    acc += sizes[i]
    cornerIdx.push(acc)
  }
  const used = new Set()
  const placed = new Map()
  const placeOnSide = (sideI, prefer) => {
    const A = corners[sideI], B = corners[(sideI + 1) % 4]
    const cells = []
    if (A[0] === B[0]) {
      const y0 = Math.min(A[1], B[1]), y1 = Math.max(A[1], B[1])
      for (let y = y0; y <= y1; y++) cells.push([A[0], y])
    } else {
      const x0 = Math.min(A[0], B[0]), x1 = Math.max(A[0], B[0])
      for (let x = x0; x <= x1; x++) cells.push([x, A[1]])
    }
    let best = null, bd = Infinity
    for (const cell of cells) {
      const k = ckey(cell[0], cell[1])
      if (used.has(k)) continue
      const d = Math.hypot(cell[0] - prefer[0], cell[1] - prefer[1])
      if (d < bd) { bd = d; best = cell }
    }
    return best
  }
  for (let sideI = 0; sideI < 4; sideI++) {
    const i0 = cornerIdx[sideI]
    const i1 = sideI === 3 ? n : cornerIdx[sideI + 1]
    for (let j = 0; j < i1 - i0; j++) {
      const prefer = [
        corners[sideI][0] + (corners[(sideI + 1) % 4][0] - corners[sideI][0]) * (j / sizes[sideI]),
        corners[sideI][1] + (corners[(sideI + 1) % 4][1] - corners[sideI][1]) * (j / sizes[sideI]),
      ]
      const cell = placeOnSide(sideI, prefer)
      if (!cell) return null
      used.add(ckey(cell[0], cell[1]))
      placed.set(ring[i0 + j], cell)
    }
  }
  return { box, placed, ring }
}

/**
 * @param {Map<number,{path:number[][], allowGreen?:boolean}>} routeBySi
 * allowGreen=true 僅規定路段 W——綠轉折只出現在要方形化的線上。
 */
function materializeRoutes(segs, layout, routeBySi) {
  const greens = []
  let gSeq = 0
  const outSegs = []

  for (let si = 0; si < segs.length; si++) {
    const base = segs[si]
    const hit = routeBySi.get(si)
    if (!hit) {
      outSegs.push({
        a: base.a, b: base.b, routes: base.routes, hops: base.hops,
        interior: [...(base.interior ?? [])], edge: base.edge,
      })
      continue
    }
    const bends = bendCells(hit.path)
    const mids = hit.allowGreen ? bends.slice(1, -1) : []
    if (!mids.length) {
      outSegs.push({
        a: base.a, b: base.b, routes: base.routes, hops: base.hops,
        interior: [...(base.interior ?? [])], edge: base.edge,
      })
      continue
    }
    const nodes = [base.a]
    for (const cell of mids) {
      const gid = `shape-g${gSeq++}`
      layout.set(gid, [...cell])
      greens.push({ id: gid, c: cell[0], r: cell[1], a: base.a, b: base.b })
      nodes.push(gid)
    }
    nodes.push(base.b)
    for (let i = 1; i + 1 < nodes.length; i++) {
      const g = greens.find((x) => x.id === nodes[i])
      if (g) { g.a = nodes[i - 1]; g.b = nodes[i + 1] }
    }
    const parts = nodes.length - 1
    for (let i = 0; i < parts; i++) {
      outSegs.push({
        a: nodes[i], b: nodes[i + 1],
        routes: base.routes,
        hops: Math.max(1, Math.floor(base.hops / parts)),
        interior: i === 0 ? [...(base.interior ?? [])] : [],
        edge: base.edge,
      })
    }
  }
  return { segs: outSegs, greens }
}

/**
 * 論文 §6 主程序（加速版）。
 */
export async function runShapeOctiGrid({
  mixed, cutIds, pathSet, segs, inc, cols, rows, isShapeSeg,
  cross0 = Infinity, onProgress, tick,
}) {
  let lastYield = 0
  const progress = async (msg, force = false) => {
    if (typeof onProgress === 'function') onProgress(msg)
    const now = performance.now()
    // 最多約 8 次/秒讓出 UI，避免 await 拖慢
    if (!force && now - lastYield < 120) return
    lastYield = now
    if (typeof tick === 'function') await tick()
    else if (typeof onProgress === 'function') await new Promise((r) => setTimeout(r, 0))
  }

  await progress('§6 Octi：釘 W 到引導形 P（正方）…', true)
  const placedW = placeWOnSquare(mixed, cutIds, cols, rows)
  if (!placedW) {
    await progress('§6 Octi：無法放置引導形', true)
    return null
  }
  const { box, placed } = placedW
  const shapeCells = squarePerimeter(box)
  const shapeSet = new Set(shapeCells.map(([c, r]) => ckey(c, r)))

  const layout = new Map([...mixed].map(([id, p]) => [id, [...p]]))
  for (const [id, p] of placed) layout.set(id, [...p])

  const sinkClosed = new Set()
  for (const [, p] of layout) sinkClosed.add(ckey(p[0], p[1]))
  const bendClosed = new Set()

  const routeBySi = new Map()
  let failed = 0

  const settle = (id, cell) => {
    const old = layout.get(id)
    if (old) sinkClosed.delete(ckey(old[0], old[1]))
    layout.set(id, [...cell])
    sinkClosed.add(ckey(cell[0], cell[1]))
  }

  const markPath = (path, A, B) => {
    const ak = ckey(A[0], A[1]), bk = ckey(B[0], B[1])
    for (const cell of path) {
      const k = ckey(cell[0], cell[1])
      if (k !== ak && k !== bk) bendClosed.add(k)
    }
  }

  const makeBlocked = (A, B, oldA, oldB) => {
    const blocked = new Set(bendClosed)
    const ak = ckey(A[0], A[1]), bk = ckey(B[0], B[1])
    for (const k of sinkClosed) {
      if (k !== ak && k !== bk) blocked.add(k)
    }
    if (oldA) blocked.delete(ckey(oldA[0], oldA[1]))
    if (oldB) blocked.delete(ckey(oldB[0], oldB[1]))
    return blocked
  }

  const candidatesOf = (id) => {
    if (placed.has(id) || pathSet.has(id)) {
      const p = layout.get(id)
      return p ? [p] : []
    }
    const p0 = layout.get(id) || mixed.get(id)
    if (!p0) return []
    const out = []
    for (let dc = -R_CAND; dc <= R_CAND; dc++) {
      for (let dr = -R_CAND; dr <= R_CAND; dr++) {
        const c = p0[0] + dc, r = p0[1] + dr
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue
        const k = ckey(c, r)
        if (sinkClosed.has(k)) {
          const cur = layout.get(id)
          if (!cur || cur[0] !== c || cur[1] !== r) continue
        }
        out.push([c, r])
      }
    }
    // 由近到遠
    out.sort((a, b) =>
      Math.hypot(a[0] - p0[0], a[1] - p0[1]) - Math.hypot(b[0] - p0[0], b[1] - p0[1]))
    return out.length ? out : [[
      Math.max(0, Math.min(cols - 1, Math.round(p0[0]))),
      Math.max(0, Math.min(rows - 1, Math.round(p0[1]))),
    ]]
  }

  // ── C_shape＝僅規定路段 W—W（綠轉折只允許這裡）──
  await progress('§6 Octi：先 route 規定路段 W 沿 P…', true)
  const shapeSegIdx = []
  const octoSegIdx = []
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si]
    // 嚴格：兩端都在 W 才算描形邊（勿用 Sshape 擴大——否則綠點灑到其他線）
    if (pathSet.has(s.a) && pathSet.has(s.b)) shapeSegIdx.push(si)
    else octoSegIdx.push(si)
  }
  void isShapeSeg // 論文混合段標記；格網綠控只認 W

  for (const si of shapeSegIdx) {
    const s = segs[si]
    const A = layout.get(s.a), B = layout.get(s.b)
    if (!A || !B) { failed++; continue }
    let path = perimeterWalk(box, A, B)
    if (!path || path.length < 2) {
      const blocked = makeBlocked(A, B, A, B)
      path = routePath(A, B, cols, rows, blocked, shapeSet, { preferShape: true })
    }
    if (!path) { failed++; continue }
    markPath(path, A, B)
    routeBySi.set(si, { path, allowGreen: true })
  }

  // ── C_octo：只收單段八方向（不插綠點；L/多彎會變成非 W 綠點）──
  await progress(`§6 Octi：route C_octo 直連（${octoSegIdx.length} 邊，禁非W綠）…`, true)
  const octoSet = new Set(octoSegIdx)
  const ordered = orderEdges(segs, inc).filter((si) => octoSet.has(si))

  /** 僅直線八方向暢通（不含 L——L 需要中間點＝綠） */
  const tryDirectOnly = (A, B, blocked) => {
    const sk = ckey(A[0], A[1]), gk = ckey(B[0], B[1])
    return lineClear(A, B, blocked, sk, gk)
  }

  let done = 0
  for (const si of ordered) {
    const s = segs[si]
    const aFixed = pathSet.has(s.a) || placed.has(s.a)
    const bFixed = pathSet.has(s.b) || placed.has(s.b)
    const CA = aFixed ? [layout.get(s.a)].filter(Boolean) : candidatesOf(s.a)
    const CB = bFixed ? [layout.get(s.b)].filter(Boolean) : candidatesOf(s.b)
    const oldA = layout.get(s.a), oldB = layout.get(s.b)

    const pairs = []
    for (const A of CA) {
      for (const B of CB) {
        if (A[0] === B[0] && A[1] === B[1]) continue
        // 必須已是八方向弦，否則直連不存在
        const dx = B[0] - A[0], dy = B[1] - A[1]
        const oct = dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)
        if (!oct) continue
        const disp = Math.hypot(A[0] - (oldA?.[0] ?? A[0]), A[1] - (oldA?.[1] ?? A[1]))
          + Math.hypot(B[0] - (oldB?.[0] ?? B[0]), B[1] - (oldB?.[1] ?? B[1]))
        pairs.push({ A, B, disp })
      }
    }
    pairs.sort((a, b) => a.disp - b.disp)

    let best = null
    let bestCost = Infinity
    const limit = Math.min(pairs.length, MAX_PAIR_TRIES)
    for (let pi = 0; pi < limit; pi++) {
      const { A, B, disp } = pairs[pi]
      const blocked = makeBlocked(A, B, oldA, oldB)
      const path = tryDirectOnly(A, B, blocked)
      if (!path) continue
      const cost = path.length + 1.5 * disp
      if (cost < bestCost) {
        bestCost = cost
        best = { A, B, path }
        if (disp < 0.5) break
      }
    }
    if (!best) { failed++; continue }
    // 論文 D1：試套用後交叉不可增
    const snapA = oldA ? [...oldA] : null
    const snapB = oldB ? [...oldB] : null
    settle(s.a, best.A)
    settle(s.b, best.B)
    if (improperCrossCount(layout, segs) > cross0) {
      if (snapA) settle(s.a, snapA)
      else layout.delete(s.a)
      if (snapB) settle(s.b, snapB)
      else layout.delete(s.b)
      failed++
      continue
    }
    markPath(best.path, best.A, best.B)
    routeBySi.set(si, { path: best.path, allowGreen: false })
    done++
    if (done % 40 === 0) {
      await progress(`§6 Octi：C_octo ${done}/${ordered.length}（失敗 ${failed}）…`)
    }
  }

  const mat = materializeRoutes(segs, layout, routeBySi)
  const crossFinal = improperCrossCount(layout, mat.segs)
  await progress(
    `§6 Octi：完成（W綠×${mat.greens.length}，未路由 ${failed}，交叉 ${cross0}→${crossFinal}）`,
    true)
  return {
    layout,
    segs: mat.segs,
    greens: mat.greens,
    box,
    via: failed ? `octi·fail${failed}` : 'octi',
    failed,
    crosses: crossFinal,
  }
}
