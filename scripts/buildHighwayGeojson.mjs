// Assemble the motorway networks fetched by fetchHighways.mjs into GeoJSON that
// mirrors the metro schema (see skill highway-osm-fetch), so the same D3 /
// MapLibre renderers and the schematic pipeline consume it unchanged:
//
//   交流道 (highway=motorway_junction)     ≙ metro station  (Point feature)
//   編號高速公路 (highway=motorway, by ref) ≙ metro line     (one feature per ref)
//   交流道依序以直線相接                    ≙ 線壓站點        (segment geometry)
//
// ONE geojson per country (使用者: 台灣只要一個 geojson). Continent/country come
// from the metro anchor cached with each fetch — no geocoding. Each 國道 (ref)
// is a SINGLE continuous line through its interchanges, ordered along the road
// (nearest-neighbour open path + 2-opt), drawn as STRAIGHT interchange-to-
// interchange lines (real road shape used only to find interchanges, never
// drawn). Output → data/highway/{systems,index.json,*.geojson}.
//
//   node scripts/buildHighwayGeojson.mjs
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const HIGHWAY = join(ROOT, 'data', 'highway')
const CACHE = join(HIGHWAY, '_cache')
const METRO = join(ROOT, 'data', 'metro')
const MAX_EDGE_M = 30000 // drop adjacency edges longer than this (fake/huge bridge)

// 中文 labels from the metro data (cityNamesZh.json keyed by city slug carries a
// Chinese country + city name), so highway layers show 中文＋English like metro.
// Returns { countryZh: {English country → 中文}, citySlug: {slug → {country,city}} }.
async function zhMaps() {
  const countryZh = {}
  let citySlug = {}
  try {
    const idx = JSON.parse(await readFile(join(METRO, 'index.json'), 'utf8'))
    citySlug = JSON.parse(await readFile(join(ROOT, 'src', 'stores', 'cityNamesZh.json'), 'utf8'))
    for (const s of idx.systems) {
      const slug = s.file.split('/').pop().replace(/\.geojson$/, '')
      if (s.country && citySlug[slug]?.country) countryZh[s.country] = citySlug[slug].country
    }
  } catch { /* labels fall back to English */ }
  return { countryZh, citySlug }
}

// Colour by ROAD LEVEL, not per route (使用者: 同一層同同色, 可參考該國路標選色).
// motorway (國道/Interstate/Autobahn) vs expressway (封閉式快速公路) each get one
// colour, keyed to the country's road-sign scheme where known.
const SIGN_COLORS = {
  Taiwan: { motorway: '#12489b', expressway: '#1f8a4c' },          // 國道藍盾、快速公路綠盾
  Japan: { motorway: '#1f8a4c', expressway: '#1666b0' },           // 高速道路綠、都市高速藍
  China: { motorway: '#12489b', expressway: '#1f8a4c' },           // 国道/高速綠…→用藍/綠對比
  'South Korea': { motorway: '#1f8a4c', expressway: '#1666b0' },   // 고속도로 녹색
  'United States': { motorway: '#0b3d91', expressway: '#1f8a4c' }, // Interstate 藍盾
  Canada: { motorway: '#0b3d91', expressway: '#1f8a4c' },
  Germany: { motorway: '#0061a8', expressway: '#e0a800' },         // Autobahn 藍、Bundesstraße 黃
  'United Kingdom': { motorway: '#0b6cb0', expressway: '#1f8a4c' }, // 藍底 motorway sign
  France: { motorway: '#c0392b', expressway: '#1666b0' },          // autoroute 紅
  Australia: { motorway: '#0b7a3b', expressway: '#12489b' },
  default: { motorway: '#12489b', expressway: '#1f8a4c' },
}
function classColor(country, cls) {
  const t = SIGN_COLORS[country] || SIGN_COLORS.default
  return t[cls] || SIGN_COLORS.default[cls]
}

const key = (x, y) => `${x.toFixed(7)},${y.toFixed(7)}`
function haversine(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0])
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

