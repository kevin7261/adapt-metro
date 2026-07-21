// Shape-Guided（Batik et al. 2022 精神）——§4/§5 暖身＋§6 徑向成方（密網實用主路徑）。
// §4 規定路段 W → §5 平滑／混合 LS（平面性守門）
// → §6 徑向／RBF 整網成方＋釘四邊＋清交叉（Octi 僅 opts.tryOcti 可選加強）。
// 掛在「⑨Shape-Guided／layout-shape」；要不要算看 shapePresets（未規定＝不跑）。
import {
  buildHcGraph, countHV, countHVD, makeMover,
} from '../hillClimb.js'
import {
  emptyResult, sectorOf, SECTOR_VEC, TWO_PI,
} from './_shared.js'
import {
  SHAPE_SQUARE, getShapePreset,
} from './shapePresets.js'
import { runShapeOctiGrid } from './shapeOcti.js'

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

/**
 * 論文 D1 平面性：不當交叉 ≤ 輸入、無撞格。
 * （環繞序是 Stott／本庫 HC 規則，不在 Batik 2022 Shape-Guided 論文裡——不成交付條件。）
 */
function topoPlanarOk(layout, segs, cross0) {
  if (hasCellClash(layout)) return false
  if (improperCrossCount(layout, segs) > cross0) return false
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
      console.warn('[shape] green not placed', g)
    }
  }
  return { ...skeleton, stationClass, edges }
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

