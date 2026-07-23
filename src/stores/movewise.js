// movewise 三步鏈＋循環＋逐步驗證——自 hillClimb.js 抽出，公開契約不變。
import {
  buildHcGraph, makeMover, countHV,
  makeUnionFind, compactGridSafe, auditGridDensity,
  setFrozen, getFrozen,
} from './hillClimb.js'
import { sharesRoute, isHV } from './netUtil.js'
import { isFourLineSquare } from './paper/shapeSquare.js'

// 八方向 1 格（上下左右＋ 45° 對角；使用者規則：一次一格，含對角）
const DIRS8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
]

// 端點移動：每個非白點一次移 1 格（八方向）。採納優先序（使用者規則）：
//   1. 移動後入射段 H/V 直線變多（淨增 > 0）——優先挑淨增最大者
//   2. 若皆無，但移動後入射段總長變短——挑縮最短者
// H/V 不可變少；bendsPaid／SPAN_CAP／validMove 硬規則同前。
function buildEndpointStraighten(skeleton, cells, cols, rows, opts = {}) {
  const limit = opts.limit ?? Infinity // 逐步驗證 子步驟：最多接受 limit 個移動
  const skip = opts.skip // 一遍掃描（movewiseSweep）中本輪已動過的點——跳過
  const movedIds = []
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length) {
    return { cellAfter: pos, stats: { hvBefore: 0, hvAfter: 0, segs: segs.length, verts: pos.size, moved: 0, endpoints: 0, movedIds } }
  }
  const M = makeMover(pos, segs, inc, cols, rows)
  const hvBefore = countHV(pos, segs)
  const ids = [...pos.keys()].sort()
  let moved = 0
  for (const v of ids) {
    if (moved >= limit) break
    if (skip && skip.has(v)) continue
    const vsegs = inc.get(v).map((si) => segs[si])
    if (!vsegs.length) continue
    const pv = pos.get(v)
    const otherPos = (s) => pos.get(s.a === v ? s.b : s.a)
    const hvAt = (P) => vsegs.reduce((n, s) => n + (isHV(P, otherPos(s)) ? 1 : 0), 0)
    const cur = hvAt(pv)
    const cand = DIRS8.map(([dc, dr]) => [pv[0] + dc, pv[1] + dr])
    const lenTotal = (P) => {
      let L = 0
      for (const s of vsegs) {
        const pu = otherPos(s)
        L += Math.hypot(P[0] - pu[0], P[1] - pu[1])
      }
      return L
    }
    const len0 = lenTotal(pv)
    // Tie-break: does an aligned segment continue straight into a same-route
    // H/V segment on the far side of its neighbour?
    const contScore = (P) => {
      let sc = 0
      for (const s of vsegs) {
        const u = s.a === v ? s.b : s.a
        const pu = pos.get(u)
        if (!isHV(P, pu)) continue
        const horiz = P[1] === pu[1]
        for (const si of inc.get(u)) {
          const t = segs[si]
          if (t === s || !sharesRoute(t.routes, s.routes)) continue
          const A = pos.get(t.a), B = pos.get(t.b)
          if (horiz ? (A[1] === B[1] && A[0] !== B[0]) : (A[0] === B[0] && A[1] !== B[1])) { sc++; break }
        }
      }
      return sc
    }
    // A bent segment must be paid for by a same-route segment straightening
    // in the same move; bending route X to straighten route Y is not allowed.
    const bendsPaid = (P) => {
      const gained = [], lost = []
      for (const s of vsegs) {
        const pu = otherPos(s)
        const before = isHV(pv, pu), after = isHV(P, pu)
        if (before && !after) lost.push(s)
        else if (!before && after) gained.push(s)
      }
      return lost.every((s) => gained.some((t) => sharesRoute(t.routes, s.routes)))
    }
    const scored = []
    for (const P of cand) {
      // 使用者規則：不得讓任一入射段的兩個顏色點橫跨超過 SPAN_CAP 格
      if (!vsegs.every((sg) => spanOk(pv, otherPos(sg), P, otherPos(sg)))) continue
      const delta = hvAt(P) - cur
      if (delta < 0) continue // H/V 數不可變少
      if (!bendsPaid(P)) continue
      const shorten = len0 - lenTotal(P) // >0＝路線變短
      // 優先：直線變多；否則：路線變短（都沒有則不進候選）
      if (delta <= 0 && shorten <= 1e-9) continue
      scored.push({ P, delta, shorten, cont: contScore(P) })
    }
    // 直線淨增優先 → 縮最短者 → 接直延續 → 座標決定序
    scored.sort((a, b) => b.delta - a.delta || b.shorten - a.shorten || b.cont - a.cont
      || a.P[0] - b.P[0] || a.P[1] - b.P[1])
    for (const c of scored) {
      if (!M.validMove(v, c.P)) continue
      M.applyMove(v, c.P)
      moved++
      movedIds.push(v)
      break
    }
  }
  return {
    cellAfter: pos,
    stats: { hvBefore, hvAfter: countHV(pos, segs), segs: segs.length, verts: pos.size, moved, endpoints: pos.size, movedIds },
  }
}

