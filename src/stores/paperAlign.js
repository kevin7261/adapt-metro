// 七條「論文直線演算法」後處理鏈（Straighten tabs）——與 直角爬山/軸對齊/整數規劃
// 相同契約：以 Hill Climbing 的整數格佈局為輸入、短距離移動彩色頂點、產生 targets
// 後經 **同一套 §5 硬規則**（applyTargets：不壓點、不新增交叉、象限與邊環繞序不變、
// 淨對齊分數變差整批退回）套用；由 iteratePost 迭代到不動點。回傳形狀
// { cellAfter, stats }，stats 帶 hvBefore/hvAfter/segs/verts/moved/passes/reverted。
//
// 每條鏈都是對應論文核心機制的「整數格短距離後處理」改編（原論文多為全圖佈局器；
// 這裡的輸入已是示意格網化＋爬山後的佈局，所以取其方向指派／能量模型／路徑簡化的
// 核心，座標變動以 WINDOW 格為上限——與整數規劃鏈的 ±2 視窗同精神）。忠實度與
// 簡化點逐條記在各 build 函式的註解與對應 skill。
//
//   stroke  ① Li & Dong 2010 筆畫法（stroke-based）        [route-stroke-align]
//   milp    ③ Nöllenburg & Wolff 2011 MILP                 [route-milp-align]
//   force   ④ Hong et al. 2006 力導向（磁力彈簧）          [route-force-align]
//   lsq     ⑤ Wang & Chi 2011 最小平方（Focus+Context）    [route-lsq-align]
//   octi    ⑥ Bast et al. 2020 八向格網圖                  [route-octi-align]
//   path    ⑦ Merrick & Gudmundsson 2007 路徑簡化          [route-path-align]
//   sat     ⑧ Fuchs 2022 SAT（＝③ 同模型、換求解器）       [route-sat-align]
//
// 接受準則用 countHVD（H/V ＋格對角 45°，同 LLM 鏈）——這七篇都是八方向系演算法，
// 用純 countHV 會把演算法刻意給的 45° 判成退步而整批退回。
//
// Pure functions in CELL SPACE: deterministic, input maps unchanged in-place
// semantics follow the other post-passes (pos is a fresh map from buildHcGraph).

import {
  buildHcGraph, makeMover, applyTargets, countHV, countHVD,
} from './hillClimb.js'
import { sharesRoute, isHVD } from './netUtil.js'

const TWO_PI = 2 * Math.PI
const WINDOW = 2 // 目標離目前位置的 Chebyshev 上限（短距離後處理——同整數規劃鏈）

/* ==================== 共用小工具 ==================== */

// 空圖的統一回傳（同 buildAxisAlign 的空 stats 形狀）。
const emptyResult = (pos, segs) => ({
  cellAfter: pos,
  stats: { hvBefore: 0, hvAfter: 0, segs: segs?.length ?? 0, verts: pos?.size ?? 0, moved: 0, passes: 0, reverted: false },
})

// 夾 WINDOW ＋界內（targets 可為連續座標——四捨五入）。回傳只含「真的要動」的格。
function clampTargets(pos, targets, cols, rows) {
  const clamped = new Map()
  for (const [id, t] of targets) {
    const cur = pos.get(id)
    const c = Math.max(cur[0] - WINDOW, Math.min(cur[0] + WINDOW, Math.round(t[0])))
    const r = Math.max(cur[1] - WINDOW, Math.min(cur[1] + WINDOW, Math.round(t[1])))
    const cc = Math.max(0, Math.min(cols - 1, c))
    const rr = Math.max(0, Math.min(rows - 1, r))
    if (cc !== cur[0] || rr !== cur[1]) clamped.set(id, [cc, rr])
  }
  return clamped
}

// targets 收尾（單批鏈共用）：夾 WINDOW → applyTargets(countHVD) → stats。
function finishPass(pos, M, segs, targets, cols, rows, extra = {}) {
  const hvBefore = countHV(pos, segs)
  const hvdBefore = countHVD(pos, segs)
  const clamped = clampTargets(pos, targets, cols, rows)
  const { moved, passes, reverted } = applyTargets(pos, M, clamped, segs, 6, countHVD)
  return {
    cellAfter: pos,
    stats: {
      hvBefore, hvAfter: countHV(pos, segs),
      hvdBefore, hvdAfter: countHVD(pos, segs),
      segs: segs.length, verts: pos.size,
      moved, passes, reverted, proposed: clamped.size,
      ...extra,
    },
  }
}

// 逐批（逐筆畫/逐路線/逐頂點）漸進套用：每批各自過 applyTargets（淨 HVD 變差
// 該批獨立退回——對應論文的 progressive 排程：先處理的定案、壞的局部提案不拖垮
// 整體）。opts.strict：批要**嚴格**改善 HVD 才收（單頂點批用——中性移動會讓
// iteratePost 永不收斂地漂移；嚴格遞增以段數為上界保證終止）。
function finishBatches(pos, M, segs, batches, cols, rows, extra = {}, opts = {}) {
  const hvBefore = countHV(pos, segs)
  const hvdBefore = countHVD(pos, segs)
  let moved = 0, passes = 0, reverted = false
  let proposed = 0, revertedN = 0
  for (const targets of batches) {
    const clamped = clampTargets(pos, targets, cols, rows)
    if (!clamped.size) continue
    proposed += clamped.size
    const cnt0 = opts.strict ? countHVD(pos, segs) : 0
    const orig = opts.strict
      ? new Map([...clamped.keys()].map((id) => [id, [...pos.get(id)]])) : null
    const r = applyTargets(pos, M, clamped, segs, 6, countHVD)
    if (opts.strict && r.moved && countHVD(pos, segs) <= cnt0) {
      // 中性（或被部份擋掉後無淨益）的批 → 回退（單頂點批：一一放回原格是安全的）。
      for (const [id, p] of orig) {
        const cur = pos.get(id)
        if (cur[0] !== p[0] || cur[1] !== p[1]) M.applyMove(id, p)
      }
      revertedN++
      continue
    }
    moved += r.moved
    passes += r.passes
    reverted ||= r.reverted
    if (r.reverted) revertedN++
  }
  return {
    cellAfter: pos,
    stats: {
      hvBefore, hvAfter: countHV(pos, segs),
      hvdBefore, hvdAfter: countHVD(pos, segs),
      segs: segs.length, verts: pos.size,
      moved, passes, reverted, proposed, revertedN, batches: batches.length,
      ...extra,
    },
  }
}

