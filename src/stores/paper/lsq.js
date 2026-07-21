import {
  buildHcGraph, makeMover, applyTargets, countHV, countHVD,
} from '../hillClimb.js'
import { sharesRoute, isHVD } from '../netUtil.js'
import {
  WINDOW, emptyResult, clampTargets, finishPass, makeApplier, finishBatches,
  snapAligned, sectorOf, SECTOR_VEC, cyc8, outAngle, angBetween, TWO_PI,
} from './_shared.js'

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

