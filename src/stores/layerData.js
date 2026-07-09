import { shallowReactive } from 'vue'

// Loaded GeoJSON per layer id (shallow: the geojson itself stays a plain object).
// Filled by LayerTab when a metro system file finishes loading; read by the
// attribute table and zoom-to-layer.
export const layerData = shallowReactive({})

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