// 直線縮減：跨相交點串接的 H/V 直線整條剛體平移 1 格（八方向，含 45°）。
// 採納優先序（使用者規則）：① 邊界段 H/V 淨增 > 0；② 若皆無，邊界段總長
// 變短——挑縮最短者。H/V 不可變少；SPAN_CAP／validShift 硬規則同前。
// straight-line components per axis (union-find over same-axis straight
// segments), stitched across intersection vertices — shared by 直線縮減 and
// 網格合併.
function lineComponents(pos, segs, horiz) {
  const { parent, add, find, union } = makeUnionFind()
  for (const s of segs) {
    const A = pos.get(s.a), B = pos.get(s.b)
    const straight = horiz ? (A[1] === B[1] && A[0] !== B[0]) : (A[0] === B[0] && A[1] !== B[1])
    if (!straight) continue
    add(s.a); add(s.b)
    union(s.a, s.b)
  }
  const comps = new Map()
  for (const v of parent.keys()) {
    const root = find(v)
    if (!comps.has(root)) comps.set(root, [])
    comps.get(root).push(v)
  }
  return [...comps.values()].filter((c) => c.length >= 2 && c.length < pos.size)
    .map((c) => c.sort()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

// 使用者規則：任何移動不得讓「受影響段的兩個顏色點」橫跨超過 SPAN_CAP 格
// （Chebyshev：max(|dx|,|dy|)）——防止兩個顏色點之間的線被拉太長。本來就
// 超過上限的舊長段只准縮短或不變、不准再拉長（否則會把它們永久凍結）。
// 可由樣式 tab 設定（setSpanCap，預設 3 格）；離線腳本/畫廊用預設值。
let SPAN_CAP = 3
export function setSpanCap(n) {
  SPAN_CAP = Math.max(1, Math.round(+n) || 3)
}
const spanOf = (A, B) => Math.max(Math.abs(A[0] - B[0]), Math.abs(A[1] - B[1]))
const spanOk = (A0, B0, A1, B1) => {
  const ns = spanOf(A1, B1)
  return ns <= SPAN_CAP || ns <= spanOf(A0, B0)
}
// 剛體平移下所有邊界段（一端動、一端不動）的跨距檢查
function boundarySpanOk(pos, segs, inC, dc, dr) {
  for (const s of segs) {
    const ma = inC.has(s.a), mb = inC.has(s.b)
    if (ma === mb) continue
    const A = pos.get(s.a), B = pos.get(s.b)
    const A1 = ma ? [A[0] + dc, A[1] + dr] : A
    const B1 = mb ? [B[0] + dc, B[1] + dr] : B
    if (!spanOk(A, B, A1, B1)) return false
  }
  return true
}

// net H/V change of the BOUNDARY segments (one endpoint moving, one static)
// under a rigid shift of the inC vertex set — internal/static segments are
// unchanged, so this is the network-wide H/V delta. Shared by 直線縮減 and
// 網格合併.
function boundaryHvDelta(pos, segs, inC, dc, dr) {
  let d = 0
  for (const s of segs) {
    const ma = inC.has(s.a), mb = inC.has(s.b)
    if (ma === mb) continue
    const A = pos.get(s.a), B = pos.get(s.b)
    const A2 = ma ? [A[0] + dc, A[1] + dr] : A
    const B2 = mb ? [B[0] + dc, B[1] + dr] : B
    d += (isHV(A2, B2) ? 1 : 0) - (isHV(A, B) ? 1 : 0)
  }
  return d
}

// 邊界段總長變化（剛體平移）；shorten = −delta > 0 表示路線變短
function boundaryLenDelta(pos, segs, inC, dc, dr) {
  let d = 0
  for (const s of segs) {
    const ma = inC.has(s.a), mb = inC.has(s.b)
    if (ma === mb) continue
    const A = pos.get(s.a), B = pos.get(s.b)
    const A2 = ma ? [A[0] + dc, A[1] + dr] : A
    const B2 = mb ? [B[0] + dc, B[1] + dr] : B
    d += Math.hypot(A2[0] - B2[0], A2[1] - B2[1]) - Math.hypot(A[0] - B[0], A[1] - B[1])
  }
  return d
}

function lineCompactPass(skeleton, cells, cols, rows, opts = {}) {
  const limit = opts.limit ?? Infinity // 逐步驗證 子步驟：最多接受 limit 個移動
  const skip = opts.skip // 一遍掃描中本輪已動過的線（以最小成員 id 識別）——跳過
  const movedIds = []
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  const empty = { cellAfter: pos, moved: 0, hvBefore: 0, hvAfter: 0, segs: segs.length, verts: pos.size, occBefore: [0, 0], occAfter: [0, 0], movedIds }
  if (!pos.size || !segs.length) return empty
  const M = makeMover(pos, segs, inc, cols, rows)
  const hvBefore = countHV(pos, segs)

  // occupied-coordinate counts per axis（stats 用）
  const count = [new Map(), new Map()]
  const recount = () => {
    for (const ax of [0, 1]) {
      count[ax].clear()
      for (const p of pos.values()) count[ax].set(p[ax], (count[ax].get(p[ax]) ?? 0) + 1)
    }
  }
  recount()
  const occBefore = [count[0].size, count[1].size]
  let moved = 0
  for (const horiz of [true, false]) {
    for (const comp of lineComponents(pos, segs, horiz)) {
      if (moved >= limit) break
      if (skip && skip.has(comp[0])) continue
      const inC = new Set(comp)
      // 八方向各 ±1 格（含 45°；使用者規則：一次一格）
      const scored = []
      for (const [dc, dr] of DIRS8) {
        if (!boundarySpanOk(pos, segs, inC, dc, dr)) continue
        const hv = boundaryHvDelta(pos, segs, inC, dc, dr)
        if (hv < 0) continue // 整個 network 的直線（H/V 段）不可變少
        const shorten = -boundaryLenDelta(pos, segs, inC, dc, dr)
        // 優先：直線變多；否則：路線變短
        if (hv <= 0 && shorten <= 1e-9) continue
        scored.push({ dc, dr, hv, shorten })
      }
      scored.sort((a, b) => b.hv - a.hv || b.shorten - a.shorten
        || a.dc - b.dc || a.dr - b.dr)
      for (const c of scored) {
        if (!M.validShift(comp, inC, c.dc, c.dr)) continue
        M.applyShift(comp, [c.dc, c.dr])
        recount()
        moved++
        movedIds.push(...comp)
        break
      }
    }
  }
  return {
    cellAfter: pos, moved, hvBefore, hvAfter: countHV(pos, segs),
    segs: segs.length, verts: pos.size,
    occBefore, occAfter: [count[0].size, count[1].size], movedIds,
  }
}

// （直線縮減整段掃描的 wrapper 已退役——所有下游改走 movewiseStage('line')：
// 每一個移動後立即縮減網格。單掃描 pass 本身保留給 movewise/逐步驗證 用。）

// 網格合併（原「網格合併」）one sweep：把相鄰的 row 兩兩合併、col 兩兩合併。
// 合併 r|r+1 ＝「row > r 的所有點整體上移 1 格」（半平面剛體平移，row r+1 的
// 點落進 row r、其下全部跟著上移）——不留空列、自帶壓縮；col 同理左移。
// 合法性走 validShift **同一套硬規則**（不壓點、不新增交叉/路線重疊、象限與
// 邊環繞序不變＝拓撲不變——與端點移動/直線縮減同判準）。附帶性質：邊界段
// 跨距只縮不增、H/V 段只增不減（水平/垂直段不受影響、dy=1 的斜段會變水平、
// dy=1 的垂直段會因兩端撞格被 validShift 擋下）。掃描順序：rows 由上而下、
// cols 由左而右，每個邊界本遍試一次（合併成功即前進，兩兩配對不重複吃）；
// cursor 讓逐步驗證的小步跨點擊延續同一遍。
function gridMergeSweep(skeleton, cells, cols, rows, opts = {}) {
  const limit = opts.limit ?? Infinity
  let cursor = opts.cursor ? { ...opts.cursor } : { phase: 'row', idx: 0 }
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  if (!pos.size || !segs.length || cursor.phase === 'done') {
    return { cellAfter: pos, cols, rows, merged: 0, mergedRows: 0, mergedCols: 0, cursor: { phase: 'done', idx: 0 }, movedIds: [], desc: [] }
  }
  const M = makeMover(pos, segs, inc, cols, rows)
  let nC = cols, nR = rows
  let mergedRows = 0, mergedCols = 0
  const desc = []
  const half = (ax, gt) => {
    const comp = []
    for (const [id, pnt] of pos) if (pnt[ax] > gt) comp.push(id)
    return comp.sort()
  }
  if (cursor.phase === 'row') {
    let r = cursor.idx
    while (r + 1 < nR && mergedRows + mergedCols < limit) {
      const comp = half(1, r)
      const inC = new Set(comp)
      if (comp.length && M.validShift(comp, inC, 0, -1)) {
        M.applyShift(comp, [0, -1])
        nR -= 1
        mergedRows++
        desc.push(`row ${r}｜${r + 1}`)
      }
      r += 1
    }
    cursor = r + 1 < nR ? { phase: 'row', idx: r } : { phase: 'col', idx: 0 }
  }
  if (cursor.phase === 'col') {
    let c = cursor.idx
    while (c + 1 < nC && mergedRows + mergedCols < limit) {
      const comp = half(0, c)
      const inC = new Set(comp)
      if (comp.length && M.validShift(comp, inC, -1, 0)) {
        M.applyShift(comp, [-1, 0])
        nC -= 1
        mergedCols++
        desc.push(`col ${c}｜${c + 1}`)
      }
      c += 1
    }
    cursor = c + 1 < nC ? { phase: 'col', idx: c } : { phase: 'done', idx: 0 }
  }
  return { cellAfter: pos, cols: nC, rows: nR, merged: mergedRows + mergedCols, mergedRows, mergedCols, cursor, movedIds: [], desc }
}

const NUDGE_DIRS = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [-1, 1], [1, -1], [1, 1],
]

/**
 * 半平面平移前清掉「落地格被非凍結點佔住」的擋格——否則成對縮格在密集區
 * 會全部 occupy 失敗、空列永遠消不掉（東京山手形狀層 2026-07）。
 * 只准挪動非 members；失敗回 false。
 */
function shiftAfterClearing(M, pos, movers, dc, dr, cols, rows, frozenMembers) {
  const inC = new Set(movers)
  if (!movers.length) return false
  for (let round = 0; round < 64; round++) {
    if (M.validShift(movers, inC, dc, dr)) {
      M.applyShift(movers, [dc, dr])
      return true
    }
    let cleared = false
    const blockers = new Set()
    for (const w of movers) {
      const [c, r] = pos.get(w)
      const nc = c + dc, nr = r + dr
      for (const [id, p] of pos) {
        if (p[0] === nc && p[1] === nr && !inC.has(id)) blockers.add(id)
      }
    }
    for (const owner of blockers) {
      if (frozenMembers?.has(owner)) continue
      const cur = pos.get(owner)
      if (!cur) continue
      for (const [ddc, ddr] of NUDGE_DIRS) {
        const P = [cur[0] + ddc, cur[1] + ddr]
        if (P[0] < 0 || P[1] < 0 || P[0] >= cols || P[1] >= rows) continue
        if (!M.validMove(owner, P)) continue
        M.applyMove(owner, P)
        cleared = true
        break
      }
    }
    if (!cleared) return false
  }
  return false
}

/**
 * 成方成對縮格：剛體護欄會擋「切開方形」的單軸合併（否則寬高一變就破方）。
 * 同時併一欄＋一列（各縮 1），再驗 isFourLineSquare——方仍是方，但能繼續壓縮。
 * 半平面落地被擋時先把非凍結擋格挪開（shiftAfterClearing），避免做到一半停住。
 */
function squarePairShrinkOnce(skeleton, cells, cols, rows) {
  const guard = getFrozen()
  if (!guard?.members?.size || !guard.ringIds?.length) return null
  const { pos } = buildHcGraph(skeleton, cells)
  if (!pos.size) return null
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity
  for (const id of guard.members) {
    const p = pos.get(id)
    if (!p) continue
    minC = Math.min(minC, p[0]); maxC = Math.max(maxC, p[0])
    minR = Math.min(minR, p[1]); maxR = Math.max(maxR, p[1])
  }
  if (!(maxC > minC && maxR > minR)) return null

  const saved = guard
  // 優先消「無顏色點」的列／欄邊界，再掃一般邊界（空帶先清，避免半途停）
  const usedC = new Set(), usedR = new Set()
  for (const p of pos.values()) { usedC.add(p[0]); usedR.add(p[1]) }
  const colCuts = []
  const rowCuts = []
  for (let c = minC; c < maxC; c++) colCuts.push(c)
  for (let r = minR; r < maxR; r++) rowCuts.push(r)
  colCuts.sort((a, b) => Number(usedC.has(a + 1)) - Number(usedC.has(b + 1)) || a - b)
  rowCuts.sort((a, b) => Number(usedR.has(a + 1)) - Number(usedR.has(b + 1)) || a - b)

  setFrozen(null) // 試算單軸時關護欄；成對後用 isFourLineSquare 驗方
  try {
    for (const c of colCuts) {
      for (const r of rowCuts) {
        const trialCells = new Map([...cells].map(([id, p]) => [id, [...p]]))
        for (const [id, p] of pos) {
          if (!trialCells.has(id)) trialCells.set(id, [...p])
        }
        const g = buildHcGraph(skeleton, trialCells)
        for (const [id, p] of trialCells) {
          if (!g.pos.has(id)) { g.pos.set(id, [...p]); g.inc.set(id, []) }
        }
        const M = makeMover(g.pos, g.segs, g.inc, cols, rows)
        const compC = []
        for (const [id, pnt] of g.pos) if (pnt[0] > c) compC.push(id)
        if (!shiftAfterClearing(M, g.pos, compC, -1, 0, cols, rows, saved.members)) continue
        const compR = []
        for (const [id, pnt] of g.pos) if (pnt[1] > r) compR.push(id)
        if (!shiftAfterClearing(M, g.pos, compR, 0, -1, cols, rows, saved.members)) continue
        const ring = saved.ringIds.filter((id) => g.pos.has(id))
        if (ring.length < 4 || !isFourLineSquare(ring, g.pos, g.segs)) continue
        const out = new Map()
        for (const id of cells.keys()) {
          const p = g.pos.get(id)
          if (p) out.set(id, [p[0], p[1]])
        }
        return { cellAfter: out, cols: cols - 1, rows: rows - 1 }
      }
    }
    // 列優先（有時欄向擋格清完後列向才過）
    for (const r of rowCuts) {
      for (const c of colCuts) {
        const trialCells = new Map([...cells].map(([id, p]) => [id, [...p]]))
        for (const [id, p] of pos) {
          if (!trialCells.has(id)) trialCells.set(id, [...p])
        }
        const g = buildHcGraph(skeleton, trialCells)
        for (const [id, p] of trialCells) {
          if (!g.pos.has(id)) { g.pos.set(id, [...p]); g.inc.set(id, []) }
        }
        const M = makeMover(g.pos, g.segs, g.inc, cols, rows)
        const compR = []
        for (const [id, pnt] of g.pos) if (pnt[1] > r) compR.push(id)
        if (!shiftAfterClearing(M, g.pos, compR, 0, -1, cols, rows, saved.members)) continue
        const compC = []
        for (const [id, pnt] of g.pos) if (pnt[0] > c) compC.push(id)
        if (!shiftAfterClearing(M, g.pos, compC, -1, 0, cols, rows, saved.members)) continue
        const ring = saved.ringIds.filter((id) => g.pos.has(id))
        if (ring.length < 4 || !isFourLineSquare(ring, g.pos, g.segs)) continue
        const out = new Map()
        for (const id of cells.keys()) {
          const p = g.pos.get(id)
          if (p) out.set(id, [p[0], p[1]])
        }
        return { cellAfter: out, cols: cols - 1, rows: rows - 1 }
      }
    }
  } finally {
    setFrozen(saved)
  }
  return null
}

/**
 * 空帶填滿：成對縮／半平面消不掉的空列／空欄（東京 stroke 常卡 1 空列），
 * 把「來源列／欄有 ≥2 點」的非凍結點 validMove 進空帶——網格尺寸不變、
 * 方仍是方、audit dense。消不掉就填滿，使用者規則：不可留無顏色點的欄列。
 */
function fillEmptyBandsOnce(skeleton, cells, cols, rows) {
  const dens0 = auditGridDensity(cells, cols, rows)
  if (dens0.dense) return null
  const guard = getFrozen()
  const frozenMembers = guard?.members ?? null
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  for (const [id, cell] of cells) {
    if (!pos.has(id)) { pos.set(id, [cell[0], cell[1]]); inc.set(id, []) }
  }
  const M = makeMover(pos, segs, inc, cols, rows)
  let filled = 0
  const tryFill = (axis, emptyIdx) => {
    // axis 0＝空欄（改 x）；1＝空列（改 y）
    const countAt = (v) => {
      let n = 0
      for (const p of pos.values()) if (p[axis] === v) n++
      return n
    }
    for (const [id, p] of pos) {
      if (frozenMembers?.has(id)) continue
      const src = p[axis]
      if (src === emptyIdx) continue
      if (countAt(src) < 2) continue
      const P = axis === 0 ? [emptyIdx, p[1]] : [p[0], emptyIdx]
      if (P[0] < 0 || P[1] < 0 || P[0] >= cols || P[1] >= rows) continue
      if (!M.validMove(id, P)) continue
      M.applyMove(id, P)
      filled++
      return true
    }
    return false
  }
  // 多輪：填一格可能露出下一條可填
  for (let guardN = 0; guardN < 64; guardN++) {
    const dens = auditGridDensity(pos, cols, rows)
    if (dens.dense) break
    let did = false
    for (const r of dens.emptyRows) if (tryFill(1, r)) { did = true; break }
    if (!did) for (const c of dens.emptyCols) if (tryFill(0, c)) { did = true; break }
    if (!did) break
  }
  if (!filled) return null
  const out = new Map()
  for (const id of cells.keys()) {
    const p = pos.get(id)
    if (p) out.set(id, [p[0], p[1]])
  }
  return { cellAfter: out, cols, rows, filled }
}

/* ==================== 逐移動壓縮（movewise） ====================
   使用者規則：取消獨立的縮減網格步驟——端點移動/直線縮減/網格合併的
   **每一個小步驟（單一移動）完成後就做縮減網格**。實作＝以 limit=1 反覆呼叫
   該階段的 pass，每個移動後立即 compactGrid，直到動不了；網格因此隨時緻密。
   所有吃這三個階段的地方（tabs／循環／RWD 底圖／llmGrid／畫廊）都走這裡。 */
const MOVEWISE_CAP = 5000 // 單一階段的移動數保險上限（遠大於實測）
const MOVEWISE_PASS = {
  endp: (sk, cells, cols, rows, skip) => {
    const r = buildEndpointStraighten(sk, cells, cols, rows, { limit: 1, skip })
    return { cellAfter: r.cellAfter, moved: r.stats.moved, pts: r.stats.moved, lines: 0, ids: r.stats.movedIds, key: r.stats.movedIds[0] }
  },
  line: (sk, cells, cols, rows, skip) => {
    const r = lineCompactPass(sk, cells, cols, rows, { limit: 1, skip })
    return { cellAfter: r.cellAfter, moved: r.moved, pts: 0, lines: r.moved, ids: r.movedIds, key: r.movedIds[0] }
  },
  // gather（網格合併）不在此表——半平面合併自帶壓縮，走 gridMergeSweep 專用路徑。
}
// 跑到該階段自己的不動點（同一元素可動多次）——tabs／循環的整段執行用。
export function movewiseStage(stage, skeleton, cells, cols, rows) {
  return movewiseCore(stage, skeleton, cells, cols, rows, null)
}

// 網格合併掃到不動點的保險上限——不可共用 POST_ITER_CAP（=20，論文鏈用）。
// 成方圖層幾乎全靠「成對縮方」，東京山手一圈就需要數十次；用 20 會半途截斷
// （實測 rot-shape：20 次停在 62×64，跑滿可到 21×20 且方仍在；使用者回報 2026-07）。
const MERGE_ITER_CAP = 5000
// 網格合併的 stage 驅動：single=true 只掃一遍（逐步小步／單遍 sweep 用）、
// 否則掃到沒有可合併（網格合併 tab、循環、逐步「下一步」）。成方時另跑
// 「成對縮方」（單軸切開會破方，成對縮仍保正方）。
function gridMergeStage(skeleton, cells, cols, rows, opts = {}) {
  let comp = compactGridSafe(skeleton, cells, cols, rows)
  let cur = comp.cellAfter, nC = comp.cols, nR = comp.rows
  const fromCols = nC, fromRows = nR
  const g0 = buildHcGraph(skeleton, cur)
  const hvBefore = countHV(g0.pos, g0.segs)
  const verts = g0.pos.size, segsN = g0.segs.length
  let mergedRows = 0, mergedCols = 0, pairMerges = 0, guardN = 0
  // 一般合併 ⇄ 成對縮方交替到不動點——成對縮完常又露出可單軸合併的空帶，
  // 舊邏輯只跑「先合併後成對」各一輪會半途停住（使用者回報 2026-07）。
  while (guardN++ < MERGE_ITER_CAP) {
    let progressed = false
    while (guardN++ < MERGE_ITER_CAP) {
      const r = gridMergeSweep(skeleton, cur, nC, nR)
      mergedRows += r.mergedRows
      mergedCols += r.mergedCols
      cur = r.cellAfter
      nC = r.cols
      nR = r.rows
      if (!r.merged) break
      progressed = true
      if (opts.single) break
    }
    if (getFrozen()) {
      while (guardN++ < MERGE_ITER_CAP) {
        const p = squarePairShrinkOnce(skeleton, cur, nC, nR)
        if (!p) break
        cur = p.cellAfter
        nC = p.cols
        nR = p.rows
        pairMerges++
        mergedRows++
        mergedCols++
        progressed = true
        const dens = compactGridSafe(skeleton, cur, nC, nR)
        cur = dens.cellAfter
        nC = dens.cols
        nR = dens.rows
        if (opts.single) break
      }
    }
    if (!progressed || opts.single) break
  }
  // 收尾再壓一次空帶（成對縮／擋格挪開後，先前被擋的空列可能已合法）
  {
    const dens = compactGridSafe(skeleton, cur, nC, nR)
    cur = dens.cellAfter
    nC = dens.cols
    nR = dens.rows
  }
  // 仍有空列／空欄且成方中：端點／直線微調可能挪開擋格，再給成對縮一次機會
  // （否則會「明明看得到空帶卻停住」）。
  if (!opts.single && getFrozen()) {
    let densifyGuard = 0
    while (densifyGuard++ < 8) {
      const dens = auditGridDensity(cur, nC, nR)
      if (dens.dense) break
      const endp = MOVEWISE_PASS.endp(skeleton, cur, nC, nR, undefined)
      let next = cur, nC2 = nC, nR2 = nR
      if (endp.moved) {
        const d = compactGridSafe(skeleton, endp.cellAfter, nC, nR)
        next = d.cellAfter; nC2 = d.cols; nR2 = d.rows
      }
      const line = MOVEWISE_PASS.line(skeleton, next, nC2, nR2, undefined)
      if (line.moved) {
        const d = compactGridSafe(skeleton, line.cellAfter, nC2, nR2)
        next = d.cellAfter; nC2 = d.cols; nR2 = d.rows
      }
      cur = next; nC = nC2; nR = nR2
      let paired = false
      while (true) {
        const p = squarePairShrinkOnce(skeleton, cur, nC, nR)
        if (!p) break
        cur = p.cellAfter
        nC = p.cols
        nR = p.rows
        pairMerges++
        mergedRows++
        mergedCols++
        paired = true
        const d2 = compactGridSafe(skeleton, cur, nC, nR)
        cur = d2.cellAfter
        nC = d2.cols
        nR = d2.rows
      }
      if (!endp.moved && !line.moved && !paired) break
    }
    // 成對仍消不掉的空帶：非凍結點填進空列／空欄（保方＋dense）
    while (true) {
      const f = fillEmptyBandsOnce(skeleton, cur, nC, nR)
      if (!f) break
      cur = f.cellAfter
      nC = f.cols
      nR = f.rows
    }
  }
  // 非成方：compactGridSafe 後若仍有空帶（硬規則擋），同樣嘗試填滿
  if (!opts.single && !getFrozen()) {
    while (true) {
      const f = fillEmptyBandsOnce(skeleton, cur, nC, nR)
      if (!f) break
      cur = f.cellAfter
    }
  }
  const g1 = buildHcGraph(skeleton, cur)
  const density = auditGridDensity(cur, nC, nR)
  return {
    cellAfter: cur,
    cols: nC,
    rows: nR,
    stats: {
      hvBefore, hvAfter: countHV(g1.pos, g1.segs), segs: segsN, verts,
      moved: mergedRows + mergedCols, mergedRows, mergedCols, pairMerges,
      movedPts: mergedRows, movedLines: mergedCols,
      converged: true,
      fromCols, fromRows, cols: nC, rows: nR,
      ...density,
    },
  }
}

// 一遍掃描（逐步「下一小步」延續同一遍用）：每個元素本遍最多動一次。
// 循環／逐步「下一步」改走 movewiseStage（跑到不動點），不再用 sweep。
function movewiseSweep(stage, skeleton, cells, cols, rows, visited = new Set()) {
  return movewiseCore(stage, skeleton, cells, cols, rows, visited)
}

// movewiseStage / movewiseSweep 的共用本體——唯二差異由 visited 決定：
// null＝跑到不動點（元素可重複動；gather 掃到沒有可合併），Set＝一遍掃描
// （動過進 visited、pass 以 skip 跳過；gather 只掃一遍 single:true）。
// 每一個移動後都立即 compactGrid（起點也先壓；上一階段輸出已緻密時是 no-op）。
function movewiseCore(stage, skeleton, cells, cols, rows, visited) {
  if (stage === 'gather') return gridMergeStage(skeleton, cells, cols, rows, visited ? { single: true } : {})
  let comp = compactGridSafe(skeleton, cells, cols, rows)
  let cur = comp.cellAfter, nC = comp.cols, nR = comp.rows
  const fromCols = nC, fromRows = nR
  const g0 = buildHcGraph(skeleton, cur)
  const hvBefore = countHV(g0.pos, g0.segs)
  const verts = g0.pos.size, segsN = g0.segs.length
  let moved = 0, movedPts = 0, movedLines = 0
  while (moved < MOVEWISE_CAP) {
    const r = MOVEWISE_PASS[stage](skeleton, cur, nC, nR, visited ?? undefined)
    if (!r.moved) break
    if (visited) visited.add(r.key)
    moved += r.moved
    movedPts += r.pts
    movedLines += r.lines
    comp = compactGridSafe(skeleton, r.cellAfter, nC, nR) // 每一個移動後立即縮減網格
    cur = comp.cellAfter
    nC = comp.cols
    nR = comp.rows
  }
  const g1 = buildHcGraph(skeleton, cur)
  return {
    cellAfter: cur,
    cols: nC,
    rows: nR,
    stats: {
      hvBefore, hvAfter: countHV(g1.pos, g1.segs), segs: segsN, verts,
      moved, movedPts, movedLines, converged: moved < MOVEWISE_CAP,
      fromCols, fromRows, cols: nC, rows: nR,
    },
  }
}

/* ==================== 逐步驗證（逐步執行） ====================
   讓使用者一鍵一步看鏈怎麼收斂：每一步 = 目前階段的**一個單掃描**（或
   limit=1 的單一移動），順序 端點移動 → 直線縮減 → 網格合併；**每一步完成後
   立即縮減網格**（使用者規則：取消獨立的縮減網格階段，改成每步後都壓），
   所以畫面上的網格永遠是緻密的。某階段掃不動就自動換下一階段（同一鍵內
   跳過空階段），一輪三階段都沒動靜＝完成。
   狀態是純資料（cells/cols/rows/stage/round/steps/info），呼叫端自己保存。 */
const STEP_STAGE_LABEL = { endp: '端點移動', line: '直線縮減', gather: '網格合併' }
export function stepChainInit(skeleton, cells, cols, rows) {
  const comp = compactGridSafe(skeleton, cells, cols, rows) // 每步後都壓 → 起點也先壓
  return {
    cells: comp.cellAfter, cols: comp.cols, rows: comp.rows,
    stage: 'endp', round: 1, steps: 0, roundMoves: 0, done: false,
    lastStage: null, // 這一步執行的工作（endp/line/gather）——顯示在面板的階段 chips
    movedIds: [], // 這一步移動的點/線成員 id——畫布上以橘圈標示
    moves: [], // 這一步的前後比對 [{ id, from:[c,r], to:[c,r] }]（縮減後 rank 空間，可為半格）
    sweepVisited: [], // 目前這一遍掃描中已動過的元素 key（小步跨點擊延續同一遍）
    mergeCursor: null, // 網格合併這一遍掃到哪個邊界（{phase:'row'|'col', idx}；小步延續用）
    info: '按「下一步」開始——每步＝目前演算法跑到不能動，再換下一個：端點移動 → 直線縮減 → 網格合併 → 下一輪；三個都沒改動就停止',
  }
}
export function stepChainNext(skeleton, st, opts = {}) {
  if (st.done) return st
  const limit = opts.limit ?? Infinity // limit=1 ＝「下一小步」：只做一個點/線的移動
  const subTag = limit === 1 ? '（小步）' : ''
  let { cells, cols, rows, stage, round, steps, roundMoves } = st
  let sweepVisited = st.sweepVisited ?? []
  let mergeCursor = st.mergeCursor ?? null
  // 前後比對：這一步每個移動元素的 from→to 格座標（移動當下、縮減前的座標）
  const movesOf = (prev, next, ids) => {
    const seen = new Set()
    const out = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const a = prev.get(id), b = next.get(id)
      if (a && b && (a[0] !== b[0] || a[1] !== b[1])) out.push({ id, from: [a[0], a[1]], to: [b[0], b[1]] })
    }
    return out
  }
  // 小步的訊息尾巴：單點顯示 (c,r)→(c,r)、整條線顯示位移向量＋成員數
  const coordTag = (mv) => {
    if (limit !== 1 || !mv.length) return ''
    if (mv.length === 1) return `｜(${mv[0].from[0]},${mv[0].from[1]}) → (${mv[0].to[0]},${mv[0].to[1]})`
    const dx = mv[0].to[0] - mv[0].from[0], dy = mv[0].to[1] - mv[0].from[1]
    return `｜整條線位移 (${dx},${dy})、${mv.length} 點`
  }
  // 每一步完成後立即縮減網格：新佈局壓縮、前後比對座標換算到縮減後的 rank
  // 空間（to 一定是佔用座標 → 整數 rank；from 的欄/列可能被清空 → 落在前後
  // 兩個保留 rank 之間的 -0.5 半格，畫圖用內插）。
  const finalize = (next, ids, infoBase) => {
    const usedC = [...new Set([...next.values()].map((p) => p[0]))].sort((a, b) => a - b)
    const usedR = [...new Set([...next.values()].map((p) => p[1]))].sort((a, b) => a - b)
    const rankOf = (v, used) => {
      let lo = 0, hi = used.length
      while (lo < hi) { const m = (lo + hi) >> 1; if (used[m] < v) lo = m + 1; else hi = m }
      return used[lo] === v ? lo : lo - 0.5
    }
    const moves = movesOf(cells, next, ids).map((m) => ({
      id: m.id,
      from: [rankOf(m.from[0], usedC), rankOf(m.from[1], usedR)],
      to: [rankOf(m.to[0], usedC), rankOf(m.to[1], usedR)],
    }))
    const comp = compactGridSafe(skeleton, next, cols, rows)
    const shrunk = comp.cols !== cols || comp.rows !== rows
    return {
      cells: comp.cellAfter, cols: comp.cols, rows: comp.rows,
      stage, round, steps: steps + 1, roundMoves, done: false, lastStage: stage,
      movedIds: ids, moves, sweepVisited, mergeCursor,
      info: infoBase + (shrunk ? `｜縮減網格 ${cols}×${rows} → ${comp.cols}×${comp.rows}` : ''),
    }
  }
  // 「下一步」＝目前演算法**跑到不動點**（movewiseStage）再換下一個——使用者規則
  // （2026-07）：算到不能動才到下一階段／下一輪。小步仍逐移動，但同一階段要
  // 連做多遍直到一整遍都動不了才換。
  const NEXT_STAGE = { endp: 'line', line: 'gather', gather: 'endp' }
  const STAGE_INFO = {
    endp: (t) => `移動 ${t.moved} 點（水平垂直 ${t.hvBefore} → ${t.hvAfter}／${t.segs} 段）`,
    line: (t) => `移動 ${t.moved} 線`,
    gather: (t) => `合併 ${t.mergedRows ?? t.movedPts} 列＋${t.mergedCols ?? t.movedLines} 欄`,
  }
  for (let guard = 0; guard < 9; guard++) {
    if (stage === 'gather') {
      if (limit !== 1) {
        // 大步：網格合併跑到不動點（含成對縮方），再進下一輪
        const sw = movewiseStage('gather', skeleton, cells, cols, rows)
        if (sw.stats.moved) {
          const gridTag = sw.stats.fromCols !== sw.cols || sw.stats.fromRows !== sw.rows
            ? `｜網格 ${sw.stats.fromCols}×${sw.stats.fromRows} → ${sw.cols}×${sw.rows}` : ''
          return {
            cells: sw.cellAfter, cols: sw.cols, rows: sw.rows,
            stage: 'endp', round: round + 1, steps: steps + 1, roundMoves: 0, done: false,
            lastStage: 'gather', movedIds: [], moves: [], sweepVisited: [], mergeCursor: null,
            info: `第 ${round} 輪 · ${STEP_STAGE_LABEL.gather}（至不動點）：${STAGE_INFO.gather(sw.stats)}${gridTag}`,
          }
        }
        if (!roundMoves) {
          return { cells, cols, rows, stage, round, steps, roundMoves, done: true, lastStage: null, movedIds: [], moves: [], sweepVisited: [], mergeCursor: null, info: `✔ 收斂完成——共 ${steps} 步、第 ${round} 輪三個演算法都沒有改動` }
        }
        round += 1
        roundMoves = 0
        stage = 'endp'
        sweepVisited = []
        mergeCursor = null
        continue
      }
      // 小步：合併下一個可合併的邊界（cursor 延續）；成方時單軸掃不動改試成對縮方
      let r = gridMergeSweep(skeleton, cells, cols, rows,
        { limit: 1, cursor: mergeCursor ?? undefined })
      if (!r.merged && getFrozen() && (mergeCursor == null || mergeCursor.phase === 'done')) {
        const p = squarePairShrinkOnce(skeleton, cells, cols, rows)
        if (p) {
          const dens = compactGridSafe(skeleton, p.cellAfter, p.cols, p.rows)
          r = {
            cellAfter: dens.cellAfter, cols: dens.cols, rows: dens.rows,
            merged: 2, mergedRows: 1, mergedCols: 1, cursor: { phase: 'done', idx: 0 },
            movedIds: [], desc: ['成對縮方'],
          }
        }
      }
      if (r.merged) {
        roundMoves += r.merged
        const info = `第 ${round} 輪 · ${STEP_STAGE_LABEL.gather}${subTag}：合併 ${r.desc[0]}｜網格 ${cols}×${rows} → ${r.cols}×${r.rows}`
        if (r.cursor.phase !== 'done') {
          return { cells: r.cellAfter, cols: r.cols, rows: r.rows, stage, round, steps: steps + 1, roundMoves, done: false, lastStage: 'gather', movedIds: [], moves: [], sweepVisited, mergeCursor: r.cursor, info }
        }
        // 這一遍掃完但仍有合併 → 再開一遍（同一階段算到不能動）
        return { cells: r.cellAfter, cols: r.cols, rows: r.rows, stage: 'gather', round, steps: steps + 1, roundMoves, done: false, lastStage: 'gather', movedIds: [], moves: [], sweepVisited: [], mergeCursor: null, info }
      }
      // 這一遍沒有可合併 → 一輪結束
      if (!roundMoves) {
        return { cells, cols, rows, stage, round, steps, roundMoves, done: true, lastStage: null, movedIds: [], moves: [], sweepVisited: [], mergeCursor: null, info: `✔ 收斂完成——共 ${steps} 步、第 ${round} 輪三個演算法都沒有改動` }
      }
      round += 1
      roundMoves = 0
      stage = 'endp'
      sweepVisited = []
      mergeCursor = null
      continue
    }
    if (limit === 1) {
      // 小步：這一遍中的下一個單一移動；遍完且本遍有動過 → 清空 visited 再開一遍
      // （同一階段算到不能動）；一整遍都動不了才換階段
      const r = MOVEWISE_PASS[stage](skeleton, cells, cols, rows, new Set(sweepVisited))
      if (r.moved) {
        roundMoves += r.moved
        sweepVisited = [...sweepVisited, r.key]
        const mv = movesOf(cells, r.cellAfter, r.ids)
        const what = stage === 'endp' ? '移動 1 點' : '移動 1 線'
        return finalize(r.cellAfter, r.ids,
          `第 ${round} 輪 · ${STEP_STAGE_LABEL[stage]}${subTag}：${what}${coordTag(mv)}`)
      }
      if (sweepVisited.length > 0) {
        sweepVisited = []
        mergeCursor = null
        continue // 新的一遍，仍留在本階段
      }
      // 一整遍都動不了 → 換下一個演算法
    } else {
      // 大步：目前演算法跑到不動點，再換下一個
      const sw = movewiseStage(stage, skeleton, cells, cols, rows)
      if (sw.stats.moved) {
        roundMoves += sw.stats.moved
        const gridTag = sw.stats.fromCols !== sw.cols || sw.stats.fromRows !== sw.rows
          ? `｜縮減網格 ${sw.stats.fromCols}×${sw.stats.fromRows} → ${sw.cols}×${sw.rows}` : ''
        const doneStage = stage
        const nextStage = NEXT_STAGE[stage]
        const endOfRound = stage === 'gather'
        return {
          cells: sw.cellAfter, cols: sw.cols, rows: sw.rows,
          stage: nextStage, round: endOfRound ? round + 1 : round,
          steps: steps + 1, roundMoves: endOfRound ? 0 : roundMoves, done: false,
          lastStage: doneStage, movedIds: [], moves: [], sweepVisited: [], mergeCursor: null,
          info: `第 ${round} 輪 · ${STEP_STAGE_LABEL[doneStage]}（至不動點）：${STAGE_INFO[doneStage](sw.stats)}${gridTag}`,
        }
      }
    }
    // 推進：換下一個演算法（gather 的一輪結束邏輯在上面的特例處理）
    stage = NEXT_STAGE[stage]
    sweepVisited = []
    mergeCursor = null
  }
  return { cells, cols, rows, stage, round, steps, roundMoves, done: true, lastStage: null, movedIds: [], moves: [], sweepVisited: [], mergeCursor: null, info: `✔ 收斂完成——共 ${steps} 步、${round} 輪` }
}

