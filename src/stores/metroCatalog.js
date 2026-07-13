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
  catalogPromise ??= fetch(assetUrl('data/metro/index.json'))
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

// Official route-map image index (data/metro/maps/maps_index.json),
// keyed by '{continent}/{country}/{slug}'.
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
