// Assemble OSM subway cache into GeoJSON: per-system files + global layers.
//   stations: station_id, station_name (+ network/city/country/lines)
//   lines:    route_id, route_name, route_color, route_ref (+ network/city/country)
// Line geometry connects each route's stops in member order (schematic), not
// the real track ways. Operational elements only (no construction/proposed).
// Run fetchMetro.mjs first. Outputs under data/metro/.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '..', 'data', 'metro')
const CACHE = join(BASE, '_cache')
const SYS_DIR = join(BASE, 'systems')

const CSS_COLORS = {
  red: '#e6194b', blue: '#0000ff', green: '#3cb44b', yellow: '#ffe119',
  orange: '#f58231', purple: '#911eb4', cyan: '#42d4f4', magenta: '#f032e6',
  lime: '#bfef45', pink: '#fabed4', teal: '#469990', lavender: '#dcbeff',
  brown: '#9a6324', beige: '#fffac8', maroon: '#800000', navy: '#000080',
  grey: '#808080', gray: '#808080', black: '#000000', white: '#ffffff',
  silver: '#c0c0c0', gold: '#ffd700', violet: '#ee82ee', indigo: '#4b0082',
}

function normColor(c) {
  if (!c) return null
  c = c.trim()
  const low = c.toLowerCase()
  if (CSS_COLORS[low]) return CSS_COLORS[low]
  let m = /^#?([0-9a-fA-F]{6})$/.exec(c)
  if (m) return '#' + m[1].toLowerCase()
  m = /^#?([0-9a-fA-F]{3})$/.exec(c)
  if (m) return '#' + [...m[1].toLowerCase()].map((ch) => ch + ch).join('')
  return c
}

const pick = (tags, ...keys) => { for (const k of keys) if (tags[k]) return tags[k]; return null }

// Operational only: an element carrying a lifecycle tag (under construction,
// proposed, disused…) is not part of the running network. The fetch queries
// already exclude these; this re-filters older caches fetched without the guard.
const NONOP = /^(proposed|construction|planned|disused|abandoned|razed)$/
const isOperational = (t = {}) =>
  !NONOP.test(t.state || '') && !NONOP.test(t.railway || '') &&
  !('construction' in t) && !('proposed' in t) && !('planned' in t) &&
  !('disused' in t) && !('abandoned' in t)

function slugify(s) {
  if (!s) return ''
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
}

const readJSON = async (name) => JSON.parse(await readFile(join(CACHE, name), 'utf8'))

async function readGeocode() {
  try { return JSON.parse(await readFile(join(CACHE, 'geocode.json'), 'utf8')) }
  catch { return {} }
}

const STOP = new Set(['metro', 'subway', 'underground', 'u-bahn', 'the', 'of', 'rapid',
  'transit', 'railway', 'rail', 'mrt', 'system', 'line', 'lines'])

function tokens(s) {
  s = (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const out = new Set()
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/))
    if (t && t.length > 1 && !STOP.has(t)) out.add(t)
  return out
}
const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n }
const union = (a, b) => new Set([...a, ...b])

function matchWiki(networkStr, cityHint, idx) {
  const nt = union(tokens(networkStr), tokens(cityHint))
  if (nt.size === 0) return null
  let best = null, bestScore = 0
  for (const row of idx) {
    let score = inter(nt, union(row.nameTok, row.cityTok))
    if (inter(nt, row.cityTok) > 0) score += 1
    if (score > bestScore) { bestScore = score; best = row.sys }
  }
  return bestScore >= 1 ? { sys: best, score: bestScore } : null
}

