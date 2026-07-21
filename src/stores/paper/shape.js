// Shape-Guided（Batik et al. 2022）——依論文／開源 MetroShapes::Smooth 的整數格改編。
// 掛在 D3Tab「循環」與「逐步驗證」之間：輸入＝①〜⑧各鏈的循環結果。
// 要不要算、算哪段：一律看 shapePresets（使用者規定）；其餘城市＝不需計算。
// §4 規定路段＋擺方 → §5 LS → §6 成方且合規才交付（交叉不增、無重疊）
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
const WALK_ROUNDS = 160
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
  maxRad = 5, frozen = null, relaxCross = false,
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
    const budget = relaxCross ? crossBudget + 8 : crossBudget
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
          const cx = improperCrossCount(trial, segs)
          if (cx > budget) continue
          const d = Math.hypot(c - p[0], r - p[1])
          if (cx < bestCross || (cx === bestCross && d < bd)) {
            bestCross = cx; bd = d; best = cand
          }
        }
      }
      if (best && bestCross <= crossBudget) break
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

/** 順時針正方周界格（含角，不重複） */
function squarePerimeterCells(minX, minY, maxX, maxY) {
  const perim = []
  for (let x = minX; x < maxX; x++) perim.push([x, minY])
  for (let y = minY; y < maxY; y++) perim.push([maxX, y])
  for (let x = maxX; x > minX; x--) perim.push([x, maxY])
  for (let y = maxY; y > minY; y--) perim.push([minX, y])
  return perim
}

/**
 * 規定路段 W 依站序強制鋪正方周界；其餘站從 base 跟過來（撞格則外推）。
 * 這是「一定成方」的目標佈局。
 */
function forceSquareLayout(base, cutIds, cols, rows) {
  // 閉合環首尾同站 → 去重但保序
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ring.push(id)
  }
  if (ring.length < MIN_CUTS - 1) return null

  const pts = ring.map((id) => base.get(id)).filter(Boolean)
  if (pts.length < ring.length) return null
  let minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]))
  let minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]))
  let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const need = ring.length
  // 周界格數 ≈ 4*side；side 至少容納全部環站
  let side = Math.max(
    Math.round(Math.max(maxX - minX, maxY - minY)),
    Math.ceil(need / 4),
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
    if (box && squarePerimeterCells(box.minX, box.minY, box.maxX, box.maxY).length >= need) break
    box = null
  }
  if (!box) {
    // 最後手段：用最大可放正方
    const sMax = Math.min(cols, rows) - 1
    box = fit(Math.max(2, sMax))
  }
  if (!box) return null

  const perim = squarePerimeterCells(box.minX, box.minY, box.maxX, box.maxY)
  if (perim.length < need) return null

  const out = new Map([...base].map(([id, p]) => [id, [...p]]))
  const used = new Set()
  // 依站序均勻鋪周界（保環順序＝論文嵌形）
  for (let i = 0; i < ring.length; i++) {
    const target = Math.round((i / ring.length) * perim.length) % perim.length
    let placed = null
    for (let k = 0; k < perim.length; k++) {
      const cell = perim[(target + k) % perim.length]
      const key = ckey(cell[0], cell[1])
      if (used.has(key)) continue
      placed = cell
      used.add(key)
      break
    }
    if (!placed) return null
    out.set(ring[i], [placed[0], placed[1]])
  }

  // 其餘站：若撞到環站格，先標著等 repair 推開（此處只清同格）
  for (const [id, p] of out) {
    if (seen.has(id)) continue
    if (used.has(ckey(p[0], p[1]))) {
      // 暫移到原位附近空格（粗放；精修交給 repair）
      let found = null
      for (let rad = 1; rad <= 6 && !found; rad++) {
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
  }
  return { layout: out, box, side: box.side }
}

/** 佈局是否合規：無重疊、交叉不比輸入多 */
function layoutRulesOk(posMap, segs, cross0) {
  return !hasPointOverlap(posMap, segs) && improperCrossCount(posMap, segs) <= cross0
}

function isSquareEnough(cutIds, posMap, soft = false) {
  const q = squareQuality(cutIds, posMap)
  if (soft) return { ok: q.ar <= QUALITY_AR, q }
  return { ok: q.ok, q }
}

/**
 * 輕量修規則（快）：清重疊＋只動「交叉邊端點」的非凍結站。
 * 最多幾輪；不成也回傳目前交叉數。
 */
function lightRepairRules(posMap, segs, frozen, cols, rows, crossBudget) {
  for (let round = 0; round < 6; round++) {
    if (layoutRulesOk(posMap, segs, crossBudget)) return true
    repairPointOverlaps(posMap, segs, cols, rows, crossBudget + 5, {
      frozen, relaxCross: true, maxRad: 8,
    })
    // 只收集目前仍交叉的邊端點
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
        if (segIntersect(A, B, C, D)) {
          if (!frozen.has(si.a)) hot.add(si.a)
          if (!frozen.has(si.b)) hot.add(si.b)
          if (!frozen.has(sj.a)) hot.add(sj.a)
          if (!frozen.has(sj.b)) hot.add(sj.b)
        }
      }
    }
    let cross = improperCrossCount(posMap, segs)
    for (const id of hot) {
      if (cross <= crossBudget) break
      const p = posMap.get(id)
      const occ = new Set(
        [...posMap].filter(([oid]) => oid !== id).map(([, q]) => ckey(q[0], q[1])),
      )
      let best = null, bestC = cross
      for (let rad = 1; rad <= 6; rad++) {
        for (let dc = -rad; dc <= rad; dc++) {
          for (let dr = -rad; dr <= rad; dr++) {
            if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
            const c = Math.max(0, Math.min(cols - 1, p[0] + dc))
            const r = Math.max(0, Math.min(rows - 1, p[1] + dr))
            if (occ.has(ckey(c, r))) continue
            const trial = new Map([...posMap].map(([i, q]) => [i, [...q]]))
            trial.set(id, [c, r])
            if (stationOnForeignSeg(id, [c, r], trial, segs)) continue
            if (hasPointOverlap(trial, segs)) continue
            const cx = improperCrossCount(trial, segs)
            if (cx < bestC) { bestC = cx; best = [c, r] }
          }
        }
        if (best && bestC < cross) break
      }
      if (best) { posMap.set(id, best); cross = bestC }
    }
  }
  return layoutRulesOk(posMap, segs, crossBudget)
}

