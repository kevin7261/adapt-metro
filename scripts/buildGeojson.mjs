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
const OVERRIDES_DIR = join(BASE, '_overrides')

// City-binding overrides: data/metro/_overrides/*.json, each
//   { city, country, continent, osm_route_ids: [..], source?, note? }
// A route relation listed here is bucketed into that city, no questions asked.
// Written by scripts/auditLoop.mjs (machine) or by hand (human) — same format.
async function readOverrides() {
  const byRid = new Map()
  let files = []
  try { files = (await readdir(OVERRIDES_DIR)).filter((n) => n.endsWith('.json')) }
  catch { return byRid }
  for (const f of files) {
    try {
      const ov = JSON.parse(await readFile(join(OVERRIDES_DIR, f), 'utf8'))
      if (!ov.city || !Array.isArray(ov.osm_route_ids)) continue
      for (const rid of ov.osm_route_ids) if (!byRid.has(rid)) byRid.set(rid, ov)
    } catch (e) { console.log(`  !! bad override ${f}: ${e.message}`) }
  }
  return byRid
}

// Per-city audit verdicts (written by scripts/auditLoop.mjs) — embedded into
// each system's metro_system.audit so the UI can show pass/fail + reasons.
async function readAuditState() {
  try { return JSON.parse(await readFile(join(CACHE, 'audit_state.json'), 'utf8')) }
  catch { return {} }
}

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
// stations sometimes mark construction only in the name — "大明北路(建设中)"
const NONOP_NAME = /[（(【[][^）)】\]]*(建設中|建设中|在建|未开通|未開通|規劃|规划|under construction|planned|u\/c)[^）)】\]]*[）)】\]]/i
const isOperational = (t = {}) =>
  !NONOP.test(t.state || '') && !NONOP.test(t.railway || '') &&
  !('construction' in t) && !('proposed' in t) && !('planned' in t) &&
  !('disused' in t) && !('abandoned' in t) &&
  !NONOP_NAME.test(t.name || '') && !NONOP_NAME.test(t['name:en'] || '')

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
  const cacheFiles = await readdir(CACHE)
  const routesRaw = await readJSON('routes_tags.json')
  const routesTags = new Map()
  for (const e of routesRaw.elements)
    if (e.type === 'relation' && isOperational(e.tags)) routesTags.set(e.id, e.tags || {})
  // gap supplements: extra route relations fetched per-city by auditLoop.mjs
  for (const f of cacheFiles.filter((n) => /^gap_routes_.+\.json$/.test(n))) {
    const d = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    for (const e of d.elements || [])
      if (e.type === 'relation' && isOperational(e.tags) && !routesTags.has(e.id))
        routesTags.set(e.id, e.tags || {})
  }
  const ovByRid = await readOverrides()

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
  for (const f of cacheFiles.filter((n) =>
    /^(geom_.+|gap_geom_.+)\.json$/.test(n) && !n.endsWith('.partial'))) {
    const d = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    for (const e of d.elements || []) {
      if (e.type === 'relation') geom.set(e.id, e)
      else if (e.type === 'node' && e.lat != null) memberXY.set(e.id, [e.lon, e.lat])
    }
  }

  const stRaw = await readJSON('stations.json')
  const stations = []
  const seenStation = new Set()
  const pushStation = (e) => {
    if (!isOperational(e.tags)) return
    let lon, lat
    if (e.type === 'node') { lon = e.lon; lat = e.lat }
    else { lon = e.center?.lon; lat = e.center?.lat }
    if (lon == null || lat == null) return
    const key = `${e.type}/${e.id}`
    if (seenStation.has(key)) return
    seenStation.add(key)
    stations.push({ id: e.id, lon, lat, tags: e.tags || {} })
  }
  for (const e of stRaw.elements) pushStation(e)
  // gap supplements: extra stations fetched per-city by auditLoop.mjs
  for (const f of cacheFiles.filter((n) => /^gap_stations_.+\.json$/.test(n))) {
    const d = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    for (const e of d.elements || []) pushStation(e)
  }

  const wikiSystems = await readJSON('wiki_metro_systems.json')
  const wikiIdx = wikiSystems.map((s) => ({
    sys: s, nameTok: tokens(s.name), cityTok: tokens(s.city),
  }))
  const geocode = await readGeocode()
  let wikiXY = {}
  try { wikiXY = JSON.parse(await readFile(join(CACHE, 'wiki_city_coords.json'), 'utf8')) }
  catch { /* optional; rebucket-by-distance is skipped without it */ }
  // Resolve continent/country/city for a network: prefer reverse-geocode
  // (coordinate-truthful), fall back to the Wikipedia name match.
  // Known country-name variants (reverse-geocode vs Wikipedia wording).
  const COUNTRY_ALIAS = {
    czechia: 'czechrepublic',
    turkiye: 'turkey',
    unitedstatesofamerica: 'unitedstates',
    republicofkorea: 'southkorea',
    russianfederation: 'russia',
    myanmarburma: 'myanmar',
  }
  const normCountry = (s) => {
    const n = (s || '').toLowerCase().replace(/[^a-z]/g, '')
    return COUNTRY_ALIAS[n] ?? n
  }
  const countryOk = (a, b) => {
    if (!a || !b) return false
    const na = normCountry(a), nb = normCountry(b)
    return na === nb || na.includes(nb) || nb.includes(na)
  }
  const normCity = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '')
  // word-boundary form: " xiancun subdistrict " must NOT match "Xi'an",
  // while " suzhou industrial park " must match "Suzhou"
  const cityWords = (s) => {
    const w = (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    return w ? ` ${w} ` : ''
  }
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
  const geoFor = (network, netTag, own) => {
    // Prefer the routes' own network key (most specific), then the display
    // network (may come from a route_master), then the local network name.
    const g = geocode[own] || geocode[network] || geocode[netTag] || {}
    // continent + country come ONLY from coordinate reverse-geocoding (authoritative).
    const continent = g.continent || null
    const country = g.country || null
    let city = g.city || null
    if (country) {
      // Pick the canonical Wikipedia city for this country, trying every
      // geocoded admin level ("Yinzhou District" alone hides "Ningbo"):
      //   1. a candidate that IS a wiki city of this country (exact),
      //   2. a candidate containing / contained by one ("Stockholm Municipality"
      //      ⊃ "Stockholm"; longest wiki name wins so "New Taipei" beats "Taipei"),
      //   3. network-name token match — same-country only, so "Taipei Metro"
      //      can't be pulled to "New Taipei".
      const candList = [...new Set([g.city, ...(g.city_candidates || [])])].filter(Boolean)
      const candsExact = candList.map(normCity)
      const candsWords = candList.map(cityWords).filter(Boolean)
      const inCountry = wikiIdx.filter((r) => countryOk(country, r.sys.country))
      const exact = inCountry.find((r) => candsExact.includes(normCity(r.sys.city)))
      const within = exact || inCountry
        .filter((r) => {
          const b = cityWords(r.sys.city)
          return b && candsWords.some((c) => c.includes(b) || b.includes(c))
        })
        .sort((a, b) => normCity(b.sys.city).length - normCity(a.sys.city).length)[0]
      if (within) city = within.sys.city
      else {
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
    // the routes' own operator/network, before master fill-in — city resolution
    // prefers it so e.g. Incheon's lines (operator 인천교통공사, but network:en
    // "Seoul Metropolitan Subway") aren't pulled into Seoul
    base.__own = pick(base, 'operator') || pick(base, 'network:en', 'network')
    if (g.key.startsWith('m|')) {
      const mt = masterTags.get(Number(g.key.slice(2))) || {}
      for (const [k, v] of Object.entries(mt)) if (v && !base[k]) base[k] = v
      for (const k of ['name', 'name:en', 'ref', 'colour']) if (mt[k]) base[k] = mt[k]
    }
    return base
  }

  // Resolve each network to a city bucket; networks sharing a city merge into
  // one file: systems/{continent}/{country}/{continent}-{country}-{city}.geojson
  const mkInfo = (geo, fallbackName) => {
    const cont = geo.continent || 'unknown'
    const countrySlug = slugify(geo.country) || 'unknown'
    const nameParts = [geo.continent, slugify(geo.country), slugify(geo.city)].filter(Boolean)
    const slug = nameParts.join('-') || slugify(fallbackName) || 'system'
    return { continent: geo.continent, country: geo.country, city: geo.city,
      key: `${cont}/${countrySlug}/${slug}` }
  }
  const cityCache = new Map()
  const cityInfo = (network, netTag, own) => {
    const ck = `${network}|${own || ''}`
    if (cityCache.has(ck)) return cityCache.get(ck)
    const info = mkInfo(geoFor(network, netTag, own), network)
    cityCache.set(ck, info)
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

  const kmDist = (aLat, aLon, bLat, bLon) => {
    const dx = (aLon - bLon) * Math.cos(((aLat + bLat) / 2) * Math.PI / 180)
    return Math.sqrt(dx * dx + (aLat - bLat) ** 2) * 111
  }
  const wikiRowXY = (sys) => wikiXY[`${sys.city}|${sys.country}`] || null
  const nearestWiki = (lat, lon, country) => {
    let best = null, bestKm = Infinity
    for (const row of wikiIdx) {
      if (country && !countryOk(country, row.sys.country)) continue
      const xy = wikiRowXY(row.sys)
      if (!xy) continue
      const km = kmDist(lat, lon, xy.lat, xy.lon)
      if (km < bestKm) { bestKm = km; best = row.sys }
    }
    return best ? { sys: best, km: bestKm } : null
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

  const pinnedKeys = new Set()
  for (const g of groups.values()) {
    const kept = dedupeSeqs(g.seqs)
    if (!kept.length) continue
    const t = repTags(g)
    const network = pick(t, 'network:en', 'network') || pick(t, 'operator') || 'Unknown'
    // Override wins outright: bind these relations to the specified city and
    // pin the bucket (no sanity-check drift, no rebucketing).
    const ov = g.rids.map((r) => ovByRid.get(r)).find(Boolean)
    let info = ov
      ? mkInfo({ continent: ov.continent, country: ov.country, city: ov.city }, ov.city)
      : cityInfo(network, t.network, t.__own)
    if (ov) pinnedKeys.add(info.key)
    // 座標為準 sanity check: tags can point at the wrong system city — Pune's
    // lines are operated by Nagpur-shared MahaMetro, Incheon's are tagged as
    // the Seoul network. If the resolved city sits far from the line while a
    // same-country wiki city is at least twice as close, the line lives there.
    if (!ov) {
      let sx = 0, sy = 0, n = 0
      for (const seq of kept) for (const r of seq) { sx += r.coord[0]; sy += r.coord[1]; n++ }
      if (n) {
        const clat = sy / n, clon = sx / n
        const own = wikiIdx.find((r) => countryOk(info.country || '', r.sys.country) &&
          normCity(r.sys.city) === normCity(info.city || ''))
        const ownXY = own && wikiRowXY(own.sys)
        const near = nearestWiki(clat, clon, info.country || null)
        if (ownXY && near && near.km < 30) {
          const ownKm = kmDist(clat, clon, ownXY.lat, ownXY.lon)
          if (ownKm > 20 && near.km * 2 < ownKm &&
              normCity(near.sys.city) !== normCity(info.city))
            info = mkInfo({ continent: info.continent, country: info.country,
              city: near.sys.city }, near.sys.city)
        }
      }
    }
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
    // ~900 m: station nodes can sit well away from the line's stop_position
    // nodes (big interchanges, entrance-tagged stations)
    return best && Math.sqrt(bestD) < 0.008 ? [...best.refs] : []
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

  // ---- rebucket: groups whose city never resolved to a Wikipedia city ----
  // 1st chance: a member network resolves (station tags often carry the English
  //   name the routes lack — "Ningbo Rail Transit" on 宁波轨道交通 lines).
  // 2nd chance: the group's centroid sits next to a forward-geocoded wiki city
  //   (language-independent — 济南 buckets as "Lixia District" but IS Jinan).
  const isCanon = (info) => !!info.city && wikiIdx.some((r) =>
    countryOk(info.country || '', r.sys.country) && normCity(r.sys.city) === normCity(info.city))
  const groupCentroid = (grp) => {
    let sx = 0, sy = 0, n = 0
    for (const f of grp.lines) for (const seg of f.geometry.coordinates)
      for (const [lon, lat] of seg) { sx += lon; sy += lat; n++ }
    for (const f of grp.stations) {
      sx += f.geometry.coordinates[0]; sy += f.geometry.coordinates[1]; n++
    }
    return n ? { lon: sx / n, lat: sy / n } : null
  }
  const nearestWikiCity = (grp) => {
    const c = groupCentroid(grp)
    if (!c) return null
    const near = nearestWiki(c.lat, c.lon, null)
    if (!near) return null
    // same country within 30 km; cross-country only when unambiguous (<15 km,
    // e.g. Macau is listed under China but reverse-geocodes as Macao)
    const sameCountry = countryOk(grp.info.country || '', near.sys.country)
    return (near.km < 30 && sameCountry) || near.km < 15 ? near.sys : null
  }
  const rebucket = (grp, key, alt) => {
    for (const f of [...grp.lines, ...grp.stations]) {
      f.properties.city = alt.city
      f.properties.country = alt.country
    }
    const tgt = groupFor(alt)
    tgt.lines.push(...grp.lines)
    tgt.stations.push(...grp.stations)
    for (const n of grp.networks) tgt.networks.add(n)
    tgt.operator = tgt.operator || grp.operator
    tgt.official_url = tgt.official_url || grp.official_url
    tgt.wikipedia = tgt.wikipedia || grp.wikipedia
    tgt.wikidata = tgt.wikidata || grp.wikidata
    cityGroups.delete(key)
  }
  for (const [key, grp] of [...cityGroups]) {
    if (pinnedKeys.has(key)) continue  // override-bound buckets never move
    if (isCanon(grp.info)) continue
    let alt = null
    for (const net of grp.networks) {
      if (net === 'Unknown') continue
      const c = cityInfo(net, null, null)
      if (isCanon(c) && c.key !== key) { alt = c; break }
    }
    if (!alt) {
      const w = nearestWikiCity(grp)
      if (w) {
        const cand = mkInfo({ continent: grp.info.continent,
          country: grp.info.country || w.country, city: w.city }, w.city)
        if (cand.key !== key) alt = cand
      }
    }
    if (alt) rebucket(grp, key, alt)
  }

  // ---- merge same-named stations within a city (shared point, mean coords) ----
  // OSM often carries one station node per line at an interchange; the map wants
  // a single shared point. Same normalized name within a city merges to the
  // average coordinate — with an ~800 m guard so distinct stations that happen
  // to share a name stay separate. Unnamed stations (synthetic n123) never merge.
  const normName = (s) => (s || '').normalize('NFKD').toLowerCase().replace(/\s+/g, ' ').trim()
  let mergedAway = 0
  for (const grp of cityGroups.values()) {
    const keep = []
    const byName = new Map()
    for (const f of grp.stations) {
      const key = normName(f.properties.station_name)
      if (!key || /^n\d+$/.test(key)) { keep.push(f); continue }
      if (!byName.has(key)) byName.set(key, [])
      byName.get(key).push(f)
    }
    for (const feats of byName.values()) {
      // greedy spatial clustering within the same name (~800 m)
      const clusters = []
      for (const f of feats) {
        const [lon, lat] = f.geometry.coordinates
        let c = clusters.find((c) =>
          Math.abs(c.lat - lat) < 0.0072 &&
          Math.abs((c.lon - lon) * Math.cos((lat * Math.PI) / 180)) < 0.0072)
        if (!c) { c = { members: [], lon, lat }; clusters.push(c) }
        c.members.push(f)
        c.lon = c.members.reduce((s, m) => s + m.geometry.coordinates[0], 0) / c.members.length
        c.lat = c.members.reduce((s, m) => s + m.geometry.coordinates[1], 0) / c.members.length
      }
      for (const c of clusters) {
        if (c.members.length === 1) { keep.push(c.members[0]); continue }
        mergedAway += c.members.length - 1
        const first = c.members[0]
        const lines = [...new Set(c.members.flatMap((m) => m.properties.lines || []))].sort()
        keep.push({
          type: 'Feature',
          properties: {
            ...first.properties,
            lines: lines.length ? lines : null,
            merged_from: c.members.length,
          },
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        })
      }
    }
    grp.stations = keep
  }
  // ---- drop stations that serve no operational line (invariant 2) ----
  // A station the widened matching still can't tie to any line is either a
  // station of an excluded (under-construction / out-of-scope) route or noise;
  // "operational" means served by an operational route, so it doesn't ship.
  let orphansDropped = 0
  for (const grp of cityGroups.values()) {
    const before = grp.stations.length
    grp.stations = grp.stations.filter((f) => (f.properties.lines || []).length)
    orphansDropped += before - grp.stations.length
  }
  // prune buckets left with neither lines nor stations (stray station nodes of
  // out-of-scope modes — e.g. tram-based Stadtbahn — end up here after the
  // orphan drop; they are not systems)
  let pruned = 0
  for (const [key, grp] of [...cityGroups]) {
    if (!grp.lines.length && !grp.stations.length) { cityGroups.delete(key); pruned++ }
  }
  // rebuild the global station layer from the merged per-city stations
  stationFeatures.length = 0
  for (const grp of cityGroups.values()) stationFeatures.push(...grp.stations)
  console.log(`  merged ${mergedAway} duplicate same-named station points; ` +
    `dropped ${orphansDropped} stations with no operational line; ` +
    `pruned ${pruned} empty buckets`)

  await writeOutputs(lineFeatures, stationFeatures, cityGroups, wikiSystems)
}

const fc = (features, extra = {}) => ({ type: 'FeatureCollection', ...extra, features })

async function writeOutputs(lines, stations, cityGroups, wikiSystems) {
  await mkdir(SYS_DIR, { recursive: true })
  const auditState = await readAuditState()
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
    const audit = auditState[`${info.city}|${info.country}`] ?? null
    const systemMeta = {
      continent: info.continent, country: info.country, city: info.city,
      osm_networks: [...grp.networks].sort(),
      operator: grp.operator,
      official_website: grp.official_url,
      official_map: wikiUrl,
      wikidata: grp.wikidata,
      line_count: grp.lines.length, station_count: grp.stations.length,
      // per-city audit verdict (scripts/auditLoop.mjs): passed / reasons / checks
      audit,
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
    generated_from: 'OpenStreetMap via Overpass API (route=subway|light_rail, operational only; ' +
      'line geometry = stops connected in member order; same-named stations merged)',
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
