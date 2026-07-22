// Shape-Guided（Batik et al. 2022 精神）——⑨ LLM 成方（route-llm-shape）的支援機構。
// 演算法本體 buildShapeAlign（格網→貼形 layout-shape）已移除（2026-07，使用者裁決）；
// 此檔現只保留 LLM 成方需要的：規定路段選路／對齊（pickRouteAndAlign）、成方判準與
// 品質（squareQuality／wSquareBox／fourSideTargets）、綠折套用（applyShapeGreens）、
// LLM 脈絡與套用（shapeLlmContext／applyShapeLlmTargets）＋共用拓撲/幾何工具。
// 要不要算看 shapePresets（未規定＝不跑）。
import {
  buildHcGraph, makeMover,
} from '../hillClimb.js'
import {
  SHAPE_SQUARE, getShapePreset, getShapePresets,
} from './shapePresets.js'
import { isShapeGreenId, isFourLineSquare } from './shapeSquare.js'

export { isFourLineSquare }

const SHAPE_ZH = { [SHAPE_SQUARE]: '方', 0: '方', square: '方' }
const MIN_CUTS = 6
const QUALITY_AR = 1.001
const ALREADY_AR = 1.001
const QUALITY_ON_EDGE = 0.4
const QUALITY_SIDES = 4
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
function segIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  return false
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

/**
 * 依「原始邊」分組的交叉對集合——比對「哪兩條線互相穿越」而非只數交叉「數量」。
 * 這才擋得住「站的相對內外側翻面」（例：棕線本在黃線外、移動後跑到黃線內）——
 * 這種翻面會讓某兩條線新交叉，即使總交叉數沒變也不合法。綠折點屬其母邊（keyOf 回傳
 * 母邊鍵），同母邊的碎段互相不算。回傳 Set of `kA#kB`（kA<kB）。
 */
function edgeCrossKeySet(posMap, segs, keyOf) {
  const set = new Set()
  for (let i = 0; i < segs.length; i++) {
    const si = segs[i]
    const A = posMap.get(si.a), B = posMap.get(si.b)
    if (!A || !B) continue
    for (let j = i + 1; j < segs.length; j++) {
      const sj = segs[j]
      if (si.a === sj.a || si.a === sj.b || si.b === sj.a || si.b === sj.b) continue
      const ki = keyOf(i), kj = keyOf(j)
      if (ki === kj) continue // 同一條原始邊的碎段（綠折）互穿不算
      const C = posMap.get(sj.a), D = posMap.get(sj.b)
      if (!C || !D) continue
      if (segIntersect(A, B, C, D)) set.add(ki < kj ? `${ki}#${kj}` : `${kj}#${ki}`)
    }
  }
  return set
}

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

function cyclicEqual(a, b) {
  if (a.length !== b.length) return false
  if (!a.length) return true
  const start = b.indexOf(a[0])
  if (start < 0) return false
  for (let i = 1; i < a.length; i++) if (a[i] !== b[(start + i) % b.length]) return false
  return true
}

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
function extractRouteStations(rt, pos, segment) {
  let ids = dedupeAdj((rt.stations ?? []).filter((id) => pos.has(id)))
  if (segment === 'first-cycle') {
    ids = firstCycle(ids) ?? []
  }
  return ids
}

