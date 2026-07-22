// Delaunay→貼形（簡單版）：
//   1) 三角化
//   2) 先定正方四邊；缺角才補綠
//   3) 整網用同一個徑向變形一次套上（所有點一起平均動）
//   4) 二分找最大合法 t（翻三角=0 且網邊不交叉）；壞了就退回
import { Delaunay } from 'd3-delaunay'
import { buildHcGraph, countHV, countHVD } from '../hillClimb.js'
import { emptyResult } from './_shared.js'
import { getShapePreset, SHAPE_SQUARE } from './shapePresets.js'

const MIN_CUTS = 6
const EPS = 1e-9
const CORNER_COVER = 0.75
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

function segIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function clonePos(P) {
  return new Map([...P].map(([id, p]) => [id, [...p]]))
}

function lerpPos(src, dst, t) {
  const out = new Map()
  for (const [id, s] of src) {
    const g = dst.get(id) ?? s
    out.set(id, [s[0] + (g[0] - s[0]) * t, s[1] + (g[1] - s[1]) * t])
  }
  return out
}

function makeTri(a, b, c, pos) {
  const A = pos.get(a), B = pos.get(b), C = pos.get(c)
  const sign = Math.sign(orient(A[0], A[1], B[0], B[1], C[0], C[1]))
  if (!sign) return null
  return { a, b, c, sign }
}

function indexMesh(tris) {
  const adj = new Map()
  const triIdx = new Map()
  const edgeSet = new Set()
  for (const t of tris) {
    for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
      edgeSet.add(u < v ? `${u}|${v}` : `${v}|${u}`)
    }
    for (const id of [t.a, t.b, t.c]) {
      if (!triIdx.has(id)) triIdx.set(id, [])
      triIdx.get(id).push(t)
      if (!adj.has(id)) adj.set(id, new Set())
    }
  }
  for (const e of edgeSet) {
    const [u, v] = e.split('|')
    adj.get(u).add(v)
    adj.get(v).add(u)
  }
  const edges = [...edgeSet].map((e) => e.split('|'))
  return { adj, triIdx, edges, edgeCount: edges.length }
}

function buildDelaunay(ids, pos) {
  const pts = ids.map((id, i) => {
    const p = pos.get(id)
    return [p[0] + ((i * 17) % 7) * 1e-4, p[1] + ((i * 31) % 7) * 1e-4]
  })
  const del = Delaunay.from(pts)
  const tris = []
  for (let i = 0; i < del.triangles.length; i += 3) {
    const t = makeTri(ids[del.triangles[i]], ids[del.triangles[i + 1]], ids[del.triangles[i + 2]], pos)
    if (t) tris.push(t)
  }
  return { tris, ...indexMesh(tris) }
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

function countMeshCross(edges, P) {
  let n = 0
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i]
    const A = P.get(a), B = P.get(b)
    if (!A || !B) continue
    for (let j = i + 1; j < edges.length; j++) {
      const [c, d] = edges[j]
      if (a === c || a === d || b === c || b === d) continue
      const C = P.get(c), D = P.get(d)
      if (!C || !D) continue
      if (segIntersect(A, B, C, D)) n++
    }
  }
  return n
}

function meshOk(tris, edges, P) {
  return countFlips(tris, P) === 0 && countMeshCross(edges, P) === 0
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
  const need = Math.max(2, Math.floor(seen.size / 4))
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
  const q = Math.floor(n / 4)
  const rem = n % 4
  const sizes = [0, 1, 2, 3].map((i) => q + (i < rem ? 1 : 0))
  if (sizes.some((s) => s < 1)) return null
  const { minX, minY, maxX, maxY } = box
  const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]
  const cornerIdx = [0]
  let acc = 0
  for (let i = 0; i < 3; i++) {
    acc += sizes[i]
    cornerIdx.push(acc)
  }
  const targets = new Map()
  for (let sideI = 0; sideI < 4; sideI++) {
    const i0 = cornerIdx[sideI]
    const i1 = sideI === 3 ? n : cornerIdx[sideI + 1]
    const A = corners[sideI], B = corners[(sideI + 1) % 4]
    for (let j = 0; j < i1 - i0; j++) {
      const u = j / sizes[sideI]
      targets.set(ring[i0 + j], [
        A[0] + (B[0] - A[0]) * u,
        A[1] + (B[1] - A[1]) * u,
      ])
    }
  }
  return { targets, ring, corners }
}

