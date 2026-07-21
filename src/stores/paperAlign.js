// 「論文直線演算法」後處理鏈（Straighten tabs）——每條鏈與 ②直角爬山（hillClimb.js）
// 相同契約：以 Hill Climbing 的整數格佈局為輸入、短距離移動彩色頂點、產生 targets
// 後經 **同一套 §5 硬規則**（applyTargets：不壓點、不新增交叉、象限與邊環繞序不變、
// 淨對齊分數變差整批退回）套用；由 iteratePost 迭代到不動點。回傳形狀
// { cellAfter, stats }，stats 帶 hvBefore/hvAfter/segs/verts/moved/passes/reverted。
//
// 每條鏈都是對應論文核心機制的「整數格短距離後處理」改編（原論文多為全圖佈局器；
// 這裡的輸入已是示意格網化＋爬山後的佈局，所以取其方向指派／能量模型／路徑簡化的
// 核心，座標變動以 WINDOW 格為上限）。忠實度與簡化點逐條記在各 build 函式的註解
// 與對應 skill。
//
//   stroke  ① Li & Dong 2010 筆畫法（stroke-based）        [route-stroke-align]
//   rect    ② Stott et al. 2011 直角爬山（|sin 2θ| 再爬）  [route-rect-polish]（build 在 hillClimb.js）
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
  buildHcGraph, makeMover, applyTargets, countHV, countHVD, buildRectPolish,
} from './hillClimb.js'
import { sharesRoute, isHVD } from './netUtil.js'

const TWO_PI = 2 * Math.PI
const WINDOW = 2 // 目標離目前位置的 Chebyshev 上限（短距離後處理）

/* ==================== 共用小工具 ==================== */

// 空圖的統一回傳（同各後處理鏈的空 stats 形狀）。
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

// 逐批（逐筆畫/逐路線/逐頂點）漸進套用器：每批各自過 applyTargets（淨 HVD 變差
// 該批獨立退回——對應論文的 progressive 排程：先處理的定案、壞的局部提案不拖垮
// 整體）。批可以給**多個候選**（Map[]，依序試到第一個被接受為止——①筆畫法的
// 「4 主方向優先、壅擠時退而求其次用 ±45°」，論文 §4.3/§9.9）。
// opts.strict：批要**嚴格**改善 HVD 才收（單頂點批用——中性移動會讓 iteratePost
// 永不收斂地漂移；嚴格遞增以段數為上界保證終止）。
// 一批套完才算下一批的幾何（漸進式：後面的筆畫/路線看到的是已定案的位置）。
function makeApplier(pos, M, segs, cols, rows, opts = {}) {
  const hvBefore = countHV(pos, segs)
  const hvdBefore = countHVD(pos, segs)
  let moved = 0, passes = 0, reverted = false
  let proposed = 0, revertedN = 0, batches = 0
  // 回傳是否被接受（被擋下或退回 → false，呼叫者可改試下一個候選）。
  const applyOne = (targets) => {
    const clamped = clampTargets(pos, targets, cols, rows)
    if (!clamped.size) return false
    proposed += clamped.size
    const cnt0 = countHVD(pos, segs)
    const orig = new Map([...clamped.keys()].map((id) => [id, [...pos.get(id)]]))
    const r = applyTargets(pos, M, clamped, segs, 6, countHVD)
    if (!r.moved) return false
    if (opts.strict && countHVD(pos, segs) <= cnt0) {
      // 中性（或被部份擋掉後無淨益）的批 → 回退（一一放回原格是安全的）。
      for (const [id, p] of orig) {
        const cur = pos.get(id)
        if (cur[0] !== p[0] || cur[1] !== p[1]) M.applyMove(id, p)
      }
      revertedN++
      return false
    }
    moved += r.moved
    passes += r.passes
    reverted ||= r.reverted
    if (r.reverted) revertedN++
    return !r.reverted
  }
  return {
    // targets: Map 或 Map[]（候選依序試）。
    apply(targets) {
      batches++
      for (const t of Array.isArray(targets) ? targets : [targets]) {
        if (applyOne(t)) return true
      }
      return false
    },
    result: (extra = {}) => ({
      cellAfter: pos,
      stats: {
        hvBefore, hvAfter: countHV(pos, segs),
        hvdBefore, hvdAfter: countHVD(pos, segs),
        segs: segs.length, verts: pos.size,
        moved, passes, reverted, proposed, revertedN, batches,
        ...extra,
      },
    }),
  }
}

