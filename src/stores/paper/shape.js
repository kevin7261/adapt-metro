// ⑨ Shape-Guided（Batik et al. 2022）——整數格短距離改編。
// 論文三步（路線比對 → 平滑/混合變形 → Octi 格網織入）收成：
//   (1) 自動從網路挑「最適合嵌形」的路線＋內建形狀（只方形）
//   (2) 描形站往形狀吸、其餘邊近八方向（最小平方式）
//   (3) snapAligned＋硬規則嚴格接受
// 無比對品質／路線太短／不像方形 → skipped（佈局不變）。
import {
  buildHcGraph, makeMover, countHV, countHVD,
} from '../hillClimb.js'
import {
  WINDOW, emptyResult, finishBatches, snapAligned, sectorOf, SECTOR_VEC,
} from './_shared.js'

const SHAPE_ZH = { square: '方' }
const MIN_CUTS = 6          // 切點太少無法描形
const SCORE_MIN = 0.42      // 低於此 → 略過（方向相似度不夠）
const ROUNDS = 40
const WC = 8, WO = 10, WP = 0.05 // 貼形／八方向／錨定（同 ⑤ 量級）

/* ---------- 內建形狀（單位框 [-1,1]² 閉合折線）——只方形 ---------- */
function unitSquare() {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]
}
const SHAPES = { square: unitSquare() }

