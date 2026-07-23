// ---- 下游佈局預計算結果（data/metro/straighten-cells/*.json）----
// 不是快取、不存 network／骨架：只存各節點整數格座標 cellAfter＋stats。
// 開分頁只讀檔；缺檔不現場重算。按「重新計算」或 CLI bakeHcCells 才寫檔。
//
// 檔名：data/metro/straighten-cells/<cityId>.<variant>[.shapelike].json
//   variant＝orig / rot / orig-shape / rot-shape
//   shapelike＝成方已餵下游的那份
// 失效：fingerprint（資料＋河流門檻）或 algo 不符 → 視為無結果。
// 寫檔：vite POST /hc-cells/save（僅 dev）；讀檔：/data/... 。
import { assetUrl } from './assetUrl'
import { getDataOverlay, setDataOverlay } from './dataOverlay'

// 改了 skeleton／schematicGrid／hillClimb／movewise 演算法就 +1（舊檔自動失效）。
// v2: 直線演算法／循環 base＝格網化後（不再吃 HC）
// v3: 成方護欄下循環上限 1→40
// v4: 直線縮減四方向＋H/V 變多就要移
// v5: 循環收斂＝三階段皆無移動（與逐步驗證同；去掉 stall 提前停）
// 寫入用最新；讀取相容舊版（畫廊縮圖常對應已存在的 v4 檔，勿因 bump 整批空白）。
export const HC_CELLS_ALGO = 'hccells-v6'
// v5 及更早：網格合併成對縮格曾被 POST_ITER_CAP=20 截斷（形狀圖層尤嚴重）。
// 仍可讀 v5 以免全城空白；形狀圖層請「重新計算」或 metro:hccells:shape。
export const HC_CELLS_ALGO_READ = new Set(['hccells-v5', 'hccells-v6'])

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
  return `data/metro/straighten-cells/${city}.${v}${shapelike ? '.shapelike' : ''}.json`
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

/** 清掉舊的 localStorage（曾誤存整份 network）；啟動時呼叫一次。 */
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

/** 讀預計算結果。無檔／algo／fingerprint 不符 → null（開分頁不重算）。 */
export async function loadStraightenCells({ cityId, variant, shapelike = false, fingerprint }) {
  const rel = hcCellsRelPath(cityId, variant, shapelike)
  if (!rel || !fingerprint) return null
  try {
    let e = getDataOverlay(rel)
    if (!e) {
      const res = await fetch(assetUrl(rel))
      const isJson = (res.headers.get('content-type') ?? '').includes('json')
      if (!res.ok || !isJson) return null
      e = await res.json()
    }
    if (!HC_CELLS_ALGO_READ.has(e.algo) || e.fingerprint !== fingerprint || !e.hc?.cellAfter) return null
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

/** 寫入預計算結果（只含 cellAfter／stats，不含 network）。 */
export async function saveStraightenCells(
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
  const rel = hcCellsRelPath(cityId, variant, shapelike)
  if (rel) setDataOverlay(rel, payload)
  try {
    const res = await fetch('/hc-cells/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: cityId, variant, shapelike: !!shapelike, payload }),
    })
    return res.ok
  } catch { return false }
}

/** 刪預計算結果檔。city only → 該城全部變體；有 variant → 單檔。 */
export async function clearStraightenCells({ cityId, variant = null, shapelike = false } = {}) {
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

// 舊名相容（勿再新增引用）
export const loadHcCache = loadStraightenCells
export const saveHcCache = saveStraightenCells
export const clearHcCache = clearStraightenCells
