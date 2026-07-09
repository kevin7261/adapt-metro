// Reverse-geocode each metro system's centroid to continent / country / city,
// so per-system GeoJSON files can be named  continent-country-city.geojson.
// Uses Nominatim (rate-limited 1 req/s, cached & resumable in _cache/geocode.json).
// Run after fetchMetro.mjs; before buildGeojson.mjs.
import { readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'
import { CONTINENT } from './continents.mjs'

const CACHE = overpass.CACHE
const OUT = join(CACHE, 'geocode.json')
const UA = 'adapt-metro-thesis/1.0 (metro data extraction; knowledge.nomads.tw2@gmail.com)'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const pick = (t, ...ks) => { for (const k of ks) if (t[k]) return t[k]; return null }
const netKey = (t) => pick(t, 'network:en', 'network', 'operator') || 'Unknown'

async function exists(p) { try { return (await stat(p)).size > 0 } catch { return false } }

async function centroids() {
  // Average coordinate per network. Use BOTH stations and route geometry so that
  // networks that appear only on route relations (not on any station) still get a
  // centroid — build groups lines by route network, so those must be geocoded too.
  const acc = new Map()
  const add = (net, lon, lat) => {
    let a = acc.get(net)
    if (!a) { a = { sx: 0, sy: 0, n: 0 }; acc.set(net, a) }
    a.sx += lon; a.sy += lat; a.n++
  }

  const st = JSON.parse(await readFile(join(CACHE, 'stations.json'), 'utf8'))
  for (const e of st.elements) {
    let lon, lat
    if (e.type === 'node') { lon = e.lon; lat = e.lat }
    else { lon = e.center?.lon; lat = e.center?.lat }
    if (lon == null || lat == null) continue
    add(netKey(e.tags || {}), lon, lat)
  }

  const routeNet = new Map()  // route relation id -> network key
  const rt = JSON.parse(await readFile(join(CACHE, 'routes_tags.json'), 'utf8'))
  for (const e of rt.elements) if (e.type === 'relation') routeNet.set(e.id, netKey(e.tags || {}))
  for (const f of (await readdir(CACHE)).filter((n) => /^geom_\d+\.json$/.test(n))) {
    const d = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    for (const e of d.elements || []) {
      if (e.type !== 'relation') continue
      const net = routeNet.get(e.id)
      if (!net) continue
      for (const m of e.members || []) {
        if (m.type === 'way' && m.geometry) {
          // sample a few points per way to keep the centroid cheap but representative
          const g = m.geometry, step = Math.max(1, Math.floor(g.length / 5))
          for (let i = 0; i < g.length; i += step) add(net, g[i].lon, g[i].lat)
        }
      }
    }
  }

  const out = new Map()
  for (const [net, a] of acc) out.set(net, { lon: a.sx / a.n, lat: a.sy / a.n, n: a.n })
  return out
}

async function reverse(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}` +
    `&lon=${lon}&zoom=12&accept-language=en`
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      const a = j.address || {}
      const cc = (a.country_code || '').toUpperCase()
      const city = a.city || a.town || a.municipality || a.city_district ||
        a.county || a.state || a.region || a.village || null
      return {
        continent: CONTINENT[cc] || null,
        country: a.country || null,
        country_code: cc || null,
        city,
      }
    } catch (e) {
      if (attempt === 3) { process.stderr.write(`  geocode fail (${lat},${lon}): ${e.message}\n`); return null }
      await sleep(2000 * (attempt + 1))
    }
  }
}

async function main() {
  const cents = await centroids()
  const cache = (await exists(OUT)) ? JSON.parse(await readFile(OUT, 'utf8')) : {}
  const nets = [...cents.keys()].filter((n) => n !== 'Unknown')
  console.log(`${nets.length} networks to geocode (${Object.keys(cache).length} already cached)`)
  let done = 0
  for (const net of nets) {
    done++
    if (cache[net] && cache[net].country_code) continue
    const c = cents.get(net)
    const geo = await reverse(c.lat.toFixed(5), c.lon.toFixed(5))
    cache[net] = { ...geo, stations: c.n }
    if (done % 10 === 0 || geo) {
      console.log(`  [${done}/${nets.length}] ${net} -> ` +
        `${geo ? `${geo.continent}/${geo.country}/${geo.city}` : 'FAILED'}`)
    }
    await writeFile(OUT, JSON.stringify(cache, null, 2))
    await sleep(1100)  // Nominatim usage policy: max 1 req/s
  }
  console.log(`\nDONE geocoding -> ${OUT}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
