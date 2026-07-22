// 成方判準（四邊直線正方）——獨立模組，避免 hillClimb ↔ shape 循環依賴。
// 供 [[route-shape-align]]／[[route-llm-shape]] 與 makeMover 成方護欄共用。

export const isShapeGreenId = (id) => String(id).startsWith('shape-g')

/**
 * 規定 ring 是否仍為「四邊直線正方」（邊長相等的軸對齊框；邊可經綠折走 L）。
 * @param {string[]} cutIds 規定 ring 站序
 * @param {{ get: (id: string) => [number, number]|undefined }} posMap
 * @param {{ a: string, b: string }[]|null} segs 可選；有則允許經綠點的 H/V 折線
 */
export function isFourLineSquare(cutIds, posMap, segs = null) {
  const ring = []
  const seen = new Set()
  for (const id of cutIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ring.push(id)
  }
  if (ring.length < 4) return false
  const pts = ring.map((id) => posMap.get(id)).filter(Boolean)
  if (pts.length < ring.length) return false
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]))
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]))
  if (maxX - minX !== maxY - minY || maxX === minX) return false
  const onBound = (p) => p
    && (p[0] === minX || p[0] === maxX || p[1] === minY || p[1] === maxY)
  for (const p of pts) {
    if (!onBound(p)) return false
  }

  let adj = null
  if (segs) {
    adj = new Map()
    for (const s of segs) {
      if (!adj.has(s.a)) adj.set(s.a, [])
      if (!adj.has(s.b)) adj.set(s.b, [])
      adj.get(s.a).push(s.b)
      adj.get(s.b).push(s.a)
    }
  }
  const hopHV = (u, v) => {
    const A = posMap.get(u), B = posMap.get(v)
    if (!A || !B) return false
    return A[0] === B[0] || A[1] === B[1]
  }
  /** a→b：直連 H/V，或只經綠點的 H/V 折線 */
  const connectedHV = (a, b) => {
    if (hopHV(a, b)) return true
    if (!adj) return false
    const q = [a]
    const prev = new Map([[a, null]])
    while (q.length) {
      const u = q.shift()
      if (u === b) break
      for (const v of adj.get(u) ?? []) {
        if (prev.has(v)) continue
        if (v !== b && !isShapeGreenId(v)) continue
        if (!hopHV(u, v)) continue
        if (isShapeGreenId(v) && !onBound(posMap.get(v))) continue
        prev.set(v, u)
        q.push(v)
      }
    }
    return prev.has(b)
  }

  for (let i = 0; i < ring.length; i++) {
    if (!connectedHV(ring[i], ring[(i + 1) % ring.length])) return false
  }
  return true
}