// 連續解的「對齊感知」量化（力導向/最小平方用）：頂點依 id 序逐一吸到連續位置
// 四周的整數格，取「入射段與鄰居（已量化者用其量化格）HVD 對齊數」最高、平手取
// 離連續位置近者——單純四捨五入會把連續空間的準確 45°/軸向毀掉。
function snapAligned(P, pos, segs, inc) {
  const t = new Map()
  const ids = [...P.keys()].sort()
  for (const id of ids) {
    const p = P.get(id)
    const fx = Math.floor(p[0]), fy = Math.floor(p[1])
    const cands = [[fx, fy], [fx + 1, fy], [fx, fy + 1], [fx + 1, fy + 1]]
    let best = null, bs = -1, bd = Infinity
    for (const cand of cands) {
      let sc = 0
      for (const si of inc.get(id)) {
        const s = segs[si]
        const o = s.a === id ? s.b : s.a
        const q = t.get(o) ?? [Math.round(P.get(o)[0]), Math.round(P.get(o)[1])]
        if (isHVD(cand, q)) sc++
      }
      const d = Math.hypot(cand[0] - p[0], cand[1] - p[1])
      if (sc > bs || (sc === bs && d < bd - 1e-12)) { best = cand; bs = sc; bd = d }
    }
    t.set(id, best)
  }
  return t
}

// 八方向扇區（0..7，扇區 k 的中心角 = k·45°；螢幕座標 y 向下不影響一致性）。
const sectorOf = (dx, dy) => {
  const k = Math.round(Math.atan2(dy, dx) / (Math.PI / 4))
  return ((k % 8) + 8) % 8
}
const SECTOR_VEC = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
]
// 環狀方向差（0..4）——Nöllenburg 彎折成本 bd = min(|Δ|, 8−|Δ|)：直行 0、45° 差 1…
const cyc8 = (a, b) => {
  const t = Math.abs(((a - b) % 8 + 8) % 8)
  return Math.min(t, 8 - t)
}
// 段（以 v 為端點）朝外的方向角；重合回傳 null。
const outAngle = (pos, seg, v) => {
  const o = pos.get(seg.a === v ? seg.b : seg.a)
  const p = pos.get(v)
  if (o[0] === p[0] && o[1] === p[1]) return null
  return Math.atan2(o[1] - p[1], o[0] - p[0])
}
// 角度差正規化到 [0, π]。
const angBetween = (a, b) => {
  let d = Math.abs(a - b) % TWO_PI
  if (d > Math.PI) d = TWO_PI - d
  return d
}

/* ==================== ① 筆畫法（stroke-based） ==================== */
// Li & Dong 2010：把段串成「筆畫」（同名/同路線優先＋every-best-fit 良好連續），
// 逐筆畫依「最大方向扭曲 > 45°」遞迴切成子筆畫，各子筆畫吸附 4 主方向（H/V 優先、
// 45° 為輔），成員頂點**垂直投影**到過錨點（度數最高的交點）的定向直線上。
// 漸進式：筆畫依（路線數 > 長度 > 度數）排序，先處理的頂點定案、後續筆畫視為錨。
// 改編：拓撲一致性不用論文的點在多邊形修復——targets 統一走 applyTargets 硬規則
// （擋下會翻轉拓撲的投影，效果等價於「移不動就留在原地」）。
export function buildStrokeAlign(skeleton, cells, cols, rows) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)
  const M = makeMover(pos, segs, inc, cols, rows)

  // --- FormStrokes：每個頂點上 every-best-fit 配對（共線接續，偏角 < 45°）---
  // 偏角 deflection = π − 兩出向夾角（0 = 完全直行）。只允許共享路線的段配對
  // （捷運圖：路線天然是具名筆畫——論文 §3.1）。
  const T = Math.PI / 4
  const nextSeg = new Map() // `${segIdx}|${vertexId}` -> 接續的 segIdx
  for (const [v, list] of inc) {
    if (list.length < 2) continue
    const cand = []
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const si = segs[list[i]], sj = segs[list[j]]
        if (!sharesRoute(si.routes, sj.routes)) continue
        const a1 = outAngle(pos, si, v), a2 = outAngle(pos, sj, v)
        if (a1 == null || a2 == null) continue
        const def = Math.PI - angBetween(a1, a2)
        if (def < T) cand.push([def, list[i], list[j]])
      }
    }
    cand.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2])
    const used = new Set()
    for (const [, si, sj] of cand) {
      if (used.has(si) || used.has(sj)) continue
      used.add(si); used.add(sj)
      nextSeg.set(`${si}|${v}`, sj)
      nextSeg.set(`${sj}|${v}`, si)
    }
  }
  // 由配對關係走出筆畫（頂點鏈）。從「無接續」的一端開始走到底。
  const segUsed = new Array(segs.length).fill(false)
  const strokes = [] // { ids: [vertexId...], routes:Set }
  const walk = (startSeg, startV) => {
    const ids = [startV]
    let si = startSeg
    let v = startV
    for (;;) {
      segUsed[si] = true
      const s = segs[si]
      const u = s.a === v ? s.b : s.a
      ids.push(u)
      const nx = nextSeg.get(`${si}|${u}`)
      if (nx == null || segUsed[nx]) break
      si = nx
      v = u
    }
    return ids
  }
  for (let si = 0; si < segs.length; si++) {
    if (segUsed[si]) continue
    const s = segs[si]
    // 找沒有接續的那一端當起點（兩端都有接續＝環，任取 a）。
    const start = nextSeg.get(`${si}|${s.a}`) == null || segUsed[nextSeg.get(`${si}|${s.a}`)] ? s.a
      : nextSeg.get(`${si}|${s.b}`) == null || segUsed[nextSeg.get(`${si}|${s.b}`)] ? s.b : s.a
    const ids = walk(si, start)
    const routes = new Set()
    for (const id of ids) for (const k of inc.get(id)) for (const r of segs[k].routes) routes.add(r)
    strokes.push({ ids, routes })
  }
  // 排序（式 3）：路線數（type）> 弧長 > 交點數。
  const arcLen = (ids) => {
    let m = 0
    for (let i = 1; i < ids.length; i++) {
      const A = pos.get(ids[i - 1]), B = pos.get(ids[i])
      m += Math.hypot(B[0] - A[0], B[1] - A[1])
    }
    return m
  }
  const degSum = (ids) => ids.reduce((n, id) => n + inc.get(id).length, 0)
  strokes.sort((x, y) => y.routes.size - x.routes.size || arcLen(y.ids) - arcLen(x.ids)
    || degSum(y.ids) - degSum(x.ids))

  // --- 逐筆畫：遞迴切分 → 4 主方向吸附 → 垂直投影 ---
  const targets = new Map()
  const fixed = new Set() // 先處理的筆畫定案的頂點——後續筆畫不再改它
  let strokesN = 0, subN = 0
  const at = (id) => targets.get(id) ?? pos.get(id)
  const orient = (ids) => { // 子筆畫吸附方向：H/V 優先（偏差可多容 7.5°），否則 45°
    const A = at(ids[0]), B = at(ids[ids.length - 1])
    const ang = Math.atan2(B[1] - A[1], B[0] - A[0])
    const devTo = (base) => Math.min(angBetween(ang, base), angBetween(ang, base + Math.PI))
    const devH = devTo(0), devV = devTo(Math.PI / 2)
    const devD1 = devTo(Math.PI / 4), devD2 = devTo(3 * Math.PI / 4)
    const hv = Math.min(devH, devV), dg = Math.min(devD1, devD2)
    if (hv <= dg + Math.PI / 24) return devH <= devV ? 0 : 2 // 主方向偏好（論文 §4.3）
    return devD1 <= devD2 ? 1 : 3 // 扇區 1 / 3（45° / 135°）
  }
  const project = (ids) => {
    subN++
    const dirSec = orient(ids)
    const [ux, uy] = SECTOR_VEC[dirSec]
    const un = Math.hypot(ux, uy)
    // 錨點＝度數最高者（交點權重高——論文 §5.1 的 common 值），並取「不動」為先。
    let anchor = ids[0]
    for (const id of ids) {
      if (fixed.has(id) && !fixed.has(anchor)) { anchor = id; continue }
      if (fixed.has(anchor) && !fixed.has(id)) continue
      if (inc.get(id).length > inc.get(anchor).length) anchor = id
    }
    const A = at(anchor)
    for (const id of ids) {
      if (fixed.has(id)) continue
      const p = at(id)
      const t = ((p[0] - A[0]) * ux + (p[1] - A[1]) * uy) / (un * un)
      targets.set(id, [A[0] + t * ux, A[1] + t * uy])
    }
  }
  // 最大方向扭曲切分（類 DP、準則是「角度」非垂距——論文 §4.2 方法一）。
  const split = (ids) => {
    if (ids.length < 2) return
    const A = at(ids[0]), B = at(ids[ids.length - 1])
    const base = Math.atan2(B[1] - A[1], B[0] - A[0])
    let worst = 0, wi = -1
    for (let i = 1; i < ids.length - 1; i++) {
      const p = at(ids[i])
      if (p[0] === A[0] && p[1] === A[1]) continue
      const d = angBetween(Math.atan2(p[1] - A[1], p[0] - A[0]), base)
      if (d > worst) { worst = d; wi = i }
    }
    if (worst > T && wi > 0) {
      split(ids.slice(0, wi + 1))
      split(ids.slice(wi))
    } else {
      project(ids)
    }
  }
  const batches = []
  for (const st of strokes) {
    if (st.ids.length < 2) continue
    strokesN++
    const before = new Set(targets.keys())
    split(st.ids)
    // 本筆畫新產生的 targets 自成一批（漸進式：逐筆畫套用、壞提案獨立退回）。
    const batch = new Map()
    for (const [id, t] of targets) if (!before.has(id)) batch.set(id, t)
    if (batch.size) batches.push(batch)
    for (const id of st.ids) fixed.add(id) // 漸進式：本筆畫定案
  }
  return finishBatches(pos, M, segs, batches, cols, rows, { strokes: strokesN, substrokes: subN })
}