const isCJK = (c) => /Taiwan|China|Hong Kong|Macau/i.test(c)
const isJP = (c) => /Japan/i.test(c)
function nameFor(tags, country) {
  if (!tags) return null
  const zh = tags['name:zh'] || tags['name:zh-Hant'] || tags['name:zh-Hans']
  if (isCJK(country)) return zh || tags.name || tags['name:en'] || null
  if (isJP(country)) return tags['name:ja'] || tags.name || null
  return tags['name:en'] || tags.name || zh || null
}
function refLabel(tags, country) {
  const zh = tags['ref:zh'], en = tags['ref:en'], ja = tags['ref:ja']
  const fallback = `Motorway ${tags.ref}`
  if (isCJK(country)) return zh || en || nameFor(tags, country) || fallback
  if (isJP(country)) return ja || en || zh || fallback
  return en || zh || nameFor(tags, country) || fallback
}

// Chain a ref's motorway ways into maximal polylines by shared endpoints (used
// only to discover which interchanges belong to the ref, not for drawing).
function buildPolylines(ways) {
  const segs = ways.map((w) => (w.geometry || []).map((g) => [g.lon, g.lat]))
    .filter((s) => s.length >= 2)
  const endMap = new Map()
  const push = (k, i) => { if (!endMap.has(k)) endMap.set(k, []); endMap.get(k).push(i) }
  segs.forEach((s, i) => { push(key(...s[0]), i); push(key(...s[s.length - 1]), i) })
  const used = new Array(segs.length).fill(false)
  const polylines = []
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = true
    let poly = segs[i].slice()
    for (const dir of ['tail', 'head']) {
      let grew = true
      while (grew) {
        grew = false
        const anchor = dir === 'tail' ? poly[poly.length - 1] : poly[0]
        const ak = key(...anchor)
        for (const j of endMap.get(ak) || []) {
          if (used[j]) continue
          const s = segs[j]
          const headMatch = key(...s[0]) === ak
          const tailMatch = key(...s[s.length - 1]) === ak
          if (!headMatch && !tailMatch) continue
          const ordered = headMatch ? s : s.slice().reverse()
          if (dir === 'tail') poly = poly.concat(ordered.slice(1))
          else poly = ordered.slice().reverse().slice(0, -1).concat(poly)
          used[j] = true; grew = true; break
        }
      }
    }
    polylines.push(poly)
  }
  return polylines
}


