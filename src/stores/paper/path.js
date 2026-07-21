import {
  buildHcGraph, makeMover, applyTargets, countHV, countHVD,
} from '../hillClimb.js'
import { sharesRoute, isHVD } from '../netUtil.js'
import {
  WINDOW, emptyResult, clampTargets, finishPass, makeApplier, finishBatches,
  snapAligned, sectorOf, SECTOR_VEC, cyc8, outAngle, angBetween, TWO_PI,
} from './_shared.js'

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