/* ==================== ③/⑧ 共用：方向指派模型 ==================== */
// Nöllenburg 模型的方向階段（③ 與 ⑧ 完全同模型，只換求解器——Fuchs 論文的定位）：
// 每段 3 個候選方向（目前幾何的最近八方向扇區 ±1，dev=1），成本 =
//   λ1·Σ 同路線相鄰段彎折 bd（S1） + λ2·Σ 非 orig 候選（S2 相對位置）；
// 硬限制：同頂點兩段不得同向（H2 環繞序的可線性化部份）。
// 回傳每段選定的扇區（Map<segIdx, sector>）。
const L1 = 3, L2 = 2 // 論文權重 (λ_S1, λ_S2) = (3, 2)（S3 由座標階段隱含）

function dirModel(pos, segs, inc) {
  const orig = segs.map((s) => {
    const A = pos.get(s.a), B = pos.get(s.b)
    return sectorOf(B[0] - A[0], B[1] - A[1]) // a→b 的參考方向
  })
  const candOf = (si) => [(orig[si] + 7) % 8, orig[si], (orig[si] + 1) % 8]
  // 頂點上的段對（i<j）＋是否同路線（決定要不要算彎折）。
  const pairs = [] // { si, sj, v, coline }
  for (const [v, list] of inc) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        pairs.push({ si: list[i], sj: list[j], v, coline: sharesRoute(segs[list[i]].routes, segs[list[j]].routes) })
      }
    }
  }
  // 段在頂點 v 的「出向」扇區：a→b 方向為 d，從 a 出發＝d、從 b 出發＝d+4。
  const outSec = (si, v, d) => (segs[si].a === v ? d : (d + 4) % 8)
  // 對成本：同向（出向相同）＝硬 veto；同路線＝彎折 bd（180° 直行 0…45° 3）。
  const pairCost = (p, di, dj) => {
    const oi = outSec(p.si, p.v, di), oj = outSec(p.sj, p.v, dj)
    if (oi === oj) return Infinity
    if (!p.coline) return 0
    return L1 * (4 - cyc8(oi, oj)) // bd = 4 − 環狀差（對向 4 → 0 成本；同向已 veto）
  }
  const unary = (si, d) => (d === orig[si] ? 0 : L2)
  return { orig, candOf, pairs, pairCost, unary }
}

// 方向指派 → 座標重建：迭代鬆弛（shape-matching 式）。每輪逐段把兩端往「沿選定
// 方向、長度＝目前投影長（下限 1 格）」的理想相對位置拉。連續空間收斂後由
// snapAligned 做對齊感知量化、finishPass 夾 WINDOW ＋硬規則（S3 緊湊由段長貼
// 理想值隱含；不加錨定項——targets 的 WINDOW 夾擠已限制位移）。
function coordsFromDirs(pos, segs, dirs) {
  const P = new Map([...pos].map(([id, p]) => [id, [p[0], p[1]]]))
  const ROUNDS = 40
  for (let r = 0; r < ROUNDS; r++) {
    for (let si = 0; si < segs.length; si++) {
      const d = dirs.get(si)
      if (d == null) continue
      const s = segs[si]
      const A = P.get(s.a), B = P.get(s.b)
      const [ux, uy] = SECTOR_VEC[d]
      const un = Math.hypot(ux, uy)
      // 目前沿方向的投影長（下限 1 格），重建理想 B′ = A + u·len。
      const proj = ((B[0] - A[0]) * ux + (B[1] - A[1]) * uy) / un
      const len = Math.max(1, proj)
      const tx = A[0] + (ux / un) * len, ty = A[1] + (uy / un) * len
      const ex = (B[0] - tx) / 2, ey = (B[1] - ty) / 2
      A[0] += ex; A[1] += ey
      B[0] -= ex; B[1] -= ey
    }
  }
  return P
}