// ---- per-system assembly (a system = a country, or a metro area for big ones)
function buildSystem(raw, { countryZh, cityZh } = {}) {
  const { continent, country } = raw
  const slug = raw.slug || raw.cc
  const city = raw.city || country      // country name (country-unit) or metro city
  countryZh = countryZh ?? country
  cityZh = cityZh ?? city
  const ways = raw.elements.filter((e) => e.type === 'way' && e.tags?.ref)
  const junctions = raw.elements.filter((e) => e.type === 'node' && e.tags?.highway === 'motorway_junction')

  const byRef = new Map()
  for (const w of ways) {
    const r = w.tags.ref
    if (!byRef.has(r)) byRef.set(r, [])
    byRef.get(r).push(w)
  }

  // Merge junction nodes into ONE interchange point (使用者: 同一個交流道只能有
  // 一個點在中間；單一路線只能一條線). The many carriageway / on-off-ramp / A-B
  // sub-nodes of one interchange must all collapse, else they draw as multiple
  // points and parallel duplicate lines. Merge two junctions if:
  //   · same interchange NAME within 2.5 km (named interchanges: NB/SB/系統), or
  //   · same EXIT-NUMBER BASE within 2 km — US exits 36/36A/36B (letters/suffix
  //     stripped → "36") are the SAME interchange but are usually unnamed, or
  //   · simply within 250 m (unnamed carriageway pairs / dense ramp clusters).
  const norm = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  const exitBase = (t) => { const m = String(t?.ref ?? '').match(/\d+/); return m ? m[0] : null }
  const parent = junctions.map((_, i) => i)
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a }
  const union = (a, b) => { parent[find(a)] = find(b) }
  const named = junctions.map((j) => ({ name: nameFor(j.tags, country), base: exitBase(j.tags), lon: j.lon, lat: j.lat }))
  for (let i = 0; i < junctions.length; i++) {
    for (let k = i + 1; k < junctions.length; k++) {
      const dd = haversine([named[i].lon, named[i].lat], [named[k].lon, named[k].lat])
      const sameName = named[i].name && named[k].name && norm(named[i].name) === norm(named[k].name)
      const sameBase = named[i].base && named[i].base === named[k].base
      if ((sameName && dd < 2500) || (sameBase && dd < 2000) || dd < 250) union(i, k)
    }
  }
  const ic = new Map()
  junctions.forEach((j, i) => {
    const r = find(i)
    if (!ic.has(r)) ic.set(r, { members: [], names: new Map(), lons: [], lats: [], exitRefs: new Set(), wikidata: null, wikipedia: null })
    const e = ic.get(r)
    e.members.push(i); e.lons.push(j.lon); e.lats.push(j.lat)
    const nm = nameFor(j.tags, country)
    if (nm) e.names.set(norm(nm), nm)
    if (j.tags.ref) e.exitRefs.add(j.tags.ref)
    if (j.tags.wikidata && !e.wikidata) e.wikidata = j.tags.wikidata
    if (j.tags.wikipedia && !e.wikipedia) e.wikipedia = j.tags.wikipedia
  })
  const jIdxToIc = new Map()
  for (const [, e] of ic) {
    e.lon = e.lons.reduce((a, b) => a + b, 0) / e.lons.length
    e.lat = e.lats.reduce((a, b) => a + b, 0) / e.lats.length
    e.id = `n${Math.min(...e.members.map((i) => junctions[i].id))}`
    e.name = [...e.names.values()][0] || `交流道 ${[...e.exitRefs][0] ?? ''}`.trim() || e.id
    for (const i of e.members) jIdxToIc.set(i, find(i))
  }
  const coordToJ = new Map()
  junctions.forEach((j, i) => coordToJ.set(key(j.lon, j.lat), i))

  // per ref: build ROAD ADJACENCY — two interchanges are connected only if they
  // sit next to each other on some carriageway (consecutive vertices, nothing
  // between). We draw ONLY these adjacencies, so a 國道 is one continuous line
  // where the road is continuous and simply BREAKS at a real gap — never a long
  // straight line bridging interchanges that aren't actually connected.
  const ekey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const icDist = (a, b) => { const ea = ic.get(a), eb = ic.get(b); return haversine([ea.lon, ea.lat], [eb.lon, eb.lat]) }
  // De-triangulate a ref's edge set: while any triangle A-B-C exists (all three
  // edges present), drop its LONGEST edge — the "shortcut" that skips the middle
  // interchange. Kills parallel same-ref-road shortcuts (國道1號 mainline vs its
  // elevated) and thin near-duplicate-interchange triangles, keeping the network
  // connected (the two shorter edges still join all three).
  const deTriangulate = (edges) => {
    const present = new Set(edges.map(([a, b]) => ekey(a, b)))
    const adj = new Map()
    const addA = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b) }
    for (const [a, b] of edges) { addA(a, b); addA(b, a) }
    let changed = true
    while (changed) {
      changed = false
      for (const a of adj.keys()) {
        for (const b of adj.get(a)) {
          if (b < a) continue
          for (const c of adj.get(b)) {
            if (c < b || !adj.get(a).has(c)) continue
            const [x, y] = [[a, b], [b, c], [a, c]].sort((p, q) => icDist(...q) - icDist(...p))[0]
            adj.get(x).delete(y); adj.get(y).delete(x); present.delete(ekey(x, y))
            changed = true; break
          }
          if (changed) break
        }
        if (changed) break
      }
    }
    return edges.filter(([a, b]) => present.has(ekey(a, b)))
  }

  const refEdges = new Map()  // ref → [[rootA, rootB] …] (road-adjacent, de-triangulated)
  const refAdj = new Map()    // ref → Map(root → Set(root))
  const neigh = new Map(), icRefs = new Map()
  const addRef = (root, ref) => { if (!icRefs.has(root)) icRefs.set(root, new Set()); icRefs.get(root).add(ref) }
  const link = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); if (!m.has(b)) m.set(b, new Set()); m.get(a).add(b); m.get(b).add(a) }
  for (const [ref, refWays] of byRef) {
    const seen = new Set(); let edges = []
    for (const poly of buildPolylines(refWays)) {
      const hits = []
      for (const v of poly) {
        const jIdx = coordToJ.get(key(v[0], v[1]))
        if (jIdx !== undefined && jIdxToIc.has(jIdx)) hits.push(jIdxToIc.get(jIdx))
      }
      const seq = hits.filter((r, n) => n === 0 || r !== hits[n - 1]) // drop repeats
      for (let n = 0; n + 1 < seq.length; n++) {
        const a = seq[n], b = seq[n + 1]
        if (a === b) continue
        // Cap edge length: two "adjacent" interchanges >30 km apart (sparse outer
        // expressway stretch, or missing intermediate interchanges) would draw a
        // city-spanning straight line — break the road there instead.
        if (icDist(a, b) > MAX_EDGE_M) continue
        const k = ekey(a, b)
        if (!seen.has(k)) { seen.add(k); edges.push([a, b]) }
      }
    }
    refEdges.set(ref, deTriangulate(edges)) // per-road de-triangulation
  }

  // GLOBAL de-triangulation across ALL roads — catches cross-road triangles
  // (concurrent routes, express-vs-local variants) the per-road pass misses.
  {
    const owners = new Map(), adj = new Map()
    const addA = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b) }
    for (const [ref, edges] of refEdges) for (const [a, b] of edges) {
      const k = ekey(a, b)
      if (!owners.has(k)) { owners.set(k, new Set()); addA(a, b); addA(b, a) }
      owners.get(k).add(ref)
    }
    let changed = true
    while (changed) {
      changed = false
      for (const a of adj.keys()) {
        for (const b of adj.get(a)) {
          if (b < a) continue
          for (const c of adj.get(b)) {
            if (c < b || !adj.get(a).has(c)) continue
            const [x, y] = [[a, b], [b, c], [a, c]].sort((p, q) => icDist(...q) - icDist(...p))[0]
            adj.get(x).delete(y); adj.get(y).delete(x)
            const k = ekey(x, y)
            for (const ref of owners.get(k) || []) refEdges.set(ref, refEdges.get(ref).filter(([p, q]) => ekey(p, q) !== k))
            owners.delete(k); changed = true; break
          }
          if (changed) break
        }
        if (changed) break
      }
    }
  }

  // build adjacency / neighbour graph from the FINAL (de-triangulated) edges
  for (const [ref, edges] of refEdges) {
    const adj = new Map()
    for (const [a, b] of edges) { link(adj, a, b); link(neigh, a, b); addRef(a, ref); addRef(b, ref) }
    refAdj.set(ref, adj)
  }

  // Ordered interchange sequence per ref (for route.stations / the Object tab):
  // walk each connected component of the adjacency graph from an endpoint.
  const orderByAdj = (adj) => {
    const visited = new Set(), out = []
    for (const start of adj.keys()) {
      if (visited.has(start)) continue
      const comp = []
      const stack = [start], seen = new Set([start])
      while (stack.length) { const n = stack.pop(); comp.push(n); for (const m of adj.get(n) || []) if (!seen.has(m)) { seen.add(m); stack.push(m) } }
      const endpoint = comp.find((n) => (adj.get(n)?.size ?? 0) === 1) ?? comp[0]
      let cur = endpoint
      const used = new Set()
      while (cur !== undefined && !used.has(cur)) {
        used.add(cur); visited.add(cur); out.push(cur)
        cur = [...(adj.get(cur) || [])].find((m) => !used.has(m))
      }
      for (const n of comp) if (!used.has(n)) { used.add(n); visited.add(n); out.push(n) }
    }
    return out
  }
  const refStations = new Map()
  for (const [ref, adj] of refAdj) refStations.set(ref, orderByAdj(adj))

  const refTags = new Map()
  const refClass = new Map() // ref → 'motorway' | 'expressway'
  for (const [ref, refWays] of byRef) {
    refTags.set(ref, refWays.slice().sort((x, y) => Object.keys(y.tags).length - Object.keys(x.tags).length)[0].tags)
    refClass.set(ref, refWays.some((w) => w.tags.highway === 'motorway') ? 'motorway' : 'expressway')
  }
  const routeMeta = (ref) => {
    const t = refTags.get(ref)
    const cls = refClass.get(ref)
    return {
      route_id: `hw-${slug}-${ref}`,
      route_name: refLabel(t, country),
      route_name_local: t['ref:zh'] || t['name:zh'] || t.name || refLabel(t, country),
      route_ref: ref,
      route_color: classColor(country, cls), // colour by road level, not per route
      road_class: cls,                        // 'motorway' | 'expressway'
      network: t.network || `${country} ${cls === 'motorway' ? 'Motorways' : 'Expressways'}`,
      network_local: t['network:zh'] || null,
      operator: t.operator || null,
      wikidata: t.wikidata || null,
      wikipedia: t.wikipedia || null,
      status: null,
      order_suspect: 0,
    }
  }
  // 里程（mileage）: exit numbers on motorways are milepost-based (Taiwan 交流道
  // 編號＝公里數, US exit numbers＝mile), so parse the numeric part of the exit
  // ref. null when the interchange has no numeric ref.
  const mileageOf = (e) => {
    for (const r of e.exitRefs) { const m = String(r).match(/\d+(\.\d+)?/); if (m) return Number(m[0]) }
    return null
  }
  const refStationList = (ref) => (refStations.get(ref) || []).map((root) => {
    const e = ic.get(root)
    return { station_id: e.id, station_name: e.name, mileage: mileageOf(e) }
  })

  const features = []
  const usedIc = new Set()
  for (const seq of refStations.values()) for (const root of seq) usedIc.add(root)
  for (const root of usedIc) {
    const e = ic.get(root)
    const refs = [...(icRefs.get(root) || [])].sort()
    const degree = neigh.get(root)?.size ?? 0
    const isInter = refs.length >= 2 || degree > 2
    const isTerm = degree === 1
    features.push({
      type: 'Feature',
      properties: {
        station_id: e.id, station_name: e.name, station_name_local: e.name,
        network: `${country} Motorways`, network_local: null, operator: null,
        city, country,
        lines: refs.map((r) => routeMeta(r).route_name),
        line_ids: refs.map((r) => `hw-${slug}-${r}`),
        line_names: refs.map((r) => routeMeta(r).route_name),
        exit_refs: [...e.exitRefs].sort(),
        mileage: mileageOf(e),
        station_role: isInter ? 'interchange' : (isTerm ? 'terminus' : 'normal'),
        station_degree: degree, is_interchange: isInter, is_terminus: isTerm,
        merged_from: e.members.length,
        merged_names: e.names.size > 1 ? [...e.names.values()] : null,
        wikidata: e.wikidata, wikipedia: e.wikipedia,
      },
      geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
    })
  }
  // ONE segment feature per UNIQUE interchange-pair edge (global dedup across
  // roads, like metro path-segmentation): a corridor shared by concurrent roads
  // is drawn ONCE, not once per road. Each segment = a straight 2-point line
  // between the two merged interchange dots; a road's full path = every segment
  // whose `routes` include it (same class colour → reads as one continuous line).
  const globalEdges = new Map()
  for (const [ref, edges] of refEdges) for (const [a, b] of edges) {
    const k = ekey(a, b)
    if (!globalEdges.has(k)) globalEdges.set(k, { a, b, refs: [] })
    if (!globalEdges.get(k).refs.includes(ref)) globalEdges.get(k).refs.push(ref)
  }
  let segN = 0
  for (const { a, b, refs } of globalEdges.values()) {
    const routes = refs.map((ref) => ({ ...routeMeta(ref), stations: refStationList(ref), pass_stations: [] }))
    const colors = routes.map((r) => r.route_color)
    const ea = ic.get(a), eb = ic.get(b)
    features.push({
      type: 'Feature',
      properties: {
        seg_id: `${slug}-${segN++}`,
        routes, route_count: routes.length, route_refs: refs,
        route_colors: colors, route_color: colors[0],
        city, country,
      },
      geometry: { type: 'MultiLineString', coordinates: [[[ea.lon, ea.lat], [eb.lon, eb.lat]]] },
    })
  }
  const segTotal = globalEdges.size
  const refCount = [...refEdges.values()].filter((e) => e.length).length
  const meta = {
    continent, country, country_zh: countryZh, city, city_zh: cityZh, unit: raw.unit || 'country',
    osm_networks: [...byRef.keys()].sort(),
    operator: null,
    line_count: refCount, segment_count: segTotal,
    station_count: usedIc.size, interchange_count: usedIc.size,
  }
  return {
    type: 'FeatureCollection',
    highway_system: meta,
    metro_system: { ...meta, kind: 'highway' },
    features,
  }
}