async function build() {
  console.log('Loading cache...')
  const routesRaw = await readJSON('routes_tags.json')
  const routesTags = new Map()
  for (const e of routesRaw.elements)
    if (e.type === 'relation' && isOperational(e.tags)) routesTags.set(e.id, e.tags || {})

  const mastersRaw = await readJSON('route_masters.json')
  const masterOf = new Map(), masterTags = new Map()
  for (const e of mastersRaw.elements) {
    if (e.type !== 'relation') continue
    masterTags.set(e.id, e.tags || {})
    for (const m of e.members || []) if (m.type === 'relation') masterOf.set(m.ref, e.id)
  }

  // geom_* cache: relations with ordered member lists + coordinates for member
  // nodes. New caches ship node coords as separate skel elements; old `out geom`
  // caches carried lat/lon inline on each node member — support both.
  const geom = new Map(), memberXY = new Map()
  for (const f of (await readdir(CACHE)).filter((n) => /^geom_\d+\.json$/.test(n))) {
    const d = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    for (const e of d.elements || []) {
      if (e.type === 'relation') geom.set(e.id, e)
      else if (e.type === 'node' && e.lat != null) memberXY.set(e.id, [e.lon, e.lat])
    }
  }

  const stRaw = await readJSON('stations.json')
  const stations = []
  for (const e of stRaw.elements) {
    if (!isOperational(e.tags)) continue
    let lon, lat
    if (e.type === 'node') { lon = e.lon; lat = e.lat }
    else { lon = e.center?.lon; lat = e.center?.lat }
    if (lon == null || lat == null) continue
    stations.push({ id: e.id, lon, lat, tags: e.tags || {} })
  }

  const wikiSystems = await readJSON('wiki_metro_systems.json')
  const wikiIdx = wikiSystems.map((s) => ({
    sys: s, nameTok: tokens(s.name), cityTok: tokens(s.city),
  }))
  const geocode = await readGeocode()
  // Resolve continent/country/city for a network: prefer reverse-geocode
  // (coordinate-truthful), fall back to the Wikipedia name match.
  const countryOk = (a, b) => {
    if (!a || !b) return false
    const na = a.toLowerCase().replace(/[^a-z]/g, ''), nb = b.toLowerCase().replace(/[^a-z]/g, '')
    return na === nb || na.includes(nb) || nb.includes(na)
  }
  const normCity = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '')
  const bestWikiInCountry = (network, netTag, country) => {
    const nt = union(tokens(network), tokens(netTag))
    if (!nt.size) return null
    let best = null, bestScore = 0
    for (const row of wikiIdx) {
      if (!countryOk(country, row.sys.country)) continue
      let score = inter(nt, union(row.nameTok, row.cityTok))
      if (inter(nt, row.cityTok) > 0) score += 1
      if (score > bestScore) { bestScore = score; best = row.sys }
    }
    return bestScore >= 1 ? best : null
  }
  const geoFor = (network, netTag) => {
    const g = geocode[network] || {}
    // continent + country come ONLY from coordinate reverse-geocoding (authoritative).
    const continent = g.continent || null
    const country = g.country || null
    let city = g.city || null
    if (country) {
      // If the geocoded city is already a canonical Wikipedia city in this country,
      // keep it. Only when it's a district/variant (e.g. "Xuhui District", "Greater
      // London") do we upgrade to the best same-country Wikipedia city — matching
      // within the country avoids "Taipei Metro" being pulled to "New Taipei".
      const canon = city && wikiIdx.some((r) => countryOk(country, r.sys.country) &&
        normCity(r.sys.city) === normCity(city))
      if (!canon) {
        const b = bestWikiInCountry(network, netTag, country)
        if (b) city = b.city
      }
    }
    return { continent, country, city }
  }
  console.log(`  routes=${routesTags.size} masters=${masterTags.size} ` +
    `geom=${geom.size} stations=${stations.length} geocoded=${Object.keys(geocode).length}`)

  // ---- group route relations into lines ----
  const groupKey = (rid, t) => {
    if (masterOf.has(rid)) return `m|${masterOf.get(rid)}`
    const net = pick(t, 'network:en', 'network'), ref = t.ref
    if (net && ref) return `nr|${net}|${ref}`
    return `r|${rid}`
  }
  // Line geometry = the route's stops connected in relation-member order — we
  // deliberately do NOT use track (way) geometry. Prefer stop members; routes
  // mapped without stop roles fall back to platform nodes, then plain nodes.
  const stopXY = new Map()
  const groups = new Map()
  for (const [rid, t] of routesTags) {
    const key = groupKey(rid, t)
    let g = groups.get(key)
    if (!g) { g = { key, seqs: [], rids: [], stopNodes: new Set() }; groups.set(key, g) }
    g.rids.push(rid)
    const el = geom.get(rid)
    if (!el) continue
    const stops = [], platforms = [], plain = []
    for (const m of el.members || []) {
      if (m.type !== 'node') continue
      const coord = m.lat != null ? [m.lon, m.lat] : memberXY.get(m.ref)
      if (!coord) continue
      const role = m.role || ''
      const bucket = role.includes('stop') ? stops : role.includes('platform') ? platforms : plain
      bucket.push({ ref: m.ref, coord })
    }
    const seq = [stops, platforms, plain].find((b) => b.length >= 2)
    if (!seq) continue
    g.seqs.push(seq)
    for (const r of seq) { g.stopNodes.add(r.ref); stopXY.set(r.ref, r.coord) }
  }

  // A line's forward/backward variants share (nearly) all stops: keep the
  // longest sequence, then only variants adding >20% unseen stops (branches).
  // Coverage is keyed by ~100 m coordinate cells, not node ids — the two
  // directions usually use different stop_position nodes at the same station.
  const ckey = (r) => `${Math.round(r.coord[0] / 0.001)}:${Math.round(r.coord[1] / 0.001)}`
  const dedupeSeqs = (seqs) => {
    const sorted = [...seqs].sort((a, b) => b.length - a.length)
    const covered = new Set(), kept = []
    for (const seq of sorted) {
      const fresh = seq.filter((r) => !covered.has(ckey(r))).length
      if (kept.length && fresh / seq.length <= 0.2) continue
      kept.push(seq)
      for (const r of seq) covered.add(ckey(r))
    }
    return kept
  }

  const repTags = (g) => {
    const variants = g.rids.map((r) => routesTags.get(r))
    variants.sort((a, b) =>
      (Number(!!pick(b, 'colour')) - Number(!!pick(a, 'colour'))) ||
      (Number(!!pick(b, 'name:en', 'name')) - Number(!!pick(a, 'name:en', 'name'))))
    const base = { ...(variants[0] || {}) }
    if (g.key.startsWith('m|')) {
      const mt = masterTags.get(Number(g.key.slice(2))) || {}
      for (const [k, v] of Object.entries(mt)) if (v && !base[k]) base[k] = v
      for (const k of ['name', 'name:en', 'ref', 'colour']) if (mt[k]) base[k] = mt[k]
    }
    return base
  }

  // Resolve each network to a city bucket; networks sharing a city merge into
  // one file: systems/{continent}/{country}/{continent}-{country}-{city}.geojson
  const cityCache = new Map()
  const cityInfo = (network, netTag) => {
    if (cityCache.has(network)) return cityCache.get(network)
    const geo = geoFor(network, netTag)
    const cont = geo.continent || 'unknown'
    const countrySlug = slugify(geo.country) || 'unknown'
    const nameParts = [geo.continent, slugify(geo.country), slugify(geo.city)].filter(Boolean)
    const slug = nameParts.join('-') || slugify(network) || 'system'
    const info = { continent: geo.continent, country: geo.country, city: geo.city,
      key: `${cont}/${countrySlug}/${slug}` }
    cityCache.set(network, info)
    return info
  }
  const cityGroups = new Map()
  const groupFor = (info) => {
    let grp = cityGroups.get(info.key)
    if (!grp) {
      grp = { info, lines: [], stations: [], networks: new Set(),
        operator: null, official_url: null, wikipedia: null, wikidata: null }
      cityGroups.set(info.key, grp)
    }
    return grp
  }

  const nodeLineRefs = new Map()
  const lineFeatures = []
  const stationFeatures = []

  // Spatial index: grid cell -> cityKey, built from line vertices. Lets us assign
  // each station to the city of the nearest metro line — OSM stations often lack a
  // network tag (or carry a different one than their lines), so grouping stations
  // by tag alone strands them in a single "unknown" bucket.
  const CELL = 0.02  // ~2 km
  const grid = new Map()
  const cellKey = (lon, lat) => `${Math.round(lon / CELL)}:${Math.round(lat / CELL)}`

  for (const g of groups.values()) {
    const kept = dedupeSeqs(g.seqs)
    if (!kept.length) continue
    const t = repTags(g)
    const network = pick(t, 'network:en', 'network') || pick(t, 'operator') || 'Unknown'
    const info = cityInfo(network, t.network)
    const routeRef = t.ref || null
    const routeId = g.key.startsWith('m|') ? `rm${g.key.slice(2)}` : `r${Math.min(...g.rids)}`
    // Stations must always resolve to a line (verify invariant), so fall back
    // to the route name when the relation carries no ref.
    const lineTag = routeRef || pick(t, 'name:en', 'name') || routeId
    for (const n of g.stopNodes) {
      if (!nodeLineRefs.has(n)) nodeLineRefs.set(n, new Set())
      nodeLineRefs.get(n).add(lineTag)
    }
    const props = {
      route_id: routeId,
      route_name: pick(t, 'name:en', 'name') || routeRef || routeId,
      route_name_local: t.name || null,
      route_ref: routeRef,
      route_color: normColor(pick(t, 'colour')),
      network,
      network_local: t.network || null,
      operator: pick(t, 'operator'),
      city: info.city, country: info.country,
      wikidata: pick(t, 'wikidata', 'network:wikidata'),
      wikipedia: pick(t, 'wikipedia', 'network:wikipedia'),
      osm_route_ids: g.rids,
    }
    const feat = {
      type: 'Feature', properties: props,
      geometry: { type: 'MultiLineString',
        coordinates: kept.map((seq) => seq.map((r) => r.coord)) },
    }
    lineFeatures.push(feat)
    for (const seg of feat.geometry.coordinates)
      for (const [lon, lat] of seg) {
        const k = cellKey(lon, lat)
        if (!grid.has(k)) grid.set(k, info.key)
      }
    const grp = groupFor(info)
    grp.lines.push(feat)
    grp.networks.add(network)
    if (!grp.operator) grp.operator = pick(t, 'operator')
    if (!grp.official_url) grp.official_url = pick(t, 'website', 'operator:website')
    if (!grp.wikipedia) grp.wikipedia = pick(t, 'wikipedia', 'network:wikipedia')
    if (!grp.wikidata) grp.wikidata = pick(t, 'wikidata', 'network:wikidata')
  }

  // ---- stations: assign to the city of the nearest metro line (spatial) ----
  const gInfo = new Map([...cityGroups].map(([k, v]) => [k, v.info]))

  // Station→line membership: route stop members are usually stop_position
  // nodes, not the station node itself, so id matching alone strands stations
  // without lines. Fall back to the nearest stop within ~500 m.
  const stopGrid = new Map()
  for (const [nid, refs] of nodeLineRefs) {
    const c = stopXY.get(nid)
    if (!c) continue
    const k = cellKey(c[0], c[1])
    if (!stopGrid.has(k)) stopGrid.set(k, [])
    stopGrid.get(k).push({ lon: c[0], lat: c[1], refs })
  }
  const nearbyLineRefs = (lon, lat) => {
    const gx = Math.round(lon / CELL), gy = Math.round(lat / CELL)
    let best = null, bestD = Infinity
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      for (const p of stopGrid.get(`${gx + dx}:${gy + dy}`) || []) {
        const d = (p.lon - lon) ** 2 + (p.lat - lat) ** 2
        if (d < bestD) { bestD = d; best = p }
      }
    return best && Math.sqrt(bestD) < 0.005 ? [...best.refs] : []  // ~500 m
  }
  const nearestCityKey = (lon, lat) => {
    const gx = Math.round(lon / CELL), gy = Math.round(lat / CELL)
    for (let r = 0; r <= 12; r++) {  // out to ~24 km
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const ck = grid.get(`${gx + dx}:${gy + dy}`)
        if (ck) return ck
      }
    }
    return null
  }

  for (const s of stations) {
    const t = s.tags
    const network = pick(t, 'network:en', 'network') || pick(t, 'operator') || 'Unknown'
    const spatialKey = nearestCityKey(s.lon, s.lat)
    const info = (spatialKey && gInfo.get(spatialKey)) || cityInfo(network, t.network)
    let lines = [...(nodeLineRefs.get(s.id) || [])]
    if (!lines.length) lines = nearbyLineRefs(s.lon, s.lat)
    lines = [...new Set(lines)].sort()
    const props = {
      station_id: `n${s.id}`,
      station_name: pick(t, 'name:en', 'name') || `n${s.id}`,
      station_name_local: t.name || null,
      network,
      network_local: t.network || null,
      operator: pick(t, 'operator'),
      city: info.city,
      country: info.country,
      lines: lines.length ? lines : null,
      wikidata: pick(t, 'wikidata'),
    }
    const feat = {
      type: 'Feature', properties: props,
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    }
    stationFeatures.push(feat)
    groupFor(info).stations.push(feat)
    groupFor(info).networks.add(network)
  }

  await writeOutputs(lineFeatures, stationFeatures, cityGroups, wikiSystems)
}