/** 朝目標每步 1 格，全程 makeMover.validMove——永不破壞硬規則 */
function walkAllToward(M, pos, targets, pathSet, maxRounds) {
  let movedVerts = 0
  const start = new Map([...pos].map(([id, p]) => [id, [p[0], p[1]]]))
  const order = [...targets.keys()].sort((a, b) =>
    (pathSet.has(a) ? 0 : 1) - (pathSet.has(b) ? 0 : 1)
    || String(a).localeCompare(String(b)))
  for (let round = 0; round < maxRounds; round++) {
    let any = false
    for (const id of order) {
      const t = targets.get(id)
      const cur = pos.get(id)
      if (!t || !cur) continue
      if (cur[0] === t[0] && cur[1] === t[1]) continue
      const dc = Math.sign(t[0] - cur[0])
      const dr = Math.sign(t[1] - cur[1])
      const cands = []
      if (dc && dr) cands.push([cur[0] + dc, cur[1] + dr])
      if (dc) cands.push([cur[0] + dc, cur[1]])
      if (dr) cands.push([cur[0], cur[1] + dr])
      for (const P of cands) {
        if (P[0] === cur[0] && P[1] === cur[1]) continue
        if (!M.validMove(id, P)) continue
        M.applyMove(id, P)
        any = true
        break
      }
    }
    if (!any) break
  }
  for (const [id, p] of pos) {
    const s = start.get(id)
    if (!s || s[0] !== p[0] || s[1] !== p[1]) movedVerts++
  }
  return movedVerts
}

