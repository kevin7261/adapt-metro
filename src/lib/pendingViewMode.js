// 視圖畫廊點縮圖 → 開啟圖層 tab 時要切到的 mode（D3Tab 讀取後清空）。
// 例：Straighten 的 loop-stroke-orig → 'hc-stroke-loop'（循環後，與縮圖一致）。
const pending = new Map() // layerId → mode string
const listeners = new Set()

export function setPendingViewMode(layerId, mode) {
  if (!layerId || !mode) return
  pending.set(layerId, mode)
  for (const fn of listeners) fn(layerId, mode)
}

export function takePendingViewMode(layerId) {
  if (!layerId || !pending.has(layerId)) return null
  const m = pending.get(layerId)
  pending.delete(layerId)
  return m
}

/** D3Tab 訂閱：已開的 tab 被畫廊再次點到時也能切 mode。回傳取消訂閱。 */
export function onPendingViewMode(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
