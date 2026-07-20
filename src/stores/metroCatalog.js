import { assetUrl } from '../lib/assetUrl'
import CITY_ZH from './cityNamesZh.json'

// World metro-system catalog (data/metro/index.json), fetched once and cached.
let catalogPromise = null

// Each entry gets Chinese 國名/城市名 (cityNamesZh.json, keyed by geojson stem)
// so every menu and gallery can show 國名－城市名 with an English fallback.
function withZh(s) {
  const id = s.file.split('/').pop().replace(/\.geojson$/, '')
  const zh = CITY_ZH[id]
  return {
    ...s,
    id,
    cityZh: zh?.city ?? s.city,
    countryZh: zh?.country ?? s.country,
  }
}

export function loadMetroCatalog() {
  catalogPromise ??= fetch(assetUrl('data/metro/index.json'), { cache: 'no-cache' })
    .then((r) => {
      if (!r.ok) throw new Error(`index.json ${r.status}`)
      return r.json()
    })
    .then((index) =>
      // Drop entries the reverse-geocoder couldn't place; enrich with Chinese.
      index.systems.filter((s) => s.continent && s.country && s.city).map(withZh),
    )
    .catch((err) => {
      catalogPromise = null // allow retry
      throw err
    })
  return catalogPromise
}

// Official-website index (data/metro/official_sites.json, from metro:sites),
// keyed by '{continent}/{country}/{slug}'. 官方路線圖圖檔不再抓（使用者 2026-07
// 裁決改抓官方網站）——資訊 tab 的「官網」列優先讀這裡，缺項 fallback 到
// metro_system.official_website（OSM build 舊值，常是深層頁）。
let sitesIndexPromise = null

export function loadSitesIndex() {
  sitesIndexPromise ??= fetch(assetUrl('data/metro/official_sites.json'))
    .then((r) => {
      if (!r.ok) throw new Error(`official_sites.json ${r.status}`)
      return r.json()
    })
    .catch((err) => {
      sitesIndexPromise = null // allow retry
      throw err
    })
  return sitesIndexPromise
}

// Official metro-map image index (data/metro/maps/maps_index.json, from
// downloadMaps.mjs), keyed by '{continent}/{country}/{slug}' (= geojson `file`
// minus the `systems/` prefix and `.geojson` suffix). Each value carries
// `map_file`（相對 data/metro 的圖檔路徑，無圖為 null）＋授權。視圖畫廊的
// Metro Maps 區段用它在縮圖右邊那格顯示官方路線圖。
let mapsIndexPromise = null

export function loadMapsIndex() {
  mapsIndexPromise ??= fetch(assetUrl('data/metro/maps/maps_index.json'))
    .then((r) => {
      if (!r.ok) throw new Error(`maps_index.json ${r.status}`)
      return r.json()
    })
    .catch((err) => {
      mapsIndexPromise = null // allow retry
      throw err
    })
  return mapsIndexPromise
}

// system entry（catalog / views index／圖層，含 `file`）→ maps_index 的鍵。
// `file` 兩種形式都吃：catalog/views 的相對 `systems/…​.geojson`、圖層的
// `/data/metro/systems/…​.geojson`（帶前綴）——一律抓 `systems/` 之後那段。
// `-lm`（Landmark 疊加）/`-jr`（JR 合併）變體共用母城市的官方圖 → 去尾綴退回母城。
export function mapsKeyFor(entry) {
  const m = (entry?.file || '').match(/systems\/(.+)\.geojson$/)
  return m ? m[1] : null
}
export function mapsKeyBase(key) {
  return key.replace(/-(lm|jr)$/, '')
}

// 'north-america' → 'North America'
export function prettyContinent(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// 'north-america' → '北美洲' (Chinese-first display; English fallback).
const CONTINENT_ZH = {
  'north-america': '北美洲', 'south-america': '南美洲', asia: '亞洲',
  europe: '歐洲', africa: '非洲', oceania: '大洋洲',
}
export function continentZh(slug) {
  return CONTINENT_ZH[slug] ?? prettyContinent(slug)
}