/* ==================== ③ MILP（Nöllenburg & Wolff） ==================== */
// 方向指派用「配對圖分元件 → 生成樹 DP ＋ feedback 頂點枚舉」**精確**求解（與
// 整數規劃鏈同一求解機構，但變數是段的八方向、成本是 S1 彎折＋S2 相對位置——
// 對應論文的全域最優性）；座標指派＝方向約束下的鬆弛重建。
// 改編：H4 邊距／平面性不進模型——由 applyTargets 的硬規則把關（等價於論文的
// lazy constraint：違規的移動直接不套用）。deg-2 已在骨架階段收縮（黑點）。
export function buildMilpAlign(skeleton, cells, cols, rows) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)
  const M = makeMover(pos, segs, inc, cols, rows)
  const model = dirModel(pos, segs, inc)

  // 元件分解：段為節點、共享頂點的段對為邊。
  const adj = new Map() // segIdx -> [pairIdx]
  model.pairs.forEach((p, pi) => {
    if (!adj.has(p.si)) adj.set(p.si, [])
    if (!adj.has(p.sj)) adj.set(p.sj, [])
    adj.get(p.si).push(pi)
    adj.get(p.sj).push(pi)
  })
  const dirs = new Map()
  let comps = 0, fallback = 0
  const seen = new Set()
  const allSegs = [...Array(segs.length).keys()]
  for (const start of allSegs) {
    if (seen.has(start)) continue
    // BFS 收元件
    const nodes = []
    const stack = [start]
    seen.add(start)
    while (stack.length) {
      const u = stack.pop()
      nodes.push(u)
      for (const pi of adj.get(u) ?? []) {
        const p = model.pairs[pi]
        const v = p.si === u ? p.sj : p.si
        if (!seen.has(v)) { seen.add(v); stack.push(v) }
      }
    }
    nodes.sort((a, b) => a - b)
    comps++
    // 生成樹＋回邊 → feedback 段集合（同 buildAxisIlp 的機構）。
    const treeAdj = new Map(nodes.map((n) => [n, []]))
    const backPairs = []
    const inTree = new Set([nodes[0]])
    const queue = [nodes[0]]
    const usedPair = new Set()
    while (queue.length) {
      const u = queue.shift()
      for (const pi of adj.get(u) ?? []) {
        if (usedPair.has(pi)) continue
        usedPair.add(pi)
        const p = model.pairs[pi]
        const v = p.si === u ? p.sj : p.si
        if (inTree.has(v)) { backPairs.push(pi); continue }
        inTree.add(v)
        treeAdj.get(u).push({ v, pi })
        treeAdj.get(v).push({ v: u, pi })
        queue.push(v)
      }
    }
    const fb = []
    for (const pi of backPairs) {
      const p = model.pairs[pi]
      if (!fb.includes(p.si) && !fb.includes(p.sj)) fb.push(p.si)
    }
    const trials = 3 ** fb.length
    if (trials > 2187 || trials * nodes.length > 2e6) { fallback++; continue } // 保持原方向
    const fbSet = new Set(fb)
    const pairAt = (pi, u, du, v, dv) => {
      const p = model.pairs[pi]
      return p.si === u ? model.pairCost(p, du, dv) : model.pairCost(p, dv, du)
    }
    let bestScore = Infinity, bestDirs = null
    const fixedVal = new Map()
    const trialDirs = new Map()
    const runTrial = () => {
      let total = 0
      trialDirs.clear()
      for (const u of fb) {
        total += model.unary(u, fixedVal.get(u))
        trialDirs.set(u, fixedVal.get(u))
      }
      for (const pi of backPairs) { // fb–fb 對＝常數
        const p = model.pairs[pi]
        if (!fbSet.has(p.si) || !fbSet.has(p.sj)) continue
        total += model.pairCost(p, fixedVal.get(p.si), fixedVal.get(p.sj))
        if (total === Infinity) return
      }
      const done = new Set(fb)
      for (const root of nodes) {
        if (done.has(root)) continue
        // 樹 DP（後序）：dp[u][ci] = u 取候選 ci 時子樹最小成本。
        const post = []
        const st = [[root, null]]
        while (st.length) {
          const [u, par] = st.pop()
          done.add(u)
          post.push([u, par])
          for (const { v } of treeAdj.get(u)) {
            if (v === par || fbSet.has(v)) continue
            st.push([v, u])
          }
        }
        const dpOf = new Map(), pickOf = new Map()
        for (let i = post.length - 1; i >= 0; i--) {
          const [u, par] = post[i]
          const candU = model.candOf(u)
          const dp = candU.map((d) => {
            let sc = model.unary(u, d)
            for (const pi of adj.get(u) ?? []) { // u–feedback 對＝一元化
              const p = model.pairs[pi]
              const v = p.si === u ? p.sj : p.si
              if (!fbSet.has(v)) continue
              sc += pairAt(pi, u, d, v, fixedVal.get(v))
              if (sc === Infinity) break
            }
            return sc
          })
          for (const { v, pi } of treeAdj.get(u)) {
            if (v === par || fbSet.has(v)) continue
            const candV = model.candOf(v), dpv = dpOf.get(v)
            const pick = new Array(candU.length)
            for (let a = 0; a < candU.length; a++) {
              if (dp[a] === Infinity) continue
              let best = Infinity, bj = -1
              for (let j = 0; j < candV.length; j++) {
                if (dpv[j] === Infinity) continue
                const sc = dpv[j] + pairAt(pi, u, candU[a], v, candV[j])
                if (sc < best) { best = sc; bj = j }
              }
              dp[a] = bj < 0 ? Infinity : dp[a] + best
              pick[a] = bj
            }
            pickOf.set(`${u}|${v}`, pick)
          }
          dpOf.set(u, dp)
        }
        const candR = model.candOf(root), dpr = dpOf.get(root)
        let bi = -1, bv = Infinity
        for (let a = 0; a < candR.length; a++) if (dpr[a] < bv) { bv = dpr[a]; bi = a }
        if (bi < 0) { total = Infinity; break }
        total += bv
        const walk = [[root, null, bi]]
        while (walk.length) {
          const [u, par, ai] = walk.pop()
          trialDirs.set(u, model.candOf(u)[ai])
          for (const { v } of treeAdj.get(u)) {
            if (v === par || fbSet.has(v)) continue
            walk.push([v, u, pickOf.get(`${u}|${v}`)[ai]])
          }
        }
      }
      if (total < bestScore) { bestScore = total; bestDirs = new Map(trialDirs) }
    }
    const spin = (i) => {
      if (i === fb.length) { runTrial(); return }
      for (const d of model.candOf(fb[i])) { fixedVal.set(fb[i], d); spin(i + 1) }
    }
    spin(0)
    if (bestDirs) for (const [si, d] of bestDirs) dirs.set(si, d)
  }
  const targets = snapAligned(coordsFromDirs(pos, segs, dirs), pos, segs, inc)
  return finishPass(pos, M, segs, targets, cols, rows, { comps, fallback })
}

