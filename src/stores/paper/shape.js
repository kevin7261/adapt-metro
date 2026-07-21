// Shape-Guided（Batik et al. 2022）——依論文／開源 MetroShapes::Smooth 的整數格改編。
// 硬目標：規定路段嵌方形（四邊 H/V）＋拓撲鐵律（不當交叉不增、點周圍邊環繞序不變）。
// 掛在「⑨Shape-Guided／layout-shape」（格網→貼形）；要不要算看 shapePresets（未規定＝不跑）。
// §4 擺方 → §5 LS（交叉／環繞序守門）→ §6 拓撲安全變形＋釘方（禁增交叉軟交付）
import {
  buildHcGraph, countHV, countHVD, makeMover,
} from '../hillClimb.js'
import {
  emptyResult, sectorOf, SECTOR_VEC, TWO_PI,
} from './_shared.js'
import {
  SHAPE_SQUARE, getShapePreset,
} from './shapePresets.js'

const SHAPE_ZH = { [SHAPE_SQUARE]: '方', 0: '方', square: '方' }
const MIN_CUTS = 6
const QUALITY_AR = 1.001
const ALREADY_AR = 1.001
const QUALITY_ON_EDGE = 0.4
const QUALITY_SIDES = 4
const WC = 4, WL = 1, WA = 2, WP = Math.sqrt(0.025), WO = 8
const SMOOTH_ROUNDS = 120
const MIXED_ROUNDS = 60
const ADJUST_ROUNDS = 40
const WC_PATH = 20
const ckey = (c, r) => `${c},${r}`

/* ---------- 內建形狀：只方形（shape=0） ---------- */
function unitSquare() {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]
}
const SHAPE_UNIT = unitSquare()

function dedupeAdj(ids) {
  return ids.filter((id, i) => i === 0 || id !== ids[i - 1])
}

/** 從站序取首個閉合環段（首站再次出現處切斷） */
function firstCycle(ids) {
  const seen = new Map()
  for (let i = 0; i < ids.length; i++) {
    if (seen.has(ids[i])) return ids.slice(seen.get(ids[i]), i + 1)
    seen.set(ids[i], i)
  }
  return null
}

/* ---------- 幾何 ---------- */
function bbox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (y < minY) minY = y
    if (x > maxX) maxX = x; if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
    w: Math.max(1e-9, maxX - minX), h: Math.max(1e-9, maxY - minY) }
}
function alignShape(unitPts, pathPts) {
  // D5：只平移＋等比縮放，不旋轉；邊長取長寬平均（比 min 溫和，比 max 更方）
  const bP = bbox(pathPts), bU = bbox(unitPts)
  const side = (bP.w + bP.h) / 2
  const scale = side / bU.w
  return unitPts.map(([x, y]) => [
    bP.cx + (x - bU.cx) * scale,
    bP.cy + (y - bU.cy) * scale,
  ])
}
function closestOnPoly(p, poly) {
  let best = poly[0], bd = Infinity
  for (let i = 0; i + 1 < poly.length; i++) {
    const A = poly[i], B = poly[i + 1]
    const ex = B[0] - A[0], ey = B[1] - A[1]
    const l2 = ex * ex + ey * ey
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - A[0]) * ex + (p[1] - A[1]) * ey) / l2))
    const q = [A[0] + t * ex, A[1] + t * ey]
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2
    if (d < bd) { bd = d; best = q }
  }
  return best
}
function segIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  return false
}
function polyPerimeter(poly) {
  let L = 0
  for (let i = 0; i + 1 < poly.length; i++) {
    L += Math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1])
  }
  return L || 1
}
function pointAtArc(poly, s) {
  const total = polyPerimeter(poly)
  let t = ((s % total) + total) % total
  for (let i = 0; i + 1 < poly.length; i++) {
    const A = poly[i], B = poly[i + 1]
    const len = Math.hypot(B[0] - A[0], B[1] - A[1])
    if (t <= len || i + 2 >= poly.length) {
      const u = len < 1e-12 ? 0 : t / len
      return [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u]
    }
    t -= len
  }
  return poly[poly.length - 1]
}
// §6 Octi 織入替代：把比對路徑 W 依弧長均勻鋪到凍結方形上（相位掃一圈取最小位移）。
// 論文把 C_shape 沿 P 路由；整數格契約下以此保證「嵌形主線真的成方」。
function mapPathOntoShape(cutIds, posMap, shapePoly) {
  const n = cutIds.length
  if (n < 2) return new Map()
  const total = polyPerimeter(shapePoly)
  let bestTau = 0, bestCost = Infinity
  const steps = 48
  for (let k = 0; k < steps; k++) {
    const tau = (k / steps) * total
    let cost = 0
    for (let i = 0; i < n; i++) {
      const q = pointAtArc(shapePoly, tau + (i / n) * total)
      const p = posMap.get(cutIds[i])
      cost += Math.hypot(q[0] - p[0], q[1] - p[1])
    }
    if (cost < bestCost) { bestCost = cost; bestTau = tau }
  }
  const out = new Map()
  for (let i = 0; i < n; i++) {
    out.set(cutIds[i], pointAtArc(shapePoly, bestTau + (i / n) * total))
  }
  return out
}
function squareQuality(cutIds, posMap) {
  const pts = cutIds.map((id) => posMap.get(id)).filter(Boolean)
  if (pts.length < MIN_CUTS) return { ok: false, ar: Infinity, onEdge: 0, sides: 0 }
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]))
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]))
  const w = Math.max(1e-9, maxX - minX), h = Math.max(1e-9, maxY - minY)
  // 整數格：正方＝邊長相等
  const ar = (Math.round(w) === Math.round(h)) ? 1 : Math.max(w / h, h / w)
  const eps = Math.max(0.55, 0.08 * Math.min(w, h))
  let on = 0
  const hit = { L: false, R: false, B: false, T: false }
  for (const p of pts) {
    const L = Math.abs(p[0] - minX) <= eps, R = Math.abs(p[0] - maxX) <= eps
    const B = Math.abs(p[1] - minY) <= eps, T = Math.abs(p[1] - maxY) <= eps
    if ((L || R || B || T)
      && p[0] >= minX - eps && p[0] <= maxX + eps
      && p[1] >= minY - eps && p[1] <= maxY + eps) {
      on++
      if (L) hit.L = true
      if (R) hit.R = true
      if (B) hit.B = true
      if (T) hit.T = true
    }
  }
  const sides = (hit.L ? 1 : 0) + (hit.R ? 1 : 0) + (hit.B ? 1 : 0) + (hit.T ? 1 : 0)
  const onEdge = on / pts.length
  const ok = ar <= QUALITY_AR && onEdge >= QUALITY_ON_EDGE && sides >= QUALITY_SIDES
  const already = ar <= ALREADY_AR && onEdge >= QUALITY_ON_EDGE && sides >= QUALITY_SIDES
  return { ok, already, ar, onEdge, sides, w, h }
}

const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
const onCellSeg = (p, a, b) =>
  orient(a, b, p) === 0
  && Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0])
  && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])

/** 不共端點的真交叉數（不含共線重疊——吸附後共線觸碰易誤報；點壓線另由 hasPointOverlap 抓） */
function improperCrossCount(posMap, segs) {
  let n = 0
  for (let i = 0; i < segs.length; i++) {
    const si = segs[i]
    const A = posMap.get(si.a), B = posMap.get(si.b)
    if (!A || !B) continue
    for (let j = i + 1; j < segs.length; j++) {
      const sj = segs[j]
      if (si.a === sj.a || si.a === sj.b || si.b === sj.a || si.b === sj.b) continue
      const C = posMap.get(sj.a), D = posMap.get(sj.b)
      if (!C || !D) continue
      if (segIntersect(A, B, C, D)) n++
    }
  }
  return n
}

function hasCellClash(posMap) {
  const seen = new Set()
  for (const [, p] of posMap) {
    const k = ckey(p[0], p[1])
    if (seen.has(k)) return true
    seen.add(k)
  }
  return false
}

/** 與爬山④相同：入射邊依 atan2 的循環序（允許旋轉對齊） */
function cyclicEqual(a, b) {
  if (a.length !== b.length) return false
  if (!a.length) return true
  const start = b.indexOf(a[0])
  if (start < 0) return false
  for (let i = 1; i < a.length; i++) if (a[i] !== b[(start + i) % b.length]) return false
  return true
}

function edgeOrderKey(u, at, segs, inc) {
  const pu = at(u)
  if (!pu) return []
  const items = []
  for (const si of inc.get(u) ?? []) {
    const s = segs[si]
    const oid = s.a === u ? s.b : s.a
    const o = at(oid)
    if (!o || (o[0] === pu[0] && o[1] === pu[1])) continue
    items.push([Math.atan2(o[1] - pu[1], o[0] - pu[0]), si])
  }
  items.sort((p, q) => p[0] - q[0] || p[1] - q[1])
  return items.map((it) => it[1])
}

/** 點周圍連線的 360° 環繞序不可變（度≥3）——比對遠端鄰居 id（略過綠色控制點） */
function edgeOrdersMatch(posA, posB, segs, inc, isGreen = () => false) {
  const farNbr = (u, si, at) => {
    const s0 = segs[si]
    let prev = u
    let cur = s0.a === u ? s0.b : s0.a
    let guard = 0
    while (isGreen(cur) && guard++ < 32) {
      const nxt = (inc.get(cur) ?? [])
        .map((sj) => {
          const s = segs[sj]
          return s.a === cur ? s.b : s.a
        })
        .filter((id) => id !== prev)
      if (!nxt.length) break
      prev = cur
      cur = nxt[0]
    }
    return cur
  }
  const orderIds = (at, posMap) => {
    const out = new Map()
    for (const [u, list] of inc) {
      if ((list?.length ?? 0) < 3) continue
      if (!posMap.has(u)) continue
      const pu = at(u)
      if (!pu) continue
      const items = []
      for (const si of list) {
        const oid = farNbr(u, si, at)
        const o = at(oid)
        if (!o || (o[0] === pu[0] && o[1] === pu[1])) continue
        items.push([Math.atan2(o[1] - pu[1], o[0] - pu[0]), oid])
      }
      items.sort((p, q) => p[0] - q[0] || String(p[1]).localeCompare(String(q[1])))
      out.set(u, items.map((it) => it[1]))
    }
    return out
  }
  const atA = (id) => posA.get(id)
  const atB = (id) => posB.get(id)
  const oa = orderIds(atA, posA)
  const ob = orderIds(atB, posB)
  for (const [u, seqA] of oa) {
    const seqB = ob.get(u)
    if (!seqB || !cyclicEqual(seqA, seqB)) return false
  }
  return true
}

/** 拓撲鐵律：交叉不增、無撞格、環繞序＝輸入（可略過綠控） */
function topoIronOk(layout, geo, segs, inc, cross0, isGreen = () => false) {
  if (hasCellClash(layout)) return false
  if (improperCrossCount(layout, segs) > cross0) return false
  if (!edgeOrdersMatch(geo, layout, segs, inc, isGreen)) return false
  return true
}

const isShapeGreenId = (id) => String(id).startsWith('shape-g')

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

function cloneSegs(segs) {
  return segs.map((s) => ({
    a: s.a, b: s.b, routes: s.routes, hops: s.hops,
    interior: [...(s.interior ?? [])], edge: s.edge,
  }))
}

/** 把 cut-to-cut 段 a—b 在中間插入綠色控制點 gid */
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

function occupiedKeys(posMap) {
  const s = new Set()
  for (const [, p] of posMap) s.add(ckey(p[0], p[1]))
  return s
}

function resolveCellClashes(layout, frozen, cols, rows) {
  for (let round = 0; round < 40; round++) {
    const byCell = new Map()
    let clash = false
    for (const [id, p] of layout) {
      const k = ckey(p[0], p[1])
      if (!byCell.has(k)) byCell.set(k, [])
      byCell.get(k).push(id)
    }
    for (const ids of byCell.values()) {
      if (ids.length < 2) continue
      clash = true
      const movers = ids.filter((id) => !frozen.has(id))
      const victims = movers.length ? movers : ids.slice(1)
      for (const id of victims) {
        const p = layout.get(id)
        let found = null
        for (let rad = 1; rad <= 10 && !found; rad++) {
          for (let dc = -rad; dc <= rad && !found; dc++) {
            for (let dr = -rad; dr <= rad && !found; dr++) {
              if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
              const c = Math.max(0, Math.min(cols - 1, p[0] + dc))
              const r = Math.max(0, Math.min(rows - 1, p[1] + dr))
              if (occupiedKeys(layout).has(ckey(c, r))) continue
              found = [c, r]
            }
          }
        }
        if (found) layout.set(id, found)
      }
    }
    if (!clash) return
  }
}