const fc = (features, extra = {}) => ({ type: 'FeatureCollection', ...extra, features })

async function writeOutputs(lines, stations, cityGroups, wikiSystems) {
  await mkdir(SYS_DIR, { recursive: true })
  console.log(`\nWriting global layers: ${lines.length} lines, ${stations.length} stations`)
  await writeFile(join(BASE, 'metro_lines.geojson'), JSON.stringify(fc(lines)))
  await writeFile(join(BASE, 'metro_stations.geojson'), JSON.stringify(fc(stations)))

  const index = []
  const groups = [...cityGroups.values()].sort((a, b) => b.lines.length - a.lines.length)
  for (const grp of groups) {
    const { info } = grp
    const relPath = `${info.key}.geojson`
    const feats = [...grp.lines, ...grp.stations]
    const wp = grp.wikipedia
    let wikiUrl = null
    if (wp) {
      if (wp.startsWith('http')) wikiUrl = wp
      else if (wp.includes(':')) {
        const [lang, ...rest] = wp.split(':')
        wikiUrl = `https://${lang}.wikipedia.org/wiki/${rest.join(':').replace(/ /g, '_')}`
      }
    }
    const systemMeta = {
      continent: info.continent, country: info.country, city: info.city,
      osm_networks: [...grp.networks].sort(),
      operator: grp.operator,
      official_website: grp.official_url,
      official_map: wikiUrl,
      wikidata: grp.wikidata,
      line_count: grp.lines.length, station_count: grp.stations.length,
    }
    const outPath = join(SYS_DIR, relPath)
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, JSON.stringify(fc(feats, { metro_system: systemMeta })))
    index.push({ file: `systems/${relPath}`, ...systemMeta })
  }

  const matchedCities = new Set(index.map((i) => i.city).filter(Boolean))
  const missing = wikiSystems
    .filter((s) => !matchedCities.has(s.city))
    .map((s) => ({ city: s.city, country: s.country, name: s.name }))

  await writeFile(join(BASE, 'index.json'), JSON.stringify({
    generated_from: 'OpenStreetMap via Overpass API (route=subway, operational only; ' +
      'line geometry = stops connected in member order)',
    baseline: 'Wikipedia: List of metro systems',
    system_count: index.length,
    wikipedia_system_count: wikiSystems.length,
    line_total: lines.length,
    station_total: stations.length,
    systems: index,
    wikipedia_cities_without_match: missing,
  }, null, 2))

  console.log(`  ${index.length} systems written to ${SYS_DIR}`)
  console.log(`  matched ${matchedCities.size} cities; ${missing.length} wikipedia systems unmatched by city name`)
  console.log(`  index -> ${join(BASE, 'index.json')}`)
}

build().catch((e) => { console.error(e); process.exit(1) })
