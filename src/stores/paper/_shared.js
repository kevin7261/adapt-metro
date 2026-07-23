// 論文直線鏈共用機構
import {
  buildHcGraph, makeMover, applyTargets, countHV, countHVD, scoreAlign, buildRectPolish,
} from '../hillClimb.js'
import { sharesRoute, isHV, isHVD } from '../netUtil.js'

export const TWO_PI = 2 * Math.PI
export const WINDOW = 2 // 目標離目前位置的 Chebyshev 上限（短距離後處理）

/* ==================== 共用小工具 ==================== */

// 空圖的統一回傳（同各後處理鏈的空 stats 形狀）。
export const emptyResult = (pos, segs) => ({
  cellAfter: pos,
  stats: { hvBefore: 0, hvAfter: 0, segs: segs?.length ?? 0, verts: pos?.size ?? 0, moved: 0, passes: 0, reverted: false },
})

// 夾 WINDOW ＋界內（targets 可為連續座標——四捨五入）。回傳只含「真的要動」的格。
export function clampTargets(pos, targets, cols, rows) {
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

// targets 收尾（單批鏈共用）：夾 WINDOW → applyTargets(scoreAlign) → stats。
export function finishPass(pos, M, segs, targets, cols, rows, extra = {}) {
  const hvBefore = countHV(pos, segs)
  const hvdBefore = countHVD(pos, segs)
  const clamped = clampTargets(pos, targets, cols, rows)
  const { moved, passes, reverted } = applyTargets(pos, M, clamped, segs, 6, scoreAlign)
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

// 逐批（逐筆畫/逐路線/逐頂點）漸進套用器：每批各自過 applyTargets（淨 scoreAlign
// 變差該批獨立退回——對應論文的 progressive 排程：先處理的定案、壞的局部提案不拖垮
// 整體）。批可以給**多個候選**（Map[]，依序試到第一個被接受為止——①筆畫法的
// 「4 主方向優先、壅擠時退而求其次用 ±45°」，論文 §4.3/§9.9）。
// opts.strict：批要**嚴格**改善 scoreAlign 才收（單頂點批用——中性移動會讓 iteratePost
// 永不收斂地漂移；嚴格遞增以段數為上界保證終止）。
// 一批套完才算下一批的幾何（漸進式：後面的筆畫/路線看到的是已定案的位置）。
export function makeApplier(pos, M, segs, cols, rows, opts = {}) {
  const hvBefore = countHV(pos, segs)
  const hvdBefore = countHVD(pos, segs)
  let moved = 0, passes = 0, reverted = false
  let proposed = 0, revertedN = 0, batches = 0
  // 回傳是否被接受（被擋下或退回 → false，呼叫者可改試下一個候選）。
  const applyOne = (targets) => {
    const clamped = clampTargets(pos, targets, cols, rows)
    if (!clamped.size) return false
    proposed += clamped.size
    const cnt0 = scoreAlign(pos, segs)
    const orig = new Map([...clamped.keys()].map((id) => [id, [...pos.get(id)]]))
    const r = applyTargets(pos, M, clamped, segs, 6, scoreAlign)
    if (!r.moved) return false
    if (opts.strict && scoreAlign(pos, segs) <= cnt0) {
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
export function finishBatches(pos, M, segs, batches, cols, rows, extra = {}, opts = {}) {
  const app = makeApplier(pos, M, segs, cols, rows, opts)
  for (const targets of batches) app.apply(targets)
  return app.result(extra)
}

// 連續解的「對齊感知」量化（力導向/最小平方用）：頂點依 id 序逐一吸到連續位置
// 四周的整數格，取「入射段對齊分」最高（HV=2、45°=1）、平手取離連續位置近者——
// 能吸成 H/V 就不停在 45°。
export function snapAligned(P, pos, segs, inc) {
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
        if (isHV(cand, q)) sc += 2
        else if (isHVD(cand, q)) sc += 1
      }
      const d = Math.hypot(cand[0] - p[0], cand[1] - p[1])
      if (sc > bs || (sc === bs && d < bd - 1e-12)) { best = cand; bs = sc; bd = d }
    }
    t.set(id, best)
  }
  return t
}

// 八方向扇區（0..7，扇區 k 的中心角 = k·45°；螢幕座標 y 向下不影響一致性）。
export const sectorOf = (dx, dy) => {
  const k = Math.round(Math.atan2(dy, dx) / (Math.PI / 4))
  return ((k % 8) + 8) % 8
}
export const SECTOR_VEC = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
]
// 環狀方向差（0..4）——Nöllenburg 彎折成本 bd = min(|Δ|, 8−|Δ|)：直行 0、45° 差 1…
export const cyc8 = (a, b) => {
  const t = Math.abs(((a - b) % 8 + 8) % 8)
  return Math.min(t, 8 - t)
}
// 段（以 v 為端點）朝外的方向角；重合回傳 null。
export const outAngle = (pos, seg, v) => {
  const o = pos.get(seg.a === v ? seg.b : seg.a)
  const p = pos.get(v)
  if (o[0] === p[0] && o[1] === p[1]) return null
  return Math.atan2(o[1] - p[1], o[0] - p[0])
}
// 角度差正規化到 [0, π]。
export const angBetween = (a, b) => {
  let d = Math.abs(a - b) % TWO_PI
  if (d > Math.PI) d = TWO_PI - d
  return d
}

