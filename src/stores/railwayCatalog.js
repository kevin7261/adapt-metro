import { assetUrl } from '../lib/assetUrl'

// World national-railway catalog (data/railway/index.json), fetched once and
// cached. One system per COUNTRY; the build writes country_zh so every menu shows
// 中文＋English like metro maps. Railway networks mirror the metro GeoJSON schema
// (see skill railway-osm-fetch), so they render through the same pipeline.
let catalogPromise = null

function withZh(s) {
  const id = s.file.split('/').pop().replace(/\.geojson$/, '')
  const countryZh = s.country_zh ?? s.country
  const cityZh = s.city_zh ?? countryZh
  return { ...s, id, cityZh, countryZh }
}

export function loadRailwayCatalog() {
  catalogPromise ??= fetch(assetUrl('data/railway/index.json'), { cache: 'no-cache' })
    .then((r) => {
      if (!r.ok) throw new Error(`railway index.json ${r.status}`)
      return r.json()
    })
    .then((index) =>
      (index.systems ?? []).filter((s) => s.continent && s.country).map(withZh),
    )
    .catch((err) => {
      catalogPromise = null // allow retry
      throw err
    })
  return catalogPromise
}
