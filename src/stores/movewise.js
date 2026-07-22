// movewise 三步鏈＋循環＋逐步驗證——自 hillClimb.js 抽出，公開契約不變。
import {
  buildHcGraph, makeMover, countHV,
  makeUnionFind, compactGridSafe, POST_ITER_CAP,
  setFrozen, getFrozen,
} from './hillClimb.js'
import { sharesRoute, isHV } from './netUtil.js'
import { isFourLineSquare } from './paper/shapeSquare.js'

// Hill Climbing端點移動 — step 2 of the hc chain (HC → 端點移動 → 縮減網格;
// the hc 縮減網格 and the RWD base compact THIS output, while the other
// post-passes still branch off the raw HC result): EVERY coloured vertex
// (每個非白點 — endpoints, transfers, branches, crossings; white/black through
// stations are not vertices at all) may move so more of its incident segments
// become horizontal or vertical. Candidates = aligning one axis with each
// neighbour; a candidate is taken only when its NET H/V delta over the
// vertex's own segments is positive, so the global H/V count strictly grows
// (segments not incident to v are untouched — no revert needed). Each move is
// capped at ONE cell (使用者規則：移動不可超過 1 格)——遠處的對齊靠 movewise
// 的逐移動壓縮把距離拉近後、在後續移動慢慢完成. H/V 數不變的移動若能讓
// 「直線變長且斜線變短」也採納（使用者規則——典型是直線接斜線的轉折點，
// 沿直線方向推一格；兩者都要嚴格改善才動）. A currently
// straight (H/V) segment may only be BENT when the same move straightens a
// SAME-ROUTE segment in exchange (使用者規則：除非同名路線有拉直，否則不可
// 讓直線路段變少) — a net-positive move that sacrifices route X's straight
// leg to straighten route Y's is rejected. Each move still goes through the
// SAME §5 hard rules as the optimizer (makeMover): no new crossing, no
// landing on another segment or vertex, quadrant + edge-order preserved.
// Tie-breaks: bigger delta → continues a same-route H/V segment past the
// neighbour → smaller displacement. Runs under iteratePost — a move can
// unblock another vertex's move in the next iteration.
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
    // Candidates: the four 1-cell unit moves — under the 1-cell cap
    // （使用者規則：端點移動每次移動不可超過 1 格，由此構造保證）, every
    // useful snap-onto-a-neighbour's-row/col candidate IS one of these, and
    // they additionally cover the length-improving moves (直線變長、斜線變短).
    const cand = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dc, dr]) => [pv[0] + dc, pv[1] + dr])
    // 使用者規則的長度準則：v 入射段的（直線總長, 斜線總長）
    const lenOf = (P) => {
      let straight = 0, diag = 0
      for (const s of vsegs) {
        const pu = otherPos(s)
        const L = Math.hypot(P[0] - pu[0], P[1] - pu[1])
        if (isHV(P, pu)) straight += L
        else diag += L
      }
      return [straight, diag]
    }
    const [len0S, len0D] = lenOf(pv)
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
      let lenScore = 0
      if (delta > 0) {
        if (!bendsPaid(P)) continue
      } else if (delta === 0) {
        // 使用者規則（二擇一）：H/V 數不變，但這一步能——
        // (a) 讓「直線變長且斜線變短」（典型：直線接斜線的轉折點沿直線方向
        //     推一格；兩者都要嚴格改善），或
        // (b) v 是藍點（單一入射段）且「線變短」（把端點往鄰居收）。
        // 收斂：每步讓 (−H/V 數, 斜線長, 總長) 字典序嚴格下降——(a) 斜線長
        // 嚴格降、(b) 斜線長不增且總長嚴格降。
        const [s1, d1] = lenOf(P)
        const bendGain = s1 > len0S + 1e-9 && d1 < len0D - 1e-9
        const blueShorten = vsegs.length === 1 && s1 + d1 < len0S + len0D - 1e-9
        if (!bendGain && !blueShorten) continue
        if (!bendsPaid(P)) continue
        lenScore = bendGain ? (s1 - len0S) + (len0D - d1) : (len0S + len0D) - (s1 + d1)
      } else {
        continue // H/V 數不可變少
      }
      scored.push({ P, delta, cont: contScore(P), lenScore })
    }
    scored.sort((a, b) => b.delta - a.delta || b.cont - a.cont
      || b.lenScore - a.lenScore
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

// 直線縮減 one sweep: move whole straight LINES so FEWER distinct columns +
// rows are occupied (= how small the later 縮減網格 can compact to) — the
// grid DIMENSIONS are untouched; in the chain this pass runs AFTER 端點移動
// and BEFORE 縮減網格. A "line" is a maximal collinear chain of horizontal (or
// vertical) segments stitched ACROSS intersection vertices — the connected
// component over same-axis straight segments, so transfers, branches and
// yellow crossings a line runs straight through move with it. Moves are the
// four 1-cell unit shifts（使用者規則：直線可上下左右移，一次一格）——
// movewise 下網格隨時緻密，逐格合併即可. A shift is accepted when
// （使用者規則：移動後直線路段會變多就要移）boundary H/V 淨增 > 0，
// 或嚴格縮小佔用欄列且 H/V 不減（gain > 0 ∧ hv ≥ 0）。H/V 不可變少。
// Same rigid-shift hard rules as the optimizer (validShift). Tie-breaks:
// bigger H/V gain → bigger grid gain.
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

function lineCompactPass(skeleton, cells, cols, rows, opts = {}) {
  const limit = opts.limit ?? Infinity // 逐步驗證 子步驟：最多接受 limit 個移動
  const skip = opts.skip // 一遍掃描中本輪已動過的線（以最小成員 id 識別）——跳過
  const movedIds = []
  const { pos, segs, inc } = buildHcGraph(skeleton, cells)
  const empty = { cellAfter: pos, moved: 0, hvBefore: 0, hvAfter: 0, segs: segs.length, verts: pos.size, occBefore: [0, 0], occAfter: [0, 0], movedIds }
  if (!pos.size || !segs.length) return empty
  const M = makeMover(pos, segs, inc, cols, rows)
  const hvBefore = countHV(pos, segs)

  // occupied-coordinate counts per axis; distinct cols+rows = compacted size
  const count = [new Map(), new Map()]
  const recount = () => {
    for (const ax of [0, 1]) {
      count[ax].clear()
      for (const p of pos.values()) count[ax].set(p[ax], (count[ax].get(p[ax]) ?? 0) + 1)
    }
  }
  recount()
  const axisDistinctAfter = (memAt, ax, d) => {
    const occ = new Set()
    for (const [x, n] of count[ax]) if (n - (memAt.get(x) ?? 0) > 0) occ.add(x)
    for (const x of memAt.keys()) occ.add(x + d)
    return occ.size
  }
  const gainOf = (mems, dc, dr) => {
    let gain = 0
    for (const [ax, d] of [[0, dc], [1, dr]]) {
      if (!d) continue
      const memAt = new Map()
      for (const w of mems) { const x = pos.get(w)[ax]; memAt.set(x, (memAt.get(x) ?? 0) + 1) }
      gain += count[ax].size - axisDistinctAfter(memAt, ax, d)
    }
    return gain
  }
  const occBefore = [count[0].size, count[1].size]
  let moved = 0
  for (const horiz of [true, false]) {
    for (const comp of lineComponents(pos, segs, horiz)) {
      if (moved >= limit) break
      if (skip && skip.has(comp[0])) continue
      const inC = new Set(comp)
      // 四方向各 ±1 格（使用者規則：直線可上下左右移；一次一格）——
      // movewise 下網格隨時緻密，相鄰欄列必有佔用，逐格合併即可。
      const scored = []
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!boundarySpanOk(pos, segs, inC, dc, dr)) continue // 顏色點間不可拉超過 SPAN_CAP 格
        const hv = boundaryHvDelta(pos, segs, inC, dc, dr)
        if (hv < 0) continue // 整個 network 的直線（H/V 段）不可變少
        const gain = gainOf(comp, dc, dr)
        // 使用者規則：直線路段變多就要移；否則須嚴格縮網格（且 H/V 已 ≥ 0）
        if (hv <= 0 && gain <= 0) continue
        scored.push({ dc, dr, gain, hv })
      }
      scored.sort((a, b) => b.hv - a.hv || b.gain - a.gain
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

/**
 * 成方成對縮格：剛體護欄會擋「切開方形」的單軸合併（否則寬高一變就破方）。
 * 同時併一欄＋一列（各縮 1），再驗 isFourLineSquare——方仍是方，但能繼續壓縮。
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
  setFrozen(null) // 試算單軸時關護欄；成對後用 isFourLineSquare 驗方
  try {
    for (let c = minC; c < maxC; c++) {
      for (let r = minR; r < maxR; r++) {
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
        if (!compC.length || !M.validShift(compC, new Set(compC), -1, 0)) continue
        M.applyShift(compC, [-1, 0])
        const compR = []
        for (const [id, pnt] of g.pos) if (pnt[1] > r) compR.push(id)
        if (!compR.length || !M.validShift(compR, new Set(compR), 0, -1)) continue
        M.applyShift(compR, [0, -1])
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

// 網格合併的 stage 驅動：single=true 只掃一遍（循環用）、否則掃到沒有可合併
// （網格合併 tab 用）。成方時另跑「成對縮方」（單軸切開會破方，成對縮仍保正方）。
function gridMergeStage(skeleton, cells, cols, rows, opts = {}) {
  let comp = compactGridSafe(skeleton, cells, cols, rows)
  let cur = comp.cellAfter, nC = comp.cols, nR = comp.rows
  const fromCols = nC, fromRows = nR
  const g0 = buildHcGraph(skeleton, cur)
  const hvBefore = countHV(g0.pos, g0.segs)
  const verts = g0.pos.size, segsN = g0.segs.length
  let mergedRows = 0, mergedCols = 0, pairMerges = 0, guardN = 0
  while (guardN++ < POST_ITER_CAP) {
    const r = gridMergeSweep(skeleton, cur, nC, nR)
    mergedRows += r.mergedRows
    mergedCols += r.mergedCols
    cur = r.cellAfter
    nC = r.cols
    nR = r.rows
    if (!r.merged || opts.single) break
  }
  let pairGuard = 0
  while (getFrozen() && pairGuard++ < POST_ITER_CAP) {
    const p = squarePairShrinkOnce(skeleton, cur, nC, nR)
    if (!p) break
    cur = p.cellAfter
    nC = p.cols
    nR = p.rows
    pairMerges++
    mergedRows++
    mergedCols++
    const dens = compactGridSafe(skeleton, cur, nC, nR)
    cur = dens.cellAfter
    nC = dens.cols
    nR = dens.rows
    if (opts.single) break
  }
  const g1 = buildHcGraph(skeleton, cur)
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
    },
  }
}

// 一遍掃描（使用者規則：循環與逐步驗證的每一步＝該演算法把**整個 network
// 跑一次**，不是跑到該演算法自己的不動點）：每個元素本輪最多動一次（動過的
// 進 visited、pass 以 skip 跳過）。visited 由呼叫端傳入（逐步驗證的小步跨
// 呼叫延續同一遍）。
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
    info: '按「下一步」開始——每步＝目前演算法把整個 network 掃一遍（每個移動後立即縮減網格），掃完換下一個：端點移動 → 直線縮減 → 網格合併 → 回到端點移動；三個都沒改動就停止',
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
  // 「下一步」＝目前演算法把整個 network 掃**一遍**（movewiseSweep，接續小步
  // 已走過的 sweepVisited），掃完就換下一個演算法（掃不動也換）——使用者規則：
  // 端點移動一遍 → 直線縮減一遍 → 網格合併一遍 → 回到端點移動。
  const NEXT_STAGE = { endp: 'line', line: 'gather', gather: 'endp' }
  const STAGE_INFO = {
    endp: (t) => `移動 ${t.moved} 點（水平垂直 ${t.hvBefore} → ${t.hvAfter}／${t.segs} 段）`,
    line: (t) => `移動 ${t.moved} 線`,
    gather: (t) => `合併 ${t.mergedRows ?? t.movedPts} 列＋${t.mergedCols ?? t.movedLines} 欄`,
  }
  for (let guard = 0; guard < 9; guard++) {
    if (stage === 'gather') {
      // 網格合併：小步＝合併下一個可合併的邊界（cursor 延續這一遍）；
      // 大步＝把這一遍剩下的邊界全掃完。半平面合併自帶壓縮。
      // 成方：單軸掃不動時改試成對縮方（保正方）。
      let r = gridMergeSweep(skeleton, cells, cols, rows,
        { limit: limit === 1 ? 1 : Infinity, cursor: mergeCursor ?? undefined })
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
        const isSub = limit === 1
        const info = isSub
          ? `第 ${round} 輪 · ${STEP_STAGE_LABEL.gather}${subTag}：合併 ${r.desc[0]}｜網格 ${cols}×${rows} → ${r.cols}×${r.rows}`
          : `第 ${round} 輪 · ${STEP_STAGE_LABEL.gather}（掃一遍）：合併 ${r.mergedRows} 列＋${r.mergedCols} 欄｜網格 ${cols}×${rows} → ${r.cols}×${r.rows}`
        if (isSub && r.cursor.phase !== 'done') {
          // 小步：這一遍還沒掃完——留在 gather、cursor 前進
          return { cells: r.cellAfter, cols: r.cols, rows: r.rows, stage, round, steps: steps + 1, roundMoves, done: false, lastStage: 'gather', movedIds: [], moves: [], sweepVisited, mergeCursor: r.cursor, info }
        }
        // 大步（或小步剛好掃完）：gather 是一輪的最後 → 進下一輪
        return { cells: r.cellAfter, cols: r.cols, rows: r.rows, stage: 'endp', round: round + 1, steps: steps + 1, roundMoves: 0, done: false, lastStage: 'gather', movedIds: [], moves: [], sweepVisited: [], mergeCursor: null, info }
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
      // 小步：這一遍掃描中的下一個單一移動（動過的元素本輪不再動）
      const r = MOVEWISE_PASS[stage](skeleton, cells, cols, rows, new Set(sweepVisited))
      if (r.moved) {
        roundMoves += r.moved
        sweepVisited = [...sweepVisited, r.key]
        const mv = movesOf(cells, r.cellAfter, r.ids)
        const what = stage === 'endp' ? '移動 1 點' : '移動 1 線' // gather 已在上方分支處理，走到這只剩 endp/line
        return finalize(r.cellAfter, r.ids,
          `第 ${round} 輪 · ${STEP_STAGE_LABEL[stage]}${subTag}：${what}${coordTag(mv)}`)
      }
      // 這一遍掃完（剩下的元素都動不了）→ 換下一個演算法（下面共用推進邏輯）
    } else {
      // 大步：把這一遍掃完（接續小步的 sweepVisited），掃完換下一個演算法
      const visited = new Set(sweepVisited)
      const sw = movewiseSweep(stage, skeleton, cells, cols, rows, visited)
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
          info: `第 ${round} 輪 · ${STEP_STAGE_LABEL[doneStage]}（掃一遍）：${STAGE_INFO[doneStage](sw.stats)}${gridTag}`,
        }
      }
      // 這一遍沒有任何移動 → 換下一個演算法（下面共用推進邏輯）
    }
    // 推進：換下一個演算法（gather 的一輪結束邏輯在上面的特例處理）
    stage = NEXT_STAGE[stage]
    sweepVisited = []
    mergeCursor = null
  }
  return { cells, cols, rows, stage, round, steps, roundMoves, done: true, lastStage: null, movedIds: [], moves: [], sweepVisited: [], mergeCursor: null, info: `✔ 收斂完成——共 ${steps} 步、${round} 輪` }
}

// 端點移動+直線縮減+網格合併循環: each round runs the three MOVEWISE stages
// （每個階段自己迭代到不動點，且**每一個移動後都立即縮減網格**——縮減不再是
// 獨立步驟）until a round where NOTHING moves. Per-move compaction renumbers
// cells continuously, so hard-rule blocks (occlusion, landing on another
// vertex) shift and new moves keep opening up between stages/rounds.
// Straighten moves strictly grow H/V (bounded), line moves strictly shrink
// the (always-dense) grid (bounded below); gather slides are H/V-neutral, so
// POST_ITER_CAP rounds is the backstop against slide/median oscillation.
// 使用者規則（2026-07）：每輪＝三個演算法**各把整個 network 掃一遍**（一遍
// 掃描 movewiseSweep，非各自跑到不動點）——端點移動一遍 → 直線縮減一遍 →
// 網格合併一遍 → 回到端點移動；某一輪三個都沒有改動才停止。輪數因此比階段
// 固定點制多，上限放寬到 LOOP_ROUND_CAP。
const LOOP_ROUND_CAP = 200
// 成方護欄開啟時，網格合併／端點常在剛體約束下振盪；靠 LOOP_STALL_ROUNDS
// （欄列＋H/V 連續不變）提前停，勿把上限砍成 1——否則循環遠未收斂，
// 與逐步驗證（跑到三階段都不動）結果不一致（使用者回報 2026-07）。
const LOOP_ROUND_CAP_FROZEN = 40
const LOOP_STALL_ROUNDS = 2
export function straightenCompactLoop(skeleton, cells, cols, rows) {
  let cur = cells, nC = cols, nR = rows
  let rounds = 0, moved = 0, lineMoved = 0, gatherMoved = 0
  let hvBefore = null, last = null
  let converged = false
  const frozen = !!getFrozen()
  const roundCap = frozen ? LOOP_ROUND_CAP_FROZEN : LOOP_ROUND_CAP
  let stall = 0
  let prevSig = null
  while (rounds < roundCap) {
    const endp = movewiseSweep('endp', skeleton, cur, nC, nR)
    const line = movewiseSweep('line', skeleton, endp.cellAfter, endp.cols, endp.rows)
    const gather = movewiseSweep('gather', skeleton, line.cellAfter, line.cols, line.rows)
    rounds++
    hvBefore ??= endp.stats.hvBefore
    last = gather.stats
    moved += endp.stats.moved
    lineMoved += line.stats.moved
    gatherMoved += gather.stats.moved
    cur = gather.cellAfter
    nC = gather.cols
    nR = gather.rows
    if (!endp.stats.moved && !line.stats.moved && !gather.stats.moved) { converged = true; break }
    // 有移動但網格／平直度沒變 → 振盪，提早停（尤其成方護欄）。
    const sig = `${nC}x${nR}:${last.hvAfter}`
    if (sig === prevSig) {
      if (++stall >= LOOP_STALL_ROUNDS) break
    } else { stall = 0; prevSig = sig }
  }
  return {
    cellAfter: cur,
    cols: nC,
    rows: nR,
    stats: {
      hvBefore, hvAfter: last.hvAfter,
      segs: last.segs, verts: last.verts, moved, lineMoved, gatherMoved,
      rounds, roundCap, converged,
      fromCols: cols, fromRows: rows, cols: nC, rows: nR,
    },
  }
}