function findCrossingPair(posMap, segs) {
  for (let i = 0; i < segs.length; i++) {
    const si = segs[i]
    const A = posMap.get(si.a), B = posMap.get(si.b)
    if (!A || !B) continue
    for (let j = i + 1; j < segs.length; j++) {
      const sj = segs[j]
      if (si.a === sj.a || si.a === sj.b || si.b === sj.a || si.b === sj.b) continue
      const C = posMap.get(sj.a), D = posMap.get(sj.b)
      if (!C || !D) continue
      if (segIntersect(A, B, C, D)) return { i, j }
    }
  }
  return null
}

/** 列出所有不當交叉對（綠控要掃完全部，不能卡在第一對修不了就停） */
function findAllCrossingPairs(posMap, segs, limit = 400) {
  const out = []
  for (let i = 0; i < segs.length && out.length < limit; i++) {
    const si = segs[i]
    const A = posMap.get(si.a), B = posMap.get(si.b)
    if (!A || !B) continue
    for (let j = i + 1; j < segs.length && out.length < limit; j++) {
      const sj = segs[j]
      if (si.a === sj.a || si.a === sj.b || si.b === sj.a || si.b === sj.b) continue
      const C = posMap.get(sj.a), D = posMap.get(sj.b)
      if (!C || !D) continue
      if (segIntersect(A, B, C, D)) out.push({ i, j })
    }
  }
  return out
}

/**
 * 對一組不當交叉：在其中一段插入綠控轉折，嚴格減少交叉並保遠端環繞序。
 * @returns {{ pos, segs, inc, green } | null}
 */
function tryInsertGreenClearCross(pos, segs, geo, pathSet, cross0, cols, rows, seq) {
  const pair = findCrossingPair(pos, segs)
  if (!pair) return null
  const crossBefore = improperCrossCount(pos, segs)
  const bendOrder = [pair.i, pair.j].sort((bi, bj) => {
    const wa = pathSet.has(segs[bi].a) && pathSet.has(segs[bi].b) ? 1 : 0
    const wb = pathSet.has(segs[bj].a) && pathSet.has(segs[bj].b) ? 1 : 0
    return wa - wb // 非 W 段優先彎
  })
  for (const bi of bendOrder) {
    const s = segs[bi]
    const A = pos.get(s.a), B = pos.get(s.b)
    if (!A || !B) continue
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2
    const dx = B[0] - A[0], dy = B[1] - A[1]
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len, ny = dx / len
    const dirs = [
      [nx, ny], [-nx, -ny],
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ]
    for (const [ux, uy] of dirs) {
      for (let d = 1; d <= 14; d++) {
        const c = Math.round(mx + ux * d)
        const r = Math.round(my + uy * d)
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue
        const trialPos = new Map([...pos].map(([id, p]) => [id, [...p]]))
        if (occupiedKeys(trialPos).has(ckey(c, r))) continue
        const trialSegs = cloneSegs(segs)
        const gid = `shape-g${seq}`
        const trialInc = splitSegAt(trialSegs, trialPos, bi, gid, [c, r])
        const crossAfter = improperCrossCount(trialPos, trialSegs)
        if (crossAfter >= crossBefore) continue
        if (hasCellClash(trialPos)) continue
        if (!edgeOrdersMatch(geo, trialPos, trialSegs, trialInc, isShapeGreenId)) continue
        // 最終預算：中途可暫高於 cross0，但不得高於插入前；收斂靠迴圈
        if (crossAfter > Math.max(cross0, crossBefore - 1) && crossAfter >= crossBefore) continue
        return {
          pos: trialPos,
          segs: trialSegs,
          inc: trialInc,
          green: { id: gid, c, r, a: s.a, b: s.b },
        }
      }
    }
  }
  return null
}

/**
 * 把綠控寫進骨架：path 插入、stationClass=green（placeBlacks 會當切點轉折）。
 */
export function applyShapeGreens(skeleton, greens) {
  if (!greens?.length) return skeleton
  const stationClass = new Map(skeleton.stationClass)
  const edges = skeleton.edges.map((e) => ({
    ...e,
    path: e.path.slice(),
    routeColors: e.routeColors ? e.routeColors.slice() : e.routeColors,
    renderColors: e.renderColors ? e.renderColors.slice() : e.renderColors,
  }))
  for (const g of greens) {
    const id = g.id
    stationClass.set(id, 'green')
    let placed = false
    for (const e of edges) {
      if (e.path.includes(id)) { placed = true; break }
      const ia = e.path.indexOf(g.a)
      const ib = e.path.indexOf(g.b)
      if (ia < 0 || ib < 0) continue
      const after = ia < ib ? ia + 1 : ib + 1
      e.path.splice(after, 0, id)
      placed = true
      break
    }
    if (!placed) {
      // 兜底：找不到 a/b 邊時略過（不應發生）
      console.warn('[shape] green not placed', g)
    }
  }
  return { ...skeleton, stationClass, edges }
}

/**
 * 只動非 W：從 base 出發、validMove 移向 targets（W 凍結在 base）。
 * 禁止整網 RBF 硬吸附——那會把密網撕成義大利麵。
 */
function topoSafeNonW(base, targets, segs, inc, cols, rows, pathSet) {
  const pos = new Map([...base].map(([id, p]) => [id, [...p]]))
  const M = makeMover(pos, segs, inc, cols, rows)
  const ids = [...targets.keys()].filter((id) => !pathSet.has(id) && pos.has(id))
  for (let pass = 0; pass < 60; pass++) {
    let moved = 0
    for (const id of ids) {
      const tgt = targets.get(id)
      const cur = pos.get(id)
      if (!tgt || !cur) continue
      const dist0 = Math.hypot(cur[0] - tgt[0], cur[1] - tgt[1])
      if (dist0 < 0.5) continue
      const tc = Math.max(0, Math.min(cols - 1, Math.round(tgt[0])))
      const tr = Math.max(0, Math.min(rows - 1, Math.round(tgt[1])))
      const cands = [[tc, tr]]
      const dx = Math.sign(tc - cur[0]), dy = Math.sign(tr - cur[1])
      if (dx || dy) {
        cands.push([cur[0] + dx, cur[1] + dy])
        if (dx) cands.push([cur[0] + dx, cur[1]])
        if (dy) cands.push([cur[0], cur[1] + dy])
      }
      for (let rad = 1; rad <= 4; rad++) {
        for (let dc = -rad; dc <= rad; dc++) {
          for (let dr = -rad; dr <= rad; dr++) {
            if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
            cands.push([cur[0] + dc, cur[1] + dr])
          }
        }
      }
      let best = null, bd = dist0
      const seen = new Set()
      for (const [c, r] of cands) {
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue
        const key = ckey(c, r)
        if (seen.has(key)) continue
        seen.add(key)
        if (c === cur[0] && r === cur[1]) continue
        if (!M.validMove(id, [c, r])) continue
        const d = Math.hypot(c - tgt[0], r - tgt[1])
        if (d + 1e-9 < bd) { bd = d; best = [c, r] }
      }
      if (best) { M.applyMove(id, best); moved++ }
    }
    if (!moved) break
  }
  return pos
}

/** 綠控候選方向：優先往方外推（避開方形內部義大利麵） */
function greenDirCandidates(A, B, box) {
  const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2
  const dx = B[0] - A[0], dy = B[1] - A[1]
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len, ny = dx / len
  const dirs = [
    [nx, ny], [-nx, -ny],
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ]
  if (!box) return dirs
  const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2
  const ox = mx - cx, oy = my - cy
  // 方外方向排前面
  return [...dirs].sort((a, b) => {
    const sa = a[0] * ox + a[1] * oy
    const sb = b[0] * ox + b[1] * oy
    return sb - sa
  })
}

/**
 * 硬釘 W 成四邊方；其餘只 validMove 跟著 RBF 場（不硬吸）。
 * 剩餘交叉用綠控轉折消掉。必定交付 fourLine。
 */
