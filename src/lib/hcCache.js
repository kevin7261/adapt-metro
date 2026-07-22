// ---- 跨 reload 持久快取（localStorage）----
// 最貴的計算是爬山（buildHillClimb）＋後處理（iteratePost）。它們的輸出是純資料
// （cellAfter = Map<id,[c,r]>、stats = 數字），與畫布大小無關（rank-based），且對
// 一份資料＋變體是確定的 → 存下來、關 tab 再開或重新整理都直接載回、不重跑。
// 失效靠「資料內容指紋」：站/線一變指紋就變 → 自動 cache miss 重算，永不載到舊的。
// LLM 對齊視圖只為了做指紋比對而跑爬山，載回快取後連它也免重算。
// **快取鍵必須含演算法版本**：鍵的另一半是「資料指紋」（dataFingerprint 只看資料），
// 資料沒變但**演算法變了**（如骨架建圖改含 pass）時，舊快取的佈局與新骨架結構對不上——
// 節點缺格子 → RWD/HC 整段線消失、站點退回舊座標懸空（倫敦 Kilburn 案，2026-07-17）。
// 且 localStorage 不隨 dev server 重啟/硬重載清除，殘留跨天。**改了 skeleton/schematicGrid/
// hillClimb 的演算法就把版本 +1**；另有 use-time 結構驗證兜底（見 D3Tab 的 cachedHC 使用處）。
const HC_LS_KEY = 'd3tab-hc-cache-v54' // v54: Delaunay 整網所有點一起動；v53: 成方頂點凍結；v52: 綠控擴三角；v51: 拓撲不變；v50: 曾委派 shape；v49: 硬釘；v48: 拒翻；v47: Delaunay→貼形；v46: LLM成方可餵②HC；v45: §6 徑向成方；v44: 必交付；v43: 論文規定必做；v42: 綠僅W＋論文平面性；v41: 算完即交付；v40: 成方∧平面；v39: Octi 加速；v38: 論文 Octi；v37: 持續算；v36: 破鐵律不交付；v35: W綠≤4；v34: 慢移＋綠控；v33: 鐵律；v32: RBF；v31: 綠控；v30: 禁 soft-topo；v29: 縮方重試；v28: 嚴格 D1；v27: 成方不得增交叉；v26: 四邊直線方；v25: 合規才交付；v24: 強制成方；v23: validMove；v22: 先嵌方；v21: 規定表；v20: LS 吸附；v19: 正方／禁交叉重疊；v18: 軸向貼方；v17: 禁硬鎖；v16: 環線＋品質；v15: 移出論文鏈；v14: Smooth；v13: 弧長；v12: 只方形；v11: 圓／方；v10: 新增⑨；v9: 論文忠實度校正＋layouts＋stats.ms；v8: llm fingerprint；v7: 河流不放灰；v6: 河流粉紅/灰；v5: 河流全點；v4: validShift；v3: pass
const HC_LS_MAX = 12 // 最多保留幾個 (資料,變體) 佈局；超過刪最久沒用的

let hcLruClock = Date.now() // 單調遞增的 LRU 時戳（避免 Date.now 在同毫秒重複）

export function dataFingerprint(data) {
  let h = 5381
  const add = (s) => { for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0 }
  for (const f of data.features) {
    if (f.geometry?.type === 'Point') add(`${f.properties.station_id}@${f.geometry.coordinates.join(',')}`)
    else for (const r of f.properties?.routes ?? []) add(`${r.route_id ?? ''}#${(r.stations ?? []).map((s) => s.station_id).join('.')}`)
  }
  return (h >>> 0).toString(36)
}

function hcLsRead() { try { return JSON.parse(localStorage.getItem(HC_LS_KEY) || '{}') } catch { return {} } }
function hcLsWrite(o) { try { localStorage.setItem(HC_LS_KEY, JSON.stringify(o)) } catch { /* quota / private mode → 靜默跳過 */ } }
const deCells = (arr) => new Map(arr.map(([id, c, r]) => [id, [c, r]]))
const serCells = (m) => [...m.entries()].map(([id, [c, r]]) => [id, c, r])

const deMap = (obj) => {
  const out = {}
  for (const k of Object.keys(obj ?? {})) out[k] = { cellAfter: deCells(obj[k].cellAfter), stats: obj[k].stats }
  return out
}
const serMap = (obj) => {
  const out = {}
  for (const k of Object.keys(obj ?? {})) if (obj[k]) out[k] = { cellAfter: serCells(obj[k].cellAfter), stats: obj[k].stats }
  return out
}

export function loadHcCache(key) {
  try {
    const e = hcLsRead()[key]; if (!e) return null
    return {
      hc: { cellAfter: deCells(e.hc.cellAfter), stats: e.hc.stats },
      posts: deMap(e.posts),
      layouts: deMap(e.layouts), // 初步直線化群組的 ①〜⑧ 比較佈局
    }
  } catch { return null }
}

// 清掉某份資料（指紋 fp）的全部快取（原始/旋轉變體都清）——「重新計算此城市全部
// 圖層」按鈕用：清完 ② 與 ①〜⑧ 都會重算，回到剛匯入的狀態。
export function clearHcCache(fpPrefix) {
  if (!fpPrefix) return 0
  const o = hcLsRead()
  let n = 0
  for (const k of Object.keys(o)) if (k.startsWith(fpPrefix)) { delete o[k]; n++ }
  if (n) hcLsWrite(o)
  return n
}

export function saveHcCache(key, hc, posts, layouts) {
  if (!key || !hc) return
  const o = hcLsRead()
  const pj = serMap(posts)
  o[key] = {
    t: hcLruClock++,
    hc: { cellAfter: serCells(hc.cellAfter), stats: hc.stats },
    posts: pj,
    layouts: serMap(layouts),
  }
  const keys = Object.keys(o)
  if (keys.length > HC_LS_MAX) {
    keys.sort((a, b) => (o[a].t ?? 0) - (o[b].t ?? 0))
    for (const k of keys.slice(0, keys.length - HC_LS_MAX)) delete o[k]
  }
  hcLsWrite(o)
}
