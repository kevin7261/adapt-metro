import {
  buildHcGraph, makeMover, applyTargets, countHV, countHVD,
} from '../hillClimb.js'
import { sharesRoute, isHVD } from '../netUtil.js'
import {
  WINDOW, emptyResult, clampTargets, finishPass, makeApplier, finishBatches,
  snapAligned, sectorOf, SECTOR_VEC, cyc8, outAngle, angBetween, TWO_PI,
} from './_shared.js'
import { dirModel, coordsFromDirs, L1, L2 } from './_dirModel.js'

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