/* ==================== ⑧ SAT（Fuchs） ==================== */
// 同 ③ 的模型（每段 3 候選、一熱、同頂點不同向硬子句、S1/S2 軟子句），但求解器
// 換成 **DPLL 分支定界**（MaxSAT 語意：走訪佈林指派樹、單元傳播同頂點 veto、
// 以目前最佳成本剪枝）——對應論文「同模型、換求解技術」的定位。節點上限保證
// 終止；超限的元件退回原方向（論文大實例 timeout 的對應行為）。
export function buildSatAlign(skeleton, cells, cols, rows) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)
  const M = makeMover(pos, segs, inc, cols, rows)
  const model = dirModel(pos, segs, inc)

  const adj = new Map()
  model.pairs.forEach((p, pi) => {
    if (!adj.has(p.si)) adj.set(p.si, [])
    if (!adj.has(p.sj)) adj.set(p.sj, [])
    adj.get(p.si).push(pi)
    adj.get(p.sj).push(pi)
  })
  const dirs = new Map()
  let comps = 0, fallback = 0
  const seen = new Set()
  for (let start = 0; start < segs.length; start++) {
    if (seen.has(start)) continue
    const nodes = []
    const stack = [start]
    seen.add(start)
    while (stack.length) {
      const u = stack.pop()
      nodes.push(u)
      for (const pi of adj.get(u) ?? []) {
        const p = model.pairs[pi]
        const v = p.si === u ? p.sj : p.si
        if (!seen.has(v)) { seen.add(v); stack.push(v) }
      }
    }
    comps++
    // 分支順序：最受限（配對數多）優先——DPLL 的 most-constrained heuristic。
    nodes.sort((a, b) => (adj.get(b)?.length ?? 0) - (adj.get(a)?.length ?? 0) || a - b)
    const order = nodes
    const idxOf = new Map(order.map((n, i) => [n, i]))
    let budget = 60000 // 分支節點上限（實測百段級元件遠低於此）
    let bestScore = Infinity, bestAssign = null
    const assign = new Map()
    const dfs = (i, acc) => {
      if (acc >= bestScore || budget <= 0) return
      if (i === order.length) { bestScore = acc; bestAssign = new Map(assign); return }
      const u = order[i]
      for (const d of model.candOf(u)) {
        budget--
        // 累積成本：u 與所有已指派鄰居的對成本＋自身一元成本（單元 veto 內含）。
        let add = model.unary(u, d)
        for (const pi of adj.get(u) ?? []) {
          const p = model.pairs[pi]
          const v = p.si === u ? p.sj : p.si
          if (!assign.has(v)) continue
          const c = p.si === u ? model.pairCost(p, d, assign.get(v)) : model.pairCost(p, assign.get(v), d)
          if (c === Infinity) { add = Infinity; break }
          add += c
        }
        if (add === Infinity) continue
        assign.set(u, d)
        dfs(i + 1, acc + add)
        assign.delete(u)
      }
    }
    dfs(0, 0)
    if (bestAssign && budget > 0) {
      for (const [si, d] of bestAssign) dirs.set(si, d)
    } else {
      fallback++ // timeout（budget 用盡）＝一無所有——退回原方向（論文 SAT 版行為）
    }
    void idxOf
  }
  const targets = snapAligned(coordsFromDirs(pos, segs, dirs), pos, segs, inc)
  return finishPass(pos, M, segs, targets, cols, rows, { comps, fallback })
}

