import { shallowReactive } from 'vue'

// Loaded GeoJSON per layer id (shallow: the geojson itself stays a plain object).
// Filled by LayerTab when a metro system file finishes loading; read by the
// attribute table and zoom-to-layer.
export const layerData = shallowReactive({})

// 目前畫面內容的可匯出快照 per layer id（使用者規則：每個圖層的「匯出」＝下載它
// 目前畫面顯示的佈局）。衍生視圖（Map Adjust／Hill Climbing／RWD／骨架／格網化…）
// 的佈局不是來源 GeoJSON、也不存在 layerData（那裡放的是「來源」資料），故 D3Tab
// 每次 render 後把「畫面上實際畫出的線與節點」序列化成 GeoJSON（座標＝畫面像素）
// 存進這裡；LayerPanel 匯出時優先取用。移除圖層時一併清掉。
export const layerExport = shallowReactive({})

// Chinese-first display names: for a station whose English `station_name` has a
// Chinese `station_name_local` (e.g. HK "炮台山 Fortress Hill"), swap in the
// leading 中文 part ("炮台山"). Idempotent + guarded: stations already in CJK/
// kana/hangul (Tokyo/Seoul, fetched as name:ja/local) and Latin-only cities
// (London) are untouched. Mutates the GeoJSON in place; call once on load.
const CJK = /[぀-ヿ㐀-鿿가-힯]/ // kana + CJK + hangul
export function localizeStationNames(geojson) {
  for (const f of geojson?.features ?? []) {
    if (f.geometry?.type !== 'Point') continue
    const p = f.properties
    if (!p || CJK.test(p.station_name ?? '')) continue // already local
    const local = p.station_name_local
    if (!local || !CJK.test(local)) continue
    const m = local.match(/^[぀-ヿ㐀-鿿가-힯·・（）()、\s]+/)
    const zh = m ? m[0].trim() : ''
    if (zh) p.station_name = zh
  }
  return geojson
}

// [west, south, east, north] of a metro-system GeoJSON, or null if empty.
export function boundsOfGeojson(geojson) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      if (coords[0] < w) w = coords[0]
      if (coords[0] > e) e = coords[0]
      if (coords[1] < s) s = coords[1]
      if (coords[1] > n) n = coords[1]
    } else {
      coords.forEach(visit)
    }
  }
  geojson.features.forEach((f) => visit(f.geometry.coordinates))
  return w <= e ? [w, s, e, n] : null
}