async function forceSquareWithGreens(
  geo, pick, pathSet, segs, inc, cols, rows, boxes, box0, cross0, opts,
) {
  await shapeProgress(opts, '§6F 強制成方（validMove＋綠控）…')

  // 1) 用 forceFourSideSquare 取夠大的正方（站數均分四邊），不要用過短的 shrink box
  const forced = forceFourSideSquare(geo, pick.cutIds, cols, rows)
  let useBox = forced?.box
    || (boxes.length ? boxes[0] : null)
    || box0
  let L = new Map([...geo].map(([id, p]) => [id, [...p]]))
  if (forced?.layout) {
    for (const [id, p] of forced.layout) L.set(id, p)
  } else if (useBox) {
    const pinned = pinWFourSidesOnBox(L, pick.cutIds, useBox, cols, rows)
    if (pinned) for (const [id, p] of pinned) L.set(id, p)
  }
  if (!isFourLineSquare(pick.cutIds, L) && useBox) {
    const pinned = pinWFourSidesOnBox(L, pick.cutIds, useBox, cols, rows)
    if (pinned) for (const [id, p] of pinned) L.set(id, p)
  }

  // 2) RBF 只當吸引場；非 W 用 validMove 落地（W 已釘死不動）
  if (useBox) {
    const targets = fourSideTargets(pick.cutIds, useBox, false)
    if (targets) {
      const morphed = rbfMorph(geo, pick.cutIds, targets.targets)
      if (morphed) {
        await shapeProgress(opts, '§6F 非 W 拓撲安全跟隨…')
        L = topoSafeNonW(L, morphed, segs, inc, cols, rows, pathSet)
      }
      // W 再釘一次（validMove 不應動到，保險）
      const pinned = pinWFourSidesOnBox(L, pick.cutIds, useBox, cols, rows)
      if (pinned) for (const [id, p] of pinned) L.set(id, p)
    }
    snapCorridorsToSquare(L, pick.cutIds, useBox, segs, inc)
  }
  clearStationsOnEdges(L, segs, pathSet, cols, rows, { allowSlideFrozen: null })
  // 方內非 W 站往外推（減少貫穿方形的弦）
  if (useBox) {
    const cx = (useBox.minX + useBox.maxX) / 2
    const cy = (useBox.minY + useBox.maxY) / 2
    const half = useBox.side / 2
    for (const [id, p] of L) {
      if (pathSet.has(id) || isShapeGreenId(id)) continue
      if (p[0] <= useBox.minX || p[0] >= useBox.maxX
        || p[1] <= useBox.minY || p[1] >= useBox.maxY) continue
      const dx = p[0] - cx, dy = p[1] - cy
      const scale = Math.max(Math.abs(dx), Math.abs(dy)) || 1
      const t = (half + 1.5) / scale
      let c = Math.round(cx + dx * t)
      let r = Math.round(cy + dy * t)
      c = Math.max(0, Math.min(cols - 1, c))
      r = Math.max(0, Math.min(rows - 1, r))
      // 若仍在方內，推到最近邊外一格
      if (c > useBox.minX && c < useBox.maxX && r > useBox.minY && r < useBox.maxY) {
        const toL = p[0] - useBox.minX, toR = useBox.maxX - p[0]
        const toT = p[1] - useBox.minY, toB = useBox.maxY - p[1]
        const m = Math.min(toL, toR, toT, toB)
        if (m === toL) c = useBox.minX - 1
        else if (m === toR) c = useBox.maxX + 1
        else if (m === toT) r = useBox.minY - 1
        else r = useBox.maxY + 1
        c = Math.max(0, Math.min(cols - 1, c))
        r = Math.max(0, Math.min(rows - 1, r))
      }
      L.set(id, [c, r])
    }
  }
  resolveCellClashes(L, pathSet, cols, rows)
  if (useBox) {
    const pinned = pinWFourSidesOnBox(L, pick.cutIds, useBox, cols, rows)
    if (pinned) for (const [id, p] of pinned) L.set(id, p)
  }

  // 3) 輻射邊正交繞行（一次處理，遠快於逐交叉搜尋）
  let workSegs = cloneSegs(segs)
  let workInc = rebuildInc(workSegs)
  const greens = []
  let seq = 0

  const freeCell = (c, r) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return false
    if (occupiedKeys(L).has(ckey(c, r))) return false
    return true
  }
  const outsideOk = (c, r) => {
    if (!useBox) return true
    // 允許邊上外一圈；禁止深入方內
    return !(c > useBox.minX && c < useBox.maxX && r > useBox.minY && r < useBox.maxY)
  }

  await shapeProgress(opts, '§6F 輻射邊 L 繞行…')
  // 反序插入，避免 index 漂移
  const spokeIdx = []
  for (let si = 0; si < workSegs.length; si++) {
    const s = workSegs[si]
    const aW = pathSet.has(s.a), bW = pathSet.has(s.b)
    if (aW === bW) continue // 兩端都 W 或都非 W
    // 已是 H/V 則不必繞
    const A = L.get(s.a), B = L.get(s.b)
    if (!A || !B) continue
    if (A[0] === B[0] || A[1] === B[1]) continue
    spokeIdx.push(si)
  }
  for (let k = spokeIdx.length - 1; k >= 0; k--) {
    const si = spokeIdx[k]
    // 前面插入可能已使 index 失效——改以端點重找
    const want = segs[spokeIdx[k]] // 原始端點（clone 時 a/b 同）
    // 用當前 workSegs 找仍是 a-b 的段
    let bi = -1
    for (let i = 0; i < workSegs.length; i++) {
      const s = workSegs[i]
      if ((s.a === want.a && s.b === want.b) || (s.a === want.b && s.b === want.a)) {
        bi = i
        break
      }
    }
    if (bi < 0) continue
    const s = workSegs[bi]
    const aW = pathSet.has(s.a)
    const u = aW ? s.a : s.b
    const v = aW ? s.b : s.a
    const U = L.get(u), V = L.get(v)
    if (!U || !V) continue
    if (U[0] === V[0] || U[1] === V[1]) continue
    const cands = [
      [V[0], U[1]],
      [U[0], V[1]],
    ]
    // 微調找空格
    let cell = null
    for (const [c0, r0] of cands) {
      for (const [dc, dr] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
        const c = c0 + dc, r = r0 + dr
        if (!freeCell(c, r) || !outsideOk(c, r)) continue
        cell = [c, r]
        break
      }
      if (cell) break
    }
    if (!cell) continue
    const gid = `shape-g${seq++}`
    splitSegAt(workSegs, L, bi, gid, cell)
    greens.push({ id: gid, c: cell[0], r: cell[1], a: s.a, b: s.b })
  }
  workInc = rebuildInc(workSegs)
  await shapeProgress(opts,
    `§6F L 繞行 ${greens.length} 點，交叉 ${improperCrossCount(L, workSegs)}`)

  // 4) 殘餘交叉：便宜搜尋（只看前幾對、短半徑）
  const maxExtra = 80
  let extra = 0
  while (extra < maxExtra) {
    const crossNow = improperCrossCount(L, workSegs)
    if (crossNow <= cross0) break
    const pairs = findAllCrossingPairs(L, workSegs, 40)
    if (!pairs.length) break
    let placed = null
    const crossBefore = crossNow
    for (const pair of pairs) {
      for (const bi of [pair.i, pair.j]) {
        const s = workSegs[bi]
        if (pathSet.has(s.a) && pathSet.has(s.b)) continue
        const A = L.get(s.a), B = L.get(s.b)
        if (!A || !B) continue
        const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2
        for (const [ux, uy] of greenDirCandidates(A, B, useBox).slice(0, 6)) {
          for (let d = 1; d <= 10 && !placed; d++) {
            const c = Math.round(mx + ux * d), r = Math.round(my + uy * d)
            if (!freeCell(c, r) || !outsideOk(c, r)) continue
            const trialPos = new Map([...L].map(([id, p]) => [id, [...p]]))
            const trialSegs = cloneSegs(workSegs)
            const gid = `shape-g${seq}`
            splitSegAt(trialSegs, trialPos, bi, gid, [c, r])
            const crossAfter = improperCrossCount(trialPos, trialSegs)
            if (crossAfter >= crossBefore || hasCellClash(trialPos)) continue
            placed = {
              pos: trialPos, segs: trialSegs,
              green: { id: gid, c, r, a: s.a, b: s.b },
            }
          }
        }
        if (placed) break
      }
      if (placed) break
    }
    if (!placed) break
    L = placed.pos
    workSegs = placed.segs
    greens.push(placed.green)
    seq++
    extra++
    if (extra % 10 === 0) {
      await shapeProgress(opts, `§6F 殘餘綠控 ${extra}，交叉 ${improperCrossCount(L, workSegs)}`)
    }
  }
  workInc = rebuildInc(workSegs)

  for (const g of greens) L.set(g.id, [g.c, g.r])
  if (useBox) {
    const pinned = pinWFourSidesOnBox(L, pick.cutIds, useBox, cols, rows)
    if (pinned) {
      for (const [id, p] of pinned) {
        if (isShapeGreenId(id)) continue
        L.set(id, p)
      }
    }
  }

  const four = isFourLineSquare(pick.cutIds, L)
  const cross1 = improperCrossCount(L, workSegs)
  await shapeProgress(opts,
    `§6F 交付：方=${four} 綠控=${greens.length} 交叉 ${cross0}→${cross1}`)
  return {
    layout: L,
    via: greens.length ? `force+green×${greens.length}` : 'force-square',
    box: useBox,
    greens,
    segs: workSegs,
    inc: workInc,
  }
}

/**
 * 用爬山 validMove 逐步把站移向目標（每步保交叉／象限／環繞序）。
 * 比整網 RBF 吸附慢但不會撕拓撲。
 */
function topoSafeTowardTargets(geo, targets, segs, inc, cols, rows, pathSet) {
  const pos = new Map([...geo].map(([id, p]) => [id, [...p]]))
  const M = makeMover(pos, segs, inc, cols, rows)
  const ids = [
    ...[...pathSet].filter((id) => targets.has(id) && pos.has(id)),
    ...[...targets.keys()].filter((id) => !pathSet.has(id) && pos.has(id)),
  ]
  for (let pass = 0; pass < 80; pass++) {
    let moved = 0
    for (const id of ids) {
      const tgt = targets.get(id)
      const cur = pos.get(id)
      if (!tgt || !cur) continue
      const dist0 = Math.hypot(cur[0] - tgt[0], cur[1] - tgt[1])
      if (dist0 < 0.5) continue
      const tc = Math.max(0, Math.min(cols - 1, Math.round(tgt[0])))
      const tr = Math.max(0, Math.min(rows - 1, Math.round(tgt[1])))
      // 先試目標格，再由近到遠搜（validMove 允許非相鄰格，但須過鐵律）
      const cands = [[tc, tr]]
      const dx = Math.sign(tc - cur[0]), dy = Math.sign(tr - cur[1])
      if (dx || dy) {
        cands.push([cur[0] + dx, cur[1] + dy])
        if (dx) cands.push([cur[0] + dx, cur[1]])
        if (dy) cands.push([cur[0], cur[1] + dy])
      }
      for (let rad = 1; rad <= 5; rad++) {
        for (let dc = -rad; dc <= rad; dc++) {
          for (let dr = -rad; dr <= rad; dr++) {
            if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
            cands.push([cur[0] + dc, cur[1] + dr])
          }
        }
      }
      let best = null, bd = dist0
      const seen = new Set()
      for (const [c, r] of cands) {
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue
        const key = ckey(c, r)
        if (seen.has(key)) continue
        seen.add(key)
        if (c === cur[0] && r === cur[1]) continue
        if (!M.validMove(id, [c, r])) continue
        const d = Math.hypot(c - tgt[0], r - tgt[1])
        if (d + 1e-9 < bd) { bd = d; best = [c, r] }
      }
      if (best) {
        M.applyMove(id, best)
        moved++
      }
    }
    if (!moved) break
  }
  return pos
}

/** 點重疊：同格兩站，或站落在非入射邊上 */
function hasPointOverlap(posMap, segs) {
  const seen = new Set()
  for (const [id, p] of posMap) {
    const key = ckey(p[0], p[1])
    if (seen.has(key)) return true
    seen.add(key)
  }
  for (const [id, p] of posMap) {
    for (const s of segs) {
      if (s.a === id || s.b === id) continue
      const A = posMap.get(s.a), B = posMap.get(s.b)
      if (!A || !B) continue
      if ((p[0] === A[0] && p[1] === A[1]) || (p[0] === B[0] && p[1] === B[1])) continue
      if (onCellSeg(p, A, B)) return true
    }
  }
  return false
}

function stationOnForeignSeg(id, p, posMap, segs) {
  for (const s of segs) {
    if (s.a === id || s.b === id) continue
    const A = posMap.get(s.a), B = posMap.get(s.b)
    if (!A || !B) continue
    if ((p[0] === A[0] && p[1] === A[1]) || (p[0] === B[0] && p[1] === B[1])) continue
    if (onCellSeg(p, A, B)) return true
  }
  return false
}

/**
 * 把壓線／撞格的站推到最近空格。
 * @param {Set<string>|null} frozen 鎖定站（規定路段 W）——不移動，只推其餘站
 * @param {boolean} relaxCross 允許交叉略增（嵌方後調其餘時用）
 */
function repairPointOverlaps(posMap, segs, cols, rows, crossBudget, {
  maxRad = 5, frozen = null, relaxCross = false, ignoreCross = false,
} = {}) {
  for (let iter = 0; iter < 60; iter++) {
    if (!hasPointOverlap(posMap, segs)) return true
    let offender = null
    // 只動非凍結站（W 已嵌方，鎖死）
    for (const [id, p] of posMap) {
      if (frozen?.has(id)) continue
      const clash = [...posMap].some(([oid, op]) => oid !== id && op[0] === p[0] && op[1] === p[1])
      const onSeg = stationOnForeignSeg(id, p, posMap, segs)
      if (clash || onSeg) { offender = [id, p]; break }
    }
    if (!offender) return !hasPointOverlap(posMap, segs)
    const [id, p] = offender
    const occ = new Set([...posMap].filter(([oid]) => oid !== id).map(([, q]) => ckey(q[0], q[1])))
    let best = null, bd = Infinity, bestCross = Infinity
    const budget = ignoreCross ? Infinity : (relaxCross ? crossBudget + 8 : crossBudget)
    for (let rad = 1; rad <= maxRad; rad++) {
      for (let dc = -rad; dc <= rad; dc++) {
        for (let dr = -rad; dr <= rad; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
          const c = Math.max(0, Math.min(cols - 1, p[0] + dc))
          const r = Math.max(0, Math.min(rows - 1, p[1] + dr))
          if (occ.has(ckey(c, r))) continue
          const cand = [c, r]
          const trial = new Map([...posMap].map(([i, q]) => [i, [...q]]))
          trial.set(id, cand)
          if (stationOnForeignSeg(id, cand, trial, segs)) continue
          const cx = ignoreCross ? 0 : improperCrossCount(trial, segs)
          if (cx > budget) continue
          const d = Math.hypot(c - p[0], r - p[1])
          if (cx < bestCross || (cx === bestCross && d < bd)) {
            bestCross = cx; bd = d; best = cand
          }
        }
      }
      if (best && (ignoreCross || bestCross <= crossBudget)) break
    }
    if (!best) return false
    posMap.set(id, best)
  }
  return !hasPointOverlap(posMap, segs)
}

/**
 * 論文 §6 輕量版：以 LS 連續解 P 為準（W 再投影到凍結方形），互不撞整數吸附。
 * 比「只對輸入做仿射」更貼論文——連續域已近方，離散化跟 P 走。
 */
