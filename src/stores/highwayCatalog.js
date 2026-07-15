import { assetUrl } from '../lib/assetUrl'
import CITY_ZH from './cityNamesZh.json'

// World highway-network catalog (data/highway/index.json), fetched once and
// cached. Each system is anchored on a metro area, so its slug matches the
// metro slug and CITY_ZH (keyed by that slug) gives the 國名/城市名 labels.
let catalogPromise = null

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