/** 若佈局已成方且合規 → 套用；否則 null */
function tryAtomicSquare(layout, cutIds, pathSet, segs, cols, rows, cross0, softSquare) {
  const scratch = new Map([...layout].map(([id, p]) => [id, [...p]]))
  if (!layoutRulesOk(scratch, segs, cross0)) {
    if (!lightRepairRules(scratch, segs, pathSet, cols, rows, cross0)) return null
  }
  const { ok, q } = isSquareEnough(cutIds, scratch, softSquare)
  if (!ok || !layoutRulesOk(scratch, segs, cross0)) return null
  return { layout: scratch, q }
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
  return { snapped, sx, sy, side }
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

/* ---------- 主建置（論文三步） ---------- */
export function buildShapeAlign(skeleton, cells, cols, rows, opts = {}) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)

  const pick = pickRouteAndAlign(skeleton, pos, opts.cityId)
  if (!pick) return skipStats(pos, segs)

  const shapePoly = pick.aligned // 凍結（D5）
  const ids = [...pos.keys()].sort()
  const geo = new Map(ids.map((id) => [id, [...pos.get(id)]])) // Ωp／Ωl 錨定＝輸入格位
  const P = new Map(ids.map((id) => [id, [...pos.get(id)]]))
  const pathSet = new Set(pick.cutIds) // 論文 autoPath／W
  const shapeMeta = {
    shape: pick.shape, // 0＝方形
    shapeZh: SHAPE_ZH[pick.shape] ?? '方',
    route: pick.routeName,
    routeId: pick.routeId,
    routeSegment: pick.routeSegment,
  }

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

  // ── §5.1 平滑佈局 ──
  for (let round = 0; round < SMOOTH_ROUNDS; round++) {
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
  }

  // ── §5.2 混合佈局 ──
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

  for (let round = 0; round < MIXED_ROUNDS; round++) mixedStep()

  // 論文：W 硬嵌到凍結方形後，再跑一輪只動其餘站
  const pathOnSquare2 = mapPathOntoShape(pick.cutIds, P, shapePoly)
  for (const [id, q] of pathOnSquare2) {
    closestFixed.set(id, q)
    P.set(id, [q[0], q[1]])
  }
  for (let round = 0; round < ADJUST_ROUNDS; round++) mixedStep()

  // ── §6：成方＋合規（交叉不增、無重疊）才硬套；否則 validMove 逐步靠近 ──
  const hvBefore = countHV(pos, segs)
  const hvdBefore = countHVD(pos, segs)
  const cross0 = improperCrossCount(pos, segs)
  const overlap0 = hasPointOverlap(pos, segs)
  const M = makeMover(pos, segs, inc, cols, rows)

  const q0 = squareQuality(pick.cutIds, pos)
  if (q0.already && !overlap0) {
    return {
      cellAfter: pos,
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
        quality: { ar: +q0.ar.toFixed(2), onEdge: +q0.onEdge.toFixed(2), sides: q0.sides, square: true },
        crosses: `${cross0}→${cross0}`,
        via: 'already',
        rulesOk: true,
      },
    }
  }

  const aff = affineSquareSnap(geo, pick.cutIds, cols, rows)
  const ls = lsSquareSnap(P, pick.cutIds, shapePoly, cols, rows)

  // 原子候選：必須同時成方＋合規才套用（絕不交付交叉/重疊變差的圖）
  const atomics = []
  if (aff) {
    const pinned = forceSquareLayout(aff.snapped, pick.cutIds, cols, rows)
    if (pinned) atomics.push({ layout: pinned.layout, via: 'affine+perim', soft: false, meta: { ...aff, side: pinned.side } })
    atomics.push({ layout: aff.snapped, via: 'affine', soft: true, meta: aff })
  }
  if (ls) {
    const pinned = forceSquareLayout(ls, pick.cutIds, cols, rows)
    if (pinned) atomics.push({ layout: pinned.layout, via: 'ls+perim', soft: false, meta: { side: pinned.side } })
  }

  let accepted = null
  let affMeta
  for (const cand of atomics) {
    const ok = tryAtomicSquare(
      cand.layout, pick.cutIds, pathSet, segs, cols, rows, cross0, cand.soft,
    )
    if (!ok) continue
    accepted = { ...ok, via: cand.via }
    affMeta = cand.meta
    break
  }

  if (accepted) {
    for (const [id, p] of accepted.layout) pos.set(id, [p[0], p[1]])
  } else {
    // 合規優先：用 validMove 朝「仿射＋周界」目標走——永不破壞硬規則
    const base = aff?.snapped
      ?? ls
      ?? new Map([...geo].map(([id, p]) => [id, [...p]]))
    const pinned = forceSquareLayout(base, pick.cutIds, cols, rows)
    const targets = pinned?.layout ?? base
    if (pinned) affMeta = { side: pinned.side, ...(aff ?? {}) }
    walkAllToward(M, pos, targets, pathSet, WALK_ROUNDS)
  }

  const cross1 = improperCrossCount(pos, segs)
  const overlap1 = hasPointOverlap(pos, segs)
  // 只在「比輸入更差」時退回——輸入若已有重疊不強迫清掉
  const worsened = cross1 > cross0 || (overlap1 && !overlap0)
  if (worsened) {
    for (const [id, p] of geo) pos.set(id, [...p])
  }
  const crossFinal = worsened ? cross0 : cross1
  const qFinal = squareQuality(pick.cutIds, pos)
  const rulesOk = !worsened
  let moved = 0
  if (!worsened) {
    for (const [id, p] of pos) {
      const s = geo.get(id)
      if (!s || s[0] !== p[0] || s[1] !== p[1]) moved++
    }
  }

  return {
    cellAfter: pos,
    stats: {
      hvBefore, hvAfter: countHV(pos, segs),
      hvdBefore, hvdAfter: countHVD(pos, segs),
      segs: segs.length, verts: pos.size,
      moved, passes: 1, reverted: worsened,
      smoothRounds: SMOOTH_ROUNDS, mixedRounds: MIXED_ROUNDS,
      adjustRounds: ADJUST_ROUNDS,
      skipped: false,
      ...shapeMeta,
      shapeVerts: Sshape.size,
      score: +pick.score.toFixed(3),
      note: '→方',
      quality: {
        ar: +qFinal.ar.toFixed(2),
        onEdge: +qFinal.onEdge.toFixed(2),
        sides: qFinal.sides,
        square: qFinal.ok || qFinal.ar <= QUALITY_AR,
      },
      crosses: `${cross0}→${crossFinal}`,
      via: worsened ? 'reverted-rules' : (accepted?.via ?? 'walk+validMove'),
      rulesOk,
      affine: affMeta?.sx != null
        ? { sx: +affMeta.sx.toFixed(3), sy: +affMeta.sy.toFixed(3), side: +(+affMeta.side || 0).toFixed(2) }
        : affMeta?.side != null ? { side: affMeta.side } : undefined,
    },
  }
}

export { SHAPE_ZH }
export { SHAPE_SQUARE, SHAPE_PRESETS, getShapePreset, shapePresetKey } from './shapePresets.js'