function missingCorners(targets, box) {
  const corners = [
    [box.minX, box.minY], [box.maxX, box.minY],
    [box.maxX, box.maxY], [box.minX, box.maxY],
  ]
  return corners.filter((c) =>
    ![...targets.values()].some((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= CORNER_COVER))
    .map((cell, index) => ({ index, cell }))
}

function convexHull(pts) {
  const p = pts.map((q) => [...q]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length <= 2) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = [], upper = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
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

/** 整網同一個徑向變形：W 凸包 → 正方，其餘點同一套比例 */
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
  const dstPoly = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const out = new Map()
  for (const [id, p] of srcPos) {
    if (wTargets.has(id)) {
      out.set(id, [...wTargets.get(id)])
      continue
    }
    const ang = Math.atan2(p[1] - cy, p[0] - cx)
    const r = Math.hypot(p[0] - cx, p[1] - cy)
    if (r < 1e-9) { out.set(id, [cx, cy]); continue }
    let rSrc = rayPolyHitDist(cx, cy, ang, srcPoly)
    let rDst = rayPolyHitDist(cx, cy, ang, dstPoly)
    if (!Number.isFinite(rSrc) || rSrc < 1e-6) rSrc = Math.max(1e-3, r)
    if (!Number.isFinite(rDst) || rDst < 1e-6) rDst = Math.min(maxX - minX, maxY - minY) / 2
    const rNew = r <= rSrc + 1e-9 ? r * (rDst / rSrc) : rDst + (r - rSrc)
    out.set(id, [cx + Math.cos(ang) * rNew, cy + Math.sin(ang) * rNew])
  }
  return out
}

function distPointSeg(p, A, B) {
  const dx = B[0] - A[0], dy = B[1] - A[1]
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(p[0] - A[0], p[1] - A[1])
  let t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (A[0] + t * dx), p[1] - (A[1] + t * dy))
}

function hasMeshEdge(adj, a, b) {
  return adj.get(a)?.has(b)
}

function splitMeshEdge(tris, pos, a, b, g) {
  const next = []
  for (const t of tris) {
    const verts = [t.a, t.b, t.c]
    if (!verts.includes(a) || !verts.includes(b)) { next.push(t); continue }
    const c = verts.find((v) => v !== a && v !== b)
    const t1 = makeTri(a, g, c, pos)
    const t2 = makeTri(g, b, c, pos)
    if (t1) next.push(t1)
    if (t2) next.push(t2)
  }
  return next
}

function pointInTri(px, py, A, B, C) {
  const o1 = orient(A[0], A[1], B[0], B[1], px, py)
  const o2 = orient(B[0], B[1], C[0], C[1], px, py)
  const o3 = orient(C[0], C[1], A[0], A[1], px, py)
  return !((o1 < -EPS || o2 < -EPS || o3 < -EPS) && (o1 > EPS || o2 > EPS || o3 > EPS))
}

function splitMeshFace(tris, pos, tri, g) {
  const next = []
  for (const t of tris) {
    if (t !== tri) { next.push(t); continue }
    for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
      const nt = makeTri(g, u, v, pos)
      if (nt) next.push(nt)
    }
  }
  return next
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
  const h1 = Math.max(1, Math.floor(hops / 2))
  segs[si] = { a, b: gid, routes, hops: h1, interior: (interior ?? []).slice(0, mid), edge }
  segs.push({ a: gid, b, routes, hops: Math.max(1, hops - h1), interior: (interior ?? []).slice(mid), edge })
  return rebuildInc(segs)
}