function lsSquareSnap(P, cutIds, shapePoly, cols, rows) {
  const cont = new Map([...P].map(([id, p]) => [id, [...p]]))
  const onPath = mapPathOntoShape(cutIds, P, shapePoly)
  for (const [id, q] of onPath) cont.set(id, [q[0], q[1]])
  const used = new Set()
  const snapped = new Map()
  const cutSet = new Set(cutIds)
  const order = [...cont.keys()].sort((a, b) =>
    (cutSet.has(a) ? 0 : 1) - (cutSet.has(b) ? 0 : 1) || String(a).localeCompare(String(b)))
  for (const id of order) {
    const p = cont.get(id)
    const prefer = cutSet.has(id) ? closestOnPoly(p, shapePoly) : p
    let best = null, bd = Infinity
    const c0 = Math.round(prefer[0]), r0 = Math.round(prefer[1])
    for (let rad = 0; rad <= 8; rad++) {
      for (let dc = -rad; dc <= rad; dc++) {
        for (let dr = -rad; dr <= rad; dr++) {
          if (rad > 0 && Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
          const c = Math.max(0, Math.min(cols - 1, c0 + dc))
          const r = Math.max(0, Math.min(rows - 1, r0 + dr))
          const key = ckey(c, r)
          if (used.has(key)) continue
          const on = closestOnPoly([c, r], shapePoly)
          const onDist = cutSet.has(id) ? Math.hypot(c - on[0], r - on[1]) : 0
          const cost = Math.hypot(c - prefer[0], r - prefer[1]) + (cutSet.has(id) ? 2 * onDist : 0)
          if (cost < bd) { bd = cost; best = [c, r] }
        }
      }
    }
    if (!best) return null
    used.add(ckey(best[0], best[1]))
    snapped.set(id, best)
  }
  return snapped
}

/**
 * 規定路段 W → 正方「四條直線邊」（只 H/V，角點轉折、禁止斜切角）。
 * 站序均分到四邊；相鄰站必在同一邊或共角 → 畫出來只有 4 條邊。
 */
function forceFourSideSquare(base, cutIds, cols, rows) {
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ring.push(id)
  }
  if (ring.length < 4) return null

  const n = ring.length
  const pts = ring.map((id) => base.get(id)).filter(Boolean)
  if (pts.length < n) return null
  let minX0 = Math.min(...pts.map((p) => p[0])), maxX0 = Math.max(...pts.map((p) => p[0]))
  let minY0 = Math.min(...pts.map((p) => p[1])), maxY0 = Math.max(...pts.map((p) => p[1]))
  const cx = (minX0 + maxX0) / 2, cy = (minY0 + maxY0) / 2

  // 四邊站數（含起角、不含終角），總和 = n
  const q = Math.floor(n / 4)
  const rem = n % 4
  const sizes = [0, 1, 2, 3].map((i) => q + (i < rem ? 1 : 0))
  if (sizes.some((s) => s < 1)) return null

  // 邊長至少能放下該邊站數；優先取短邊成方（避免鋪滿畫布）
  let side = Math.max(
    Math.max(...sizes),
    Math.round(Math.min(maxX0 - minX0, maxY0 - minY0)),
    2,
  )

  const fit = (s) => {
    let x0 = Math.round(cx - s / 2), y0 = Math.round(cy - s / 2)
    let x1 = x0 + s, y1 = y0 + s
    if (x0 < 0) { x1 -= x0; x0 = 0 }
    if (y0 < 0) { y1 -= y0; y0 = 0 }
    if (x1 >= cols) { const d = x1 - (cols - 1); x0 = Math.max(0, x0 - d); x1 = x0 + s }
    if (y1 >= rows) { const d = y1 - (rows - 1); y0 = Math.max(0, y0 - d); y1 = y0 + s }
    if (x1 >= cols || y1 >= rows || x0 < 0 || y0 < 0) return null
    return { minX: x0, minY: y0, maxX: x1, maxY: y1, side: s }
  }

  let box = null
  for (let s = side; s <= Math.min(cols, rows) - 1; s++) {
    box = fit(s)
    if (box) break
  }
  if (!box) box = fit(Math.max(2, Math.min(cols, rows) - 1))
  if (!box) return null

  const { minX, minY, maxX, maxY } = box
  // 底→右→頂→左（螢幕 y 向下）
  const corners = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ]
  const atSide = (sideI, t) => {
    const A = corners[sideI], B = corners[(sideI + 1) % 4]
    return [
      Math.round(A[0] + (B[0] - A[0]) * t),
      Math.round(A[1] + (B[1] - A[1]) * t),
    ]
  }

  const cornerIdx = [0]
  let acc = 0
  for (let i = 0; i < 3; i++) {
    acc += sizes[i]
    cornerIdx.push(acc)
  }

  const out = new Map([...base].map(([id, p]) => [id, [...p]]))
  const used = new Set()
  /** 只在同一邊上找空格，避免跨邊造成斜切角 */
  const placeUniqueOnSide = (sideI, prefer) => {
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
      if (used.has(ckey(cell[0], cell[1]))) continue
      const d = Math.hypot(cell[0] - prefer[0], cell[1] - prefer[1])
      if (d < bd) { bd = d; best = cell }
    }
    return best
  }

  for (let sideI = 0; sideI < 4; sideI++) {
    const i0 = cornerIdx[sideI]
    const i1 = sideI === 3 ? n : cornerIdx[sideI + 1]
    const nOn = i1 - i0
    for (let j = 0; j < nOn; j++) {
      const t = j / sizes[sideI]
      const prefer = atSide(sideI, t)
      const cell = placeUniqueOnSide(sideI, prefer)
      if (!cell) return null
      used.add(ckey(cell[0], cell[1]))
      out.set(ring[i0 + j], cell)
    }
  }

  // 其餘站撞到環站格 → 外推
  for (const [id, p] of out) {
    if (seen.has(id)) continue
    if (!used.has(ckey(p[0], p[1]))) continue
    let found = null
    for (let rad = 1; rad <= 8 && !found; rad++) {
      for (let dc = -rad; dc <= rad && !found; dc++) {
        for (let dr = -rad; dr <= rad && !found; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
          const c = Math.max(0, Math.min(cols - 1, p[0] + dc))
          const r = Math.max(0, Math.min(rows - 1, p[1] + dr))
          if (used.has(ckey(c, r))) continue
          const clash = [...out].some(([oid, op]) => oid !== id && op[0] === c && op[1] === r)
          if (clash) continue
          found = [c, r]
        }
      }
    }
    if (found) out.set(id, found)
  }

  return { layout: out, box, side: box.side }
}

/** 是否為四邊直線方形：外接正方、站在邊上、相鄰段皆 H/V */
function isFourLineSquare(cutIds, posMap) {
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ring.push(id)
  }
  if (ring.length < 4) return false
  const pts = ring.map((id) => posMap.get(id)).filter(Boolean)
  if (pts.length < ring.length) return false
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]))
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]))
  if (maxX - minX !== maxY - minY || maxX === minX) return false
  for (const p of pts) {
    if (p[0] !== minX && p[0] !== maxX && p[1] !== minY && p[1] !== maxY) return false
  }
  for (let i = 0; i < ring.length; i++) {
    const a = posMap.get(ring[i]), b = posMap.get(ring[(i + 1) % ring.length])
    if (!a || !b) return false
    if (a[0] !== b[0] && a[1] !== b[1]) return false // 斜線＝不是四邊直線
  }
  return true
}

/**
 * 由大到小產生正方候選（密網縮方較易保拓撲）。
 * 最小邊長＝能放下四邊站數。
 */
function shrinkBoxes(base, cutIds, cols, rows) {
  if (!base) return []
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ring.push(id)
  }
  const n = ring.length
  if (n < 4) return []
  const q = Math.floor(n / 4)
  const rem = n % 4
  const sizes = [0, 1, 2, 3].map((i) => q + (i < rem ? 1 : 0))
  const minSide = Math.max(2, Math.max(...sizes))
  const cx = (base.minX + base.maxX) / 2
  const cy = (base.minY + base.maxY) / 2
  const out = []
  const seenSide = new Set()
  // 最多約 5 個邊長（密網每次修復很貴）
  const span = base.side - minSide
  const steps = Math.max(1, Math.min(5, span))
  for (let i = 0; i <= steps; i++) {
    const s = Math.round(base.side - (span * i) / steps)
    if (s < minSide || seenSide.has(s)) continue
    seenSide.add(s)
    let minX = Math.round(cx - s / 2)
    let minY = Math.round(cy - s / 2)
    let maxX = minX + s
    let maxY = minY + s
    if (minX < 0) { maxX -= minX; minX = 0 }
    if (minY < 0) { maxY -= minY; minY = 0 }
    if (maxX >= cols) { const d = maxX - (cols - 1); minX = Math.max(0, minX - d); maxX = minX + s }
    if (maxY >= rows) { const d = maxY - (rows - 1); minY = Math.max(0, minY - d); maxY = minY + s }
    if (maxX >= cols || maxY >= rows || maxX - minX !== s || maxY - minY !== s) continue
    out.push({ minX, minY, maxX, maxY, side: s })
  }
  return out.length ? out : [base]
}

/** 把規定路段相鄰站之間的走廊點投影到同一條 H/V 邊上（避免畫線離開方形） */
function snapCorridorsToSquare(layout, cutIds, box, segs, inc) {
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ring.push(id)
  }
  if (ring.length < 4 || !box) return
  const W = new Set(ring)
  const adj = new Map()
  for (const s of segs) {
    if (!adj.has(s.a)) adj.set(s.a, [])
    if (!adj.has(s.b)) adj.set(s.b, [])
    adj.get(s.a).push(s.b)
    adj.get(s.b).push(s.a)
  }
  const pathBetween = (a, b) => {
    const q = [a]
    const prev = new Map([[a, null]])
    while (q.length) {
      const u = q.shift()
      if (u === b) break
      for (const v of adj.get(u) ?? []) {
        if (prev.has(v)) continue
        // 不穿其他 W（除了端點）
        if (W.has(v) && v !== b) continue
        prev.set(v, u)
        q.push(v)
      }
    }
    if (!prev.has(b)) return null
    const path = [b]
    while (path[path.length - 1] !== a) path.push(prev.get(path[path.length - 1]))
    return path.reverse()
  }
  const projectToSeg = (p, A, B) => {
    if (A[0] === B[0]) {
      const y0 = Math.min(A[1], B[1]), y1 = Math.max(A[1], B[1])
      return [A[0], Math.max(y0, Math.min(y1, Math.round(p[1])))]
    }
    const x0 = Math.min(A[0], B[0]), x1 = Math.max(A[0], B[0])
    return [Math.max(x0, Math.min(x1, Math.round(p[0]))), A[1]]
  }
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const A = layout.get(a), B = layout.get(b)
    if (!A || !B) continue
    if (A[0] !== B[0] && A[1] !== B[1]) continue
    const path = pathBetween(a, b)
    if (!path || path.length <= 2) continue
    for (let k = 1; k < path.length - 1; k++) {
      const id = path[k]
      if (W.has(id)) continue
      const p = layout.get(id)
      if (!p) continue
      layout.set(id, projectToSeg(p, A, B))
    }
  }
}

/**
 * 在既有正方 box 上把 W 釘成四邊直線（其餘站不動）。
 * box 應已是正方（通常來自整網仿射後的 W 外接框）——只推 W 到邊上，少撕網。
 */
