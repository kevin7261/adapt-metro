// RWD Maps 版面路網的 weight 驅動版面簡化（論文 §九「流量屬性概括化」）。
// 版面簡化不改拓撲：weight（流量／重要性）→ 決定每欄多寬、每列多高 →（可選）藏次要黑點
// → 在**新像素座標**重跑 buildRwdMap（八方向約束以版面 pixel 為準，見 skill route-rwd-draw）。
// 純函式；隨機由呼叫端注入（frontend 用 Math.random）。
//
// **weight 的粒度是「相鄰兩站」的無向站對（link），不是 cut-to-cut 段的兩端點**（使用者
// 規則：weight 是 2 個站點就要有，不是 2 個端點）。一個 cut-to-cut 段的完整站鏈是
// [a, ...interior 黑點, b]，鏈上每一對相鄰站各自一個 weight。

// 反等比抽樣：k=1..9，相對機率 ∝ 1/2^k（數字越小越常見）→ 少數主走廊、多數次要邊，
// 畫面容易出現「主走廊 vs 次要邊」對比，而非九個數字均勻亂灑。
export function sampleWeight(rnd = Math.random) {
  const p = []
  let sum = 0
  for (let k = 1; k <= 9; k++) { const pk = 1 / 2 ** k; p.push(pk); sum += pk }
  let x = rnd() * sum
  for (let k = 1; k <= 9; k++) { x -= p[k - 1]; if (x <= 0) return k }
  return 9
}

// 無向站對鍵（"u|v" 排序）——同一站對全圖只算一次、兩向共用。
export const linkKey = (u, v) => (u < v ? `${u}|${v}` : `${v}|${u}`)

// 把 cut-to-cut 段展開成「相鄰兩站」links。chain = [a, ...interior, b]，
// 相鄰對 (chain[i], chain[i+1]) 各一 link；回傳 { u, v, seg, i, n }（n=段內 hop 數）。
export function segLinks(seg) {
  const chain = [seg.a, ...seg.interior, seg.b]
  const out = []
  for (let i = 0; i + 1 < chain.length; i++) out.push({ u: chain[i], v: chain[i + 1], seg, i, n: chain.length - 1 })
  return out
}

// 每個相鄰站對抽一次 weight（1–9，反等比）。整表重抽，不在舊值上微調。
export function randomWeights(segs, rnd = Math.random) {
  const w = new Map()
  for (const s of segs) for (const l of segLinks(s)) {
    const k = linkKey(l.u, l.v)
    if (!w.has(k)) w.set(k, sampleWeight(rnd))
  }
  return w
}

export const linkWeight = (weights, u, v) => weights.get(linkKey(u, v)) ?? 1

// 均勻網格的 axes（動畫「起點」用，等寬等高）。area=[x0,y0,x1,y1]。
export function uniformAxes(cols, rows, area) {
  const [x0, y0, x1, y1] = area
  const cw = (x1 - x0) / cols, ch = (y1 - y0) / rows
  const colX = Array.from({ length: cols + 1 }, (_, i) => x0 + i * cw)
  const rowY = Array.from({ length: rows + 1 }, (_, i) => y0 + i * ch)
  return { colX, rowY, cellPx: ([c, r]) => [x0 + (c + 0.5) * cw, y0 + (r + 0.5) * ch] }
}

// 動畫：內插兩組 axes 的欄／列格線位置（**內插比例／格線，不內插折線頂點**，否則
// 中間幀會違反八方向——見 skill route-rwd-draw §8.3）。a、b 同 cols/rows。
export function lerpAxes(a, b, t) {
  const colX = a.colX.map((v, i) => v + (b.colX[i] - v) * t)
  const rowY = a.rowY.map((v, i) => v + (b.rowY[i] - v) * t)
  return { colX, rowY, cellPx: ([c, r]) => [(colX[c] + colX[c + 1]) / 2, (rowY[r] + rowY[r + 1]) / 2] }
}

