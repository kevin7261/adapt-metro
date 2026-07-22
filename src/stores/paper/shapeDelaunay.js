// Delaunay→貼形：**三角網拓撲不可變**（連通＋定向／相對位置），但可加綠控點擴充三角網。
// 綠點＝控制點：插在規定路段 W 邊上 → 分割既有三角（新加三角形），目標釘在正方四角。
// 既有三角仍拒翻；新三角以插入當下定向鎖定。
import { Delaunay } from 'd3-delaunay'
import { buildHcGraph, countHV, countHVD } from '../hillClimb.js'
import { emptyResult } from './_shared.js'
import { getShapePreset, SHAPE_SQUARE } from './shapePresets.js'

const MIN_CUTS = 6
const MORPH_STEPS = 96
const RELAX_ROUNDS = 20
const MICRO_PASSES = 3 // 每步整網多掃幾次，讓所有三角頂點都動
const EPS = 1e-9
const ckey = (c, r) => `${c},${r}`
const isGreenId = (id) => String(id).startsWith('shape-g')

function dedupeAdj(ids) {
  return ids.filter((id, i) => i === 0 || id !== ids[i - 1])
}

function firstCycle(ids) {
  const seen = new Map()
  for (let i = 0; i < ids.length; i++) {
    if (seen.has(ids[i])) return ids.slice(seen.get(ids[i]), i + 1)
    seen.set(ids[i], i)
  }
  return null
}

function extractRouteStations(rt, pos, segment) {
  let ids = dedupeAdj((rt.stations ?? []).filter((id) => pos.has(id)))
  if (segment === 'first-cycle') ids = firstCycle(ids) ?? []
  return ids
}

function pickCut(skeleton, pos, cityId) {
  const preset = getShapePreset(cityId)
  if (!preset) return null
  const routes = skeleton.routes
  if (!routes?.size) return null
  const list = [...routes.values()].filter((rt) => !String(rt.id).startsWith('river:'))
  const matched = list.find((r) => r.id === preset.routeId)
    ?? list.find((r) => preset.nameRe.test(r.name ?? ''))
  let cutIds = dedupeAdj(preset.stations.filter((id) => pos.has(id)))
  const presetComplete = cutIds.length === dedupeAdj(preset.stations).length && cutIds.length >= MIN_CUTS
  if (!presetComplete) {
    if (!matched) return null
    cutIds = extractRouteStations(matched, pos, preset.segment)
  }
  if (cutIds.length < MIN_CUTS) return null
  if (cutIds.some((id) => !pos.get(id))) return null
  return {
    cutIds,
    routeId: matched?.id ?? preset.routeId,
    routeName: preset.label || (matched?.name && String(matched.name).trim()) || String(preset.routeId),
    shape: preset.shape ?? SHAPE_SQUARE,
  }
}

function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

function anyFlip(triIdx, P, id, nx, ny) {
  for (const t of (triIdx.get(id) ?? [])) {
    const A = t.a === id ? [nx, ny] : P.get(t.a)
    const B = t.b === id ? [nx, ny] : P.get(t.b)
    const C = t.c === id ? [nx, ny] : P.get(t.c)
    if (!A || !B || !C) continue
    const o = orient(A[0], A[1], B[0], B[1], C[0], C[1])
    if (t.sign > 0 && o <= EPS) return true
    if (t.sign < 0 && o >= -EPS) return true
  }
  return false
}

function countFlips(tris, P) {
  let n = 0
  for (const t of tris) {
    const A = P.get(t.a), B = P.get(t.b), C = P.get(t.c)
    if (!A || !B || !C) { n++; continue }
    const o = orient(A[0], A[1], B[0], B[1], C[0], C[1])
    if (t.sign > 0 && o <= EPS) n++
    else if (t.sign < 0 && o >= -EPS) n++
  }
  return n
}

function trySet(P, triIdx, id, nx, ny) {
  if (anyFlip(triIdx, P, id, nx, ny)) return false
  P.set(id, [nx, ny])
  return true
}

function moveToward(P, triIdx, id, tx, ty, steps = 10) {
  const cur = P.get(id)
  if (!cur) return false
  if (!anyFlip(triIdx, P, id, tx, ty)) {
    P.set(id, [tx, ty])
    return true
  }
  let lo = 0, hi = 1, best = [...cur]
  for (let k = 0; k < steps; k++) {
    const m = (lo + hi) / 2
    const nx = cur[0] + (tx - cur[0]) * m
    const ny = cur[1] + (ty - cur[1]) * m
    if (!anyFlip(triIdx, P, id, nx, ny)) {
      best = [nx, ny]
      lo = m
    } else {
      hi = m
    }
  }
  if (best[0] !== cur[0] || best[1] !== cur[1]) {
    P.set(id, best)
    return true
  }
  return false
}