function pinWFourSidesOnBox(layout, cutIds, box, cols, rows) {
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
  if (maxX - minX !== maxY - minY || maxX <= minX) return null

  const q = Math.floor(n / 4)
  const rem = n % 4
  const sizes = [0, 1, 2, 3].map((i) => q + (i < rem ? 1 : 0))
  if (sizes.some((s) => s < 1)) return null

  const corners = [
    [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY],
  ]
  const atSide = (sideI, t) => {
    const A = corners[sideI], B = corners[(sideI + 1) % 4]
    return [
      Math.round(A[0] + (B[0] - A[0]) * t),
      Math.round(A[1] + (B[1] - A[1]) * t),
    ]
  }
  const cornerIdx = [0]
  let acc = 0
  for (let i = 0; i < 3; i++) {
    acc += sizes[i]
    cornerIdx.push(acc)
  }

  const out = new Map([...layout].map(([id, p]) => [id, [...p]]))
  const used = new Set()
  const placeUniqueOnSide = (sideI, prefer) => {
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
      if (used.has(ckey(cell[0], cell[1]))) continue
      const d = Math.hypot(cell[0] - prefer[0], cell[1] - prefer[1])
      if (d < bd) { bd = d; best = cell }
    }
    return best
  }

  for (let sideI = 0; sideI < 4; sideI++) {
    const i0 = cornerIdx[sideI]
    const i1 = sideI === 3 ? n : cornerIdx[sideI + 1]
    for (let j = 0; j < i1 - i0; j++) {
      const prefer = atSide(sideI, j / sizes[sideI])
      const cell = placeUniqueOnSide(sideI, prefer)
      if (!cell) return null
      used.add(ckey(cell[0], cell[1]))
      out.set(ring[i0 + j], cell)
    }
  }

  // 非 W 若撞到 W 格 → 外推（不改 W）
  for (const [id, p] of out) {
    if (seen.has(id)) continue
    if (!used.has(ckey(p[0], p[1]))) continue
    let found = null
    for (let rad = 1; rad <= 10 && !found; rad++) {
      for (let dc = -rad; dc <= rad && !found; dc++) {
        for (let dr = -rad; dr <= rad && !found; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
          const c = Math.max(0, Math.min(cols - 1, p[0] + dc))
          const r = Math.max(0, Math.min(rows - 1, p[1] + dr))
          if (used.has(ckey(c, r))) continue
          const clash = [...out].some(([oid, op]) => oid !== id && op[0] === c && op[1] === r)
          if (clash) continue
          found = [c, r]
        }
      }
    }
    if (found) out.set(id, found)
  }
  return out
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
  const w = maxX0 - minX0, h = maxY0 - minY0
  // 縮成正方（取短邊）——用長邊擴張會幾乎鋪滿畫布、其餘路線無處可去而大量交叉
  const side = Math.max(2, Math.min(w, h))
  const cx = (minX0 + maxX0) / 2, cy = (minY0 + maxY0) / 2
  let minX = Math.round(cx - side / 2), minY = Math.round(cy - side / 2)
  let maxX = minX + side, maxY = minY + side
  if (minX < 0) { maxX -= minX; minX = 0 }
  if (minY < 0) { maxY -= minY; minY = 0 }
  if (maxX >= cols) { const d = maxX - (cols - 1); minX = Math.max(0, minX - d); maxX = minX + side }
  if (maxY >= rows) { const d = maxY - (rows - 1); minY = Math.max(0, minY - d); maxY = minY + side }
  if (maxX >= cols || maxY >= rows || maxX - minX !== side || maxY - minY !== side) {
    // 仍放不下就退回能放下的最大正方
    const side2 = Math.max(2, Math.min(side, cols - 1, rows - 1))
    minX = Math.max(0, Math.min(cols - 1 - side2, Math.round(cx - side2 / 2)))
    minY = Math.max(0, Math.min(rows - 1 - side2, Math.round(cy - side2 / 2)))
    maxX = minX + side2
    maxY = minY + side2
    return { minX, minY, maxX, maxY, side: side2 }
  }
  return { minX, minY, maxX, maxY, side }
}

/**
 * W 已釘在 layout；其餘站依連續座標 cont 重新互不撞吸附（跟已變形的鄰接，不要留在舊格）。
 */
function reseedOthersFromCont(layout, cont, pathSet, cols, rows) {
  const used = new Set()
  for (const id of pathSet) {
    const p = layout.get(id)
    if (p) used.add(ckey(p[0], p[1]))
  }
  const others = [...layout.keys()]
    .filter((id) => !pathSet.has(id))
    .sort((a, b) => String(a).localeCompare(String(b)))
  for (const id of others) {
    const prefer = cont.get(id) || layout.get(id)
    if (!prefer) continue
    let best = null, bd = Infinity
    const c0 = Math.round(prefer[0]), r0 = Math.round(prefer[1])
    for (let rad = 0; rad <= 14; rad++) {
      for (let dc = -rad; dc <= rad; dc++) {
        for (let dr = -rad; dr <= rad; dr++) {
          if (rad > 0 && Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
          const c = Math.max(0, Math.min(cols - 1, c0 + dc))
          const r = Math.max(0, Math.min(rows - 1, r0 + dr))
          const key = ckey(c, r)
          if (used.has(key)) continue
          const cost = Math.hypot(c - prefer[0], r - prefer[1])
          if (cost < bd) { bd = cost; best = [c, r] }
        }
      }
      if (best && bd < 0.5) break
    }
    if (best) {
      used.add(ckey(best[0], best[1]))
      layout.set(id, best)
    }
  }
}

/** 站序均分到正方四邊的連續／整數目標（底→右→頂→左） */
function fourSideTargets(cutIds, box, asInt = true) {
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
      let x = A[0] + (B[0] - A[0]) * t
      let y = A[1] + (B[1] - A[1]) * t
      if (asInt) { x = Math.round(x); y = Math.round(y) }
      out.set(ring[i0 + j], [x, y])
    }
  }
  return { targets: out, ring, sizes, cornerIdx, corners }
}

/** 把落在 W 邊（或任何非入射邊）上的非凍結站推離；凍結站若壓線則沿允許格滑開 */
function clearStationsOnEdges(posMap, segs, frozen, cols, rows, {
  allowSlideFrozen = null, // Set of ids allowed to slide (e.g. W) 或 (id)=>cells
} = {}) {
  for (let iter = 0; iter < 120; iter++) {
    let offender = null
    let isFrozen = false
    for (const [id, p] of posMap) {
      const clash = [...posMap].some(([oid, op]) => oid !== id && op[0] === p[0] && op[1] === p[1])
      const onSeg = stationOnForeignSeg(id, p, posMap, segs)
      if (!clash && !onSeg) continue
      if (frozen.has(id)) {
        if (allowSlideFrozen?.has?.(id) || allowSlideFrozen === true) {
          offender = [id, p]; isFrozen = true; break
        }
        continue
      }
      offender = [id, p]; isFrozen = false; break
    }
    if (!offender) return true
    const [id, p] = offender
    const occ = new Set([...posMap].filter(([oid]) => oid !== id).map(([, q]) => ckey(q[0], q[1])))
    let best = null, bd = Infinity
    const maxRad = isFrozen ? 8 : 20
    for (let rad = 1; rad <= maxRad; rad++) {
      for (let dc = -rad; dc <= rad; dc++) {
        for (let dr = -rad; dr <= rad; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
          const c = Math.max(0, Math.min(cols - 1, p[0] + dc))
          const r = Math.max(0, Math.min(rows - 1, p[1] + dr))
          if (occ.has(ckey(c, r))) continue
          // 凍結站：必須留在同一水平或垂直線上（沿邊滑）
          if (isFrozen && c !== p[0] && r !== p[1]) continue
          const trial = new Map([...posMap].map(([i, q]) => [i, [...q]]))
          trial.set(id, [c, r])
          if (stationOnForeignSeg(id, [c, r], trial, segs)) continue
          const d = Math.hypot(c - p[0], r - p[1])
          if (d < bd) { bd = d; best = [c, r] }
        }
      }
      if (best) break
    }
    if (!best) return false
    posMap.set(id, best)
  }
  return !hasPointOverlap(posMap, segs)
}

/** 從中心沿角度 ang 的射線，與閉合折線的最近交點距離 */
function rayPolyHitDist(cx, cy, ang, poly) {
  const dx = Math.cos(ang), dy = Math.sin(ang)
  let best = Infinity
  for (let i = 0; i + 1 < poly.length; i++) {
    const Ax = poly[i][0] - cx, Ay = poly[i][1] - cy
    const Bx = poly[i + 1][0] - cx, By = poly[i + 1][1] - cy
    const ex = Bx - Ax, ey = By - Ay
    // 解 A + u e = t (dx,dy), u∈[0,1], t>0
    const det = dx * ey - dy * ex
    if (Math.abs(det) < 1e-12) continue
    const t = (Ax * ey - Ay * ex) / det
    const u = (dx * Ay - dy * Ax) / det
    if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.min(best, t)
  }
  return best
}

/**
 * 徑向同胚：以環線凸包為源、正方為目標，整網沿射線比例縮放。
 * 內部：r' = r·(rDst/rSrc)；外部：保留超出量 r' = rDst+(r−rSrc)。
 */
function radialMorph(srcPos, cutIds, box, targets = null) {
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const p = srcPos.get(id)
    if (p) ring.push([...p])
  }
  if (ring.length < 4) return null
  // 凸包較不易自交，中心也更可能在核內
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
    if (targets?.has(id)) {
      out.set(id, [...targets.get(id)])
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
    if (!Number.isFinite(rSrc) || rSrc < 1e-6) {
      // 射線未擊中：用該角度上 bbox 半寬近似
      rSrc = Math.max(1e-3, Math.hypot(p[0] - cx, p[1] - cy))
    }
    if (!Number.isFinite(rDst) || rDst < 1e-6) {
      rDst = Math.min(maxX - minX, maxY - minY) / 2
    }
    const rNew = r <= rSrc + 1e-9
      ? r * (rDst / rSrc)
      : rDst + (r - rSrc)
    out.set(id, [cx + Math.cos(ang) * rNew, cy + Math.sin(ang) * rNew])
  }
  return out
}

/** 2D 凸包（Andrew monotone chain） */
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

/**
 * RBF 備援變形場（徑向失敗時用）。
 */
function rbfMorph(srcPos, cutIds, targets) {
  const anchors = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id) || !targets.has(id)) continue
    seen.add(id)
    const s = srcPos.get(id), t = targets.get(id)
    if (s && t) anchors.push({ s, dx: t[0] - s[0], dy: t[1] - s[1] })
  }
  if (!anchors.length) return null
  const out = new Map()
  for (const [id, p] of srcPos) {
    if (targets.has(id)) {
      out.set(id, [...targets.get(id)])
      continue
    }
    let sx = 0, sy = 0, w = 0
    for (const a of anchors) {
      const d2 = (p[0] - a.s[0]) ** 2 + (p[1] - a.s[1]) ** 2
      const wi = 1 / Math.max(1e-3, d2)
      sx += wi * a.dx
      sy += wi * a.dy
      w += wi
    }
    out.set(id, [p[0] + sx / w, p[1] + sy / w])
  }
  return out
}

