import {
  buildHcGraph, makeMover, applyTargets, countHV, countHVD,
} from '../hillClimb.js'
import { sharesRoute, isHVD } from '../netUtil.js'
import {
  WINDOW, emptyResult, clampTargets, finishPass, makeApplier, finishBatches,
  snapAligned, sectorOf, SECTOR_VEC, cyc8, outAngle, angBetween, TWO_PI,
} from './_shared.js'

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

