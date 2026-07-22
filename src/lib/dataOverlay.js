// 匯入專案時暫存的 data/metro/** JSON（不必寫磁碟；GH Pages 也可用）。
// key = 相對路徑，如 data/metro/straighten-cells/as-twn-taipei.orig.json
const overlay = new Map()

export function setDataOverlay(relPath, data) {
  if (!relPath) return
  if (data == null) overlay.delete(relPath)
  else overlay.set(relPath, data)
}

export function getDataOverlay(relPath) {
  return overlay.has(relPath) ? overlay.get(relPath) : undefined
}

export function clearDataOverlay(prefix = '') {
  if (!prefix) { overlay.clear(); return }
  for (const k of [...overlay.keys()]) {
    if (k.startsWith(prefix)) overlay.delete(k)
  }
}

/** fetch JSON：先看 overlay，再走網路 */
export async function fetchDataJson(relPath, { cache = 'no-store' } = {}) {
  if (overlay.has(relPath)) return structuredClone(overlay.get(relPath))
  const { assetUrl } = await import('./assetUrl.js')
  const res = await fetch(assetUrl(relPath), { cache })
  if (!res.ok) return null
  return res.json()
}
