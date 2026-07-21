import {
  buildHcGraph, makeMover, applyTargets, countHV, countHVD,
} from '../hillClimb.js'
import { sharesRoute, isHVD } from '../netUtil.js'
import {
  WINDOW, emptyResult, clampTargets, finishPass, makeApplier, finishBatches,
  snapAligned, sectorOf, SECTOR_VEC, cyc8, outAngle, angBetween, TWO_PI,
} from './_shared.js'

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

