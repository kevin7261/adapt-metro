// World metro-system catalog (data/metro/index.json), fetched once and cached.
let catalogPromise = null

export function loadMetroCatalog() {
  catalogPromise ??= fetch('/data/metro/index.json')
    .then((r) => {
      if (!r.ok) throw new Error(`index.json ${r.status}`)
      return r.json()
    })
    .then((index) =>
      // Drop entries the reverse-geocoder couldn't place.
      index.systems.filter((s) => s.continent && s.country && s.city),
    )
    .catch((err) => {
      catalogPromise = null // allow retry
      throw err
    })
  return catalogPromise
}

// 'north-america' → 'North America'
export function prettyContinent(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