/** 單一規定路段 → pick（找路線、解析環站、對齊引導方）；解析不到回 null。 */
function pickOneRing(list, preset, pos) {
  const matched = list.find((r) => r.id === preset.routeId)
    ?? list.find((r) => preset.nameRe.test(r.name ?? '')
      && (preset.segment !== 'full' || r.stations?.[0] === r.stations?.[r.stations.length - 1]
        || preset.segment === 'first-cycle'))
    ?? list.find((r) => preset.nameRe.test(r.name ?? ''))

  // 規定表站序完整存在才直接用；缺站（骨架 x* 重編）→ 從同名路線依 segment 解析
  let cutIds = dedupeAdj((preset.stations ?? []).filter((id) => pos.has(id)))
  const presetComplete = cutIds.length === dedupeAdj(preset.stations ?? []).length && cutIds.length >= MIN_CUTS
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

/** 一城全部規定環（多環）→ pick 陣列（解析不到的環略過）。 */
function pickAllRings(skeleton, pos, cityId) {
  const presets = getShapePresets(cityId)
  if (!presets?.length || !skeleton.routes?.size) return []
  const list = [...skeleton.routes.values()].filter((rt) => !String(rt.id).startsWith('river:'))
  return presets.map((p) => pickOneRing(list, p, pos)).filter(Boolean)
}

/** 向後相容：只取第一環（單環城市即唯一環）。 */
function pickRouteAndAlign(skeleton, pos, cityId) {
  const preset = getShapePreset(cityId)
  if (!preset || !skeleton.routes?.size) return null
  const list = [...skeleton.routes.values()].filter((rt) => !String(rt.id).startsWith('river:'))
  return pickOneRing(list, preset, pos)
}

export function shapeLlmContext(skeleton, cells, cols, rows, cityId) {
  const { pos, segs } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return null
  const picks = pickAllRings(skeleton, pos, cityId) // 一城多環
  if (!picks.length) return null
  const cross0 = improperCrossCount(pos, segs)
  // 邊表（連通性）——讓 LLM 能把「整條線／整個分支」當一組一起搬（整組移動）。
  const edges = segs.map((s) => [s.a, s.b])
  const dedupe = (ids) => {
    const out = []
    const seen = new Set()
    for (const id of ids) { if (!seen.has(id)) { seen.add(id); out.push(id) } }
    return out
  }
  const rings = picks.map((pick) => {
    const { cutIds } = pick
    const box = wSquareBox(pos, cutIds, cols, rows)
    const ft = box ? fourSideTargets(cutIds, box, true) : null
    const q = squareQuality(cutIds, pos)
    return {
      routeName: pick.routeName,
      routeId: pick.routeId,
      cutIds: dedupe(cutIds),
      box: box ? { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, side: box.side } : null,
      targets: ft?.targets ?? null,
      square: isFourLineSquare(cutIds, pos, segs),
      quality: {
        ar: Number.isFinite(q.ar) ? +q.ar.toFixed(2) : null,
        onEdge: +(q.onEdge ?? 0).toFixed(2),
        sides: q.sides ?? 0,
      },
    }
  })
  return {
    rings, edges, cross0,
    routeName: rings.map((r) => r.routeName).join('＋'),
    allSquare: rings.every((r) => r.square),
  }
}

/**
 * 收方後回歸：其餘被推開的站逐步拉回原相對位置——只要不破論文 D1（交叉不增／無撞格）。
 * **直線上的環站也可調整**：環站移動額外要求 isFourLineSquare 仍成立（吃 segs、會走
 * 綠折點）——所以有綠折點的地方環站有更多回歸空間、沒有的地方就沿方邊滑（都不破方）。
 * 綠折點凍結在角/彎不動。跟演算本體「W 鎖方後再跑一輪只動其餘站」同精神，讓 network
 * 形狀與原圖差異最小。回傳 { pos, settled }（settled＝實際被拉回的站數）。
 */
function settleTowardOriginal(layout, original, segs, cols, rows, cutIdsList, gate, maxPasses = 40) {
  const pos = new Map([...layout].map(([id, p]) => [id, [...p]]))
  const ringSet = new Set(cutIdsList.flat())
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
        // 完整 D1 鐵律（無壓線＋不新增互穿＋360° 環繞序）＋環站額外守成方（每一環都要守）
        const okSquare = !ringSet.has(id) || cutIdsList.every((ci) => isFourLineSquare(ci, pos, segs))
        if (gate(pos) && okSquare) {
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
  const picks = pickAllRings(skeleton, pos0, cityId) // 一城多環（如莫斯科 2 環）
  const cutIdsList = picks.map((p) => p.cutIds)
  const allCutIds = cutIdsList.flat()
  const cross0 = improperCrossCount(pos0, segs0) // 論文 D1 基準（未插綠點）
  const squareBefore = cutIdsList.length
    ? cutIdsList.every((ci) => isFourLineSquare(ci, pos0, segs0)) : false
  const clone = (m) => new Map([...m].map(([id, p]) => [id, [...p]]))
  const geo0 = clone(pos0) // 未插綠點的輸入佈局（退回基準）

  // ── 綠點：在規定路段相鄰環站之間插入轉折控制點（跟演算法本體 splitSegAt 同一套）。
  // 讓正方的四個角是綠折點——環站只要滑到邊上（小移動），不必被拉到角上（大移動），
  // network 改變最小。綠點不進 targets（凍結在角格）；成方判準 isFourLineSquare 吃
  // segs、會走綠折點的 L 形連線，所以四角綠折仍算「四邊直線正方」。──
  const ekey = (a, b) => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`)
  let pos = clone(pos0)
  let segs = cloneSegs(segs0)
  let inc = rebuildInc(segs)
  // pkey[i]＝segs[i] 所屬的原始邊鍵（綠折切開後兩半共用母鍵）——供 edgeCrossKeySet
  // 把「哪兩條線互穿」比對到原始邊層級（擋內外側翻面）。
  const pkey = segs.map((s) => ekey(s.a, s.b))
  const greens = []
  let gi = 0
  const cl = (c, lim) => Math.max(0, Math.min(lim - 1, c))
  // 每環至多 4 個角綠折（莫斯科兩環 → 上限 8）
  const greenCap = Math.max(4, picks.length * 4)
  for (const spec of (greenSpecs ?? [])) {
    if (greens.length >= greenCap) break
    const a = spec.a, b = spec.b
    if (!Number.isInteger(spec.c) || !Number.isInteger(spec.r)) continue
    const si = segs.findIndex((s) => (s.a === a && s.b === b) || (s.a === b && s.b === a))
    if (si < 0) continue // a、b 之間沒有直接段——略過（回報在 greensRejected）
    const gid = `shape-g${gi++}`
    const parent = pkey[si] // 兩半都掛母邊鍵
    inc = splitSegAt(segs, pos, si, gid, [cl(spec.c, cols), cl(spec.r, rows)])
    pkey.push(parent) // splitSegAt 把 gid-b 推到尾端，繼承母鍵；segs[si]（a-gid）保留 pkey[si]
    greens.push({ id: gid, c: cl(spec.c, cols), r: cl(spec.r, rows), a, b })
  }
  const geo = clone(pos) // 含綠點（在角格）的基準

  // 論文 D1 鐵律（LLM 成方完整版）＝三條缺一不可：
  //   ① 無撞格／無點壓線（hasPointOverlap）
  //   ② **不新增任何兩條線的互穿**（edgeCrossKeySet 比原始邊層級——擋站的相對內外
  //      側翻面，例：棕線由黃線外翻進黃線內；比只數交叉數量強）
  //   ③ 每個點連線的 360° 環繞序不變（edgeOrdersMatch，略過綠折比對真鄰居）
  const baseKeyArr = segs0.map((s) => ekey(s.a, s.b))
  const baseCross = edgeCrossKeySet(geo0, segs0, (i) => baseKeyArr[i])
  const hasNewCross = (layout) => {
    const cur = edgeCrossKeySet(layout, segs, (i) => pkey[i])
    for (const k of cur) if (!baseCross.has(k)) return true
    return false
  }
  const gate = (layout) => !hasPointOverlap(layout, segs)
    && !hasNewCross(layout)
    && edgeOrdersMatch(geo, layout, segs, inc, isShapeGreenId)

  const targets = new Map()
  for (const [id, t] of targetEntries) {
    if (!pos.has(id) || isShapeGreenId(id)) continue // 綠點凍結、不接受外部移動
    if (!Array.isArray(t) || !Number.isInteger(t[0]) || !Number.isInteger(t[1])) continue
    targets.set(id, [cl(t[0], cols), cl(t[1], rows)])
  }

  const pathSet = new Set(allCutIds)
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
      if (gate(trial)) {
        chosen = trial
        via = 'batch'
      }
    }
  }
  // 策略 B（退回）：逐點貪心朝目標移動——A 不過關時至少安全推進
  if (!chosen) chosen = topoSafeTowardTargets(geo, targets, segs, inc, cols, rows, pathSet)

  // 保險：再驗完整 D1（無壓線＋不新增互穿＋360° 環繞序）；不符則整批退回（連綠點退回）
  const ironOk = gate(chosen)
  const reverted = !ironOk
  // 收方後回歸：正方（環站＋綠折）鎖住，其餘被推開的站拉回原相對位置（不破 D1），
  // 讓 network 形狀與原圖差異最小。geo＝回歸目標＋環繞序基準；gate＝同一套鐵律。
  let settled = 0
  if (!reverted) {
    const s = settleTowardOriginal(chosen, geo, segs, cols, rows, cutIdsList, gate)
    chosen = s.pos
    settled = s.settled
  }
  const finalPos = reverted ? geo0 : chosen
  const finalSegs = reverted ? segs0 : segs
  const finalGreens = reverted ? [] : greens
  if (reverted) via = 'reverted'

  const cross1 = improperCrossCount(finalPos, finalSegs)
  // 每一環都要成方才算 square；per-ring 明細供回報。品質取「最差環」（ar 最大）。
  const ringResults = picks.map((pk) => ({
    route: pk.routeName,
    square: isFourLineSquare(pk.cutIds, finalPos, finalSegs),
    q: squareQuality(pk.cutIds, finalPos),
  }))
  const square = ringResults.length ? ringResults.every((r) => r.square) : false
  const q = ringResults.length
    ? ringResults.reduce((w, r) => (r.q.ar > (w?.ar ?? -1) ? r.q : w), null)
    : { ar: Infinity, onEdge: 0, sides: 0 }
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
      route: picks.map((p) => p.routeName).join('＋') || null,
      rings: ringResults.map((r) => ({ route: r.route, square: r.square })),
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
export { SHAPE_SQUARE, SHAPE_PRESETS, getShapePreset, getShapePresets, shapePresetKey } from './shapePresets.js'