/* ==================== ④ 力導向（Hong et al. 磁力彈簧） ==================== */
// Method 5 的力模型在格空間跑固定輪數：彈簧引力（理想邊長）＋頂點對斥力＋
// 頂點×不相鄰邊斥力＋八方向磁場力（每邊只受最近方向、垂直於邊的力偶）。
// 初始佈局＝目前整數格位置（＝論文 §3.5「保留地理嵌入的變體」——PrEd 的 8 區域
// 移動限制由 applyTargets 硬規則等價把關）。deg-2 已在骨架收縮。確定性：固定
// 頂點順序、無隨機（GEM 階段以現有佈局取代）。
export function buildForceAlign(skeleton, cells, cols, rows) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)
  const M = makeMover(pos, segs, inc, cols, rows)

  // 理想邊長：中位每跳長（同爬山法的 L），邊權 = hops（吞掉的黑點數，上限 W）。
  const lens = segs.map((s) => {
    const A = pos.get(s.a), B = pos.get(s.b)
    return Math.hypot(B[0] - A[0], B[1] - A[1]) / s.hops
  }).sort((a, b) => a - b)
  const L = Math.max(1, lens[lens.length >> 1] || 1)
  const Wcap = 6 // 邊權上限（論文 W=25 是站數尺度；這裡骨架 hops 通常個位數）
  const GAMMA = 1.5 * L // 頂點×邊期望距離
  const CM = 0.1, BM = 8.0, ALPHA = 0.5, BETA = 0.5 // 磁場力參數（格空間尺度——
  // 論文 c_m=0.1, b=30, α=1, β=0.5 是像素尺度；格空間把 b 縮小、α 降 0.5 防長邊
  // 力偶爆掉，量級調到與彈簧/斥力抗衡（磁力要能贏，八方向對齊才會發生）。
  const STEP = 0.25 // 每輪每頂點位移上限（格）——短距離後處理的溫度
  const ids = [...pos.keys()].sort()
  const P = new Map(ids.map((id) => [id, [...pos.get(id)]]))
  const ROUNDS = 40
  for (let r = 0; r < ROUNDS; r++) {
    const F = new Map(ids.map((id) => [id, [0, 0]]))
    // 彈簧（式 1）：沿邊、朝理想長度（引力/斥力合一：過長拉近、過短推開）。
    for (const s of segs) {
      const A = P.get(s.a), B = P.get(s.b)
      const dx = B[0] - A[0], dy = B[1] - A[1]
      const d = Math.hypot(dx, dy) || 1e-9
      const ideal = L * Math.min(Wcap, s.hops)
      const f = (d - ideal) / d * 0.5
      F.get(s.a)[0] += dx * f; F.get(s.a)[1] += dy * f
      F.get(s.b)[0] -= dx * f; F.get(s.b)[1] -= dy * f
    }
    // 頂點對斥力（式 1）：δ²/d² 沿連線推開（只算近的，遠場影響極小）。
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const A = P.get(ids[i]), B = P.get(ids[j])
        const dx = B[0] - A[0], dy = B[1] - A[1]
        const d2 = dx * dx + dy * dy
        if (d2 > (3 * L) * (3 * L) || d2 < 1e-9) continue
        const f = (L * L) / d2 * 0.3 / Math.sqrt(d2)
        F.get(ids[i])[0] -= dx * f; F.get(ids[i])[1] -= dy * f
        F.get(ids[j])[0] += dx * f; F.get(ids[j])[1] += dy * f
      }
    }
    // 頂點×不相鄰邊斥力（式 2）：投影落在段內且距離 < γ 才作用。
    for (const id of ids) {
      const p = P.get(id)
      const incSet = new Set(inc.get(id))
      for (let si = 0; si < segs.length; si++) {
        if (incSet.has(si)) continue
        const s = segs[si]
        if (s.a === id || s.b === id) continue
        const A = P.get(s.a), B = P.get(s.b)
        const dx = B[0] - A[0], dy = B[1] - A[1]
        const l2 = dx * dx + dy * dy
        if (l2 < 1e-9) continue
        const t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / l2
        if (t < 0 || t > 1) continue
        const ix = A[0] + t * dx, iy = A[1] + t * dy
        const d = Math.hypot(p[0] - ix, p[1] - iy)
        if (d >= GAMMA || d < 1e-9) continue
        const f = ((GAMMA - d) * (GAMMA - d)) / d * 0.05 / d
        F.get(id)[0] += (p[0] - ix) * f
        F.get(id)[1] += (p[1] - iy) * f
      }
    }
    // 磁場力（式 4）：每邊取最近八方向，力偶垂直於邊、兩端反向。
    for (const s of segs) {
      const A = P.get(s.a), B = P.get(s.b)
      const dx = B[0] - A[0], dy = B[1] - A[1]
      const d = Math.hypot(dx, dy)
      if (d < 1e-9) continue
      const ang = Math.atan2(dy, dx)
      const sec = sectorOf(dx, dy)
      const target = sec * Math.PI / 4
      let diff = ang - target
      while (diff > Math.PI) diff -= TWO_PI
      while (diff < -Math.PI) diff += TWO_PI
      const mag = CM * BM * Math.pow(d, ALPHA) * Math.pow(Math.abs(diff), BETA)
      const sgn = diff > 0 ? -1 : 1 // 把邊轉回最近方向
      // 垂直於邊的單位向量（逆時針）：(-dy, dx)/d
      const px = -dy / d, py = dx / d
      F.get(s.b)[0] += px * mag * sgn; F.get(s.b)[1] += py * mag * sgn
      F.get(s.a)[0] -= px * mag * sgn; F.get(s.a)[1] -= py * mag * sgn
    }
    // 更新（位移截斷 STEP——PrEd 區域限制的保守替代；硬規則最後把關）。
    for (const id of ids) {
      const f = F.get(id)
      const m = Math.hypot(f[0], f[1])
      if (m < 1e-9) continue
      const k = Math.min(1, STEP / m)
      const p = P.get(id)
      p[0] += f[0] * k
      p[1] += f[1] * k
    }
  }
  // 力平衡是「接近」八方向而非嚴格對齊（論文自承的弱點）——整批套用常淨變差被
  // 全退。改成**逐頂點批＋嚴格改善**：磁場把頂點拉向的位置裡，只收真的讓對齊
  // 變多的（等價於把力場當提案器、硬規則＋HVD 當接受器）。
  const snapped = snapAligned(P, pos, segs, inc)
  const ids2 = [...snapped.keys()].sort()
  const batches = ids2.map((id) => new Map([[id, snapped.get(id)]]))
  return finishBatches(pos, M, segs, batches, cols, rows, { rounds: ROUNDS }, { strict: true })
}

/* ==================== ⑤ 最小平方（Wang & Chi） ==================== */
// 階段二（八方向化）：每段目標向量 f(v_i − v_j) = 目前邊向量旋到最近八方向、長度
// 不變；解 min Σ|(ṽ_i−ṽ_j) − f_ij|² + w_g·Σ|ṽ_i − v_i|²（Ω_o + Ω_g，式 6）——
// 用 Gauss–Seidel 迭代（共軛梯度的輕量替代；系統小、對角佔優，收斂等價）。
// 階段一（平滑變形）不需要：輸入已是格網化＋爬山後的規律佈局。邊界/邊距/交叉
// 抑制（式 7–8、位移減半）由 applyTargets 硬規則統一把關。
export function buildLsqAlign(skeleton, cells, cols, rows) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)
  const M = makeMover(pos, segs, inc, cols, rows)

  const WG = 0.05, WO = 10 // 論文權重 w_g = 0.05、w_o = 10
  // f_ij：以「目前」邊向量就近吸附（階段二的 f；每輪重算會震盪，論文是一次吸附）。
  const fvec = segs.map((s) => {
    const A = pos.get(s.a), B = pos.get(s.b)
    const dx = B[0] - A[0], dy = B[1] - A[1]
    const d = Math.hypot(dx, dy)
    if (d < 1e-9) return [0, 0]
    const sec = sectorOf(dx, dy)
    const [ux, uy] = SECTOR_VEC[sec]
    const un = Math.hypot(ux, uy)
    return [ux / un * d, uy / un * d]
  })
  const ids = [...pos.keys()].sort()
  const P = new Map(ids.map((id) => [id, [...pos.get(id)]]))
  const ROUNDS = 60
  for (let r = 0; r < ROUNDS; r++) {
    for (const id of ids) {
      // ∂Ω/∂ṽ_i = 0 的座標更新：鄰居暗示位置的加權平均＋原位錨定。
      let sx = WG * pos.get(id)[0], sy = WG * pos.get(id)[1], w = WG
      for (const si of inc.get(id)) {
        const s = segs[si]
        const f = fvec[si]
        const o = P.get(s.a === id ? s.b : s.a)
        const sgn = s.a === id ? -1 : 1 // f 定義為 a→b：v_b = v_a + f
        sx += WO * (o[0] + sgn * f[0])
        sy += WO * (o[1] + sgn * f[1])
        w += WO
      }
      const p = P.get(id)
      p[0] = sx / w
      p[1] = sy / w
    }
  }
  return finishPass(pos, M, segs, snapAligned(P, pos, segs, inc), cols, rows, { rounds: ROUNDS })
}