function indexMesh(tris) {
  const edges = new Set()
  const addE = (a, b) => {
    const u = a < b ? a : b, v = a < b ? b : a
    edges.add(`${u}|${v}`)
  }
  const adj = new Map()
  const triIdx = new Map()
  for (const t of tris) {
    addE(t.a, t.b); addE(t.b, t.c); addE(t.c, t.a)
    for (const id of [t.a, t.b, t.c]) {
      if (!adj.has(id)) adj.set(id, new Set())
      if (!triIdx.has(id)) triIdx.set(id, [])
      triIdx.get(id).push(t)
    }
  }
  for (const e of edges) {
    const [u, v] = e.split('|')
    if (!adj.has(u)) adj.set(u, new Set())
    if (!adj.has(v)) adj.set(v, new Set())
    adj.get(u).add(v)
    adj.get(v).add(u)
  }
  return { adj, triIdx, edgeCount: edges.size }
}

function makeTri(a, b, c, pos) {
  const A = pos.get(a), B = pos.get(b), C = pos.get(c)
  const sign = Math.sign(orient(A[0], A[1], B[0], B[1], C[0], C[1]))
  if (!sign) return null
  return { a, b, c, sign }
}

function buildDelaunay(ids, pos) {
  const pts = ids.map((id, i) => {
    const p = pos.get(id)
    const jx = ((i * 17) % 7) * 1e-4
    const jy = ((i * 31) % 7) * 1e-4
    return [p[0] + jx, p[1] + jy]
  })
  const del = Delaunay.from(pts)
  const tris = []
  for (let i = 0; i < del.triangles.length; i += 3) {
    const t = makeTri(
      ids[del.triangles[i]],
      ids[del.triangles[i + 1]],
      ids[del.triangles[i + 2]],
      pos,
    )
    if (t) tris.push(t)
  }
  return { tris, ...indexMesh(tris) }
}

function hasMeshEdge(adj, a, b) {
  return adj.get(a)?.has(b)
}

/** 在邊 a—b 上插 g：每個含該邊的三角切成兩個（新加三角形） */
function splitMeshEdge(tris, pos, a, b, g) {
  const next = []
  let split = 0
  for (const t of tris) {
    const verts = [t.a, t.b, t.c]
    const ia = verts.indexOf(a), ib = verts.indexOf(b)
    if (ia < 0 || ib < 0) {
      next.push(t)
      continue
    }
    const c = verts.find((v) => v !== a && v !== b)
    const t1 = makeTri(a, g, c, pos)
    const t2 = makeTri(g, b, c, pos)
    if (t1) next.push(t1)
    if (t2) next.push(t2)
    split++
  }
  return { tris: next, split }
}

/** 在三角內部插 g：一面切成三面 */
function splitMeshFace(tris, pos, tri, g) {
  const next = []
  for (const t of tris) {
    if (t !== tri) {
      next.push(t)
      continue
    }
    for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
      const nt = makeTri(g, u, v, pos)
      if (nt) next.push(nt)
    }
  }
  return next
}

function pointInTri(px, py, A, B, C) {
  const o1 = orient(A[0], A[1], B[0], B[1], px, py)
  const o2 = orient(B[0], B[1], C[0], C[1], px, py)
  const o3 = orient(C[0], C[1], A[0], A[1], px, py)
  const hasNeg = (o1 < -EPS) || (o2 < -EPS) || (o3 < -EPS)
  const hasPos = (o1 > EPS) || (o2 > EPS) || (o3 > EPS)
  return !(hasNeg && hasPos)
}

function closestTri(tris, pos, p) {
  let best = null, bd = Infinity
  for (const t of tris) {
    const A = pos.get(t.a), B = pos.get(t.b), C = pos.get(t.c)
    const cx = (A[0] + B[0] + C[0]) / 3
    const cy = (A[1] + B[1] + C[1]) / 3
    const d = Math.hypot(cx - p[0], cy - p[1])
    if (d < bd) { bd = d; best = t }
  }
  return best
}

function rebuildInc(segs) {
  const inc = new Map()
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si]
    if (!inc.has(s.a)) inc.set(s.a, [])
    if (!inc.has(s.b)) inc.set(s.b, [])
    inc.get(s.a).push(si)
    inc.get(s.b).push(si)
  }
  return inc
}

