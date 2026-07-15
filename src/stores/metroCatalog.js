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