// 端點移動+直線縮減+網格合併循環：每輪三個階段**各自跑到不動點**再換下一個；
// 每一個移動後立即縮減網格。某一輪三個都沒改動才停。
// 使用者規則（2026-07）：算到不能動才到下一階段／下一輪（勿只掃一遍就換）。
const LOOP_ROUND_CAP = 200
const LOOP_ROUND_CAP_FROZEN = 200
export function straightenCompactLoop(skeleton, cells, cols, rows) {
  let cur = cells, nC = cols, nR = rows
  let rounds = 0, moved = 0, lineMoved = 0, gatherMoved = 0
  let hvBefore = null, last = null
  let converged = false
  const frozen = !!getFrozen()
  const roundCap = frozen ? LOOP_ROUND_CAP_FROZEN : LOOP_ROUND_CAP
  while (rounds < roundCap) {
    const endp = movewiseStage('endp', skeleton, cur, nC, nR)
    const line = movewiseStage('line', skeleton, endp.cellAfter, endp.cols, endp.rows)
    const gather = movewiseStage('gather', skeleton, line.cellAfter, line.cols, line.rows)
    rounds++
    hvBefore ??= endp.stats.hvBefore
    last = gather.stats
    moved += endp.stats.moved
    lineMoved += line.stats.moved
    gatherMoved += gather.stats.moved
    cur = gather.cellAfter
    nC = gather.cols
    nR = gather.rows
    // 與逐步驗證相同：一輪三個演算法都沒改動才停（保險上限 roundCap）。
    if (!endp.stats.moved && !line.stats.moved && !gather.stats.moved) { converged = true; break }
  }
  // 收斂後再壓＋必要時再 gather：成方內部空列單軸會破方，需成對縮才消得掉；
  // 舊 bake 常停在「方還在、但空列仍在」——這裡強制再收一次緻密。
  {
    const dens = compactGridSafe(skeleton, cur, nC, nR)
    cur = dens.cellAfter
    nC = dens.cols
    nR = dens.rows
  }
  if (frozen) {
    for (let i = 0; i < 8; i++) {
      const density = auditGridDensity(cur, nC, nR)
      if (density.dense) break
      const ga = movewiseStage('gather', skeleton, cur, nC, nR)
      const progressed = ga.cols !== nC || ga.rows !== nR
        || !!(ga.stats?.moved || ga.stats?.pairMerges)
      cur = ga.cellAfter
      nC = ga.cols
      nR = ga.rows
      gatherMoved += ga.stats?.moved ?? 0
      last = ga.stats
      if (!progressed) {
        const f = fillEmptyBandsOnce(skeleton, cur, nC, nR)
        if (!f) break
        cur = f.cellAfter
      }
    }
  }
  const density = auditGridDensity(cur, nC, nR)
  return {
    cellAfter: cur,
    cols: nC,
    rows: nR,
    stats: {
      hvBefore, hvAfter: last.hvAfter,
      segs: last.segs, verts: last.verts, moved, lineMoved, gatherMoved,
      rounds, roundCap, converged,
      fromCols: cols, fromRows: rows, cols: nC, rows: nR,
      ...density,
    },
  }
}