// 先算好全部批次再逐批套用（④⑥ 用——提案器與佈局無關，不需要漸進重算）。
function finishBatches(pos, M, segs, batches, cols, rows, extra = {}, opts = {}) {
  const app = makeApplier(pos, M, segs, cols, rows, opts)
  for (const targets of batches) app.apply(targets)
  return app.result(extra)
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
// Li & Dong 2010：把段串成「筆畫」（§3.1 同路線＝具名優先，§3.2 剩餘段跨路線
// every-best-fit、偏角 < 45°），逐筆畫依「最大方向扭曲 > 45°」遞迴切成子筆畫，
// 各子筆畫吸附 **4 主方向**（§4.3：先試最近的水平/垂直，被擋下才退用最近的
// ±45°），成員頂點**垂直投影**到過錨點（§D：已定案筆畫的交點 → 無交點取首尾
// 中點）的定向直線上。漸進式（§6.3）：筆畫依（類型 > 總長 > 交點數）排序，
// 每條子筆畫**當場套用**、頂點定案，後續筆畫看到的是已定案的佈局。
// 改編：拓撲一致性不用論文的點在多邊形修復——targets 統一走 applyTargets 硬規則
// （擋下會翻轉拓撲的投影，效果等價於「移不動就留在原地」）。
export function buildStrokeAlign(skeleton, cells, cols, rows) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)
  const M = makeMover(pos, segs, inc, cols, rows)

  // --- FormStrokes（§3.1 具名優先 → §3.2 無名 every-best-fit）---
  // 偏角 deflection = π − 兩出向夾角（0 = 完全直行）。捷運圖裡「路線」就是名稱
  // （§3.1 註：捷運應用 3.1 就足夠）：同路線的段在頂點上直接串接，**不設偏角
  // 門檻**（路線該轉彎就轉彎，過彎的筆畫由 §4.2 的方向扭曲切分處理）；同路線有
  // 多種接法（分歧）時才用偏角排序決定配對。剩下沒配到的段再跑第二輪
  // every-best-fit（§3.2：跨路線、偏角 < T 才配）。
  const T = Math.PI / 4
  const nextSeg = new Map() // `${segIdx}|${vertexId}` -> 接續的 segIdx
  for (const [v, list] of inc) {
    if (list.length < 2) continue
    const named = [], unnamed = []
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const si = segs[list[i]], sj = segs[list[j]]
        const a1 = outAngle(pos, si, v), a2 = outAngle(pos, sj, v)
        if (a1 == null || a2 == null) continue
        const def = Math.PI - angBetween(a1, a2)
        const pair = [def, list[i], list[j]]
        if (sharesRoute(si.routes, sj.routes)) named.push(pair)
        else if (def < T) unnamed.push(pair)
      }
    }
    const used = new Set()
    for (const cand of [named, unnamed]) { // 具名先配，無名只能撿剩下的
      cand.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2])
      for (const [, si, sj] of cand) {
        if (used.has(si) || used.has(sj)) continue
        used.add(si); used.add(sj)
        nextSeg.set(`${si}|${v}`, sj)
        nextSeg.set(`${sj}|${v}`, si)
      }
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
  // 排序（式 3）：類型（路線數）> 總長 > 交點數（與其他筆畫共享的頂點數——
  // 筆畫在一個頂點最多用掉 2 條段，所以 deg ≥ 3 的頂點就是共享點）。
  const arcLen = (ids) => {
    let m = 0
    for (let i = 1; i < ids.length; i++) {
      const A = pos.get(ids[i - 1]), B = pos.get(ids[i])
      m += Math.hypot(B[0] - A[0], B[1] - A[1])
    }
    return m
  }
  const junctions = (ids) => ids.filter((id) => inc.get(id).length >= 3).length
  strokes.sort((x, y) => y.routes.size - x.routes.size || arcLen(y.ids) - arcLen(x.ids)
    || junctions(y.ids) - junctions(x.ids))

  // --- 逐筆畫：遞迴切分 → 方向指派 → 垂直投影（每條子筆畫即時套用）---
  const app = makeApplier(pos, M, segs, cols, rows)
  const fixed = new Set() // 先處理的筆畫定案的頂點——後續筆畫不再改它
  const fixOrder = new Map() // id -> 定案序（越小＝所屬筆畫排序鍵越高）
  let strokesN = 0, subN = 0
  const at = (id) => pos.get(id) // 漸進式：永遠讀「已套用」的目前佈局
  // 子筆畫首尾連線方位角 → 4 主方向（§4.3）。回傳 [主要, 備援]：主要＝最近的
  // 水平/垂直，備援＝最近的 ±45°（論文：先試 H/V，壅擠/不一致時才退用斜線）。
  const orient = (ids) => {
    const A = at(ids[0]), B = at(ids[ids.length - 1])
    const ang = Math.atan2(B[1] - A[1], B[0] - A[0])
    const devTo = (base) => Math.min(angBetween(ang, base), angBetween(ang, base + Math.PI))
    const hv = devTo(0) <= devTo(Math.PI / 2) ? 0 : 2
    const dg = devTo(Math.PI / 4) <= devTo(3 * Math.PI / 4) ? 1 : 3
    return [hv, dg]
  }
  // 錨點（子計算 D）：交點優先（已定案筆畫中排序鍵最高者的交點），無交點時取
  // 首尾中點。
  const anchorOf = (ids) => {
    const js = ids.filter((id) => inc.get(id).length >= 3)
    if (!js.length) {
      const A = at(ids[0]), B = at(ids[ids.length - 1])
      return [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]
    }
    const done = js.filter((id) => fixed.has(id))
    if (done.length) {
      done.sort((a, b) => fixOrder.get(a) - fixOrder.get(b))
      return at(done[0])
    }
    js.sort((a, b) => inc.get(b).length - inc.get(a).length || String(a).localeCompare(String(b)))
    return at(js[0])
  }
  // 垂直投影到「過錨點、方向 dirSec」的直線（水平/垂直＝保留另一軸；±45° 等價
  // 於旋轉→投影→逆旋轉）。
  const project = (ids, dirSec) => {
    const [ux, uy] = SECTOR_VEC[dirSec]
    const un2 = ux * ux + uy * uy
    const A = anchorOf(ids)
    const t = new Map()
    for (const id of ids) {
      if (fixed.has(id)) continue
      const p = at(id)
      const k = ((p[0] - A[0]) * ux + (p[1] - A[1]) * uy) / un2
      t.set(id, [A[0] + k * ux, A[1] + k * uy])
    }
    return t
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
      subN++
      const [hv, dg] = orient(ids)
      app.apply([project(ids, hv), project(ids, dg)]) // 主方向優先、斜線備援
    }
  }
  for (const st of strokes) {
    if (st.ids.length < 2) continue
    strokesN++
    split(st.ids)
    for (const id of st.ids) { // 漸進式：本筆畫定案
      if (!fixed.has(id)) { fixed.add(id); fixOrder.set(id, strokesN) }
    }
  }
  return app.result({ strokes: strokesN, substrokes: subN })
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
// 方向、長度＝目前投影長」的理想相對位置拉，並套 H3 最短邊長：deg-2 壓縮的段
// 其 L_min = 吞掉的白點數 + 1（③ 步驟 0b／⑧ 步驟 0b：壓縮路徑的 L_min ← n+1，
// 白點之後等距回插才有空間）。連續空間收斂後由 snapAligned 做對齊感知量化、
// finishPass 夾 WINDOW ＋硬規則。S3（總長最小化）交給下游「縮減網格」——它就是
// 全域壓縮這張圖的步驟，不在這裡重複施力。
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
      // 目前沿方向的投影長（下限 = H3 最短邊長 hops），重建理想 B′ = A + u·len。
      const proj = ((B[0] - A[0]) * ux + (B[1] - A[1]) * uy) / un
      const len = Math.max(s.hops, proj)
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
    // 生成樹＋回邊 → feedback 段集合（沿用已下架整數規劃鏈的機構）。
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
// Method 5（STEP 3 改良版 PrEd）的力模型在格空間跑固定輪數，逐頂點算合力、當場
// 移動：引力 d/δ（δ 由邊權——吞掉的白點數——決定）＋全頂點對斥力 δ²/d²＋頂點×
// 不相鄰邊斥力 (γ−d)²/d ＋八方向磁場力 c_m·b·len^α·θ^β（力偶垂直於邊），位移再
// 過 **PrEd 8 區域移動上限**（§5.1：沿合力方向不得穿過任何不相鄰邊）。
// STEP 1 的 deg-2 收縮已由骨架完成（白點＝被吞掉的站，STEP 4 等距回插由下游
// placeBlacks 做）；STEP 2 的 GEM 初始佈局不需要——輸入已是格網化＋爬山的佈局
// （論文允許以地理/既有佈局起始）。確定性：固定頂點順序、無隨機。
export function buildForceAlign(skeleton, cells, cols, rows) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)
  const M = makeMover(pos, segs, inc, cols, rows)

  // 理想距離 δ(u,v) = sqrt(L·(min(W, weight)+1))（§5.3）——weight = 邊吞掉的
  // deg-2 站數，本層即段的黑點數，所以 min(W,weight)+1 = min(W+1, hops)。
  // 格空間把單位常數 L 校準成「每跳中位長 ℓ 的平方」：δ = ℓ·sqrt(min(26, hops))，
  // 保留論文的 sqrt 尺度律（吞越多站越長，但成長趨緩）。
  const lens = segs.map((s) => {
    const A = pos.get(s.a), B = pos.get(s.b)
    return Math.hypot(B[0] - A[0], B[1] - A[1]) / s.hops
  }).sort((a, b) => a - b)
  const ELL = Math.max(1, lens[lens.length >> 1] || 1)
  const Wcap = 25 // 論文 W = 25
  const deltaOf = (hops) => ELL * Math.sqrt(Math.min(Wcap + 1, hops))
  const GAMMA = 3 * ELL // 頂點×邊期望距離（論文 γ=100 是其輸入座標尺度）
  const CM = 0.1, BM = 30.0, ALPHA = 1.0, BETA = 0.5 // 論文 c_m, b, α, β
  const ids = [...pos.keys()].sort()
  const P = new Map(ids.map((id) => [id, [...pos.get(id)]]))
  const nbrSeg = new Map(ids.map((id) => [id, inc.get(id)])) // v 的鄰接段
  const ROUNDS = 40
  // PrEd 8 區域移動上限（§5.1）：對每條不相鄰邊，算 v 沿 8 個方向各走多遠會穿過
  // 它，取最小；合力方向的上限就是本輪位移上限（保嵌入的原始機制）。
  const clipByPredZones = (v, fx, fy) => {
    const move = Math.hypot(fx, fy)
    if (move < 1e-12) return [0, 0]
    const p = P.get(v)
    const k = sectorOf(fx, fy)
    const [vx0, vy0] = SECTOR_VEC[k]
    const vn = Math.hypot(vx0, vy0)
    const dvx = vx0 / vn, dvy = vy0 / vn
    let limit = Infinity
    const incSet = new Set(inc.get(v))
    for (let si = 0; si < segs.length; si++) {
      if (incSet.has(si)) continue
      const s = segs[si]
      if (s.a === v || s.b === v) continue
      const A = P.get(s.a), B = P.get(s.b)
      const ex = B[0] - A[0], ey = B[1] - A[1]
      const nx = -ey, ny = ex // 邊的法向
      const denom = dvx * nx + dvy * ny
      if (Math.abs(denom) < 1e-12) continue // 平行
      const t = ((A[0] - p[0]) * nx + (A[1] - p[1]) * ny) / denom
      if (t <= 0) continue
      const cx = p[0] + t * dvx, cy = p[1] + t * dvy
      const l2 = ex * ex + ey * ey
      if (l2 < 1e-12) continue
      const u = ((cx - A[0]) * ex + (cy - A[1]) * ey) / l2
      if (u < 0 || u > 1) continue
      limit = Math.min(limit, t)
    }
    if (move <= limit) return [fx, fy]
    const scale = limit / move
    return [fx * scale, fy * scale]
  }
  for (let r = 0; r < ROUNDS; r++) {
    // 論文 STEP 3 是逐頂點算合力、當場移動（頂點順序固定＝確定性）。
    for (const v of ids) {
      const p = P.get(v)
      let fx = 0, fy = 0
      // ── 引力（鄰接邊，帶邊權）：ratio = d/δ ──
      for (const si of inc.get(v)) {
        const s = segs[si]
        const o = P.get(s.a === v ? s.b : s.a)
        const dx = o[0] - p[0], dy = o[1] - p[1]
        const d = Math.hypot(dx, dy) || 1e-9
        const ratio = d / deltaOf(s.hops)
        fx += ratio * dx; fy += ratio * dy
      }
      // ── 斥力（所有頂點對）：ratio = δ²/d² ──
      const nbrDelta = new Map()
      for (const si of nbrSeg.get(v)) {
        const s = segs[si]
        nbrDelta.set(s.a === v ? s.b : s.a, deltaOf(s.hops))
      }
      for (const u of ids) {
        if (u === v) continue
        const o = P.get(u)
        const dx = o[0] - p[0], dy = o[1] - p[1]
        const d2 = dx * dx + dy * dy
        if (d2 < 1e-12) continue
        const dl = nbrDelta.get(u) ?? deltaOf(1)
        const ratio = (dl * dl) / d2
        fx -= ratio * dx; fy -= ratio * dy
      }
      // ── 頂點×不相鄰邊斥力（PrEd，式 2）──
      const incSet = new Set(inc.get(v))
      for (let si = 0; si < segs.length; si++) {
        if (incSet.has(si)) continue
        const s = segs[si]
        if (s.a === v || s.b === v) continue
        const A = P.get(s.a), B = P.get(s.b)
        const ex = B[0] - A[0], ey = B[1] - A[1]
        const l2 = ex * ex + ey * ey
        if (l2 < 1e-12) continue
        const t = ((p[0] - A[0]) * ex + (p[1] - A[1]) * ey) / l2
        if (t <= 0 || t >= 1) continue // 投影落在段內才作用
        const ix = A[0] + t * ex, iy = A[1] + t * ey
        const dvi = Math.hypot(p[0] - ix, p[1] - iy)
        if (dvi >= GAMMA || dvi < 1e-9) continue
        const coeff = ((GAMMA - dvi) * (GAMMA - dvi)) / dvi
        fx -= coeff * (ix - p[0]); fy -= coeff * (iy - p[1])
      }
      // ── 磁場力（式 4）：每條鄰接邊取最近八方向，力偶垂直於邊 ──
      for (const si of inc.get(v)) {
        const s = segs[si]
        const o = P.get(s.a === v ? s.b : s.a)
        const ex = o[0] - p[0], ey = o[1] - p[1]
        const len = Math.hypot(ex, ey)
        if (len < 1e-9) continue
        const ang = Math.atan2(ey, ex)
        const target = sectorOf(ex, ey) * Math.PI / 4
        let delta = target - ang
        while (delta > Math.PI) delta -= TWO_PI
        while (delta < -Math.PI) delta += TWO_PI
        const fm = CM * BM * Math.pow(len, ALPHA) * Math.pow(Math.abs(delta), BETA)
        const sgn = Math.sign(delta) || 0
        const px = -ey / len * sgn, py = ex / len * sgn
        fx += -fm * px; fy += -fm * py // v 受 −F_m·perp（u 在自己的迴圈收到反向）
      }
      // GEM 溫度（STEP 2 的 step_size ← min(T[v], |F|)）：一輪位移不超過一個理想
      // 邊長——沒有它，格空間的 δ²/d² 斥力在近距離會把座標推到溢位。
      const mag = Math.hypot(fx, fy)
      if (!Number.isFinite(mag) || mag < 1e-12) continue
      const temp = deltaOf(1)
      if (mag > temp) { fx *= temp / mag; fy *= temp / mag }
      const [cx, cy] = clipByPredZones(v, fx, fy)
      p[0] += cx; p[1] += cy
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
  // 邊排序（STEP 3）：從 ldeg 最高的站起，UNPROCESSED → DANGLING → PROCESSED
  // 逐層往外長，每層鄰居也依 ldeg 降冪——複雜轉乘樞紐先佔位。
  const order = []
  {
    const state = new Map([...pos.keys()].map((id) => [id, 'U']))
    const byLdeg = (a, b) => ldeg.get(b) - ldeg.get(a) || String(a).localeCompare(String(b))
    const segBetween = new Map() // "v|u" -> segIdx（同對頂點多段時保留全部）
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
        for (const si of inc.get(vd)) nbrs.add(segs[si].a === vd ? segs[si].b : segs[si].a)
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
  }
  // 成本參數（§1）：c_135 = 1, c_90 = 1.5, c_45 = 2, c_180 = 0, c_h = 1, c_m = 0.5，
  // 成本偏移 a = c_45 − c_135 = 1 → 格網移動邊 H/V 收 c_h − a = 0、對角收 0.5。
  const C_H = 1, C_M = 0.5, A_OFF = 1
  // 站上彎折成本，索引 = 兩個出向的環狀差 Δ（＝進出港口的夾角格數）：
  // Δ=4 直行（180°）→ c_180 = 0；Δ=3（135°）→ 1；Δ=2（90°）→ 1.5；
  // Δ=1（45°）→ 2；Δ=0 兩段同向重疊 → 不允許。
  const BEND = [Infinity, 2, 1.5, 1, 0]
  const HOP = [C_H - A_OFF, C_H - A_OFF + 0.5] // [H/V, 對角] 每跳成本 = 0 / 0.5
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
      m += BEND[cyc8(sec, osec)]
    }
    return m
  }
  for (const si of order) {
    const s = segs[si]
    const CA = candsOf(s.a), CB = candsOf(s.b)
    let best = null, bestCost = Infinity
    const pa0 = pos.get(s.a), pb0 = pos.get(s.b)
    for (const A of CA) {
      // 位移懲罰（STEP 4）：與原位的距離 / D × (c_h + c_m)。
      const dispA = Math.hypot(A[0] - pa0[0], A[1] - pa0[1]) * (C_H + C_M)
      for (const B of CB) {
        if (A[0] === B[0] && A[1] === B[1]) continue
        const dispB = Math.hypot(B[0] - pb0[0], B[1] - pb0[1]) * (C_H + C_M)
        const dx = B[0] - A[0], dy = B[1] - A[1]
        const sec = sectorOf(dx, dy)
        // 弦＝格網路徑：正八方向時是一條直線（每跳付 HOP，H/V 0、對角 0.5）；
        // 非八方向時最省也要靠兩個 135° 折繞（2·c_135），再加走過的跳數。
        const diag = Math.abs(dx) === Math.abs(dy) && dx !== 0
        const exact = dx === 0 || dy === 0 || diag
        const hops = Math.max(Math.abs(dx), Math.abs(dy))
        let cost = dispA + dispB + hops * HOP[exact && diag ? 1 : 0]
        if (!exact) cost += 2 * BEND[3] // 2 × c_135
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
// §3 的兩個品質擴充都在：**最大彎角 α = 90°**（相鄰 link 方向的環狀差 ≥ 2，禁銳
// 角彎）與**最小 link 長 l_min**（一個 link 至少跨一段，防零長 link 鑽漏洞）。
export function buildPathAlign(skeleton, cells, cols, rows) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)
  const M = makeMover(pos, segs, inc, cols, rows)
  // ε（格）：論文建議「相鄰站均距的 1–2 倍」起試——取段長中位數，夾在
  // [1, WINDOW]（超過 WINDOW 的位移本來就會被夾掉）。
  const segLens = segs.map((s) => {
    const A = pos.get(s.a), B = pos.get(s.b)
    return Math.hypot(B[0] - A[0], B[1] - A[1])
  }).sort((a, b) => a - b)
  const EPS = Math.min(WINDOW, Math.max(1, segLens[segLens.length >> 1] || 1))
  const MAX_TURN = 2 // 最大彎角 α = 90° → 相鄰 link 的方向環狀差不得 < 2

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

  const app = makeApplier(pos, M, segs, cols, rows)
  const fixed = new Set()
  const at = (id) => pos.get(id) // 漸進式：讀「已定案」的目前佈局
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
      // 最少 link：BFS 分層。狀態 = (點索引, 本 link 方向)——記方向才能施加
      // §3 的最大彎角 α = 90°：相鄰兩 link 的彎角 = 45°×方向環狀差，> α 的三元組
      // 直接跳過（環狀差 > 2 ＝ 內角 < 90° 的銳角彎）；環狀差 0 是同向，不算新
      // link。每個 link 至少跨一個輸入點（j > i）＝最小 link 長，零長 link 不會出現。
      const key = (i, c) => `${i}|${c}`
      const from = new Map() // key -> [prevI, prevC]
      let frontier = [[0, -1]]
      const seen = new Set([key(0, -1)])
      let goal = null
      let guard = 0
      while (frontier.length && !goal && guard++ < n + 2) {
        const next = []
        for (const [i, cprev] of frontier) {
          for (const c of DIR8) {
            if (cprev >= 0) {
              const turn = cyc8(c, cprev)
              if (turn === 0 || turn > MAX_TURN) continue // 同向 / 超過最大彎角 α
            }
            const j = reach(i, c)
            if (j <= i) continue // 最小 link 長：一個 link 至少往前吃一個點
            const k = key(j, c)
            if (seen.has(k)) continue
            seen.add(k)
            from.set(k, [i, cprev])
            next.push([j, c])
            if (j === n - 1) { goal = [j, c]; break }
          }
          if (goal) break
        }
        frontier = next
      }
      if (!goal) continue // ε 太小或彎角限制蓋不住（罕見）——這條鏈放棄，硬規則保底
      // 回溯 links，逐 link 把中間頂點垂直投影上去。
      const cuts = []
      for (let st = goal; st[0] > 0;) {
        const [i, c] = st
        const [pi, pc] = from.get(key(i, c))
        cuts.push([pi, i, c])
        st = [pi, pc]
      }
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
          batch.set(id, [p[0] - dperp * nx2, p[1] - dperp * ny2])
        }
      }
      if (batch.size) app.apply(batch)
      for (const id of chain) fixed.add(id) // 本路線定案（漸進式）
    }
  }
  return app.result({ chains: chainsN, links: linksTotal })
}

