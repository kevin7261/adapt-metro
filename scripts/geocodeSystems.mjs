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

  // route relation id -> network key; routes with no network/operator of their
  // own (e.g. Harbin Metro) inherit their route_master's, mirroring the build.
  const masterOf = new Map(), masterTags = new Map()
  try {
    const rm = JSON.parse(await readFile(join(CACHE, 'route_masters.json'), 'utf8'))
    for (const e of rm.elements) if (e.type === 'relation') {
      masterTags.set(e.id, e.tags || {})
      for (const m of e.members || []) if (m.type === 'relation') masterOf.set(m.ref, e.id)
    }
  } catch { /* masters are optional */ }
  const routeNet = new Map()
  const rt = JSON.parse(await readFile(join(CACHE, 'routes_tags.json'), 'utf8'))
  for (const e of rt.elements) if (e.type === 'relation') {
    let k = netKey(e.tags || {})
    if (k === 'Unknown' && masterOf.has(e.id))
      k = netKey(masterTags.get(masterOf.get(e.id)) || {})
    routeNet.set(e.id, k)
  }
  for (const f of (await readdir(CACHE)).filter((n) => /^geom_.+\.json$/.test(n))) {
    const d = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    // node member coords: inline on the member (old `out geom` caches) or as
    // separate skel node elements (current member-list caches)
    const nodeXY = new Map()
    for (const e of d.elements || [])
      if (e.type === 'node' && e.lat != null) nodeXY.set(e.id, [e.lon, e.lat])
    for (const e of d.elements || []) {
      if (e.type !== 'relation') continue
      const net = routeNet.get(e.id)
      if (!net) continue
      for (const m of e.members || []) {
        if (m.type === 'way' && m.geometry) {
          // sample a few points per way to keep the centroid cheap but representative
          const g = m.geometry, step = Math.max(1, Math.floor(g.length / 5))
          for (let i = 0; i < g.length; i += step) add(net, g[i].lon, g[i].lat)
        } else if (m.type === 'node') {
          const c = m.lat != null ? [m.lon, m.lat] : nodeXY.get(m.ref)
          if (c) add(net, c[0], c[1])
        }
      }
    }
  }

  const out = new Map()
  for (const [net, a] of acc) out.set(net, { lon: a.sx / a.n, lat: a.sy / a.n, n: a.n })
  return out
}

async function fetchAddr(lat, lon, zoom) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}` +
    `&lon=${lon}&zoom=${zoom}&accept-language=en`
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()).address || {}
    } catch (e) {
      if (attempt === 3) { process.stderr.write(`  geocode fail z${zoom} (${lat},${lon}): ${e.message}\n`); return null }
      await sleep(2000 * (attempt + 1))
    }
  }
}

const CAND_KEYS = ['city', 'town', 'municipality', 'city_district', 'district',
  'suburb', 'county', 'state_district', 'region', 'state', 'province', 'village']

async function reverse(lat, lon) {
  // Two zoom levels: 12 resolves the local admin unit, 10 the city proper —
  // in e.g. China zoom 12 only yields the district (Yinzhou District) and no
  // address level carries the prefecture city (Ningbo), which zoom 10 does.
  const a12 = await fetchAddr(lat, lon, 12)
  await sleep(1100)  // Nominatim usage policy: max 1 req/s
  const a10 = await fetchAddr(lat, lon, 10)
  const a = a12 || a10
  if (!a) return null
  const cc = (a.country_code || '').toUpperCase()
  const city = a.city || a.town || a.municipality || a.city_district ||
    a.county || a.state || a.region || a.village || null
  // Every admin level from both zooms, most specific first. The build step
  // picks the one matching a Wikipedia city — the "city" field alone often
  // lands on a district or neighbouring municipality (Yinzhou District, Burnaby).
  const city_candidates = [...new Set([a12, a10].filter(Boolean)
    .flatMap((x) => CAND_KEYS.map((k) => x[k])).filter(Boolean))]
  return {
    continent: CONTINENT[cc] || null,
    country: a.country || null,
    country_code: cc || null,
    city,
    city_candidates,
    zoom10: true,
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
    if (cache[net] && cache[net].country_code && cache[net].zoom10) continue
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
  await wikiCityCoords()
}

// Forward-geocode every Wikipedia metro city once (cached). The build uses
// these coordinates to resolve system buckets whose reverse-geocoded admin
// names never mention the canonical city in any latin form (济南 → Jinan).
async function wikiCityCoords() {
  const OUT2 = join(CACHE, 'wiki_city_coords.json')
  const wiki = JSON.parse(await readFile(join(CACHE, 'wiki_metro_systems.json'), 'utf8'))
  const cache = (await exists(OUT2)) ? JSON.parse(await readFile(OUT2, 'utf8')) : {}
  const wanted = [...new Set(wiki.map((s) => `${s.city}|${s.country}`))]
  const todo = wanted.filter((k) => !(k in cache))
  console.log(`\n${todo.length}/${wanted.length} wiki cities to forward-geocode`)
  for (const k of todo) {
    const [city, country] = k.split('|')
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' +
      encodeURIComponent(`${city}, ${country}`)
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      const j = res.ok ? await res.json() : []
      cache[k] = j[0] ? { lat: +j[0].lat, lon: +j[0].lon } : null
    } catch { cache[k] = null }
    await writeFile(OUT2, JSON.stringify(cache, null, 2))
    await sleep(1100)  // Nominatim usage policy: max 1 req/s
  }
  console.log(`DONE wiki city coords -> ${OUT2}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