/* ---------- 幾何小工具 ---------- */
function bbox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (y < minY) minY = y
    if (x > maxX) maxX = x; if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
    w: Math.max(1e-9, maxX - minX), h: Math.max(1e-9, maxY - minY) }
}
// 等比縮放＋平移（不旋轉，D5）把單位形狀對到 path 的 bbox。
function alignShape(unitPts, pathPts) {
  const bP = bbox(pathPts), bU = bbox(unitPts)
  const scale = Math.min(bP.w / bU.w, bP.h / bU.h)
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
// 方向相似度：兩折線等弧長取樣後，斜率差的平均餘弦 ∈ [−1,1] → 映到 [0,1]。
function dirSimilarity(pathA, pathB, samples = 24) {
  const sample = (pts) => {
    const lens = [0]
    for (let i = 1; i < pts.length; i++) {
      lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    }
    const total = lens[lens.length - 1] || 1
    const out = []
    for (let s = 0; s < samples; s++) {
      const target = (s / samples) * total
      let i = 1
      while (i < lens.length && lens[i] < target) i++
      const a = pts[i - 1], b = pts[Math.min(i, pts.length - 1)]
      const span = lens[Math.min(i, lens.length - 1)] - lens[i - 1] || 1
      const t = (target - lens[i - 1]) / span
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
    return out
  }
  const A = sample(pathA), B = sample(pathB)
  let sum = 0, n = 0
  for (let i = 0; i + 1 < samples; i++) {
    const ax = A[i + 1][0] - A[i][0], ay = A[i + 1][1] - A[i][1]
    const bx = B[i + 1][0] - B[i][0], by = B[i + 1][1] - B[i][1]
    const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by)
    if (al < 1e-9 || bl < 1e-9) continue
    sum += (ax * bx + ay * by) / (al * bl)
    n++
  }
  if (!n) return 0
  return (sum / n + 1) / 2 // [0,1]
}

/* ---------- 選路＋選形 ---------- */
function pickRouteAndShape(skeleton, pos) {
  const routes = skeleton.routes
  if (!routes?.size) return null
  let best = null
  for (const rt of routes.values()) {
    if (String(rt.id).startsWith('river:')) continue
    const cuts = (rt.stations ?? []).filter((id) => pos.has(id))
    if (cuts.length < MIN_CUTS) continue
    // 去相鄰重複
    const ids = cuts.filter((id, i) => i === 0 || id !== cuts[i - 1])
    if (ids.length < MIN_CUTS) continue
    const pathPts = ids.map((id) => pos.get(id))
    const first = pathPts[0], last = pathPts[pathPts.length - 1]
    const loopGap = Math.hypot(first[0] - last[0], first[1] - last[1])
    const isLoop = loopGap <= 2.5
      || (rt.stations[0] && rt.stations[0] === rt.stations[rt.stations.length - 1])
    // 閉合路徑：首尾不相連時補一筆，方便跟閉合形狀比
    const pathForMatch = isLoop && loopGap > 1e-6
      ? [...pathPts, first.slice()] : pathPts

    for (const [shapeId, unit] of Object.entries(SHAPES)) {
      const aligned = alignShape(unit, pathPts)
      const sim = dirSimilarity(pathForMatch, aligned)
      // 環線／名稱暗示／緊湊 bbox → 加分；細長走廊扣分
      const nameHint = /環|circle|ring|loop|圓|кольц|大江戸|おおえど|方/i.test(`${rt.name ?? ''} ${rt.id}`)
      const b = bbox(pathPts)
      let bias = 0
      if (isLoop) bias += 0.1
      if (nameHint) bias += 0.08
      const ar = Math.max(b.w / b.h, b.h / b.w)
      if (ar > 2.5) bias -= 0.2 // 細長線不像方
      else {
        // 越接近正方越好
        bias += 0.08 * (1 - Math.min(1, (ar - 1) / 1.5))
      }
      const sizeBonus = Math.min(0.1, (ids.length - MIN_CUTS) * 0.008)
      const score = sim + bias + sizeBonus
      if (!best || score > best.score) {
        best = {
          score, shapeId, aligned, isLoop,
          routeId: rt.id,
          routeName: (rt.name && String(rt.name).trim()) || String(rt.id),
          cutIds: ids,
        }
      }
    }
  }
  if (!best || best.score < SCORE_MIN) return null
  return best
}

/* ---------- 主建置 ---------- */
export function buildShapeAlign(skeleton, cells, cols, rows) {
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) return emptyResult(pos, segs)

  const pick = pickRouteAndShape(skeleton, pos)
  if (!pick) {
    return {
      cellAfter: pos,
      stats: {
        hvBefore: countHV(pos, segs), hvAfter: countHV(pos, segs),
        hvdBefore: countHVD(pos, segs), hvdAfter: countHVD(pos, segs),
        segs: segs.length, verts: pos.size, moved: 0, passes: 0, reverted: false,
        skipped: true, shape: null, shapeZh: null, route: null, routeId: null,
        note: '略過',
      },
    }
  }

  const M = makeMover(pos, segs, inc, cols, rows)
  const shapePoly = pick.aligned

  // 描形站：切點在選中路線上，且鏡射線段不穿其他邊（論文圖 6）
  const Sshape = new Set()
  for (const id of pick.cutIds) {
    const p = pos.get(id)
    const pi = closestOnPoly(p, shapePoly)
    const mirror = [2 * pi[0] - p[0], 2 * pi[1] - p[1]]
    let hit = false
    for (const s of segs) {
      if (s.a === id || s.b === id) continue
      const A = pos.get(s.a), B = pos.get(s.b)
      if (segIntersect(p, mirror, A, B)) { hit = true; break }
    }
    if (!hit) Sshape.add(id)
  }
  // 至少留住路線上的切點（鏡射全被擋時退而求其次）
  if (!Sshape.size) for (const id of pick.cutIds) Sshape.add(id)

  // 邊分類：兩端都在描形站且屬選中路線 → shape 邊；其餘 octo
  const isShapeSeg = segs.map((s) => Sshape.has(s.a) && Sshape.has(s.b)
    && (s.routes?.has?.(pick.routeId) ?? false))

  // 連續變形（平滑＋混合合一：貼形 Ωc + 八方向 Ωo + 錨定 Ωp）
  const ids = [...pos.keys()].sort()
  const P = new Map(ids.map((id) => [id, [...pos.get(id)]]))
  const anchor = new Map(ids.map((id) => [id, [...pos.get(id)]]))

  for (let r = 0; r < ROUNDS; r++) {
    for (const id of ids) {
      let sx = WP * anchor.get(id)[0], sy = WP * anchor.get(id)[1], w = WP
      // Ωc：描形站往形狀最近點吸
      if (Sshape.has(id)) {
        const pi = closestOnPoly(P.get(id), shapePoly)
        const deg = Math.max(1, (inc.get(id) ?? []).length)
        sx += WC * deg * pi[0]
        sy += WC * deg * pi[1]
        w += WC * deg
      }
      // Ωo：非描形邊 → 近八方向目標（同 ⑤）
      for (const si of inc.get(id) ?? []) {
        if (isShapeSeg[si]) continue
        const s = segs[si]
        const o = P.get(s.a === id ? s.b : s.a)
        const me = P.get(id)
        const dx = (s.a === id ? o[0] - me[0] : me[0] - o[0])
        const dy = (s.a === id ? o[1] - me[1] : me[1] - o[1])
        // 以目前邊向量吸附到最近八方向，長度不變
        const d = Math.hypot(dx, dy)
        if (d < 1e-9) continue
        const sec = sectorOf(dx, dy)
        const [ux, uy] = SECTOR_VEC[sec]
        const un = Math.hypot(ux, uy)
        const fx = (ux / un) * d, fy = (uy / un) * d
        // v_b = v_a + f  → 本站目標
        if (s.a === id) {
          sx += WO * (o[0] - fx); sy += WO * (o[1] - fy)
        } else {
          sx += WO * (o[0] + fx); sy += WO * (o[1] + fy)
        }
        w += WO
      }
      const p = P.get(id)
      p[0] = sx / w
      p[1] = sy / w
    }
  }

  const snapped = snapAligned(P, pos, segs, inc)
  // 描形站優先套用（對應論文：C_shape 先於 C_octo）
  const shapeIds = [...Sshape].filter((id) => snapped.has(id)).sort()
  const otherIds = [...snapped.keys()].filter((id) => !Sshape.has(id)).sort()
  const batches = [...shapeIds, ...otherIds].map((id) => new Map([[id, snapped.get(id)]]))
  return finishBatches(pos, M, segs, batches, cols, rows, {
    rounds: ROUNDS,
    skipped: false,
    shape: pick.shapeId,
    shapeZh: SHAPE_ZH[pick.shapeId] ?? pick.shapeId,
    route: pick.routeName,
    routeId: pick.routeId,
    shapeVerts: Sshape.size,
    score: +pick.score.toFixed(3),
    note: `${pick.routeName}→${SHAPE_ZH[pick.shapeId] ?? pick.shapeId}`,
  }, { strict: true })
}

export { SHAPE_ZH }