/** 連續座標 → 互不撞整數格（W 優先佔格） */
function mutualSnap(cont, pathSet, cols, rows) {
  const used = new Set()
  const snapped = new Map()
  const order = [...cont.keys()].sort((a, b) =>
    (pathSet.has(a) ? 0 : 1) - (pathSet.has(b) ? 0 : 1) || String(a).localeCompare(String(b)))
  for (const id of order) {
    const p = cont.get(id)
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
    let best = null, bd = Infinity
    // 先夾到格內再搜，避免格外偏好把所有候選壓到同一條邊界
    const c0 = Math.max(0, Math.min(cols - 1, Math.round(p[0])))
    const r0 = Math.max(0, Math.min(rows - 1, Math.round(p[1])))
    for (let rad = 0; rad <= Math.max(cols, rows); rad++) {
      for (let dc = -rad; dc <= rad; dc++) {
        for (let dr = -rad; dr <= rad; dr++) {
          if (rad > 0 && Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
          const c = Math.max(0, Math.min(cols - 1, c0 + dc))
          const r = Math.max(0, Math.min(rows - 1, r0 + dr))
          if (used.has(ckey(c, r))) continue
          const cost = Math.hypot(c - p[0], r - p[1])
          if (cost < bd) { bd = cost; best = [c, r] }
        }
      }
      if (best) break // 最近一圈有空格就收
    }
    if (!best) return null
    used.add(ckey(best[0], best[1]))
    snapped.set(id, best)
  }
  return snapped
}

/** 只計算與 id 入射邊有關的不当交叉（移動單點時的正確增量） */
function incidentCrossCount(posMap, segs, inc, id) {
  const list = inc.get(id) ?? []
  let n = 0
  for (const si of list) {
    const s = segs[si]
    const A = posMap.get(s.a), B = posMap.get(s.b)
    if (!A || !B) continue
    for (let j = 0; j < segs.length; j++) {
      if (j === si) continue
      const t = segs[j]
      if (s.a === t.a || s.a === t.b || s.b === t.a || s.b === t.b) continue
      const C = posMap.get(t.a), D = posMap.get(t.b)
      if (!C || !D) continue
      if (segIntersect(A, B, C, D)) n++
    }
  }
  return n
}

/**
 * 積極修規則：W 凍結（或可沿邊滑）；清重疊＋降入射交叉。
 */
function aggressiveRepairRules(posMap, segs, frozen, cols, rows, crossBudget, inc, {
  box = null, slideW = false,
} = {}) {
  const rulesOk = () =>
    !hasPointOverlap(posMap, segs) && improperCrossCount(posMap, segs) <= crossBudget

  const onSquareEdge = (p) => box && (
    ((p[0] === box.minX || p[0] === box.maxX) && p[1] >= box.minY && p[1] <= box.maxY)
    || ((p[1] === box.minY || p[1] === box.maxY) && p[0] >= box.minX && p[0] <= box.maxX)
  )

  for (let round = 0; round < 40; round++) {
    if (rulesOk()) return true
    repairPointOverlaps(posMap, segs, cols, rows, Number.POSITIVE_INFINITY, {
      frozen: slideW ? null : frozen, // 滑邊時允許暫移 W 清重疊，稍後再釘回
      relaxCross: true, maxRad: 12, ignoreCross: true,
    })
    // 若清重疊動到 W，立刻拉回邊上
    if (slideW && box) {
      for (const id of frozen) {
        const p = posMap.get(id)
        if (p && !onSquareEdge(p)) {
          const cand = [
            [box.minX, Math.max(box.minY, Math.min(box.maxY, p[1]))],
            [box.maxX, Math.max(box.minY, Math.min(box.maxY, p[1]))],
            [Math.max(box.minX, Math.min(box.maxX, p[0])), box.minY],
            [Math.max(box.minX, Math.min(box.maxX, p[0])), box.maxY],
          ]
          let best = null, bd = Infinity
          const occ = new Set([...posMap].filter(([oid]) => oid !== id).map(([, q]) => ckey(q[0], q[1])))
          for (const [c, r] of cand) {
            if (occ.has(ckey(c, r))) continue
            const d = Math.hypot(c - p[0], r - p[1])
            if (d < bd) { bd = d; best = [c, r] }
          }
          if (best) posMap.set(id, best)
        }
      }
    }

    const hot = new Set()
    for (let i = 0; i < segs.length; i++) {
      const si = segs[i]
      const A = posMap.get(si.a), B = posMap.get(si.b)
      if (!A || !B) continue
      for (let j = i + 1; j < segs.length; j++) {
        const sj = segs[j]
        if (si.a === sj.a || si.a === sj.b || si.b === sj.a || si.b === sj.b) continue
        const C = posMap.get(sj.a), D = posMap.get(sj.b)
        if (!C || !D) continue
        if (!segIntersect(A, B, C, D)) continue
        for (const id of [si.a, si.b, sj.a, sj.b]) {
          if (slideW || !frozen.has(id)) hot.add(id)
        }
      }
    }

    let improved = false
    let globalCross = improperCrossCount(posMap, segs)
    for (const id of hot) {
      const p = posMap.get(id)
      if (!p) continue
      const isW = frozen.has(id)
      if (isW && !(slideW && box)) continue
      const baseInc = incidentCrossCount(posMap, segs, inc, id)
      const occ = new Set(
        [...posMap].filter(([oid]) => oid !== id).map(([, q]) => ckey(q[0], q[1])),
      )
      let best = null, bestScore = baseInc
      const maxRad = isW ? 1 : 12
      for (let rad = 1; rad <= maxRad; rad++) {
        for (let dc = -rad; dc <= rad; dc++) {
          for (let dr = -rad; dr <= rad; dr++) {
            if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
            const c = p[0] + dc, r = p[1] + dr
            if (c < 0 || r < 0 || c >= cols || r >= rows) continue
            if (isW && !onSquareEdge([c, r])) continue
            if (occ.has(ckey(c, r))) continue
            const old = posMap.get(id)
            posMap.set(id, [c, r])
            if (stationOnForeignSeg(id, [c, r], posMap, segs)) {
              posMap.set(id, old)
              continue
            }
            // 快速：先看入射交叉；偶爾用全域
            const cx = incidentCrossCount(posMap, segs, inc, id)
            posMap.set(id, old)
            if (cx < bestScore) { bestScore = cx; best = [c, r] }
          }
        }
        if (best && bestScore < baseInc) break
      }
      if (best) {
        posMap.set(id, best)
        improved = true
        if (round % 5 === 4) {
          const g = improperCrossCount(posMap, segs)
          if (g > globalCross) posMap.set(id, p) // 全域變差則撤
          else globalCross = g
        }
      }
    }
    if (!improved) break
  }
  return rulesOk()
}

/**
 * 以環線 bbox 中心做軸向等比縮放，使環線外接框成正方，再互不撞整數吸附。
 * 仿射保平面（連續域交叉不變）；作 LS 吸附失敗時的備援。
 */
function affineSquareSnap(src, cutIds, cols, rows) {
  const pts = cutIds.map((id) => src.get(id)).filter(Boolean)
  if (pts.length < MIN_CUTS) return null
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]))
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]))
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const w = Math.max(1e-9, maxX - minX), h = Math.max(1e-9, maxY - minY)
  const side = (w + h) / 2
  const sx = side / w, sy = side / h
  const cont = new Map()
  for (const [id, p] of src) {
    cont.set(id, [cx + (p[0] - cx) * sx, cy + (p[1] - cy) * sy])
  }
  const used = new Set()
  const snapped = new Map()
  const cutSet = new Set(cutIds)
  const order = [...cont.keys()].sort((a, b) =>
    (cutSet.has(a) ? 0 : 1) - (cutSet.has(b) ? 0 : 1) || String(a).localeCompare(String(b)))
  for (const id of order) {
    const p = cont.get(id)
    let best = null, bd = Infinity
    const c0 = Math.round(p[0]), r0 = Math.round(p[1])
    for (let rad = 0; rad <= 8; rad++) {
      for (let dc = -rad; dc <= rad; dc++) {
        for (let dr = -rad; dr <= rad; dr++) {
          if (rad > 0 && Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
          const c = Math.max(0, Math.min(cols - 1, c0 + dc))
          const r = Math.max(0, Math.min(rows - 1, r0 + dr))
          const key = ckey(c, r)
          if (used.has(key)) continue
          const cost = Math.hypot(c - p[0], r - p[1])
          if (cost < bd) { bd = cost; best = [c, r] }
        }
      }
    }
    if (!best) return null
    used.add(ckey(best[0], best[1]))
    snapped.set(id, best)
  }
  return { snapped, cont, sx, sy, side }
}

/* ---------- §4：依規定表取路線／路段＋擺方形（不自動猜環） ---------- */
function extractRouteStations(rt, pos, segment) {
  let ids = dedupeAdj((rt.stations ?? []).filter((id) => pos.has(id)))
  if (segment === 'first-cycle') {
    ids = firstCycle(ids) ?? []
  }
  return ids
}

function pickRouteAndAlign(skeleton, pos, cityId) {
  const preset = getShapePreset(cityId)
  if (!preset) return null
  const routes = skeleton.routes
  if (!routes?.size) return null

  const list = [...routes.values()].filter((rt) => !String(rt.id).startsWith('river:'))
  const matched = list.find((r) => r.id === preset.routeId)
    ?? list.find((r) => preset.nameRe.test(r.name ?? '')
      && (preset.segment !== 'full' || r.stations?.[0] === r.stations?.[r.stations.length - 1]
        || preset.segment === 'first-cycle'))
    ?? list.find((r) => preset.nameRe.test(r.name ?? ''))

  // 規定表站序完整存在才直接用；缺站（骨架 x* 重編）→ 從同名路線依 segment 解析
  let cutIds = dedupeAdj(preset.stations.filter((id) => pos.has(id)))
  const presetComplete = cutIds.length === dedupeAdj(preset.stations).length && cutIds.length >= MIN_CUTS
  if (!presetComplete) {
    if (!matched) return null
    cutIds = extractRouteStations(matched, pos, preset.segment)
  }
  if (cutIds.length < MIN_CUTS) return null
  const pathPts = cutIds.map((id) => pos.get(id))
  if (pathPts.some((p) => !p)) return null
  const aligned = alignShape(SHAPE_UNIT, pathPts)
  return {
    aligned,
    cutIds,
    routeId: matched?.id ?? preset.routeId,
    routeName: preset.label || (matched?.name && String(matched.name).trim()) || String(preset.routeId),
    routeSegment: cutIds.slice(),
    shape: preset.shape, // 0＝方形
    score: 1,
  }
}

function skipStats(pos, segs, extra = {}) {
  return {
    cellAfter: pos,
    stats: {
      hvBefore: countHV(pos, segs), hvAfter: countHV(pos, segs),
      hvdBefore: countHVD(pos, segs), hvdAfter: countHVD(pos, segs),
      segs: segs.length, verts: pos.size, moved: 0, passes: 0, reverted: false,
      skipped: true, shape: null, shapeZh: null, route: null, routeId: null,
      routeSegment: null,
      note: '不需計算',
      ...extra,
    },
  }
}

/* ---------- §5：鏡射線段不穿邊（論文圖 6 / Smooth::calculateIntersections） ---------- */
function mirrorClear(p, pi, id, P, segs) {
  const mirror = [2 * pi[0] - p[0], 2 * pi[1] - p[1]]
  for (const s of segs) {
    if (s.a === id || s.b === id) continue
    const A = P.get(s.a), B = P.get(s.b)
    // 論文同時檢查 v→pi 與 pi→v*；等價於整段 v→v*
    if (segIntersect(p, mirror, A, B)) return false
  }
  return true
}

/* ---------- §5.2：同站 octo 邊方向衝突 → 小規模精確重指派（匈牙利的 n≤8 版） ---------- */
function hungarianOctoDirs(P, segs, inc, isShapeSeg) {
  const fvec = segs.map(() => [0, 0])
  const tentative = segs.map((s, si) => {
    if (isShapeSeg[si]) return null
    const A = P.get(s.a), B = P.get(s.b)
    const dx = B[0] - A[0], dy = B[1] - A[1]
    const d = Math.hypot(dx, dy)
    if (d < 1e-9) return { si, d: 0, sec: 0, ang: 0 }
    return { si, d, sec: sectorOf(dx, dy), ang: Math.atan2(dy, dx) }
  })
  for (const t of tentative) {
    if (!t) continue
    const [ux, uy] = SECTOR_VEC[t.sec]
    const un = Math.hypot(ux, uy)
    fvec[t.si] = [ux / un * t.d, uy / un * t.d]
  }
  for (const [v, list] of inc) {
    const oct = list.filter((si) => tentative[si])
    if (oct.length < 2 || oct.length > 8) continue
    const m = oct.length
    const sectors = [0, 1, 2, 3, 4, 5, 6, 7]
    let bestAssign = null, bestCost = Infinity
    const used = new Array(8).fill(false)
    const cur = new Array(m)
    const rec = (i, cost) => {
      if (cost >= bestCost) return
      if (i === m) { bestCost = cost; bestAssign = cur.slice(); return }
      const t = tentative[oct[i]]
      for (const sec of sectors) {
        if (used[sec]) continue
        let dAng = Math.abs(t.ang - sec * Math.PI / 4)
        while (dAng > Math.PI) dAng -= TWO_PI
        dAng = Math.abs(dAng)
        used[sec] = true
        cur[i] = sec
        rec(i + 1, cost + dAng)
        used[sec] = false
      }
    }
    rec(0, 0)
    if (!bestAssign) continue
    for (let i = 0; i < m; i++) {
      const si = oct[i], t = tentative[si]
      const [ux, uy] = SECTOR_VEC[bestAssign[i]]
      const un = Math.hypot(ux, uy)
      const s = segs[si]
      const outward = [ux / un * t.d, uy / un * t.d]
      fvec[si] = s.a === v ? outward : [-outward[0], -outward[1]]
    }
  }
  for (const t of tentative) {
    if (!t) continue
    const s = segs[t.si]
    const A = P.get(s.a), B = P.get(s.b)
    const dx = B[0] - A[0], dy = B[1] - A[1]
    const f = fvec[t.si]
    if (f[0] * dx + f[1] * dy < 0) fvec[t.si] = [-f[0], -f[1]]
  }
  return fvec
}