function splitSegAt(segs, pos, si, gid, cell) {
  const s = segs[si]
  const { a, b, routes, hops, interior, edge } = s
  pos.set(gid, [cell[0], cell[1]])
  const mid = Math.floor((interior?.length ?? 0) / 2)
  const int1 = (interior ?? []).slice(0, mid)
  const int2 = (interior ?? []).slice(mid)
  const h1 = Math.max(1, Math.floor(hops / 2))
  const h2 = Math.max(1, hops - h1)
  segs[si] = { a, b: gid, routes, hops: h1, interior: int1, edge }
  segs.push({ a: gid, b, routes, hops: h2, interior: int2, edge })
  return rebuildInc(segs)
}

function distPointSeg(p, A, B) {
  const dx = B[0] - A[0], dy = B[1] - A[1]
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(p[0] - A[0], p[1] - A[1])
  let t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (A[0] + t * dx), p[1] - (A[1] + t * dy))
}

/**
 * 在 W 環四角插入綠控：分割地鐵段＋分割三角網（新三角形）。
 * 綠點初值＝邊中點（落在網內），目標＝正方角。
 */
function insertCornerGreens({
  ring, box, pos, segs, tris, adj,
}) {
  const corners = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.maxX, box.maxY],
    [box.minX, box.maxY],
  ]
  const greens = []
  const greenTargets = new Map()
  let mesh = tris
  let meshAdj = adj
  let gi = 0
  const usedEdges = new Set()

  for (const corner of corners) {
    // 選距離角最近的 W 環邊
    let bestI = -1, bestD = Infinity
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]
      const ek = a < b ? `${a}|${b}` : `${b}|${a}`
      if (usedEdges.has(ek)) continue
      const A = pos.get(a), B = pos.get(b)
      if (!A || !B) continue
      const d = distPointSeg(corner, A, B)
      if (d < bestD) { bestD = d; bestI = i }
    }
    if (bestI < 0) continue
    const a = ring[bestI], b = ring[(bestI + 1) % ring.length]
    const ek = a < b ? `${a}|${b}` : `${b}|${a}`
    usedEdges.add(ek)

    const si = segs.findIndex((s) =>
      (s.a === a && s.b === b) || (s.a === b && s.b === a))
    if (si < 0) continue

    const A = pos.get(a), B = pos.get(b)
    // 初值：邊中點（確保落在既有三角邊上／內，分割合法）
    const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]
    const gid = `shape-g${gi++}`
    pos.set(gid, mid)

    if (hasMeshEdge(meshAdj, a, b)) {
      const r = splitMeshEdge(mesh, pos, a, b, gid)
      mesh = r.tris
    } else {
      // 無網邊：找含中點的面（或最近面）切成三
      let host = null
      for (const t of mesh) {
        const TA = pos.get(t.a), TB = pos.get(t.b), TC = pos.get(t.c)
        if (pointInTri(mid[0], mid[1], TA, TB, TC)) { host = t; break }
      }
      if (!host) host = closestTri(mesh, pos, mid)
      if (!host) {
        pos.delete(gid)
        continue
      }
      mesh = splitMeshFace(mesh, pos, host, gid)
    }

    splitSegAt(segs, pos, si, gid, mid)
    const indexed = indexMesh(mesh)
    meshAdj = indexed.adj
    greens.push({ id: gid, c: corner[0], r: corner[1], a, b })
    greenTargets.set(gid, [...corner])
  }

  return {
    greens,
    greenTargets,
    tris: mesh,
    ...indexMesh(mesh),
  }
}

function wSquareBox(posMap, cutIds, cols, rows) {
  const pts = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const p = posMap.get(id)
    if (p) pts.push(p)
  }
  if (pts.length < 4) return null
  const minX0 = Math.min(...pts.map((p) => p[0]))
  const maxX0 = Math.max(...pts.map((p) => p[0]))
  const minY0 = Math.min(...pts.map((p) => p[1]))
  const maxY0 = Math.max(...pts.map((p) => p[1]))
  const n = seen.size
  const need = Math.max(2, Math.floor(n / 4))
  let side = Math.max(need, Math.round(Math.min(maxX0 - minX0, maxY0 - minY0)))
  const cx = (minX0 + maxX0) / 2, cy = (minY0 + maxY0) / 2
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
  for (let s = side; s <= Math.min(cols, rows) - 1; s++) {
    const box = fit(s)
    if (box) return box
  }
  return fit(Math.min(cols, rows) - 1)
}