/** 只在缺角插綠；插完必須 meshOk，否則取消 */
function insertMissingGreens({ ring, missing, pos, segs, tris, adj }) {
  const greens = []
  const greenTargets = new Map()
  let mesh = tris
  let meshAdj = adj
  let gi = 0
  const used = new Set()
  for (const { cell: corner } of missing) {
    let bestI = -1, bestD = Infinity
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]
      const ek = a < b ? `${a}|${b}` : `${b}|${a}`
      if (used.has(ek)) continue
      const A = pos.get(a), B = pos.get(b)
      if (!A || !B) continue
      const d = distPointSeg(corner, A, B)
      if (d < bestD) { bestD = d; bestI = i }
    }
    if (bestI < 0) continue
    const a = ring[bestI], b = ring[(bestI + 1) % ring.length]
    used.add(a < b ? `${a}|${b}` : `${b}|${a}`)
    const si = segs.findIndex((s) => (s.a === a && s.b === b) || (s.a === b && s.b === a))
    if (si < 0) continue
    const A = pos.get(a), B = pos.get(b)
    const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]
    const gid = `shape-g${gi++}`
    pos.set(gid, mid)
    if (hasMeshEdge(meshAdj, a, b)) {
      mesh = splitMeshEdge(mesh, pos, a, b, gid)
    } else {
      let host = mesh.find((t) => {
        const TA = pos.get(t.a), TB = pos.get(t.b), TC = pos.get(t.c)
        return pointInTri(mid[0], mid[1], TA, TB, TC)
      })
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
  return { greens, greenTargets, tris: mesh, ...indexMesh(mesh) }
}