/** 單段的不當交叉數（綠控增量評估，避免每次 O(n²) 全量重算） */
function segCrossCount(posMap, segs, si) {
  const s = segs[si]
  const A = posMap.get(s.a), B = posMap.get(s.b)
  if (!A || !B) return 0
  let n = 0
  for (let j = 0; j < segs.length; j++) {
    if (j === si) continue
    const t = segs[j]
    if (s.a === t.a || s.a === t.b || s.b === t.a || s.b === t.b) continue
    const C = posMap.get(t.a), D = posMap.get(t.b)
    if (!C || !D) continue
    if (segIntersect(A, B, C, D)) n++
  }
  return n
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

/**
 * 是否為四邊直線方形：外接正方、W 站在邊上、相鄰連線皆 H/V。
 * 若給 segs：允許經綠色轉折點（論文必要時插 bend）走 L 形，綠點也須在方邊上。
 */
function isFourLineSquare(cutIds, posMap, segs = null) {
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
  const onBound = (p) => p
    && (p[0] === minX || p[0] === maxX || p[1] === minY || p[1] === maxY)
  for (const p of pts) {
    if (!onBound(p)) return false
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
  /** a→b：直連 H/V，或只經綠點的 H/V 折線 */
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
        if (v !== b && !isShapeGreenId(v)) continue
        if (!hopHV(u, v)) continue
        if (isShapeGreenId(v) && !onBound(posMap.get(v))) continue
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

/** 方框內的非 W 站沿徑向外推到框外（騰出空間、降交叉） */
function evacuateNonWOutsideSquare(layout, pathSet, box, cols, rows) {
  const { minX, minY, maxX, maxY } = box
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const used = new Set()
  for (const [id, p] of layout) {
    if (pathSet.has(id) || isShapeGreenId(id)) used.add(ckey(p[0], p[1]))
  }
  for (const [id, p] of [...layout]) {
    if (pathSet.has(id) || isShapeGreenId(id)) continue
    const inside = p[0] >= minX && p[0] <= maxX && p[1] >= minY && p[1] <= maxY
    if (!inside) { used.add(ckey(p[0], p[1])); continue }
    const ang = Math.atan2(p[1] - cy, p[0] - cx || 1e-9)
    let found = null
    const r0 = Math.max(maxX - minX, maxY - minY) / 2 + 1
    for (let dist = r0; dist < Math.max(cols, rows) + 2 && !found; dist++) {
      const c = Math.max(0, Math.min(cols - 1, Math.round(cx + Math.cos(ang) * dist)))
      const r = Math.max(0, Math.min(rows - 1, Math.round(cy + Math.sin(ang) * dist)))
      if (used.has(ckey(c, r))) continue
      if (c >= minX && c <= maxX && r >= minY && r <= maxY) continue
      found = [c, r]
    }
    if (found) {
      layout.set(id, found)
      used.add(ckey(found[0], found[1]))
    }
  }
}

/**
 * §6 主路徑：徑向（失敗則 RBF）整網變形 → 互不撞吸附 → 釘四邊方 → 疏散＋修交叉。
 * 比 Octi 逐邊路由更適合密網；成方是硬步驟，平面靠修交叉逼近。
 */
async function runRadialSquareGrid({
  seed, cutIds, pathSet, segs, inc, cols, rows, cross0,
  onProgress, tick,
}) {
  const progress = async (msg) => {
    if (typeof onProgress === 'function') onProgress(msg)
    if (typeof tick === 'function') await tick()
    else await new Promise((r) => setTimeout(r, 0))
  }

  await progress('§6 徑向：選正方框並整網變形…')
  const baseBox = wSquareBox(seed, cutIds, cols, rows)
  if (!baseBox) return null
  const boxes = shrinkBoxes(baseBox, cutIds, cols, rows)

  let best = null
  let bestScore = Infinity

  for (let bi = 0; bi < boxes.length; bi++) {
    const box = boxes[bi]
    if (bi === 0 || bi % 2 === 0) {
      await progress(`§6 徑向：候選 ${bi + 1}/${boxes.length}（邊=${box.side}）…`)
    }
    const ft = fourSideTargets(cutIds, box, false)
    if (!ft?.targets) continue

    let cont = radialMorph(seed, cutIds, box, ft.targets)
    if (!cont) cont = rbfMorph(seed, cutIds, ft.targets)
    if (!cont) continue

    let L = mutualSnap(cont, pathSet, cols, rows)
    if (!L) continue
    const pinned = pinWFourSidesOnBox(L, cutIds, box, cols, rows)
    if (pinned) L = pinned
    else {
      const forced = forceFourSideSquare(L, cutIds, cols, rows)
      if (forced) L = forced.layout
    }
    resolveCellClashes(L, pathSet, cols, rows)
    clearStationsOnEdges(L, segs, pathSet, cols, rows)
    evacuateNonWOutsideSquare(L, pathSet, box, cols, rows)
    resolveCellClashes(L, pathSet, cols, rows)

    for (let pass = 0; pass < 6; pass++) {
      aggressiveRepairRules(L, segs, pathSet, cols, rows, cross0, inc, {
        box, slideW: true,
      })
      if (isFourLineSquare(cutIds, L, segs) && topoPlanarOk(L, segs, cross0)) break
    }

    const four = isFourLineSquare(cutIds, L, segs)
    const planar = topoPlanarOk(L, segs, cross0)
    const cx = improperCrossCount(L, segs)
    const score = (four ? 0 : 1000) + (planar ? 0 : 100) + cx
    if (score < bestScore) {
      bestScore = score
      best = {
        layout: new Map([...L].map(([id, p]) => [id, [...p]])),
        segs,
        greens: [],
        box,
        via: `radial·side${box.side}`,
        rulesOk: four && planar,
        crosses: cx,
        four,
        planar,
      }
    }
    if (four && planar) {
      await progress(`§6 徑向：成方且平面（邊=${box.side}，交叉 ${cross0}→${cx}）`)
      return best
    }
  }

  if (best) {
    await progress(
      `§6 徑向：最佳（方=${best.four} 平面=${best.planar} 交叉 ${cross0}→${best.crosses}）`)
  } else {
    await progress('§6 徑向：無候選')
  }
  return best
}

/**
 * 論文交付：成方 ∧ D1 ∧ 綠僅 W —— 規定必做且結果必交（永不退回輸入）。
 * 種子已合規直接用；否則釘四邊方＋疏散＋積極修交叉，耗盡候選後仍交釘方結果。
 */
async function ensurePaperDelivery({
  seedLayout, seedSegs, seedGreens, seedVia,
  baseSegs, baseInc, cutIds, pathSet, cols, rows, cross0,
  onProgress, tick,
}) {
  const progress = async (msg, force = true) => {
    if (typeof onProgress === 'function') onProgress(msg)
    if (!force) return
    if (typeof tick === 'function') await tick()
    else await new Promise((r) => setTimeout(r, 0))
  }
  const greensOk = (greens) => (greens ?? []).every((g) =>
    (pathSet.has(g.a) || isShapeGreenId(g.a))
    && (pathSet.has(g.b) || isShapeGreenId(g.b)))
  const verdict = (L, sgs, greens) => {
    const four = isFourLineSquare(cutIds, L, sgs)
    const planar = topoPlanarOk(L, sgs, cross0)
    const gok = greensOk(greens)
    return { four, planar, gok, ok: four && planar && gok }
  }

  if (seedLayout && seedSegs) {
    const v = verdict(seedLayout, seedSegs, seedGreens)
    if (v.ok) {
      await progress('論文交付：已合規')
      return {
        layout: seedLayout, segs: seedSegs, greens: seedGreens ?? [],
        via: seedVia ?? 'radial', rulesOk: true,
      }
    }
  }

  // 剝綠，從純站佈局強制釘方（綠僅 W——強制路徑可不插綠，四邊 H/V 已夠）
  const base = new Map()
  for (const [id, p] of (seedLayout ?? [])) {
    if (isShapeGreenId(id)) continue
    base.set(id, [...p])
  }
  if (!base.size) {
    await progress('強制交付：無種子佈局')
    return null
  }

  const baseBox = wSquareBox(base, cutIds, cols, rows)
  const boxes = shrinkBoxes(baseBox, cutIds, cols, rows)
  let bestFour = null
  let bestFourCx = Infinity

  for (let bi = 0; bi < boxes.length; bi++) {
    const box = boxes[bi]
    await progress(`強制交付：釘方＋修平面（${bi + 1}/${boxes.length}，邊=${box.side}）…`)
    let L = pinWFourSidesOnBox(base, cutIds, box, cols, rows)
    if (!L) {
      const forced = forceFourSideSquare(base, cutIds, cols, rows)
      if (!forced) continue
      L = forced.layout
    }
    resolveCellClashes(L, pathSet, cols, rows)
    clearStationsOnEdges(L, baseSegs, pathSet, cols, rows)
    evacuateNonWOutsideSquare(L, pathSet, box, cols, rows)
    resolveCellClashes(L, pathSet, cols, rows)
    for (let pass = 0; pass < 5; pass++) {
      aggressiveRepairRules(L, baseSegs, pathSet, cols, rows, cross0, baseInc, {
        box, slideW: true,
      })
      if (verdict(L, baseSegs, []).ok) break
    }
    const v = verdict(L, baseSegs, [])
    const cx = improperCrossCount(L, baseSegs)
    if (v.ok) {
      await progress(`完成論文交付（force·side${box.side}，交叉 ${cross0}→${cx}）`)
      return {
        layout: L, segs: baseSegs, greens: [],
        via: `force·side${box.side}`, rulesOk: true,
      }
    }
    if (v.four && cx < bestFourCx) {
      bestFourCx = cx
      bestFour = {
        layout: new Map([...L].map(([id, p]) => [id, [...p]])),
        box,
      }
    }
  }

  // 末路：在最佳成方候選上繼續清交叉，仍必交出釘方（不退回輸入）
  let L
  let box
  if (bestFour) {
    L = bestFour.layout
    box = bestFour.box
  } else {
    const forced = forceFourSideSquare(base, cutIds, cols, rows)
    if (!forced) {
      await progress('強制交付：釘方失敗 → 交種子佈局')
      return {
        layout: base, segs: baseSegs, greens: [],
        via: 'force·seed', rulesOk: false,
      }
    }
    L = forced.layout
    box = forced.box
  }
  await progress(`強制交付：最終清交叉（${bestFourCx < Infinity ? bestFourCx : '?'}→≤${cross0}）…`)
  evacuateNonWOutsideSquare(L, pathSet, box, cols, rows)
  resolveCellClashes(L, pathSet, cols, rows)
  for (let i = 0; i < 12; i++) {
    if (verdict(L, baseSegs, []).ok) break
    aggressiveRepairRules(L, baseSegs, pathSet, cols, rows, cross0, baseInc, {
      box, slideW: true,
    })
    if (i % 3 === 2) {
      await progress(`強制交付：清交叉 ${i + 1}/12（${improperCrossCount(L, baseSegs)}）…`)
    }
  }
  const cx = improperCrossCount(L, baseSegs)
  const v = verdict(L, baseSegs, [])
  await progress(
    v.ok
      ? `完成論文交付（force，交叉 ${cross0}→${cx}）`
      : `交付釘方（方=${v.four} 平面=${v.planar} 交叉 ${cross0}→${cx}；不退回）`)
  return {
    layout: L, segs: baseSegs, greens: [],
    via: v.ok ? 'force' : 'force·deliver',
    rulesOk: v.ok,
  }
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
    // 論文 §5：平面性——新交叉 → 退回上一輪（D1；無「環繞序」條款）
    if (improperCrossCount(P, segs) > cross0) {
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

  // 論文 §5：每輪平面性守門（交叉不增）
  for (let round = 0; round < MIXED_ROUNDS; round++) {
    if (round > 0 && round % 15 === 0) {
      await shapeProgress(opts, `§5.2 混合 LS ${round}/${MIXED_ROUNDS}`)
    }
    const Pprev = new Map([...P].map(([id, p]) => [id, [...p]]))
    mixedStep()
    if (improperCrossCount(P, segs) > cross0) {
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
    if (improperCrossCount(P, segs) > cross0) {
      for (const [id, p] of Pprev) P.set(id, p)
    }
  }

  // ── §6：徑向成方＋清交叉（主路徑；Octi 僅 opts.tryOcti）──
  await shapeProgress(opts, '§6 格網：徑向成方＋清交叉…')
  const hvBefore = countHV(pos, segs)
  const hvdBefore = countHVD(pos, segs)

  // mixed → 整數格（撞格先清）
  const mixed = new Map()
  for (const [id, p] of P) {
    mixed.set(id, [
      Math.max(0, Math.min(cols - 1, Math.round(p[0]))),
      Math.max(0, Math.min(rows - 1, Math.round(p[1]))),
    ])
  }
  resolveCellClashes(mixed, pathSet, cols, rows)

  if (isFourLineSquare(pick.cutIds, mixed, segs) && !hasPointOverlap(mixed, segs)
    && topoPlanarOk(mixed, segs, cross0)) {
    await shapeProgress(opts, 'mixed 已成四邊方且平面完好 → 交付')
    for (const [id, p] of mixed) pos.set(id, [...p])
    const q0 = squareQuality(pick.cutIds, pos)
    return {
      cellAfter: pos,
      greens: [],
      stats: {
        hvBefore, hvAfter: countHV(pos, segs),
        hvdBefore, hvdAfter: countHVD(pos, segs),
        segs: segs.length, verts: pos.size,
        moved: [...pos].filter(([id, p]) => {
          const s = geo.get(id)
          return s && (s[0] !== p[0] || s[1] !== p[1])
        }).length,
        passes: 1, reverted: false,
        smoothRounds: SMOOTH_ROUNDS, mixedRounds: MIXED_ROUNDS,
        adjustRounds: ADJUST_ROUNDS,
        skipped: false,
        ...shapeMeta,
        shapeVerts: Sshape.size,
        score: +pick.score.toFixed(3),
        note: '→方（mixed）',
        quality: { ar: 1, onEdge: +q0.onEdge.toFixed(2), sides: 4, square: true, fourLine: true },
        crosses: `${cross0}→${cross0}`,
        via: 'mixed-already',
        rulesOk: true,
        greens: [],
        greenCount: 0,
      },
    }
  }

  const radial = await runRadialSquareGrid({
    seed: mixed,
    cutIds: pick.cutIds,
    pathSet,
    segs,
    inc,
    cols,
    rows,
    cross0,
    onProgress: opts.onProgress,
    tick: opts.tick,
  })

  // 可選：徑向未合規時再試 Octi（慢；預設關）
  let octi = null
  if (opts.tryOcti && !radial?.rulesOk) {
    await shapeProgress(opts, '§6 加強：Octi 織形（opts.tryOcti）…')
    octi = await runShapeOctiGrid({
      mixed,
      cutIds: pick.cutIds,
      pathSet,
      segs,
      inc,
      cols,
      rows,
      isShapeSeg,
      cross0,
      onProgress: opts.onProgress,
      tick: opts.tick,
    })
  }

  // 選種子：合規優先 → 成方且交叉少 → 徑向 → mixed
  const rankSeed = (s) => {
    if (!s?.layout) return 1e9
    const four = s.rulesOk || isFourLineSquare(pick.cutIds, s.layout, s.segs ?? segs)
    const cx = s.crosses ?? improperCrossCount(s.layout, s.segs ?? segs)
    const planar = s.rulesOk || topoPlanarOk(s.layout, s.segs ?? segs, cross0)
    return (four ? 0 : 1000) + (planar ? 0 : 100) + cx
  }
  let seed = radial
  if (octi && rankSeed(octi) < rankSeed(seed)) {
    seed = {
      layout: octi.layout,
      segs: octi.segs,
      greens: octi.greens ?? [],
      via: octi.via,
      rulesOk: false,
      box: octi.box,
      crosses: octi.crosses,
    }
  }
  if (!seed) {
    seed = { layout: mixed, segs, greens: [], via: 'mixed', rulesOk: false }
  }

  // 必交：不合規則釘方修交叉，永不退回輸入
  const delivered = await ensurePaperDelivery({
    seedLayout: seed.layout,
    seedSegs: seed.segs ?? segs,
    seedGreens: seed.greens ?? [],
    seedVia: seed.via ?? 'radial',
    baseSegs: segs,
    baseInc: inc,
    cutIds: pick.cutIds,
    pathSet,
    cols,
    rows,
    cross0,
    onProgress: opts.onProgress,
    tick: opts.tick,
  })

  let greens = []
  let finalSegs = segs
  let finalInc = inc
  let via = 'force·seed'
  let affMeta
  let rulesOk = false

  if (delivered) {
    greens = delivered.greens ?? []
    finalSegs = delivered.segs
    finalInc = rebuildInc(finalSegs)
    via = delivered.via
    rulesOk = !!delivered.rulesOk
    for (const [id, p] of delivered.layout) pos.set(id, [p[0], p[1]])
    for (const id of [...pos.keys()]) {
      if (isShapeGreenId(id) && !greens.some((g) => g.id === id)) pos.delete(id)
    }
  } else {
    for (const [id, p] of (seed.layout ?? mixed)) pos.set(id, [...p])
    via = seed.via ?? 'mixed-fallback'
    await shapeProgress(opts, `交付 ${via}（強制釘方失敗；不退回輸入）`)
  }

  const cross1 = improperCrossCount(pos, finalSegs)
  const four = isFourLineSquare(pick.cutIds, pos, finalSegs)
  const q = squareQuality(pick.cutIds, pos)
  const orderOk = edgeOrdersMatch(geo, pos, finalSegs, finalInc, isShapeGreenId)
  const planar = !hasCellClash(pos) && cross1 <= cross0
  rulesOk = rulesOk && four && planar
  let moved = 0
  for (const [id, p] of pos) {
    if (isShapeGreenId(id)) continue
    const s = geo.get(id)
    if (!s || s[0] !== p[0] || s[1] !== p[1]) moved++
  }

  const greensSer = greens.map((g) => ({ id: g.id, c: g.c, r: g.r, a: g.a, b: g.b }))
  const side = delivered?.layout && seed?.box?.side != null
    ? seed.box.side
    : (octi?.box?.side ?? radial?.box?.side)
  if (side != null) affMeta = { side }

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
      note: rulesOk
        ? (greensSer.length ? `→方·${via}·W綠×${greensSer.length}` : `→方·${via}`)
        : `→方·${via}（持續交付）`,
      quality: {
        ar: +q.ar.toFixed(2),
        onEdge: +q.onEdge.toFixed(2),
        sides: q.sides,
        square: four || q.ok,
        fourLine: four,
      },
      crosses: `${cross0}→${cross1}`,
      orderOk,
      via,
      rulesOk,
      greens: greensSer,
      greenCount: greensSer.length,
      affine: affMeta?.side != null ? { side: affMeta.side } : undefined,
    },
  }
}

/* ==========================================================================
 * ⑨ LLM 成方（route-llm-shape）——Shape-Guided 的 LLM 版共用機構
 *
 * 與 §5/§6 的演算法本體（buildShapeAlign）完全不同的路徑：不跑 LS 平滑／Octi 織
 * 形，而是把「移哪些點」交給 LLM（scripts/llmShape.mjs＋skill route-llm-shape），
 * 這裡只負責兩件事，跟 hillClimb.js 的 applyLlmTargets 對 LLM 對齊的角色一樣：
 *   1) shapeLlmContext：export 給 LLM 讀——規定路段 W 的環站、建議的正方目標格、
 *      目前是否已成四邊方、輸入交叉數。
 *   2) applyShapeLlmTargets：apply——把 LLM 提的目標格（＋可選綠折點）落地，再以
 *      論文 D1（交叉不增／無撞格）把關；不成方或破平面則退回。
 * 成方判準沿用 isFourLineSquare（四邊直線正方；可經綠折點走 L 形角）。LLM 可在相鄰
 * 環站之間插入綠點當四角轉折——環站只要滑到邊上（小移動）、不必被拉到角上（大移動），
 * network 改變最小（跟演算法本體 applyShapeGreens/splitSegAt 同一套）。
 * ========================================================================== */

/** export：回傳規定路段 W 的環站、正方目標格與目前成方狀態（null＝此城非規定表） */
export function shapeLlmContext(skeleton, cells, cols, rows, cityId) {
  const { pos, segs } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return null
  const pick = pickRouteAndAlign(skeleton, pos, cityId)
  if (!pick) return null
  const { cutIds } = pick
  const cross0 = improperCrossCount(pos, segs)
  const box = wSquareBox(pos, cutIds, cols, rows)
  const ft = box ? fourSideTargets(cutIds, box, true) : null
  const q = squareQuality(cutIds, pos)
  const square = isFourLineSquare(cutIds, pos, segs)
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ring.push(id)
  }
  // 邊表（連通性）——讓 LLM 能把「整條線／整個分支」當一組一起搬（整組移動）。
  const edges = segs.map((s) => [s.a, s.b])
  return {
    routeName: pick.routeName,
    routeId: pick.routeId,
    cutIds: ring,
    edges,
    box: box ? { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, side: box.side } : null,
    targets: ft?.targets ?? null,
    cross0,
    square,
    quality: {
      ar: Number.isFinite(q.ar) ? +q.ar.toFixed(2) : null,
      onEdge: +(q.onEdge ?? 0).toFixed(2),
      sides: q.sides ?? 0,
    },
  }
}

/**
 * 收方後回歸：其餘被推開的站逐步拉回原相對位置——只要不破論文 D1（交叉不增／無撞格）。
 * **直線上的環站也可調整**：環站移動額外要求 isFourLineSquare 仍成立（吃 segs、會走
 * 綠折點）——所以有綠折點的地方環站有更多回歸空間、沒有的地方就沿方邊滑（都不破方）。
 * 綠折點凍結在角/彎不動。跟演算本體「W 鎖方後再跑一輪只動其餘站」同精神，讓 network
 * 形狀與原圖差異最小。回傳 { pos, settled }（settled＝實際被拉回的站數）。
 */
function settleTowardOriginal(layout, original, segs, cols, rows, cutIds, cross0, maxPasses = 40) {
  const pos = new Map([...layout].map(([id, p]) => [id, [...p]]))
  const ringSet = new Set(cutIds)
  let settled = 0
  const occ = () => {
    const s = new Set()
    for (const [, p] of pos) s.add(ckey(p[0], p[1]))
    return s
  }
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = 0
    const taken = occ()
    for (const [id, cur] of pos) {
      if (isShapeGreenId(id)) continue // 綠折點凍結
      const orig = original.get(id)
      if (!orig) continue
      const d0 = Math.hypot(cur[0] - orig[0], cur[1] - orig[1])
      if (d0 < 0.5) continue
      const dc = Math.sign(orig[0] - cur[0]), dr = Math.sign(orig[1] - cur[1])
      // 朝原位一步（先對角、再單軸）；只收「更靠近原位」的候選
      const cands = [[cur[0] + dc, cur[1] + dr], [cur[0] + dc, cur[1]], [cur[0], cur[1] + dr]]
      let done = false
      for (const cand of cands) {
        if (done) break
        if (cand[0] === cur[0] && cand[1] === cur[1]) continue
        if (cand[0] < 0 || cand[1] < 0 || cand[0] >= cols || cand[1] >= rows) continue
        if (taken.has(ckey(cand[0], cand[1]))) continue
        const dnew = Math.hypot(cand[0] - orig[0], cand[1] - orig[1])
        if (dnew >= d0) continue
        pos.set(id, cand)
        const okD1 = !hasPointOverlap(pos, segs) && topoPlanarOk(pos, segs, cross0)
        // 環站額外守成方（沿方邊滑、或經綠折點的 L 形微調——都不破四邊直線正方）
        const okSquare = !ringSet.has(id) || isFourLineSquare(cutIds, pos, segs)
        if (okD1 && okSquare) {
          taken.delete(ckey(cur[0], cur[1]))
          taken.add(ckey(cand[0], cand[1]))
          moved++
          settled++
          done = true
        } else {
          pos.set(id, cur) // 破 D1／破方 → 退回，這站就停在這（已盡量靠回）
        }
      }
    }
    if (!moved) break
  }
  return { pos, settled }
}

/**
 * apply：把 LLM 提的目標格（[[id,[c,r]],…]）＋可選綠折點落地，成方後把被推開的其餘站
 * 拉回原相對位置（不破論文 D1），讓 network 形狀與原圖差異最小。
 * 回傳 { cellAfter, greens, stats }（stats 含成方與否、交叉前後、被擋下未到位的提案）。
 */
export function applyShapeLlmTargets(skeleton, cells, cols, rows, targetEntries, cityId, greenSpecs = []) {
  const g0 = buildHcGraph(skeleton, cells)
  const pos0 = g0.pos
  const segs0 = g0.segs
  if (!pos0.size || !segs0.length) {
    return { cellAfter: pos0, stats: { segs: 0, verts: pos0.size, moved: 0, square: false, reverted: false, rejected: [], greens: [] } }
  }
  const pick = pickRouteAndAlign(skeleton, pos0, cityId)
  const cutIds = pick ? pick.cutIds : []
  const cross0 = improperCrossCount(pos0, segs0) // 論文 D1 基準（未插綠點）
  const squareBefore = cutIds.length ? isFourLineSquare(cutIds, pos0, segs0) : false
  const clone = (m) => new Map([...m].map(([id, p]) => [id, [...p]]))
  const geo0 = clone(pos0) // 未插綠點的輸入佈局（退回基準）

  // ── 綠點：在規定路段相鄰環站之間插入轉折控制點（跟演算法本體 splitSegAt 同一套）。
  // 讓正方的四個角是綠折點——環站只要滑到邊上（小移動），不必被拉到角上（大移動），
  // network 改變最小。綠點不進 targets（凍結在角格）；成方判準 isFourLineSquare 吃
  // segs、會走綠折點的 L 形連線，所以四角綠折仍算「四邊直線正方」。──
  let pos = clone(pos0)
  let segs = cloneSegs(segs0)
  let inc = rebuildInc(segs)
  const greens = []
  let gi = 0
  const cl = (c, lim) => Math.max(0, Math.min(lim - 1, c))
  for (const spec of (greenSpecs ?? [])) {
    if (greens.length >= 4) break // 方形至多 4 個角綠折
    const a = spec.a, b = spec.b
    if (!Number.isInteger(spec.c) || !Number.isInteger(spec.r)) continue
    const si = segs.findIndex((s) => (s.a === a && s.b === b) || (s.a === b && s.b === a))
    if (si < 0) continue // a、b 之間沒有直接段——略過（回報在 greensRejected）
    const gid = `shape-g${gi++}`
    inc = splitSegAt(segs, pos, si, gid, [cl(spec.c, cols), cl(spec.r, rows)])
    greens.push({ id: gid, c: cl(spec.c, cols), r: cl(spec.r, rows), a, b })
  }
  const geo = clone(pos) // 含綠點（在角格）的基準

  const targets = new Map()
  for (const [id, t] of targetEntries) {
    if (!pos.has(id) || isShapeGreenId(id)) continue // 綠點凍結、不接受外部移動
    if (!Array.isArray(t) || !Number.isInteger(t[0]) || !Number.isInteger(t[1])) continue
    targets.set(id, [cl(t[0], cols), cl(t[1], rows)])
  }

  const pathSet = new Set(cutIds)
  const frozen = new Set([...targets.keys(), ...greens.map((g) => g.id)])

  // 策略 A（原子整批）：目標格「一次到位」（不經逐點中間態），被壓到的非目標站推離，
  // 再用論文 D1 整體把關——過關就採用。這讓 LLM 直接指定完整正方一次成形（逐點貪心
  // 會被中間態的暫時交叉卡死）。**被推擠到的點也可再移動**（只要最終不破 D1）。
  let chosen = null
  let via = 'greedy'
  if (targets.size) {
    const tcells = new Set()
    let dup = false
    for (const [, t] of targets) {
      const k = ckey(t[0], t[1])
      if (tcells.has(k)) { dup = true; break }
      tcells.add(k)
    }
    if (!dup) {
      const trial = clone(geo)
      for (const [id, t] of targets) trial.set(id, t)
      resolveCellClashes(trial, frozen, cols, rows) // 被壓到的非凍結站→最近空格（自由讓開）
      if (!hasPointOverlap(trial, segs) && topoPlanarOk(trial, segs, cross0)) {
        chosen = trial
        via = 'batch'
      }
    }
  }
  // 策略 B（退回）：逐點貪心朝目標移動——A 不過關時至少安全推進
  if (!chosen) chosen = topoSafeTowardTargets(geo, targets, segs, inc, cols, rows, pathSet)

  // 保險：再驗論文 D1；不符則整批退回（連綠點一起退回到未插綠的輸入）
  const ironOk = topoPlanarOk(chosen, segs, cross0)
  const reverted = !ironOk
  // 收方後回歸：正方（環站＋綠折）鎖住，其餘被推開的站拉回原相對位置（不破 D1），
  // 讓 network 形狀與原圖差異最小。geo0＝未插綠的輸入位置＝回歸目標。
  let settled = 0
  if (!reverted) {
    // 環站可沿方邊/經綠折點微調回歸（守成方）；其餘站自由回歸（守 D1）；綠折點凍結。
    const s = settleTowardOriginal(chosen, geo0, segs, cols, rows, cutIds, cross0)
    chosen = s.pos
    settled = s.settled
  }
  const finalPos = reverted ? geo0 : chosen
  const finalSegs = reverted ? segs0 : segs
  const finalGreens = reverted ? [] : greens
  if (reverted) via = 'reverted'

  const cross1 = improperCrossCount(finalPos, finalSegs)
  const square = cutIds.length ? isFourLineSquare(cutIds, finalPos, finalSegs) : false
  const q = cutIds.length ? squareQuality(cutIds, finalPos) : { ar: Infinity, onEdge: 0, sides: 0 }
  const rejected = [...targets]
    .filter(([id, t]) => {
      const p = finalPos.get(id)
      return p && (p[0] !== t[0] || p[1] !== t[1])
    })
    .map(([id, t]) => ({ id, want: t, got: finalPos.get(id) }))
  let moved = 0
  for (const [id, p] of finalPos) {
    if (isShapeGreenId(id)) continue
    const s = cells.get(id)
    if (s && (s[0] !== p[0] || s[1] !== p[1])) moved++
  }

  return {
    cellAfter: finalPos,
    greens: finalGreens.map((g) => ({ id: g.id, c: g.c, r: g.r, a: g.a, b: g.b })),
    stats: {
      route: pick?.routeName ?? null,
      segs: finalSegs.length, verts: pos0.size, moved, via,
      cross0, cross1, crosses: `${cross0}→${cross1}`,
      squareBefore, square,
      greenCount: finalGreens.length,
      settled,
      quality: {
        ar: Number.isFinite(q.ar) ? +q.ar.toFixed(2) : null,
        onEdge: +(q.onEdge ?? 0).toFixed(2),
        sides: q.sides ?? 0,
        fourLine: square,
      },
      reverted,
      proposed: targets.size,
      rejected,
    },
  }
}

export { SHAPE_ZH }
export { SHAPE_SQUARE, SHAPE_PRESETS, getShapePreset, shapePresetKey } from './shapePresets.js'