function fourSideTargets(cutIds, box) {
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ring.push(id)
  }
  if (ring.length < 4) return null
  const n = ring.length
  const { minX, minY, maxX, maxY } = box
  const q = Math.floor(n / 4)
  const rem = n % 4
  const sizes = [0, 1, 2, 3].map((i) => q + (i < rem ? 1 : 0))
  if (sizes.some((s) => s < 1)) return null
  const corners = [
    [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY],
  ]
  const cornerIdx = [0]
  let acc = 0
  for (let i = 0; i < 3; i++) {
    acc += sizes[i]
    cornerIdx.push(acc)
  }
  const out = new Map()
  for (let sideI = 0; sideI < 4; sideI++) {
    const i0 = cornerIdx[sideI]
    const i1 = sideI === 3 ? n : cornerIdx[sideI + 1]
    const A = corners[sideI], B = corners[(sideI + 1) % 4]
    for (let j = 0; j < i1 - i0; j++) {
      const t = j / sizes[sideI]
      // 站點避開角（角留給綠點）：邊內 (0,1) 均分
      const u = sizes[sideI] <= 1 ? 0.5 : (j + 1) / (sizes[sideI] + 1)
      out.set(ring[i0 + j], [
        A[0] + (B[0] - A[0]) * u,
        A[1] + (B[1] - A[1]) * u,
      ])
      void t
    }
  }
  return { targets: out, ring }
}

function convexHull(pts) {
  const p = pts.map((q) => [...q]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length <= 2) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  lower.pop(); upper.pop()
  return lower.concat(upper)
}

function rayPolyHitDist(cx, cy, ang, poly) {
  const dx = Math.cos(ang), dy = Math.sin(ang)
  let best = Infinity
  for (let i = 0; i + 1 < poly.length; i++) {
    const Ax = poly[i][0] - cx, Ay = poly[i][1] - cy
    const Bx = poly[i + 1][0] - cx, By = poly[i + 1][1] - cy
    const ex = Bx - Ax, ey = By - Ay
    const det = dx * ey - dy * ex
    if (Math.abs(det) < 1e-12) continue
    const t = (Ax * ey - Ay * ex) / det
    const u = (dx * Ay - dy * Ax) / det
    if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.min(best, t)
  }
  return best
}

function radialTargets(srcPos, cutIds, box, wTargets) {
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const p = srcPos.get(id)
    if (p) ring.push([...p])
  }
  if (ring.length < 4) return null
  const hull = convexHull(ring)
  if (hull.length < 3) return null
  const srcPoly = hull.map((p) => [...p])
  srcPoly.push([...srcPoly[0]])
  const { minX, minY, maxX, maxY } = box
  const dstPoly = [
    [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
  ]
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const out = new Map()
  for (const [id, p] of srcPos) {
    if (wTargets.has(id)) {
      out.set(id, [...wTargets.get(id)])
      continue
    }
    const ang = Math.atan2(p[1] - cy, p[0] - cx)
    const r = Math.hypot(p[0] - cx, p[1] - cy)
    if (r < 1e-9) {
      out.set(id, [cx, cy])
      continue
    }
    let rSrc = rayPolyHitDist(cx, cy, ang, srcPoly)
    let rDst = rayPolyHitDist(cx, cy, ang, dstPoly)
    if (!Number.isFinite(rSrc) || rSrc < 1e-6) rSrc = Math.max(1e-3, r)
    if (!Number.isFinite(rDst) || rDst < 1e-6) rDst = Math.min(maxX - minX, maxY - minY) / 2
    const rNew = r <= rSrc + 1e-9 ? r * (rDst / rSrc) : rDst + (r - rSrc)
    out.set(id, [cx + Math.cos(ang) * rNew, cy + Math.sin(ang) * rNew])
  }
  return out
}

/**
 * 整網鬆弛：每個三角頂點都可以動。
 * 目標＝鄰接平均（跟網走）＋徑向／成方目標（mixDst）；不再錨回原位。
 */
function relaxMesh(P, triIdx, adj, ids, dst, rounds = RELAX_ROUNDS, mixDst = 0.4) {
  for (let r = 0; r < rounds; r++) {
    for (const id of ids) {
      const nbrs = [...(adj.get(id) ?? [])]
      const cur = P.get(id)
      const d = dst.get(id) ?? cur
      let nx, ny
      if (nbrs.length) {
        let sx = 0, sy = 0
        for (const n of nbrs) {
          const q = P.get(n)
          sx += q[0]; sy += q[1]
        }
        nx = (1 - mixDst) * (sx / nbrs.length) + mixDst * d[0]
        ny = (1 - mixDst) * (sy / nbrs.length) + mixDst * d[1]
      } else {
        nx = d[0]; ny = d[1]
      }
      // 大步朝目標；拒翻則二分縮步
      moveToward(P, triIdx, id, nx, ny, 10)
    }
  }
}

/** 一步：所有點同時朝 ideal 插值（Jacobi 提案＋逐點拒翻套用） */
function stepAllToward(P, triIdx, ids, ideal, alpha) {
  const want = new Map()
  for (const id of ids) {
    const cur = P.get(id)
    const t = ideal.get(id) ?? cur
    want.set(id, [
      cur[0] + alpha * (t[0] - cur[0]),
      cur[1] + alpha * (t[1] - cur[1]),
    ])
  }
  for (const id of ids) {
    const w = want.get(id)
    moveToward(P, triIdx, id, w[0], w[1], 10)
  }
}

