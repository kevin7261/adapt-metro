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

// Official route-map image index (data/metro/maps/maps_index.json),
// keyed by '{continent}/{country}/{slug}'.
let mapsIndexPromise = null

export function loadMapsIndex() {
  mapsIndexPromise ??= fetch('/data/metro/maps/maps_index.json')
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