// 權重陣列 → 一軸的格線位置：每區間保底 minFrac × 均勻寬（權重 0 也不消失），
// 其餘空間依正權重分配；外框固定（總長不變）。weightedAxes 與 intervalAxes 共用。
function axisEdges(wArr, n, total, o, minFrac) {
  const minU = (total / n) * minFrac
  const sumW = wArr.reduce((a, b) => a + b, 0)
  const rest = total - minU * n
  const size = wArr.map((w) => minU + (sumW > 0 ? rest * (w / sumW) : rest / n))
  const edges = [o]
  for (let i = 0; i < n; i++) edges.push(edges[i] + size[i])
  return { edges, center: size.map((_, i) => (edges[i] + edges[i + 1]) / 2) }
}

// LLM 調整（skill route-llm-grid）：模型直接給每個 X 欄／Y 列區間的顯示權重
// （1=原尺寸、>1 放大、<1 壓縮），這裡只做正規化進固定外框——與 weightedAxes
// 的末端變形完全相同，差別只在權重由誰填入（流量彙總 vs 模型推理）。
export function intervalAxes(colW, rowW, area, minFrac = 0.25) {
  const [x0, y0, x1, y1] = area
  const X = axisEdges(colW, colW.length, x1 - x0, x0, minFrac)
  const Y = axisEdges(rowW, rowW.length, y1 - y0, y0, minFrac)
  return { colX: X.edges, rowY: Y.edges, cellPx: ([c, r]) => [X.center[c], Y.center[r]] }
}

// weight → 非均勻欄寬列高。pos: Map<id,[c,r]>（只含 cut 節點 a/b；interior 黑點的格
// 座標沿 a→b 線性內插）；segs：cut-to-cut。area=[x0,y0,x1,y1]。
// 「取 max 不取 sum」（這一欄多重要，看最忙那條，不把所有線加起來膨脹）。
// 方向相容：算 X 欄看 H 與 45° link；算 Y 列看 V 與 45° link。
// 權重 0 的欄／列不消失——保留最小寬（minFrac × 均勻寬），其餘空間才依正權重分配；外框固定。
export function weightedAxes(pos, segs, weights, cols, rows, area, minFrac = 0.25) {
  const [x0, y0, x1, y1] = area
  const colW = new Array(cols).fill(0), rowW = new Array(rows).fill(0)
  for (const s of segs) {
    const A = pos.get(s.a), B = pos.get(s.b)
    if (!A || !B) continue
    for (const l of segLinks(s)) {
      const w = linkWeight(weights, l.u, l.v)
      // interior 黑點沒有格座標 → 依鏈上索引在 a→b 之間線性內插，取該 link 所跨的欄／列。
      const t0 = l.i / l.n, t1 = (l.i + 1) / l.n
      const P0 = [Math.round(A[0] + (B[0] - A[0]) * t0), Math.round(A[1] + (B[1] - A[1]) * t0)]
      const P1 = [Math.round(A[0] + (B[0] - A[0]) * t1), Math.round(A[1] + (B[1] - A[1]) * t1)]
      const dc = Math.abs(P0[0] - P1[0]), dr = Math.abs(P0[1] - P1[1])
      if (dc >= dr) for (let c = Math.min(P0[0], P1[0]); c < Math.max(P0[0], P1[0]); c++) { if (c >= 0 && c < cols) colW[c] = Math.max(colW[c], w) }
      if (dr >= dc) for (let r = Math.min(P0[1], P1[1]); r < Math.max(P0[1], P1[1]); r++) { if (r >= 0 && r < rows) rowW[r] = Math.max(rowW[r], w) }
    }
  }
  const X = axisEdges(colW, cols, x1 - x0, x0, minFrac)
  const Y = axisEdges(rowW, rows, y1 - y0, y0, minFrac)
  return { colX: X.edges, rowY: Y.edges, colW, rowW, cellPx: ([c, r]) => [X.center[c], Y.center[r]] }
}
