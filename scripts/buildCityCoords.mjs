// Build data/metro/city_coords.json — a lightweight { <id>: [lng, lat] } index
// giving one representative coordinate per metro system, for the 世界地圖 tab.
//
// The coordinate is the bbox centre of the system's GeoJSON geometry, computed
// once here so the browser world-map tab can place 200+ city dots without
// fetching every city's full network. Run: `node scripts/buildCityCoords.mjs`.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const METRO = resolve(process.cwd(), 'data/metro')
const index = JSON.parse(readFileSync(resolve(METRO, 'index.json'), 'utf8'))

// Walk every coordinate of a GeoJSON geometry, tracking the bbox.
function extend(box, coords) {
  if (typeof coords[0] === 'number') {
    const [lng, lat] = coords
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      if (lng < box[0]) box[0] = lng
      if (lat < box[1]) box[1] = lat
      if (lng > box[2]) box[2] = lng
      if (lat > box[3]) box[3] = lat
    }
    return
  }
  for (const c of coords) extend(box, c)
}

const out = {}
let ok = 0
let skipped = 0
for (const sys of index.systems) {
  const id = sys.file.split('/').pop().replace(/\.geojson$/, '')
  let geo
  try {
    geo = JSON.parse(readFileSync(resolve(METRO, sys.file), 'utf8'))
  } catch {
    skipped++
    continue
  }
  const box = [Infinity, Infinity, -Infinity, -Infinity]
  for (const f of geo.features ?? []) {
    if (f?.geometry?.coordinates) extend(box, f.geometry.coordinates)
  }
  if (box[0] === Infinity) { skipped++; continue }
  // bbox centre, rounded to 5 dp (~1 m) to keep the file small.
  const r = (n) => Math.round(n * 1e5) / 1e5
  out[id] = [r((box[0] + box[2]) / 2), r((box[1] + box[3]) / 2)]
  ok++
}

writeFileSync(
  resolve(METRO, 'city_coords.json'),
  JSON.stringify({ generated_at: null, coords: out }, null, 0),
)
console.log(`city_coords.json — ${ok} cities, ${skipped} skipped`)