/* ==================== ⑥ 八向格網（Bast et al.） ==================== */
// 逐邊在格網上定案：輸入邊依線度數 ldeg 排序（複雜轉乘樞紐先佔位——§4.1），每邊
// 的未定案端點在原位半徑 r 內的**空格**候選中選一對，成本 = 位移懲罰（(c_h+c_m)·d）
// ＋弦方向的彎折成本（非八方向付 c_45 級）＋站上與已定案同路線段的線彎懲罰
// （§4.4）；定案後該格關閉（一格一站——資源競爭即拓撲保證的對應）。
// 改編：下游模型是「彩色點之間單直段」，Bast 的多彎 Dijkstra 路徑無法表示——
// 取其「候選集＋成本模型＋貪婪定案順序」做**節點指派**（單 link 路由）；多彎
// 路由屬於 RWD 畫線器的職責（route-rwd-draw 已是同精神的 H/V/45 重繪）。
export function buildOctiAlign(skeleton, cells, cols, rows) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)
  const M = makeMover(pos, segs, inc, cols, rows)

  // ldeg(v) = 鄰接段的（不重複）路線數總和（§4.1）。
  const ldeg = new Map()
  for (const [v, list] of inc) {
    const rs = new Set()
    for (const si of list) for (const r of segs[si].routes) rs.add(r)
    ldeg.set(v, rs.size)
  }
  // 邊排序：端點 ldeg 較大者優先（完整 dangling 排程的簡化——同「複雜區先佔位」）。
  const order = [...Array(segs.length).keys()].sort((a, b) => {
    const la = Math.max(ldeg.get(segs[a].a), ldeg.get(segs[a].b))
    const lb = Math.max(ldeg.get(segs[b].a), ldeg.get(segs[b].b))
    return lb - la || a - b
  })
  // 位移懲罰＝c_m·d（論文式 8 的 (c_h+c_m)/D 中、格網邊實際成本 c′_h=0 的
  // 對應——offset 技巧下每跳成本歸零，位移只付 c_m）；非八方向弦＝至少一個
  // 45°/135° 彎（真格網路由的下界），計 c_45 = 2。
  const CMOVE = 0.5
  const BEND = [0, 3, 2, 1.5, 0] // 弦與已定案段的站上彎折成本（環狀差 0..4）
  const R = WINDOW // 候選半徑 r（論文 3D；短距離後處理夾 WINDOW）
  const settled = new Map() // id -> [c,r]
  const occupied = new Set() // 已定案格 + 其他頂點目前格（一格一站）
  for (const p of pos.values()) occupied.add(`${p[0]},${p[1]}`)
  const candsOf = (v) => {
    if (settled.has(v)) return [settled.get(v)]
    const [c0, r0] = pos.get(v)
    const out = []
    for (let dc = -R; dc <= R; dc++) {
      for (let dr = -R; dr <= R; dr++) {
        const c = c0 + dc, r = r0 + dr
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue
        const k = `${c},${r}`
        if (occupied.has(k) && !(dc === 0 && dr === 0)) continue
        out.push([c, r])
      }
    }
    return out
  }
  // 站上線彎（§4.4）：v 放在 P、弦出向 sec 時，與 v 上已定案同路線段的彎折總和。
  const stationBend = (v, P, sec, selfSi) => {
    let m = 0
    for (const si of inc.get(v)) {
      if (si === selfSi) continue
      const s = segs[si]
      if (!sharesRoute(s.routes, segs[selfSi].routes)) continue
      const u = s.a === v ? s.b : s.a
      const q = settled.get(u)
      if (!q) continue
      const osec = sectorOf(q[0] - P[0], q[1] - P[1])
      m += BEND[cyc8(sec, osec)] * 0.5
    }
    return m
  }
  for (const si of order) {
    const s = segs[si]
    const CA = candsOf(s.a), CB = candsOf(s.b)
    let best = null, bestCost = Infinity
    const pa0 = pos.get(s.a), pb0 = pos.get(s.b)
    for (const A of CA) {
      const dispA = Math.max(Math.abs(A[0] - pa0[0]), Math.abs(A[1] - pa0[1]))
      for (const B of CB) {
        if (A[0] === B[0] && A[1] === B[1]) continue
        const dispB = Math.max(Math.abs(B[0] - pb0[0]), Math.abs(B[1] - pb0[1]))
        const dx = B[0] - A[0], dy = B[1] - A[1]
        // 弦的八方向性：正對格網方向 = 0，否則以「距最近扇區的角度」計價（c_45 級）。
        const exact = dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)
        const sec = sectorOf(dx, dy)
        const angDev = exact ? 0 : angBetween(Math.atan2(dy, dx), sec * Math.PI / 4)
        let cost = (dispA + dispB) * CMOVE + (exact ? 0 : 2 + angDev / (Math.PI / 8))
        cost += stationBend(s.a, A, sec, si) + stationBend(s.b, B, (sec + 4) % 8, si)
        if (cost < bestCost - 1e-12) { bestCost = cost; best = [A, B] }
      }
    }
    if (!best) continue
    // 定案（同 Bast：起訖端就地定案、關閉資源）。
    for (const [v, P] of [[s.a, best[0]], [s.b, best[1]]]) {
      if (settled.has(v)) continue
      const old = pos.get(v)
      occupied.delete(`${old[0]},${old[1]}`)
      settled.set(v, P)
      occupied.add(`${P[0]},${P[1]}`)
    }
  }
  // 逐頂點（依定案順序）嚴格套用：貪婪定案的個別提案好壞不一，整批淨退回會把
  // 好的一起丟掉——單頂點批＋嚴格改善（同力導向的接受器）。
  const batches = [...settled].map(([id, P]) => new Map([[id, P]]))
  return finishBatches(pos, M, segs, batches, cols, rows, { settled: settled.size }, { strict: true })
}

