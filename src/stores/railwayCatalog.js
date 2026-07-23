import { assetUrl } from '../lib/assetUrl.js'

// World national-railway catalog (data/railway/index.json), fetched once and
// cached. One system per COUNTRY; the build writes country_zh so every menu shows
// 中文＋English like metro maps. Railway networks mirror the metro GeoJSON schema
// (see skill railway-osm-fetch), so they render through the same pipeline.
let catalogPromise = null

function withZh(s) {
  const id = s.file.split('/').pop().replace(/\.geojson$/, '')
  // Each system is one rail CLASS of a country (高鐵 / 一般國鐵, 一國拆兩檔). The
  // displayed name carries the class so the two rows/layers are distinct:
  // countryZh = "日本 高鐵" / "日本 一般國鐵". Japan is further split by JR company
  // (company_zh = "JR東日本"…, 拆六社) — the company then REPLACES the country in the
  // display: "JR東日本 一般國鐵" / "Japan · JR East Conventional". `country` stays
  // pure ("Japan") for continent grouping and quick-pick matching.
  const classZh = s.class_zh ?? null
  const classEn = s.class_en ?? null
  const pureZh = s.country_zh ?? s.country
  const ownerZh = s.company_zh ?? pureZh
  const countryZh = classZh ? `${ownerZh} ${classZh}` : ownerZh
  const ownerCityZh = s.company_zh ?? s.city_zh
  const cityZh = ownerCityZh ? (classZh ? `${ownerCityZh} ${classZh}` : ownerCityZh) : countryZh
  const enBits = [s.company_en, classEn].filter(Boolean).join(' ')
  const labelEn = enBits ? `${s.country} · ${enBits}` : s.country
  return { ...s, id, cityZh, countryZh, labelEn, railClass: s.rail_class ?? null, classZh, classEn, companyZh: s.company_zh ?? null }
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
