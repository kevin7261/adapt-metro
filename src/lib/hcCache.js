// ---- 整數格佈局持久化（data/metro/hccells/*.json，不用 localStorage）----
// 最貴的計算是直線演算法（iteratePost，base＝格網化後）＋循環（straightenCompactLoop）。
// 輸出是純資料（cellAfter = Map<id,[c,r]>、stats），與畫布大小無關 → 寫進檔案，
// 關 tab 再開／重新整理直接 fetch 載回、不重跑。
//
// 檔名：data/metro/hccells/<cityId>.<variant>[.shapelike].json
//   variant 含形狀圖層（orig / rot / orig-shape / rot-shape）
//   shapelike＝成方已餵下游的那份（與不成方管線分開）
// 失效：檔內 fingerprint（資料指紋＋河流門檻）不符 → miss 重算；
//       algo 版本不符（改了 skeleton/grid/hillClimb/movewise）→ miss。
// 寫檔走 vite middleware POST /hc-cells/save（僅 dev）；讀檔走 /data/...（serveDataDir）。
import { assetUrl } from './assetUrl'

// 改了 skeleton／schematicGrid／hillClimb／movewise 演算法就 +1（舊檔自動失效）。
// v2: 直線演算法／循環 base＝格網化後（不再吃 HC）
export const HC_CELLS_ALGO = 'hccells-v2'

export function dataFingerprint(data) {
  let h = 5381
  const add = (s) => { for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0 }
  for (const f of data.features) {
    if (f.geometry?.type === 'Point') add(`${f.properties.station_id}@${f.geometry.coordinates.join(',')}`)
    else for (const r of f.properties?.routes ?? []) add(`${r.route_id ?? ''}#${(r.stations ?? []).map((s) => s.station_id).join('.')}`)
  }
  return (h >>> 0).toString(36)
}

export function hcCellsRelPath(cityId, variant, shapelike = false) {
  const city = String(cityId || '').replace(/[^\w-]/g, '')
  const v = String(variant || 'orig').replace(/[^\w.-]/g, '')
  if (!city || !v) return null
  return `data/metro/hccells/${city}.${v}${shapelike ? '.shapelike' : ''}.json`
}

const deCells = (arr) => new Map((arr ?? []).map(([id, c, r]) => [id, [c, r]]))
const serCells = (m) => [...m.entries()].map(([id, [c, r]]) => [id, c, r])

function deStageMap(obj) {
  const out = {}
  for (const k of Object.keys(obj ?? {})) {
    const e = obj[k]
    if (!e?.cellAfter) continue
    out[k] = {
      cellAfter: deCells(e.cellAfter),
      stats: e.stats,
      ...(e.cols != null ? { cols: e.cols, rows: e.rows } : {}),
    }
  }
  return out
}
function serStageMap(obj) {
  const out = {}
  for (const k of Object.keys(obj ?? {})) {
    const e = obj[k]
    if (!e?.cellAfter) continue
    out[k] = {
      cellAfter: serCells(e.cellAfter),
      stats: e.stats,
      ...(e.cols != null ? { cols: e.cols, rows: e.rows } : {}),
    }
  }
  return out
}

// 清掉舊的 localStorage 爬山快取（曾把整份 network 塞進 LS，太大）——啟動時呼叫一次。
export function purgeLegacyHcLocalStorage() {
  try {
    const drop = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && /^d3tab-hc-cache/.test(k)) drop.push(k)
    }
    for (const k of drop) localStorage.removeItem(k)
  } catch { /* private mode */ }
}

/** @returns {Promise<null | { hc, posts, layouts, loops, endp, line, gather }>} */
export async function loadHcCache({ cityId, variant, shapelike = false, fingerprint }) {
  const rel = hcCellsRelPath(cityId, variant, shapelike)
  if (!rel || !fingerprint) return null
  try {
    const res = await fetch(assetUrl(rel))
    const isJson = (res.headers.get('content-type') ?? '').includes('json')
    if (!res.ok || !isJson) return null
    const e = await res.json()
    if (e.algo !== HC_CELLS_ALGO || e.fingerprint !== fingerprint || !e.hc?.cellAfter) return null
    return {
      hc: { cellAfter: deCells(e.hc.cellAfter), stats: e.hc.stats },
      posts: deStageMap(e.posts),
      layouts: deStageMap(e.layouts),
      loops: deStageMap(e.loops),
      endp: deStageMap(e.endp),
      line: deStageMap(e.line),
      gather: deStageMap(e.gather),
    }
  } catch { return null }
}

/** 寫入 data/metro/hccells（dev server）；靜態部署無寫檔 API 時靜默略過。 */
export async function saveHcCache(
  { cityId, variant, shapelike = false, fingerprint },
  { hc, posts, layouts, loops, endp, line, gather },
) {
  if (!cityId || !variant || !fingerprint || !hc?.cellAfter) return false
  const payload = {
    algo: HC_CELLS_ALGO,
    fingerprint,
    cityId,
    variant,
    shapelike: !!shapelike,
    hc: { cellAfter: serCells(hc.cellAfter), stats: hc.stats },
    posts: serStageMap(posts),
    layouts: serStageMap(layouts),
    loops: serStageMap(loops),
    endp: serStageMap(endp),
    line: serStageMap(line),
    gather: serStageMap(gather),
  }
  try {
    const res = await fetch('/hc-cells/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: cityId, variant, shapelike: !!shapelike, payload }),
    })
    return res.ok
  } catch { return false }
}

/** 刪 hccells 檔。city only → 該城全部變體；有 variant → 單檔（可加 shapelike）。 */
export async function clearHcCache({ cityId, variant = null, shapelike = false } = {}) {
  if (!cityId) return 0
  try {
    const body = variant != null
      ? { city: cityId, variant, shapelike: !!shapelike }
      : { city: cityId }
    const res = await fetch('/hc-cells/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return 0
    const j = await res.json()
    return j.cleared ?? 0
  } catch { return 0 }
}