const CONTINENT_DIR = {
  asia: 'asia', europe: 'europe', africa: 'africa', oceania: 'oceania',
  'north-america': 'americas', 'south-america': 'americas', americas: 'americas',
}
function countrySlug(country) {
  return country.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
}

async function main() {
  let files
  try { files = (await readdir(CACHE)).filter((f) => f.startsWith('hw_') && f.endsWith('.json')) }
  catch { files = [] }
  if (!files.length) { console.error('no fetched countries in data/highway/_cache — run npm run highway:fetch first'); process.exit(1) }

  const { countryZh: cMap, citySlug } = await zhMaps()
  const allLines = [], allIc = [], systems = []
  let lineTotal = 0, stationTotal = 0
  for (const f of files.sort()) {
    const raw = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    const slug = raw.slug || raw.cc
    const countryZh = cMap[raw.country] ?? raw.country
    // metro-unit files (big countries) get a 中文 city name; country-unit → country
    const cityZh = raw.unit === 'metro' ? (citySlug[slug]?.city ?? raw.city) : countryZh
    const fc = buildSystem(raw, { countryZh, cityZh })
    if (!fc.features.length) { console.log(`  ${slug}: 0 features, skip`); continue }
    const cont = CONTINENT_DIR[raw.continent] || 'other'
    const rel = `systems/${cont}/${countrySlug(raw.country)}/${slug}.geojson`
    await mkdir(dirname(join(HIGHWAY, rel)), { recursive: true })
    await writeFile(join(HIGHWAY, rel), JSON.stringify(fc))
    const m = fc.highway_system
    systems.push({
      file: rel, continent: raw.continent, country: raw.country, country_zh: m.country_zh,
      city: m.city, city_zh: m.city_zh, unit: m.unit,
      osm_networks: m.osm_networks, operator: m.operator,
      line_count: m.line_count, segment_count: m.segment_count, station_count: m.station_count,
    })
    lineTotal += m.line_count; stationTotal += m.station_count
    for (const feat of fc.features) (feat.geometry.type === 'Point' ? allIc : allLines).push(feat)
    console.log(`  ${slug} (${m.city_zh}): ${m.line_count} motorways, ${m.station_count} interchanges`)
  }

  await writeFile(join(HIGHWAY, 'highway_lines.geojson'), JSON.stringify({ type: 'FeatureCollection', features: allLines }))
  await writeFile(join(HIGHWAY, 'highway_interchanges.geojson'), JSON.stringify({ type: 'FeatureCollection', features: allIc }))
  await writeFile(join(HIGHWAY, 'index.json'), JSON.stringify({
    generated_from: 'OpenStreetMap highway=motorway + motorway_junction; one file per country, anchored on data/metro',
    system_count: systems.length, line_total: lineTotal, station_total: stationTotal, systems,
  }, null, 1))
  console.log(`\ndone: ${systems.length} countries, ${lineTotal} motorways, ${stationTotal} interchanges`)
}

main().catch((e) => { console.error(e); process.exit(1) })