/* ==================== 鏈目錄（下游 UI/管線共用） ==================== */
// 「直線演算法」＝論文①〜⑧＋LLM 對齊共 9 條（2026-07 使用者裁決：名稱要與
// data/thesis/<n>_*_演算法說明.md 一一對應，讓人一眼看出是哪篇論文；舊的
// 軸對齊/整數規劃為自創、不對應論文，已移除）。kind、中文 tab 名（帶論文
// 圈號）與 build 函式——D3Tab / viewGeometry / 畫廊 / mapStore 統一從這裡取，
// 避免每處手抄清單。順序＝論文編號；②直角爬山＝Stott 爬山法的 |sin 2θ| 變體
// （build 在 hillClimb.js，skill route-rect-polish）。LLM 對齊非即時 build，
// 不在此表（下游自行以 'llm' 補在表尾）。
export const PAPER_KINDS = [
  { kind: 'stroke', zh: '①筆畫法', build: buildStrokeAlign },
  { kind: 'rect', zh: '②直角爬山', build: buildRectPolish },
  { kind: 'milp', zh: '③MILP規劃', build: buildMilpAlign },
  { kind: 'force', zh: '④力導向', build: buildForceAlign },
  { kind: 'lsq', zh: '⑤最小平方', build: buildLsqAlign },
  { kind: 'octi', zh: '⑥八向格網', build: buildOctiAlign },
  { kind: 'path', zh: '⑦路徑簡化', build: buildPathAlign },
  { kind: 'sat', zh: '⑧SAT規劃', build: buildSatAlign },
]
export const PAPER_BUILD = Object.fromEntries(PAPER_KINDS.map((p) => [p.kind, p.build]))
export const PAPER_ZH = Object.fromEntries(PAPER_KINDS.map((p) => [p.kind, p.zh]))