function isFourLineSquare(cutIds, posMap, segs = null) {
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ring.push(id)
  }
  if (ring.length < 4) return false
  const all = [...ring.map((id) => posMap.get(id)).filter(Boolean)]
  for (const [id, p] of posMap) if (isGreenId(id)) all.push(p)
  const pts = ring.map((id) => posMap.get(id)).filter(Boolean)
  if (pts.length < ring.length) return false
  const minX = Math.min(...all.map((p) => p[0])), maxX = Math.max(...all.map((p) => p[0]))
  const minY = Math.min(...all.map((p) => p[1])), maxY = Math.max(...all.map((p) => p[1]))
  if (maxX - minX !== maxY - minY || maxX === minX) return false
  const onBound = (p) => p && (p[0] === minX || p[0] === maxX || p[1] === minY || p[1] === maxY)
  if (pts.some((p) => !onBound(p))) return false
  for (const [id, p] of posMap) if (isGreenId(id) && !onBound(p)) return false
  if (!segs) {
    for (let i = 0; i < ring.length; i++) {
      const A = posMap.get(ring[i]), B = posMap.get(ring[(i + 1) % ring.length])
      if (A[0] !== B[0] && A[1] !== B[1]) return false
    }
    return true
  }
  const adj = new Map()
  for (const s of segs) {
    if (!adj.has(s.a)) adj.set(s.a, [])
    if (!adj.has(s.b)) adj.set(s.b, [])
    adj.get(s.a).push(s.b)
    adj.get(s.b).push(s.a)
  }
  const hopHV = (u, v) => {
    const A = posMap.get(u), B = posMap.get(v)
    return A && B && (A[0] === B[0] || A[1] === B[1])
  }
  const connectedHV = (a, b) => {
    if (hopHV(a, b)) return true
    const q = [a], prev = new Map([[a, null]])
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

/** 整網一次吸附：同一套 round，撞格外推；最後 meshOk 才收 */
function snapAll(P, tris, edges, cols, rows) {
  const layout = new Map()
  const used = new Set()
  const ids = [...P.keys()].sort((a, b) => String(a).localeCompare(String(b)))
  for (const id of ids) {
    const prefer = P.get(id)
    let placed = null
    for (let rad = 0; rad <= 24 && !placed; rad++) {
      for (let dc = -rad; dc <= rad && !placed; dc++) {
        for (let dr = -rad; dr <= rad; dr++) {
          if (rad > 0 && Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
          const c = Math.max(0, Math.min(cols - 1, Math.round(prefer[0]) + dc))
          const r = Math.max(0, Math.min(rows - 1, Math.round(prefer[1]) + dr))
          if (used.has(ckey(c, r))) continue
          const trial = clonePos(layout)
          for (const [oid, p] of P) if (!trial.has(oid)) trial.set(oid, [...p])
          trial.set(id, [c, r])
          // 只驗已放置＋目前點；未放置仍用連續
          if (!meshOk(tris, edges, trial)) continue
          placed = [c, r]
          break
        }
      }
    }
    if (placed) {
      layout.set(id, placed)
      used.add(ckey(placed[0], placed[1]))
    } else {
      layout.set(id, [...prefer])
    }
  }
  if (meshOk(tris, edges, layout)) return layout
  return null
}

async function shapeProgress(opts, msg) {
  if (typeof opts.onProgress === 'function') opts.onProgress(msg)
  if (typeof opts.tick === 'function') await opts.tick()
  else await new Promise((r) => setTimeout(r, 0))
}

export async function buildShapeDelaunay(skeleton, cells, cols, rows, opts = {}) {
  const { pos: pos0, segs: segs0 } = buildHcGraph(skeleton, cells)
  if (!pos0.size || !segs0.length) return emptyResult(pos0, segs0)

  const pick = pickCut(skeleton, pos0, opts.cityId ?? null)
  if (!pick) {
    return {
      cellAfter: pos0, tris: [], greens: [],
      stats: {
        hvBefore: countHV(pos0, segs0), hvAfter: countHV(pos0, segs0),
        hvdBefore: countHVD(pos0, segs0), hvdAfter: countHVD(pos0, segs0),
        segs: segs0.length, verts: pos0.size, moved: 0, skipped: true,
        note: '不需計算', via: 'skip',
      },
    }
  }

  const pos = clonePos(pos0)
  const segs = segs0.map((s) => ({
    a: s.a, b: s.b, routes: s.routes, hops: s.hops,
    interior: [...(s.interior ?? [])], edge: s.edge,
  }))
  let ids = [...pos.keys()]
  await shapeProgress(opts, `Delaunay：三角化 ${ids.length} 站…`)

  let { tris, adj, edges, edgeCount } = buildDelaunay(ids, pos)
  if (!tris.length || !meshOk(tris, edges, pos)) {
    await shapeProgress(opts, 'Delaunay：三角化失敗／輸入網無效')
    return {
      cellAfter: pos0, tris: [], greens: [],
      stats: { note: '三角化失敗', via: 'fail', route: pick.routeName, flipped: true },
    }
  }

  // ① 四邊
  const box = wSquareBox(pos, pick.cutIds, cols, rows)
  const ft = box ? fourSideTargets(pick.cutIds, box) : null
  if (!box || !ft) {
    return {
      cellAfter: pos0, tris: tris.map((t) => [t.a, t.b, t.c]), greens: [],
      stats: { note: '無法定四邊', via: 'fail', route: pick.routeName },
    }
  }
  await shapeProgress(opts, `Delaunay：四邊已定（邊=${box.side}）…`)

  // ② 缺角才綠
  let greens = []
  let greenTargets = new Map()
  const missing = missingCorners(ft.targets, box)
  if (missing.length) {
    await shapeProgress(opts, `Delaunay：缺角 ${missing.length} → 補綠…`)
    const snap = clonePos(pos)
    const snapTris = tris.map((t) => ({ ...t }))
    const ins = insertMissingGreens({ ring: ft.ring, missing, pos, segs, tris, adj })
    if (meshOk(ins.tris, ins.edges, pos)) {
      tris = ins.tris
      adj = ins.adj
      edges = ins.edges
      edgeCount = ins.edgeCount
      greens = ins.greens
      greenTargets = ins.greenTargets
      ids = [...pos.keys()]
    } else {
      await shapeProgress(opts, 'Delaunay：插綠破網 → 取消')
      for (const [id, p] of snap) pos.set(id, [...p])
      for (const id of [...pos.keys()]) if (isGreenId(id)) pos.delete(id)
      tris = snapTris
      ;({ adj, edges, edgeCount } = indexMesh(tris))
    }
  }

  const wTargets = new Map(ft.targets)
  for (const [id, t] of greenTargets) wTargets.set(id, t)
  const geo = clonePos(pos)

  // ③ 整網同一個徑向目標，一次插值（所有點一起動）
  await shapeProgress(opts, `Delaunay：整網一次徑向變形（${ids.length} 點）…`)
  const dst = radialTargets(geo, pick.cutIds, box, wTargets)
    ?? new Map([...geo].map(([id, p]) => [id, wTargets.get(id) ? [...wTargets.get(id)] : [...p]]))
  for (const [id, t] of wTargets) dst.set(id, [...t])

  // 二分最大合法 t
  let lo = 0, hi = 1, bestT = 0
  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2
    if (meshOk(tris, edges, lerpPos(geo, dst, mid))) {
      bestT = mid
      lo = mid
    } else {
      hi = mid
    }
  }
  let P = lerpPos(geo, dst, bestT)
  if (!meshOk(tris, edges, P)) P = clonePos(geo)

  await shapeProgress(opts, `Delaunay：合法 t=${bestT.toFixed(3)} → 整數吸附…`)

  // ④ 整網吸附（失敗則保留連續域）
  let layout = snapAll(P, tris, edges, cols, rows)
  if (!layout || !meshOk(tris, edges, layout)) {
    await shapeProgress(opts, 'Delaunay：吸附破網 → 用連續域')
    layout = clonePos(P)
  }
  if (!meshOk(tris, edges, layout)) {
    await shapeProgress(opts, 'Delaunay：退回輸入')
    layout = clonePos(geo)
  }

  const flips = countFlips(tris, layout)
  const crosses = countMeshCross(edges, layout)
  const topoOk = flips === 0 && crosses === 0
  const four = isFourLineSquare(pick.cutIds, layout, segs)
  const greensSer = greens.map((g) => {
    const p = layout.get(g.id)
    return { id: g.id, c: Math.round(p?.[0] ?? g.c), r: Math.round(p?.[1] ?? g.r), a: g.a, b: g.b }
  })
  let moved = 0
  for (const [id, p] of layout) {
    const s = pos0.get(id) ?? geo.get(id)
    if (!s || s[0] !== p[0] || s[1] !== p[1]) moved++
  }
  const triSer = tris.map((t) => [t.a, t.b, t.c])
  await shapeProgress(opts,
    topoOk
      ? `Delaunay 完成：網✓ · t=${bestT.toFixed(2)} · ${four ? '成方' : '未成方'} · 綠×${greensSer.length}`
      : `Delaunay 完成：網✗ 翻=${flips} 交叉=${crosses}`)

  return {
    cellAfter: layout,
    greens: greensSer,
    tris: triSer,
    stats: {
      hvBefore: countHV(pos0, segs0), hvAfter: countHV(layout, segs),
      hvdBefore: countHVD(pos0, segs0), hvdAfter: countHVD(layout, segs),
      segs: segs.length, verts: layout.size, moved,
      passes: 1, skipped: false,
      shape: pick.shape, shapeZh: '方',
      route: pick.routeName, routeId: pick.routeId,
      note: topoOk
        ? (four ? `→方·整網一次·綠×${greensSer.length}` : `→整網一次 t=${bestT.toFixed(2)}`)
        : `→網✗`,
      via: 'delaunay·uniform',
      fourLine: four,
      morphT: +bestT.toFixed(4),
      flips, meshCross: crosses, topoOk,
      tris: tris.length, triEdges: edgeCount,
      greens: greensSer, greenCount: greensSer.length,
      triList: triSer,
      box: { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, side: box.side },
      affine: { side: box.side },
      rulesOk: topoOk,
      quality: { fourLine: four, square: four },
    },
  }
}
