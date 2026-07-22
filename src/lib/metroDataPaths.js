// data/metro/ 子目錄 ↔ 圖層階段名稱（LayerPanel 英文列名）
// 單一真相：腳本／前端／vite 都從這裡取路徑，勿再硬編舊名（systems/views/hcviews…）。
//
//   Metro Maps     → metro-maps/          （城市 GeoJSON）
//   Map Adjust     → map-adjust/          （畫廊縮圖 JSON）
//   Straighten     → straighten/          （畫廊縮圖 JSON）
//                    straighten-cells/    （互動整數格快取）
//                    straighten-llm/      （LLM 對齊）
//                    straighten-shape/    （LLM 成方）
//   RWD Maps       → rwd-maps/            （畫廊縮圖 JSON）
//                    rwd-llmeval/         （LLM 評價）
//                    rwd-llmgrid/         （LLM 互動網格）
//                    rwd-compare/         （RWD 比較結果）
//   （底圖／地標）  → metro-tracks/、metro-tracks-center/、metro-landmarks/

export const METRO_DIRS = Object.freeze({
  systems: 'metro-maps',
  views: 'map-adjust',
  hcviews: 'straighten',
  rwdviews: 'rwd-maps',
  hccells: 'straighten-cells',
  llmviews: 'straighten-llm',
  llmshapes: 'straighten-shape',
  llmevals: 'rwd-llmeval',
  llmgrids: 'rwd-llmgrid',
  llmcompares: 'rwd-compare',
  tracks: 'metro-tracks',
  tracksCenter: 'metro-tracks-center',
  landmarks: 'metro-landmarks',
})

/** 相對 data/metro/ 的目錄名 */
export function metroDir(key) {
  const d = METRO_DIRS[key]
  if (!d) throw new Error(`unknown metro dir key: ${key}`)
  return d
}

/** 網頁／fetch 用：data/metro/<dir>/… */
export function metroDataRel(key, ...parts) {
  return ['data', 'metro', metroDir(key), ...parts].join('/')
}

/** 圖層 file 欄位常見寫法：metro-maps/asia/…/as-twn-taipei.geojson */
export function systemFileRel(continentPath, fileName) {
  return `${METRO_DIRS.systems}/${continentPath}/${fileName}`.replace(/\/+/g, '/')
}

/** 把舊路徑字串（含 systems/views/hcviews…）改成新名——遷移／讀舊資料用 */
export function rewriteLegacyMetroPath(s) {
  if (!s || typeof s !== 'string') return s
  return s
    .replace(/\/data\/metro\/systems\//g, `/data/metro/${METRO_DIRS.systems}/`)
    .replace(/(^|\/)systems\//g, `$1${METRO_DIRS.systems}/`)
    .replace(/\/data\/metro\/views\//g, `/data/metro/${METRO_DIRS.views}/`)
    .replace(/(^|\/)views\//g, (m, p) => (m.includes('map-adjust') ? m : `${p}${METRO_DIRS.views}/`))
    .replace(/\/data\/metro\/hcviews\//g, `/data/metro/${METRO_DIRS.hcviews}/`)
    .replace(/(^|\/)hcviews\//g, `$1${METRO_DIRS.hcviews}/`)
    .replace(/\/data\/metro\/rwdviews\//g, `/data/metro/${METRO_DIRS.rwdviews}/`)
    .replace(/(^|\/)rwdviews\//g, `$1${METRO_DIRS.rwdviews}/`)
    .replace(/\/data\/metro\/hccells\//g, `/data/metro/${METRO_DIRS.hccells}/`)
    .replace(/(^|\/)hccells\//g, `$1${METRO_DIRS.hccells}/`)
    .replace(/\/data\/metro\/llmviews\//g, `/data/metro/${METRO_DIRS.llmviews}/`)
    .replace(/(^|\/)llmviews\//g, `$1${METRO_DIRS.llmviews}/`)
    .replace(/\/data\/metro\/llmshapes\//g, `/data/metro/${METRO_DIRS.llmshapes}/`)
    .replace(/(^|\/)llmshapes\//g, `$1${METRO_DIRS.llmshapes}/`)
    .replace(/\/data\/metro\/llmevals\//g, `/data/metro/${METRO_DIRS.llmevals}/`)
    .replace(/(^|\/)llmevals\//g, `$1${METRO_DIRS.llmevals}/`)
    .replace(/\/data\/metro\/llmgrids\//g, `/data/metro/${METRO_DIRS.llmgrids}/`)
    .replace(/(^|\/)llmgrids\//g, `$1${METRO_DIRS.llmgrids}/`)
    .replace(/\/data\/metro\/llmcompares\//g, `/data/metro/${METRO_DIRS.llmcompares}/`)
    .replace(/(^|\/)llmcompares\//g, `$1${METRO_DIRS.llmcompares}/`)
    .replace(/\/data\/metro\/tracks-center\//g, `/data/metro/${METRO_DIRS.tracksCenter}/`)
    .replace(/(^|\/)tracks-center\//g, `$1${METRO_DIRS.tracksCenter}/`)
    .replace(/\/data\/metro\/tracks\//g, `/data/metro/${METRO_DIRS.tracks}/`)
    .replace(/(^|\/)tracks\//g, `$1${METRO_DIRS.tracks}/`)
    .replace(/\/data\/metro\/landmarks\//g, `/data/metro/${METRO_DIRS.landmarks}/`)
    .replace(/(^|\/)landmarks\//g, `$1${METRO_DIRS.landmarks}/`)
}
