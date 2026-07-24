// 逐城市「整個資料流的地圖是否都算出來」判定（世界地圖分頁的圓點顏色來源）。
//
// 完整＝該城 Straighten／RWD 縮圖畫得出來，也就是 straighten-cells 通過與網頁畫廊
// （CityViewGrid / D3Tab.loadStraightenCells）完全相同的門檻：
//   algo ∈ {hccells-v8, v9}、fingerprint === dataFingerprint(geojson):rg1.15、
//   有 hc.cellAfter、有 loops。orig 必要；可旋轉的城市（map-adjust canRotate）rot 也要。
// Map Adjust 圖（map-adjust/<id>.json）為資料流一環，一併要求存在。
// 規定表成方城另要：straighten-shape square===true ＋ orig/rot-shape.shapelike cells。
//
// 讀「目前磁碟狀態」計算，所以按「重新計算」重烤 cells（寫 straighten-cells）後，
// 這裡立刻反映最新結果——世界地圖開著時每 2s 輪詢 city_status，UI 重算另靠 metroDataEpoch。
// 大檔 geojson 依 mtime 記憶指紋，避免每次重解析整個 data/metro。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getShapePresets } from '../src/stores/paper/shapePresets.js'

const RG = 1.15 // DEFAULT_RIVER_GRAY_SINUOSITY（畫廊縮圖固定用這個門檻）
const ALGO_READ = new Set(['hccells-v8', 'hccells-v9'])

// 與 src/lib/straightenCells.js 的 dataFingerprint 逐字一致（勿改，改了要兩邊同步）。
function dataFingerprint(data) {
  let h = 5381
  const add = (s) => { for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0 }
  for (const f of data.features) {
    if (f.geometry?.type === 'Point') {
      add(`${f.properties.station_id}@${f.geometry.coordinates.join(',')}`)
    } else {
      for (const r of f.properties?.routes ?? []) {
        add(`${r.route_id ?? ''}#${(r.stations ?? []).map((s) => s.station_id).join('.')}`)
      }
    }
  }
  return (h >>> 0).toString(36)
}

function cellsUsable(doc, fp) {
  return !!(doc && ALGO_READ.has(doc.algo) && doc.fingerprint === fp && doc.hc?.cellAfter && doc.loops)
}

function readJson(abs) {
  try { return JSON.parse(readFileSync(abs, 'utf8')) } catch { return null }
}

// geojson 指紋：mtime 沒變就沿用快取，避免重解析大檔。
const fpCache = new Map() // absPath → { mtimeMs, fp }
function fingerprintFor(abs) {
  let st
  try { st = statSync(abs) } catch { return null }
  const hit = fpCache.get(abs)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.fp
  const geo = readJson(abs)
  if (!geo?.features) return null
  const fp = `${dataFingerprint(geo)}:rg${RG}`
  fpCache.set(abs, { mtimeMs: st.mtimeMs, fp })
  return fp
}

/**
 * 回傳 { [cityId]: boolean } —— 每個城市整個資料流的圖是否都算出來（目前磁碟狀態）。
 * @param {string} root 專案根目錄（含 data/metro）
 */
export function computeCityStatus(root) {
  const metro = join(root, 'data', 'metro')
  const index = readJson(join(metro, 'index.json'))
  if (!index?.systems) return {}

  // canRotate：map-adjust/index.json（缺就當可旋轉，要求 rot）。
  const canRotate = {}
  const ma = readJson(join(metro, 'map-adjust', 'index.json'))
  for (const s of ma?.systems ?? []) canRotate[s.id] = s.canRotate !== false

  const out = {}
  for (const sys of index.systems) {
    const id = sys.file.split('/').pop().replace(/\.geojson$/, '')
    const fp = fingerprintFor(join(metro, sys.file))
    if (!fp) { out[id] = false; continue }
    const maExists = existsSync(join(metro, 'map-adjust', `${id}.json`))
    const orig = cellsUsable(readJson(join(metro, 'straighten-cells', `${id}.orig.json`)), fp)
    const needRot = canRotate[id] !== false
    const rot = cellsUsable(readJson(join(metro, 'straighten-cells', `${id}.rot.json`)), fp)
    // 規定表成方城：還要 square 成方檔＋shapelike cells（否則形狀層開了也是「沒算完」）
    let shapeOk = true
    if (getShapePresets(id)) {
      const so = readJson(join(metro, 'straighten-shape', `${id}.orig.json`))
      const sr = readJson(join(metro, 'straighten-shape', `${id}.rot.json`))
      const co = cellsUsable(readJson(join(metro, 'straighten-cells', `${id}.orig-shape.shapelike.json`)), fp)
      const cr = cellsUsable(readJson(join(metro, 'straighten-cells', `${id}.rot-shape.shapelike.json`)), fp)
      shapeOk = so?.square === true && co && (!needRot || (sr?.square === true && cr))
    }
    out[id] = maExists && orig && (needRot ? rot : true) && shapeOk
  }
  return out
}
