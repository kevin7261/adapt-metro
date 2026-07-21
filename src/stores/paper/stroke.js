import {
  buildHcGraph, makeMover, applyTargets, countHV, countHVD,
} from '../hillClimb.js'
import { sharesRoute, isHVD } from '../netUtil.js'
import {
  WINDOW, emptyResult, clampTargets, finishPass, makeApplier, finishBatches,
  snapAligned, sectorOf, SECTOR_VEC, cyc8, outAngle, angBetween, TWO_PI,
} from './_shared.js'

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

