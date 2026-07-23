import { assetUrl } from '../lib/assetUrl.js'

// World highway-network catalog (data/highway/index.json), fetched once and
// cached. One system per country; the build already writes country_zh (中文,
// derived from the metro data) so every menu shows 中文＋English like metro maps.
let catalogPromise = null

function withZh(s) {
  const id = s.file.split('/').pop().replace(/\.geojson$/, '')
  const countryZh = s.country_zh ?? s.country
  // small country → one file per country (city label = country); big country →
  // one file per metro area (city label = the metro city).
  const cityZh = s.city_zh ?? (s.unit === 'metro' ? s.city : countryZh)
  return { ...s, id, cityZh, countryZh }
}

export function loadHighwayCatalog() {
  catalogPromise ??= fetch(assetUrl('data/highway/index.json'), { cache: 'no-cache' })
    .then((r) => {
      if (!r.ok) throw new Error(`highway index.json ${r.status}`)
      return r.json()
    })
    .then((index) =>
      (index.systems ?? []).filter((s) => s.continent && s.country && s.city).map(withZh),
    )
    .catch((err) => {
      catalogPromise = null // allow retry
      throw err
    })
  return catalogPromise
}