/* ==================== ⑦ 路徑簡化（Merrick & Gudmundsson） ==================== */
// C-directed 最少 link 簡化：每條路線的彩色頂點鏈當折線 P，C = 8 方向、ε-圓刺穿，
// 求 link 數最少的八方向折線，再把頂點垂直投影到刺穿它的 link 上。逐路線漸進：
// 重要性 =「與其他路線共享的頂點數」（轉乘站數——§3 (1)），先處理的路線頂點
// **固定**，後續路線只動自己獨有的頂點（固定點機制的簡化）。
// 實作採 O(|C|²·n²) 的直觀版 reach 計算（論文自己說可以先寫直觀版）；link 位置
// 取可行 offset 區間中點、順序刺穿用貪婪參數單調驗證（Definition 1）。
export function buildPathAlign(skeleton, cells, cols, rows) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)
  const M = makeMover(pos, segs, inc, cols, rows)
  const EPS = 1.4 // ε（格）——相鄰站均距 1–2 倍的下緣（§5.9）

  // 每條路線的段集合 → 分解成最大開放鏈（頂點序列）。
  const routeSegs = new Map() // routeId -> [segIdx]
  segs.forEach((s, si) => { for (const r of s.routes) { if (!routeSegs.has(r)) routeSegs.set(r, []); routeSegs.get(r).push(si) } })
  const chainsOf = (segIdxs) => {
    const deg = new Map(), adjV = new Map()
    for (const si of segIdxs) {
      for (const v of [segs[si].a, segs[si].b]) {
        deg.set(v, (deg.get(v) ?? 0) + 1)
        if (!adjV.has(v)) adjV.set(v, [])
        adjV.get(v).push(si)
      }
    }
    const used = new Set()
    const chains = []
    const starts = [...deg.keys()].filter((v) => deg.get(v) === 1).sort()
    const walkFrom = (v0) => {
      const chain = [v0]
      let v = v0
      for (;;) {
        const nx = (adjV.get(v) ?? []).find((si) => !used.has(si))
        if (nx == null) break
        used.add(nx)
        v = segs[nx].a === v ? segs[nx].b : segs[nx].a
        chain.push(v)
      }
      return chain
    }
    for (const v0 of starts) { const c = walkFrom(v0); if (c.length >= 2) chains.push(c) }
    for (const si of segIdxs) { // 剩下的環：任取起點
      if (used.has(si)) continue
      used.add(si)
      const c = walkFrom(segs[si].a)
      if (c.length >= 2) chains.push(c)
    }
    return chains
  }
  // 路線重要性：轉乘頂點數（頂點入射段的路線 > 1 條）。
  const importance = (segIdxs) => {
    const vs = new Set()
    for (const si of segIdxs) { vs.add(segs[si].a); vs.add(segs[si].b) }
    let n = 0
    for (const v of vs) {
      const rs = new Set()
      for (const si of inc.get(v)) for (const r of segs[si].routes) rs.add(r)
      if (rs.size > 1) n++
    }
    return n
  }
  const routeOrder = [...routeSegs.keys()].sort((a, b) =>
    importance(routeSegs.get(b)) - importance(routeSegs.get(a)) || String(a).localeCompare(String(b)))

  const targets = new Map()
  const batches = []
  const fixed = new Set()
  const at = (id) => targets.get(id) ?? pos.get(id)
  const DIR8 = [0, 1, 2, 3, 4, 5, 6, 7] // 8 方向（|C|=8——順序刺穿沿行進方向單調，反向要自己的方向）
  let linksTotal = 0, chainsN = 0
  for (const r of routeOrder) {
    for (const chain of chainsOf(routeSegs.get(r))) {
      const pts = chain.map((id) => at(id))
      const n = pts.length
      if (n < 3) continue
      chainsN++
      // reach[i][c]：從點 i 起、方向 c 的單一 link 能依序刺穿到的最遠索引。
      // 固定點的 ε 收縮成 0（「恰過該點」——§3 (3) 的固定點機制）。
      const epsOf = (k) => (fixed.has(chain[k]) ? 1e-6 : EPS)
      const reach = (i, c) => {
        const th = c * Math.PI / 4
        const ux = Math.cos(th), uy = Math.sin(th)
        const nx = -uy, ny = ux
        let lo = -Infinity, hi = Infinity
        let j = i
        for (let k = i; k < n; k++) {
          const off = pts[k][0] * nx + pts[k][1] * ny
          lo = Math.max(lo, off - epsOf(k))
          hi = Math.min(hi, off + epsOf(k))
          if (lo > hi) break
          // 順序刺穿：取 offset = 區間中點，驗證沿 link 參數可單調（貪婪）。
          const o = (lo + hi) / 2
          let t = -Infinity, okOrder = true
          for (let m = i; m <= k; m++) {
            const dperp = pts[m][0] * nx + pts[m][1] * ny - o
            const rad = epsOf(m)
            const half = Math.sqrt(Math.max(0, rad * rad - dperp * dperp))
            const mid = pts[m][0] * ux + pts[m][1] * uy
            const loT = mid - half, hiT = mid + half
            t = Math.max(t, loT)
            if (t > hiT + 1e-9) { okOrder = false; break }
          }
          if (!okOrder) break
          j = k
        }
        return j
      }
      // 最少 link：BFS 分層（狀態＝點索引；同方向連續 link 無意義，不必記方向——
      // reach 已把「一直線能蓋多遠」算滿，換 link 必換方向才有進展）。
      const from = new Array(n).fill(-1)
      const dirAt = new Array(n).fill(-1)
      let frontier = [0]
      const seenPt = new Set([0])
      let found = n === 1
      let guard = 0
      while (frontier.length && !found && guard++ < n + 2) {
        const next = []
        for (const i of frontier) {
          for (const c of DIR8) {
            const j = reach(i, c)
            if (j <= i) continue
            if (!seenPt.has(j)) {
              seenPt.add(j)
              from[j] = i
              dirAt[j] = c
              next.push(j)
              if (j === n - 1) { found = true }
            }
          }
        }
        frontier = next
      }
      if (!found) continue // ε 太小蓋不住（罕見）——這條鏈放棄，硬規則保底
      // 回溯 links，逐 link 把中間頂點垂直投影上去。
      const cuts = []
      for (let j = n - 1; j > 0; j = from[j]) cuts.push([from[j], j, dirAt[j]])
      cuts.reverse()
      linksTotal += cuts.length
      const batch = new Map()
      for (const [i, j, c] of cuts) {
        const th = c * Math.PI / 4
        const ux = Math.cos(th), uy = Math.sin(th)
        const nx2 = -uy, ny2 = ux
        // link 的 offset：兩端點（若固定則以其為準）的中點。
        const oi = pts[i][0] * nx2 + pts[i][1] * ny2
        const oj = pts[j][0] * nx2 + pts[j][1] * ny2
        const o = fixed.has(chain[i]) ? oi : fixed.has(chain[j]) ? oj : (oi + oj) / 2
        for (let k = i; k <= j; k++) {
          const id = chain[k]
          if (fixed.has(id)) continue
          const p = pts[k]
          const dperp = p[0] * nx2 + p[1] * ny2 - o
          targets.set(id, [p[0] - dperp * nx2, p[1] - dperp * ny2])
          batch.set(id, targets.get(id))
        }
      }
      if (batch.size) batches.push(batch)
      for (const id of chain) fixed.add(id) // 本路線定案（漸進式）
    }
  }
  return finishBatches(pos, M, segs, batches, cols, rows, { chains: chainsN, links: linksTotal })
}

/* ==================== 鏈目錄（下游 UI/管線共用） ==================== */
// 七條論文鏈的 kind、中文 tab 名與 build 函式——D3Tab / viewGeometry / 畫廊 /
// mapStore 統一從這裡取，避免每處手抄清單。順序＝論文編號。
export const PAPER_KINDS = [
  { kind: 'stroke', zh: '筆畫法', build: buildStrokeAlign },
  { kind: 'milp', zh: 'MILP規劃', build: buildMilpAlign },
  { kind: 'force', zh: '力導向', build: buildForceAlign },
  { kind: 'lsq', zh: '最小平方', build: buildLsqAlign },
  { kind: 'octi', zh: '八向格網', build: buildOctiAlign },
  { kind: 'path', zh: '路徑簡化', build: buildPathAlign },
  { kind: 'sat', zh: 'SAT規劃', build: buildSatAlign },
]
export const PAPER_BUILD = Object.fromEntries(PAPER_KINDS.map((p) => [p.kind, p.build]))
export const PAPER_ZH = Object.fromEntries(PAPER_KINDS.map((p) => [p.kind, p.zh]))
