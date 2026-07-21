import {
  buildHcGraph, makeMover, applyTargets, countHV, countHVD,
} from '../hillClimb.js'
import { sharesRoute, isHVD } from '../netUtil.js'
import {
  WINDOW, emptyResult, clampTargets, finishPass, makeApplier, finishBatches,
  snapAligned, sectorOf, SECTOR_VEC, cyc8, outAngle, angBetween, TWO_PI,
} from './_shared.js'
import { dirModel, coordsFromDirs, L1, L2 } from './_dirModel.js'

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