function placeSafe(P, triIdx, id, prefer, used, cols, rows, { maxRad = 16 } = {}) {
  const c0 = Math.round(prefer[0]), r0 = Math.round(prefer[1])
  let best = null, bd = Infinity
  for (let rad = 0; rad <= maxRad; rad++) {
    for (let dc = -rad; dc <= rad; dc++) {
      for (let dr = -rad; dr <= rad; dr++) {
        if (rad > 0 && Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
        const c = Math.max(0, Math.min(cols - 1, c0 + dc))
        const r = Math.max(0, Math.min(rows - 1, r0 + dr))
        if (used.has(ckey(c, r))) continue
        if (anyFlip(triIdx, P, id, c, r)) continue
        const cost = Math.hypot(c - prefer[0], r - prefer[1])
        if (cost < bd) { bd = cost; best = [c, r] }
      }
    }
    if (best && rad >= 3) break
  }
  return best
}

/** 四邊直線方；允許經綠點 H/V 折角 */
function isFourLineSquare(cutIds, posMap, segs = null) {
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ring.push(id)
  }
  if (ring.length < 4) return false
  const allPts = [...ring.map((id) => posMap.get(id)).filter(Boolean)]
  for (const [id, p] of posMap) {
    if (isGreenId(id)) allPts.push(p)
  }
  const pts = ring.map((id) => posMap.get(id)).filter(Boolean)
  if (pts.length < ring.length) return false
  const minX = Math.min(...allPts.map((p) => p[0])), maxX = Math.max(...allPts.map((p) => p[0]))
  const minY = Math.min(...allPts.map((p) => p[1])), maxY = Math.max(...allPts.map((p) => p[1]))
  if (maxX - minX !== maxY - minY || maxX === minX) return false
  const onBound = (p) => p
    && (p[0] === minX || p[0] === maxX || p[1] === minY || p[1] === maxY)
  for (const p of pts) {
    if (!onBound(p)) return false
  }
  for (const [id, p] of posMap) {
    if (isGreenId(id) && !onBound(p)) return false
  }

  let adj = null
  if (segs) {
    adj = new Map()
    for (const s of segs) {
      if (!adj.has(s.a)) adj.set(s.a, [])
      if (!adj.has(s.b)) adj.set(s.b, [])
      adj.get(s.a).push(s.b)
      adj.get(s.b).push(s.a)
    }
  }
  const hopHV = (u, v) => {
    const A = posMap.get(u), B = posMap.get(v)
    if (!A || !B) return false
    return A[0] === B[0] || A[1] === B[1]
  }
  const connectedHV = (a, b) => {
    if (hopHV(a, b)) return true
    if (!adj) return false
    const q = [a]
    const prev = new Map([[a, null]])
    while (q.length) {
      const u = q.shift()
      if (u === b) break
      for (const v of adj.get(u) ?? []) {
        if (prev.has(v)) continue
        if (v !== b && !isGreenId(v)) continue
        if (!hopHV(u, v)) continue
        if (isGreenId(v) && !onBound(posMap.get(v))) continue
        prev.set(v, u)
        q.push(v)
      }
    }
    return prev.has(b)
  }
  for (let i = 0; i < ring.length; i++) {
    if (!connectedHV(ring[i], ring[(i + 1) % ring.length])) return false
  }
  return true
}

function onSquareEdge(p, box, eps = 0.55) {
  const { minX, minY, maxX, maxY } = box
  const onV = Math.abs(p[0] - minX) <= eps || Math.abs(p[0] - maxX) <= eps
  const onH = Math.abs(p[1] - minY) <= eps || Math.abs(p[1] - maxY) <= eps
  return (onV || onH)
    && p[0] >= minX - eps && p[0] <= maxX + eps
    && p[1] >= minY - eps && p[1] <= maxY + eps
}

function squareProgress(cutIds, posMap, box, greens = []) {
  const ids = [...cutIds, ...greens.map((g) => g.id)]
  let on = 0, n = 0
  for (const id of ids) {
    const p = posMap.get(id)
    if (!p) continue
    n++
    if (onSquareEdge(p, box)) on++
  }
  return n ? on / n : 0
}

async function shapeProgress(opts, msg) {
  if (typeof opts.onProgress === 'function') opts.onProgress(msg)
  if (typeof opts.tick === 'function') await opts.tick()
  else await new Promise((r) => setTimeout(r, 0))
}

/**
 * 拓撲不變的 Delaunay 貼形（可插綠控擴網）。
 */