/* ---------- 進度（UI 按「執行」時串流；無 onProgress 則不讓出） ---------- */
async function shapeProgress(opts, msg) {
  if (typeof opts.onProgress === 'function') opts.onProgress(msg)
  if (typeof opts.tick === 'function') await opts.tick()
  else if (typeof opts.onProgress === 'function') await new Promise((r) => setTimeout(r, 0))
}

/* ---------- 主建置（論文三步；async 以便進度讓出 UI） ---------- */
export async function buildShapeAlign(skeleton, cells, cols, rows, opts = {}) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)

  await shapeProgress(opts, '§4 選定規定路段…')
  const pick = pickRouteAndAlign(skeleton, pos, opts.cityId)
  if (!pick) return skipStats(pos, segs)

  const shapePoly = pick.aligned // 凍結（D5）
  const ids = [...pos.keys()].sort()
  const geo = new Map(ids.map((id) => [id, [...pos.get(id)]])) // Ωp／Ωl 錨定＝輸入格位
  const P = new Map(ids.map((id) => [id, [...pos.get(id)]]))
  const pathSet = new Set(pick.cutIds) // 論文 autoPath／W
  const cross0 = improperCrossCount(pos, segs) // D1 拓撲預算：後續不得超過
  const shapeMeta = {
    shape: pick.shape, // 0＝方形
    shapeZh: SHAPE_ZH[pick.shape] ?? '方',
    route: pick.routeName,
    routeId: pick.routeId,
    routeSegment: pick.routeSegment,
  }
  await shapeProgress(opts,
    `§4 擺方：${pick.routeName}（${pick.cutIds.length} 站）· 輸入交叉 ${cross0}`)

  // Ωc 固定目標：一般站＝最近點；比對路徑 W＝沿方形弧長（對應論文沿 P 路由的效果，
  // 但在 LS 內拉整網，讓 Ωl 帶著鄰站一起動——禁止事後硬鎖格破壞拓撲）
  const closestFixed = new Map()
  for (const id of ids) {
    closestFixed.set(id, closestOnPoly(geo.get(id), shapePoly))
  }
  const pathOnSquare = mapPathOntoShape(pick.cutIds, geo, shapePoly)
  for (const [id, q] of pathOnSquare) closestFixed.set(id, q)

  // 初始描形站：比對路徑必收；其餘鏡射通過才收
  let Sshape = new Set(pathSet)
  for (const id of ids) {
    if (pathSet.has(id)) continue
    if (mirrorClear(geo.get(id), closestFixed.get(id), id, geo, segs)) Sshape.add(id)
  }

  // 理想邊長 L＝中位
  const lens = segs.map((s) => {
    const A = pos.get(s.a), B = pos.get(s.b)
    return Math.hypot(B[0] - A[0], B[1] - A[1]) / Math.max(1, s.hops)
  }).sort((a, b) => a - b)
  const LperHop = Math.max(1, lens[lens.length >> 1] || 1)
  const R = segs.map(() => 0)

  // ── §5.1 平滑佈局（每輪平面性守門：cross > cross0 → 退回上一輪）──
  await shapeProgress(opts, `§5.1 平滑 LS（${SMOOTH_ROUNDS} 輪）…`)
  for (let round = 0; round < SMOOTH_ROUNDS; round++) {
    if (round > 0 && round % 20 === 0) {
      await shapeProgress(opts, `§5.1 平滑 LS ${round}/${SMOOTH_ROUNDS}`)
    }
    const Pprev = new Map([...P].map(([id, p]) => [id, [...p]]))
    Sshape = new Set(pathSet)
    for (const id of ids) {
      if (pathSet.has(id)) continue
      const pi = closestOnPoly(P.get(id), shapePoly)
      if (mirrorClear(P.get(id), pi, id, P, segs)) Sshape.add(id)
    }

    for (const id of ids) {
      let sx = WP * geo.get(id)[0], sy = WP * geo.get(id)[1], w = WP
      if (Sshape.has(id)) {
        const pi = closestFixed.get(id)
        const deg = Math.max(1, (inc.get(id) ?? []).length)
        const wc = pathSet.has(id) ? WC_PATH : WC
        sx += wc * deg * pi[0]
        sy += wc * deg * pi[1]
        w += wc * deg
      }
      for (const si of inc.get(id) ?? []) {
        const s = segs[si]
        const o = P.get(s.a === id ? s.b : s.a)
        const A0 = geo.get(s.a), B0 = geo.get(s.b)
        const gdx = B0[0] - A0[0], gdy = B0[1] - A0[1]
        const targetLen = LperHop * s.hops
        const th = R[si]
        const c = Math.cos(th), sn = Math.sin(th)
        const rx = c * gdx - sn * gdy, ry = sn * gdx + c * gdy
        const rn = Math.hypot(rx, ry) || 1
        const fx = rx / rn * targetLen, fy = ry / rn * targetLen
        if (s.a === id) { sx += WL * (o[0] - fx); sy += WL * (o[1] - fy) }
        else { sx += WL * (o[0] + fx); sy += WL * (o[1] + fy) }
        w += WL
      }
      const nbrs = (inc.get(id) ?? []).map((si) => {
        const s = segs[si]
        return { si, o: s.a === id ? s.b : s.a }
      })
      const deg = nbrs.length
      if (deg === 2) {
        const a = P.get(nbrs[0].o), b = P.get(nbrs[1].o)
        sx += WA * 0.5 * (a[0] + b[0]); sy += WA * 0.5 * (a[1] + b[1])
        w += WA
      } else if (deg >= 3) {
        const theta = TWO_PI / deg
        const tanH = Math.tan((Math.PI - theta) / 2)
        const ordered = nbrs.map((n) => {
          const o = P.get(n.o), me = P.get(id)
          return { ...n, ang: Math.atan2(o[1] - me[1], o[0] - me[0]) }
        }).sort((a, b) => a.ang - b.ang)
        for (let i = 0; i < ordered.length; i++) {
          const j = ordered[i], k = ordered[(i + 1) % ordered.length]
          const pj = P.get(j.o), pk = P.get(k.o)
          const mid = [(pj[0] + pk[0]) / 2, (pj[1] + pk[1]) / 2]
          const vx = pk[0] - pj[0], vy = pk[1] - pj[1]
          const half = Math.hypot(vx, vy) / 2
          let nx = -vy, ny = vx
          const nn = Math.hypot(nx, ny) || 1
          nx /= nn; ny /= nn
          const me = P.get(id)
          if ((me[0] - mid[0]) * nx + (me[1] - mid[1]) * ny < 0) { nx = -nx; ny = -ny }
          const h = tanH * half
          const target = [mid[0] + nx * h, mid[1] + ny * h]
          sx += WA * target[0]; sy += WA * target[1]
          w += WA
        }
      }
      const p = P.get(id)
      p[0] = sx / w
      p[1] = sy / w
    }
    for (let si = 0; si < segs.length; si++) {
      const s = segs[si]
      const A0 = geo.get(s.a), B0 = geo.get(s.b)
      const A = P.get(s.a), B = P.get(s.b)
      const g = Math.atan2(B0[1] - A0[1], B0[0] - A0[0])
      const cAng = Math.atan2(B[1] - A[1], B[0] - A[0])
      let d = cAng - g
      while (d > Math.PI) d -= TWO_PI
      while (d < -Math.PI) d += TWO_PI
      R[si] = d
    }
    // 論文 §5：新交叉或環繞序變 → 退回上一輪
    if (improperCrossCount(P, segs) > cross0 || !edgeOrdersMatch(Pprev, P, segs, inc)) {
      for (const [id, p] of Pprev) P.set(id, p)
    }
  }

  // ── §5.2 混合佈局 ──
  await shapeProgress(opts, `§5.2 混合 LS（${MIXED_ROUNDS} 輪）…`)
  Sshape = new Set(pathSet)
  for (const id of ids) {
    if (pathSet.has(id)) continue
    if (mirrorClear(P.get(id), closestOnPoly(P.get(id), shapePoly), id, P, segs)) Sshape.add(id)
  }
  const isShapeSeg = segs.map((s) => Sshape.has(s.a) && Sshape.has(s.b))

  const mixedStep = () => {
    const fvec = hungarianOctoDirs(P, segs, inc, isShapeSeg)
    for (const id of ids) {
      // 規定路段 W：鎖在方形弧長目標（先嵌形，再調其餘）
      if (pathSet.has(id)) {
        const pi = closestFixed.get(id)
        P.get(id)[0] = pi[0]
        P.get(id)[1] = pi[1]
        continue
      }
      let sx = WP * geo.get(id)[0], sy = WP * geo.get(id)[1], w = WP
      if (Sshape.has(id)) {
        const pi = closestFixed.get(id)
        const deg = Math.max(1, (inc.get(id) ?? []).length)
        sx += WC * deg * pi[0]
        sy += WC * deg * pi[1]
        w += WC * deg
      }
      for (const si of inc.get(id) ?? []) {
        if (isShapeSeg[si]) {
          const s = segs[si]
          const o = P.get(s.a === id ? s.b : s.a)
          const targetLen = LperHop * s.hops
          const me = P.get(id)
          const dx = o[0] - me[0], dy = o[1] - me[1]
          const d = Math.hypot(dx, dy) || 1
          sx += WL * (o[0] - dx / d * targetLen)
          sy += WL * (o[1] - dy / d * targetLen)
          w += WL
          continue
        }
        const s = segs[si]
        const f = fvec[si]
        const o = P.get(s.a === id ? s.b : s.a)
        const sgn = s.a === id ? -1 : 1
        sx += WO * (o[0] + sgn * f[0])
        sy += WO * (o[1] + sgn * f[1])
        w += WO
      }
      const p = P.get(id)
      p[0] = sx / w
      p[1] = sy / w
    }
  }

  // 論文 §5：每輪平面性＋環繞序守門
  for (let round = 0; round < MIXED_ROUNDS; round++) {
    if (round > 0 && round % 15 === 0) {
      await shapeProgress(opts, `§5.2 混合 LS ${round}/${MIXED_ROUNDS}`)
    }
    const Pprev = new Map([...P].map(([id, p]) => [id, [...p]]))
    mixedStep()
    if (improperCrossCount(P, segs) > cross0 || !edgeOrdersMatch(Pprev, P, segs, inc)) {
      for (const [id, p] of Pprev) P.set(id, p)
    }
  }

  // 論文：W 硬嵌到凍結方形後，再跑一輪只動其餘站
  await shapeProgress(opts, `§5.2 調整輪（W 鎖方，${ADJUST_ROUNDS} 輪）…`)
  const pathOnSquare2 = mapPathOntoShape(pick.cutIds, P, shapePoly)
  for (const [id, q] of pathOnSquare2) {
    closestFixed.set(id, q)
    P.set(id, [q[0], q[1]])
  }
  for (let round = 0; round < ADJUST_ROUNDS; round++) {
    if (round > 0 && round % 10 === 0) {
      await shapeProgress(opts, `§5.2 調整輪 ${round}/${ADJUST_ROUNDS}`)
    }
    const Pprev = new Map([...P].map(([id, p]) => [id, [...p]]))
    mixedStep()
    if (improperCrossCount(P, segs) > cross0 || !edgeOrdersMatch(Pprev, P, segs, inc)) {
      for (const [id, p] of Pprev) P.set(id, p)
    }
  }

  // ── §6：四邊直線方＋硬規則（交叉／重疊不得變差）──
  // RBF 變形場讓整網跟著 W 走 → 釘邊／修復；僅 four∧!clash∧cross≤cross0 交付，否則退回輸入。
  await shapeProgress(opts, '§6 格網：檢查是否已成四邊方…')
  const hvBefore = countHV(pos, segs)
  const hvdBefore = countHVD(pos, segs)

  if (isFourLineSquare(pick.cutIds, pos) && !hasPointOverlap(pos, segs)
    && topoIronOk(pos, geo, segs, inc, cross0)) {
    await shapeProgress(opts, '已成四邊方且拓撲完好 → 略過變形')
    const q0 = squareQuality(pick.cutIds, pos)
    return {
      cellAfter: pos,
      greens: [],
      stats: {
        hvBefore, hvAfter: hvBefore,
        hvdBefore, hvdAfter: hvdBefore,
        segs: segs.length, verts: pos.size,
        moved: 0, passes: 1, reverted: false,
        smoothRounds: SMOOTH_ROUNDS, mixedRounds: MIXED_ROUNDS,
        adjustRounds: ADJUST_ROUNDS,
        skipped: false,
        ...shapeMeta,
        shapeVerts: Sshape.size,
        score: +pick.score.toFixed(3),
        note: '→方',
        quality: { ar: 1, onEdge: +q0.onEdge.toFixed(2), sides: 4, square: true, fourLine: true },
        crosses: `${cross0}→${cross0}`,
        via: 'already',
        rulesOk: true,
        greens: [],
        greenCount: 0,
      },
    }
  }

  const box0 = wSquareBox(geo, pick.cutIds, cols, rows)
  const boxes = shrinkBoxes(box0, pick.cutIds, cols, rows)

  // 鐵律：四邊方 ∧ 無撞格 ∧ 交叉不增 ∧ 點周圍邊環繞序＝輸入
  const tryAccept = (layout, viaTag, useBox, { pin = true } = {}) => {
    const L = new Map([...layout].map(([id, p]) => [id, [...p]]))
    if (pin && useBox) {
      // 禁止整網硬釘 W（會撕交叉／環繞序）；只在已接近四邊時微調重釘
      if (isFourLineSquare(pick.cutIds, L)) {
        const pinned = pinWFourSidesOnBox(L, pick.cutIds, useBox, cols, rows)
        if (pinned) {
          for (const [id, p] of pinned) L.set(id, p)
        }
      }
    }
    clearStationsOnEdges(L, segs, pathSet, cols, rows, { allowSlideFrozen: null })
    // 修復不得增交叉；W 凍結、禁止 slideW（滑邊易改環繞序）
    aggressiveRepairRules(L, segs, pathSet, cols, rows, cross0, inc, {
      box: useBox, slideW: false,
    })
    if (!isFourLineSquare(pick.cutIds, L)) return null
    if (!topoIronOk(L, geo, segs, inc, cross0)) return null
    return { layout: L, via: viaTag, box: useBox }
  }

  let accepted = null
  let affMeta = box0 ? { side: box0.side } : undefined

  // A0：拓撲安全逐步移向四邊（validMove；保交叉＋環繞序）——密網首選
  // 大切點環（山手等）鐵律版幾乎無解，只試 2 個邊長後進 §6F，避免空轉數十秒
  const boxesTry = pick.cutIds.length >= 18 ? boxes.slice(0, 2) : boxes
  if (boxesTry.length) {
    await shapeProgress(opts, `§6A0 拓撲安全移方（${boxesTry.length} 邊長）…`)
    for (const box of boxesTry) {
      const targets = fourSideTargets(pick.cutIds, box, false)
      if (!targets) continue
      // 連續 RBF 當吸引場，再用 validMove 落地（禁止 mutualSnap 撕序）
      const morphed = rbfMorph(geo, pick.cutIds, targets.targets)
      if (morphed) {
        const stepped = topoSafeTowardTargets(
          geo, morphed, segs, inc, cols, rows, pathSet)
        // 再把 W 往四邊目標收一輪
        const towardW = topoSafeTowardTargets(
          stepped, targets.targets, segs, inc, cols, rows, pathSet)
        accepted = tryAccept(towardW, `topo-safe/s${box.side}`, box, { pin: false })
        if (accepted) {
          await shapeProgress(opts, `§6A0 通過（邊長 ${box.side}）`)
          break
        }
      }
      const wOnly = topoSafeTowardTargets(
        geo, targets.targets, segs, inc, cols, rows, pathSet)
      accepted = tryAccept(wOnly, `topo-safe-W/s${box.side}`, box, { pin: false })
      if (accepted) {
        await shapeProgress(opts, `§6A0 W-only 通過（邊長 ${box.side}）`)
        break
      }
    }
    if (!accepted) await shapeProgress(opts, '§6A0 未過鐵律')
  }

  // A：RBF 連續場 → validMove 吸附（不用 mutualSnap）——大切點環略過，直接 §6F
  if (!accepted && boxesTry.length && pick.cutIds.length < 18) {
    await shapeProgress(opts, `§6A RBF→validMove（須過鐵律）…`)
    for (const box of boxesTry) {
      const targets = fourSideTargets(pick.cutIds, box, false)
      if (!targets) continue
      const morphed = rbfMorph(geo, pick.cutIds, targets.targets)
      if (!morphed) continue
      const snapped = topoSafeTowardTargets(
        geo, morphed, segs, inc, cols, rows, pathSet)
      if (!topoIronOk(snapped, geo, segs, inc, cross0)) continue
      accepted = tryAccept(snapped, `rbf+validMove/s${box.side}`, box, { pin: false })
      if (accepted) {
        await shapeProgress(opts, `§6A 通過（邊長 ${box.side}）`)
        break
      }
    }
    if (!accepted) await shapeProgress(opts, '§6A 未過鐵律')
  }

  // B–E：小環才試；大切點環（山手／Circle）直接 §6F
  const smallBoxes = pick.cutIds.length < 18
    ? boxes.slice(Math.max(0, boxes.length - 3))
    : []

  if (!accepted && smallBoxes.length) {
    await shapeProgress(opts, '§6B 徑向→validMove…')
    for (const box of smallBoxes) {
      const morphed = radialMorph(geo, pick.cutIds, box, null)
      if (!morphed) continue
      const snapped = topoSafeTowardTargets(
        geo, morphed, segs, inc, cols, rows, pathSet)
      if (!topoIronOk(snapped, geo, segs, inc, cross0)) continue
      accepted = tryAccept(snapped, `radial+validMove/s${box.side}`, box, { pin: false })
      if (accepted) {
        await shapeProgress(opts, `§6B 通過（邊長 ${box.side}）`)
        break
      }
    }
  }

  if (!accepted && smallBoxes.length) {
    await shapeProgress(opts, '§6C 徑向目標→validMove…')
    for (const box of smallBoxes) {
      const targets = fourSideTargets(pick.cutIds, box, false)
      if (!targets) continue
      const morphed = radialMorph(geo, pick.cutIds, box, targets.targets)
      if (!morphed) continue
      const snapped = topoSafeTowardTargets(
        geo, morphed, segs, inc, cols, rows, pathSet)
      if (!topoIronOk(snapped, geo, segs, inc, cross0)) continue
      accepted = tryAccept(snapped, `radial-tgt+validMove/s${box.side}`, box, { pin: false })
      if (accepted) {
        await shapeProgress(opts, `§6C 通過（邊長 ${box.side}）`)
        break
      }
    }
  }

  if (!accepted && pick.cutIds.length < 18) await shapeProgress(opts, '§6D 仿射→validMove…')
  const aff = (!accepted && pick.cutIds.length < 18)
    ? affineSquareSnap(geo, pick.cutIds, cols, rows)
    : null
  if (!accepted && aff?.snapped) {
    affMeta = { sx: aff.sx, sy: aff.sy, side: aff.side }
    const abox = wSquareBox(aff.snapped, pick.cutIds, cols, rows) ?? box0
    if (abox) {
      for (const box of shrinkBoxes(abox, pick.cutIds, cols, rows).slice(-3)) {
        const targets = fourSideTargets(pick.cutIds, box, false)
        if (!targets) continue
        const base = topoIronOk(aff.snapped, geo, segs, inc, cross0)
          ? aff.snapped
          : topoSafeTowardTargets(geo, aff.snapped, segs, inc, cols, rows, pathSet)
        const stepped = topoSafeTowardTargets(
          base, targets.targets, segs, inc, cols, rows, pathSet)
        accepted = tryAccept(stepped, `affine+validMove/s${box.side}`, box, { pin: false })
        if (accepted) {
          await shapeProgress(opts, `§6D 通過（邊長 ${box.side}）`)
          break
        }
      }
    }
  }

  if (!accepted && pick.cutIds.length < 18) {
    await shapeProgress(opts, '§6E 僅 W 拓撲安全移方…')
    for (const box of (boxes.slice(-3).length ? boxes.slice(-3) : boxes)) {
      const targets = fourSideTargets(pick.cutIds, box, false)
      if (!targets) continue
      const stepped = topoSafeTowardTargets(
        geo, targets.targets, segs, inc, cols, rows, pathSet)
      accepted = tryAccept(stepped, `force-topo/s${box.side}`, box, { pin: false })
      if (accepted) {
        affMeta = { side: box.side, ...(affMeta || {}) }
        await shapeProgress(opts, `§6E 通過（邊長 ${box.side}）`)
        break
      }
    }
    if (!accepted) await shapeProgress(opts, '§6E 未過鐵律')
  }

  let greens = []
  let finalSegs = segs
  let finalInc = inc

  if (accepted) {
    await shapeProgress(opts, `完成 →方（${accepted.via}）`)
    for (const [id, p] of accepted.layout) pos.set(id, [p[0], p[1]])
    if (accepted.box) affMeta = { side: accepted.box.side, ...(affMeta || {}) }
  } else {
    // 鐵律版失敗 → 強制成方；必要時加綠色控制點讓路線轉折消交叉（一定交付）
    const forced = await forceSquareWithGreens(
      geo, pick, pathSet, segs, inc, cols, rows, boxes, box0, cross0, opts)
    accepted = { layout: forced.layout, via: forced.via, box: forced.box }
    greens = forced.greens ?? []
    finalSegs = forced.segs ?? segs
    finalInc = forced.inc ?? rebuildInc(finalSegs)
    for (const [id, p] of accepted.layout) pos.set(id, [p[0], p[1]])
    if (accepted.box) affMeta = { side: accepted.box.side, ...(affMeta || {}) }
    await shapeProgress(opts, `完成 →方（${accepted.via}）`)
  }

  const cross1 = improperCrossCount(pos, finalSegs)
  const four = isFourLineSquare(pick.cutIds, pos)
  const q = squareQuality(pick.cutIds, pos)
  const orderOk = edgeOrdersMatch(geo, pos, finalSegs, finalInc, isShapeGreenId)
  const rulesOk = four && !hasCellClash(pos) && cross1 <= cross0 && orderOk
  let moved = 0
  for (const [id, p] of pos) {
    if (isShapeGreenId(id)) continue
    const s = geo.get(id)
    if (!s || s[0] !== p[0] || s[1] !== p[1]) moved++
  }

  const greensSer = greens.map((g) => ({ id: g.id, c: g.c, r: g.r, a: g.a, b: g.b }))

  return {
    cellAfter: pos,
    greens: greensSer,
    stats: {
      hvBefore, hvAfter: countHV(pos, finalSegs),
      hvdBefore, hvdAfter: countHVD(pos, finalSegs),
      segs: finalSegs.length, verts: pos.size,
      moved, passes: 1, reverted: false,
      smoothRounds: SMOOTH_ROUNDS, mixedRounds: MIXED_ROUNDS,
      adjustRounds: ADJUST_ROUNDS,
      skipped: false,
      ...shapeMeta,
      shapeVerts: Sshape.size,
      score: +pick.score.toFixed(3),
      note: greensSer.length ? `→方·綠控×${greensSer.length}` : '→方',
      quality: {
        ar: +q.ar.toFixed(2),
        onEdge: +q.onEdge.toFixed(2),
        sides: q.sides,
        square: four || q.ok,
        fourLine: four,
      },
      crosses: `${cross0}→${cross1}`,
      orderOk,
      via: accepted?.via ?? 'force-square',
      rulesOk,
      greens: greensSer,
      greenCount: greensSer.length,
      affine: affMeta?.sx != null
        ? { sx: +affMeta.sx.toFixed(3), sy: +affMeta.sy.toFixed(3), side: +(+affMeta.side || 0).toFixed(2) }
        : affMeta?.side != null ? { side: affMeta.side } : undefined,
    },
  }
}

export { SHAPE_ZH }
export { SHAPE_SQUARE, SHAPE_PRESETS, getShapePreset, shapePresetKey } from './shapePresets.js'
