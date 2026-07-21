import { sharesRoute } from '../netUtil.js'
import { SECTOR_VEC, cyc8, WINDOW, sectorOf } from './_shared.js'
import { buildHcGraph } from '../hillClimb.js'

/* ==================== ③/⑧ 共用：方向指派模型 ==================== */
// Nöllenburg 模型的方向階段（③ 與 ⑧ 完全同模型，只換求解器——Fuchs 論文的定位）：
// 每段 3 個候選方向（目前幾何的最近八方向扇區 ±1，dev=1），成本 =
//   λ1·Σ 同路線相鄰段彎折 bd（S1） + λ2·Σ 非 orig 候選（S2 相對位置）；
// 硬限制：同頂點兩段不得同向（H2 環繞序的可線性化部份）。
// 回傳每段選定的扇區（Map<segIdx, sector>）。
export const L1 = 3, L2 = 2 // 論文權重 (λ_S1, λ_S2) = (3, 2)（S3 由座標階段隱含）

export function dirModel(pos, segs, inc) {
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
export function coordsFromDirs(pos, segs, dirs) {
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