export async function buildShapeDelaunay(skeleton, cells, cols, rows, opts = {}) {
  const { pos: pos0, segs: segs0 } = buildHcGraph(skeleton, cells)
  if (!pos0.size || !segs0.length) return emptyResult(pos0, segs0)

  const cityId = opts.cityId ?? null
  const pick = pickCut(skeleton, pos0, cityId)
  if (!pick) {
    return {
      cellAfter: pos0,
      tris: [],
      greens: [],
      stats: {
        hvBefore: countHV(pos0, segs0), hvAfter: countHV(pos0, segs0),
        hvdBefore: countHVD(pos0, segs0), hvdAfter: countHVD(pos0, segs0),
        segs: segs0.length, verts: pos0.size, moved: 0, passes: 0,
        skipped: true, note: '不需計算', via: 'skip',
      },
    }
  }

  const pos = new Map([...pos0].map(([id, p]) => [id, [...p]]))
  const segs = segs0.map((s) => ({
    a: s.a, b: s.b, routes: s.routes, hops: s.hops,
    interior: [...(s.interior ?? [])], edge: s.edge,
  }))
  const pathSet = new Set(pick.cutIds)
  const geo0 = new Map([...pos].map(([id, p]) => [id, [...p]]))
  let ids = [...pos.keys()]
  await shapeProgress(opts, `Delaunay：三角化 ${ids.length} 站（拓撲鎖定）…`)

  let { tris, adj, triIdx, edgeCount } = buildDelaunay(ids, pos)
  if (tris.length < 1) {
    await shapeProgress(opts, 'Delaunay：三角化失敗')
    return {
      cellAfter: pos0,
      tris: [],
      greens: [],
      stats: {
        hvBefore: countHV(pos0, segs0), hvAfter: countHV(pos0, segs0),
        segs: segs0.length, verts: pos0.size, moved: 0,
        note: '三角化失敗', via: 'fail', route: pick.routeName, tris: 0,
      },
    }
  }

  const box = wSquareBox(pos, pick.cutIds, cols, rows)
  const ft0 = box ? fourSideTargets(pick.cutIds, box) : null
  if (!box || !ft0) {
    await shapeProgress(opts, 'Delaunay：無法放置正方目標')
    return {
      cellAfter: pos0,
      tris: tris.map((t) => [t.a, t.b, t.c]),
      greens: [],
      stats: {
        hvBefore: countHV(pos0, segs0), hvAfter: countHV(pos0, segs0),
        segs: segs0.length, verts: pos0.size, moved: 0,
        note: '無法成方目標', via: 'fail', route: pick.routeName,
        tris: tris.length, triEdges: edgeCount, flips: 0, topoOk: true,
      },
    }
  }

  // ── 插四角綠控：新加三角形 ──
  await shapeProgress(opts, 'Delaunay：插入四角綠控（分割三角）…')
  const inserted = insertCornerGreens({
    ring: ft0.ring, box, pos, segs, tris, adj,
  })
  tris = inserted.tris
  adj = inserted.adj
  triIdx = inserted.triIdx
  edgeCount = inserted.edgeCount
  const greens = inserted.greens
  for (const g of greens) pathSet.add(g.id)
  ids = [...pos.keys()]

  // 站點目標＋綠點目標（角）
  const ft = fourSideTargets(pick.cutIds, box)
  const wTargets = new Map(ft.targets)
  for (const [gid, t] of inserted.greenTargets) wTargets.set(gid, t)

  const geo = new Map([...pos].map(([id, p]) => [id, [...p]]))
  // 徑向目標涵蓋**所有**三角頂點（含綠）；W／綠覆寫成方／角目標
  const dst = radialTargets(geo, pick.cutIds, box, wTargets)
    ?? new Map([...geo].map(([id, p]) => [id, wTargets.has(id) ? [...wTargets.get(id)] : [...p]]))
  for (const [gid, t] of inserted.greenTargets) dst.set(gid, [...t])
  for (const [id, t] of wTargets) dst.set(id, [...t])

  await shapeProgress(opts,
    `Delaunay：整網 ${ids.length} 點一起拉方 ${pick.routeName}（邊=${box.side}，綠×${greens.length}）…`)

  const P = new Map([...geo].map(([id, p]) => [id, [...p]]))
  const wIds = [...ft.ring, ...greens.map((g) => g.id)]

  // ── 整網同步變形：每一步所有三角頂點都朝徑向目標走（不鎖死非 W）──
  for (let step = 1; step <= MORPH_STEPS; step++) {
    if (step % 8 === 0) {
      await shapeProgress(opts, `Delaunay：整網拉方 ${step}/${MORPH_STEPS}（${ids.length} 點）…`)
    }
    const t = step / MORPH_STEPS
    const ideal = new Map()
    for (const id of ids) {
      const s = geo.get(id), g = dst.get(id)
      if (!s || !g) continue
      ideal.set(id, [s[0] + (g[0] - s[0]) * t, s[1] + (g[1] - s[1]) * t])
    }
    for (let m = 0; m < MICRO_PASSES; m++) {
      stepAllToward(P, triIdx, ids, ideal, 0.85)
      // 鬆弛也動整網（含 W／綠），讓內部／外部點跟著走
      relaxMesh(P, triIdx, adj, ids, ideal, RELAX_ROUNDS, 0.45)
    }
  }

  // 終局：整網再對齊最終 dst（W／綠權重高＝ideal=dst；其餘也繼續跟）
  await shapeProgress(opts, `Delaunay：整網終局對齊（${ids.length} 點，拒翻）…`)
  for (let pass = 0; pass < 40; pass++) {
    let moved = 0
    for (const id of ids) {
      const g = dst.get(id)
      if (!g) continue
      const before = P.get(id)
      if (moveToward(P, triIdx, id, g[0], g[1], 14)) {
        const after = P.get(id)
        if (Math.hypot(after[0] - before[0], after[1] - before[1]) > 1e-6) moved++
      }
    }
    relaxMesh(P, triIdx, adj, ids, dst, RELAX_ROUNDS, pathSet.size ? 0.55 : 0.4)
    // W／綠額外多推一輪（成方驅動，但仍拒翻；其餘點隨後鬆弛跟上去）
    for (const id of wIds) {
      const g = wTargets.get(id)
      if (g) moveToward(P, triIdx, id, g[0], g[1], 14)
    }
    relaxMesh(P, triIdx, adj, ids, dst, Math.ceil(RELAX_ROUNDS / 2), 0.35)
    if (moved < Math.max(3, ids.length * 0.02)) break
  }

  let flipsCont = countFlips(tris, P)
  if (flipsCont > 0) {
    await shapeProgress(opts, `Delaunay：警告連續域翻三角=${flipsCont}，整網回鬆…`)
    relaxMesh(P, triIdx, adj, ids, geo, RELAX_ROUNDS * 3, 0.2)
    flipsCont = countFlips(tris, P)
  }

  await shapeProgress(opts, `Delaunay：連續域拓撲${flipsCont === 0 ? '完好' : `翻${flipsCont}`} → 整數吸附…`)

  const layout = new Map([...P].map(([id, p]) => [id, [...p]]))
  const used = new Set()

  // 綠點優先釘角
  for (const g of greens) {
    const prefer = wTargets.get(g.id)
    const cell = placeSafe(layout, triIdx, g.id, prefer, used, cols, rows, { maxRad: Math.max(box.side, 20) })
      ?? placeSafe(layout, triIdx, g.id, P.get(g.id), used, cols, rows, { maxRad: 24 })
    if (cell) {
      layout.set(g.id, cell)
      used.add(ckey(cell[0], cell[1]))
    } else {
      layout.set(g.id, [...P.get(g.id)])
    }
  }

  const wOrder = [...ft.ring].sort((a, b) => {
    const da = Math.hypot(P.get(a)[0] - wTargets.get(a)[0], P.get(a)[1] - wTargets.get(a)[1])
    const db = Math.hypot(P.get(b)[0] - wTargets.get(b)[0], P.get(b)[1] - wTargets.get(b)[1])
    return da - db
  })
  for (const id of wOrder) {
    const prefer = wTargets.get(id)
    const cell = placeSafe(layout, triIdx, id, prefer, used, cols, rows, { maxRad: Math.max(box.side, 20) })
      ?? placeSafe(layout, triIdx, id, P.get(id), used, cols, rows, { maxRad: 24 })
    if (cell) {
      layout.set(id, cell)
      used.add(ckey(cell[0], cell[1]))
    } else {
      layout.set(id, [...P.get(id)])
    }
  }

  // 其餘三角頂點：全部吸附（與 W 同等待遇，只是優先級較後）
  const others = ids.filter((id) => !pathSet.has(id))
    .sort((a, b) => {
      const da = Math.hypot(
        (P.get(a)?.[0] ?? 0) - (dst.get(a)?.[0] ?? 0),
        (P.get(a)?.[1] ?? 0) - (dst.get(a)?.[1] ?? 0),
      )
      const db = Math.hypot(
        (P.get(b)?.[0] ?? 0) - (dst.get(b)?.[0] ?? 0),
        (P.get(b)?.[1] ?? 0) - (dst.get(b)?.[1] ?? 0),
      )
      return da - db
    })
  for (const id of others) {
    const prefer = dst.get(id) ?? P.get(id)
    const cell = placeSafe(layout, triIdx, id, prefer, used, cols, rows, { maxRad: 32 })
      ?? placeSafe(layout, triIdx, id, P.get(id), used, cols, rows, { maxRad: 40 })
    if (cell) {
      layout.set(id, cell)
      used.add(ckey(cell[0], cell[1]))
    } else {
      layout.set(id, [...(P.get(id) ?? prefer)])
    }
  }

  for (let round = 0; round < 40; round++) {
    const byCell = new Map()
    for (const [id, p] of layout) {
      const c = Math.round(p[0]), r = Math.round(p[1])
      const k = ckey(c, r)
      if (!byCell.has(k)) byCell.set(k, [])
      byCell.get(k).push(id)
    }
    let moved = false
    for (const cellIds of byCell.values()) {
      if (cellIds.length < 2) continue
      const victims = cellIds.filter((id) => !pathSet.has(id))
      const moveList = victims.length ? victims : cellIds.filter((id) => !isGreenId(id)).slice(1)
      for (const id of moveList) {
        if (isGreenId(id)) continue
        const prefer = layout.get(id)
        const occ = new Set()
        for (const [oid, q] of layout) {
          if (oid === id) continue
          occ.add(ckey(Math.round(q[0]), Math.round(q[1])))
        }
        const cell = placeSafe(layout, triIdx, id, prefer, occ, cols, rows, { maxRad: 30 })
        if (cell && (cell[0] !== prefer[0] || cell[1] !== prefer[1])) {
          layout.set(id, cell)
          moved = true
        }
      }
    }
    if (!moved) break
  }

  for (const [id, p] of [...layout]) {
    const c = Math.round(p[0]), r = Math.round(p[1])
    if (c === p[0] && r === p[1]) continue
    if (!anyFlip(triIdx, layout, id, c, r)) {
      const clash = [...layout].some(([oid, q]) =>
        oid !== id && Math.round(q[0]) === c && Math.round(q[1]) === r)
      if (!clash) layout.set(id, [c, r])
    }
  }

  // 綠點 stats 用最終格
  const greensSer = greens.map((g) => {
    const p = layout.get(g.id)
    return {
      id: g.id,
      c: p ? Math.round(p[0]) : g.c,
      r: p ? Math.round(p[1]) : g.r,
      a: g.a,
      b: g.b,
    }
  })

  const flipsFinal = countFlips(tris, layout)
  const four = isFourLineSquare(pick.cutIds, layout, segs)
  const prog = squareProgress(pick.cutIds, layout, box, greens)
  let movedN = 0
  for (const [id, p] of layout) {
    const s = geo0.get(id) ?? geo.get(id)
    if (!s || Math.abs(s[0] - p[0]) > 1e-6 || Math.abs(s[1] - p[1]) > 1e-6) movedN++
  }
  const triSer = tris.map((t) => [t.a, t.b, t.c])
  const boxMeta = {
    minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, side: box.side,
  }
  const topoOk = flipsFinal === 0
  await shapeProgress(opts,
    topoOk
      ? `Delaunay 完成：拓撲完好${four ? '·成方' : `·貼方${Math.round(prog * 100)}%`}·綠×${greensSer.length} · ${tris.length} 面`
      : `Delaunay 完成：拓撲異常 翻三角=${flipsFinal}`)

  return {
    cellAfter: layout,
    greens: greensSer,
    tris: triSer,
    stats: {
      hvBefore: countHV(geo0, segs0), hvAfter: countHV(layout, segs),
      hvdBefore: countHVD(geo0, segs0), hvdAfter: countHVD(layout, segs),
      segs: segs.length, verts: layout.size, moved: movedN,
      passes: 1, reverted: false, skipped: false,
      shape: pick.shape, shapeZh: '方',
      route: pick.routeName, routeId: pick.routeId,
      note: topoOk
        ? (four
          ? `→方·Delaunay·拓撲完好·綠×${greensSer.length}`
          : `→Delaunay·拓撲完好·貼方${Math.round(prog * 100)}%·綠×${greensSer.length}`)
        : `→Delaunay·翻三角${flipsFinal}`,
      via: 'delaunay·topo·green',
      fourLine: four,
      squareProgress: +prog.toFixed(3),
      tris: tris.length,
      triEdges: edgeCount,
      flips: flipsFinal,
      flipsCont,
      topoOk,
      affine: { side: box.side },
      box: boxMeta,
      greens: greensSer,
      greenCount: greensSer.length,
      triList: triSer,
      rulesOk: topoOk,
      quality: {
        fourLine: four,
        square: four,
        onEdge: +prog.toFixed(2),
        sides: four ? 4 : Math.round(prog * 4),
      },
    },
  }
}
