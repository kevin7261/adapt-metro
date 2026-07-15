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

const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080',
  '#e6b800', '#f032e6', '#9a6324', '#800000', '#808000', '#000075',
  '#46f0f0', '#bcf60c', '#fabebe', '#aa6e28',
]
function refColor(ref) {
  let h = 0
  for (const ch of String(ref)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
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

// Order interchanges into one path along the road: seed from an extreme end
// (one end of the farthest pair), greedy nearest-neighbour, then 2-opt to undo
// any long crossing edge. Robust even when OSM splits the road into many
// carriageway fragments (no single polyline spans the whole 國道).
function orderAlongPath(items) {
  const n = items.length
  if (n <= 2) return items.map((it) => it.root)
  const P = items.map((it) => [it.lon, it.lat])
  const d = (a, b) => haversine(P[a], P[b])
  let A = 0, bestd = -1
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const dd = d(i, j); if (dd > bestd) { bestd = dd; A = i }
  }
  const used = new Array(n).fill(false)
  const ord = [A]; used[A] = true
  for (let k = 1; k < n; k++) {
    const last = ord[ord.length - 1]
    let nx = -1, nd = Infinity
    for (let i = 0; i < n; i++) { if (used[i]) continue; const dd = d(last, i); if (dd < nd) { nd = dd; nx = i } }
    ord.push(nx); used[nx] = true
  }
  let improved = true, guard = 0
  while (improved && guard++ < 60) {
    improved = false
    for (let i = 0; i < ord.length - 1; i++) {
      for (let k = i + 1; k < ord.length; k++) {
        const a = i > 0 ? ord[i - 1] : null, b = ord[i], c = ord[k], e = k + 1 < ord.length ? ord[k + 1] : null
        let before = 0, after = 0
        if (a !== null) { before += d(a, b); after += d(a, c) }
        if (e !== null) { before += d(c, e); after += d(b, e) }
        if (after + 1e-6 < before) {
          let lo = i, hi = k
          while (lo < hi) { const t = ord[lo]; ord[lo] = ord[hi]; ord[hi] = t; lo++; hi-- }
          improved = true
        }
      }
    }
  }
  return ord.map((i) => items[i].root)
}

// ---- per-country assembly ---------------------------------------------------
function buildSystem(raw) {
  const { cc, continent, country } = raw
  const city = country // one file per country; the "city" label is the country
  const slug = cc
  const ways = raw.elements.filter((e) => e.type === 'way' && e.tags?.ref)
  const junctions = raw.elements.filter((e) => e.type === 'node' && e.tags?.highway === 'motorway_junction')

  const byRef = new Map()
  for (const w of ways) {
    const r = w.tags.ref
    if (!byRef.has(r)) byRef.set(r, [])
    byRef.get(r).push(w)
  }

  // merge junction nodes into interchanges (NB/SB carriageway pairs share a name)
  const norm = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  const parent = junctions.map((_, i) => i)
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a }
  const union = (a, b) => { parent[find(a)] = find(b) }
  const named = junctions.map((j) => ({ name: nameFor(j.tags, country), lon: j.lon, lat: j.lat }))
  for (let i = 0; i < junctions.length; i++) {
    for (let k = i + 1; k < junctions.length; k++) {
      const dd = haversine([named[i].lon, named[i].lat], [named[k].lon, named[k].lat])
      const sameName = named[i].name && named[k].name && norm(named[i].name) === norm(named[k].name)
      if ((sameName && dd < 2500) || dd < 150) union(i, k)
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

  // per ref: gather all its interchanges (any carriageway), order into one line
  const refStations = new Map()
  for (const [ref, refWays] of byRef) {
    const roots = new Set()
    for (const poly of buildPolylines(refWays)) for (const v of poly) {
      const jIdx = coordToJ.get(key(v[0], v[1]))
      if (jIdx !== undefined && jIdxToIc.has(jIdx)) roots.add(jIdxToIc.get(jIdx))
    }
    const items = [...roots].map((root) => { const e = ic.get(root); return { root, lon: e.lon, lat: e.lat } })
    refStations.set(ref, orderAlongPath(items))
  }

  // adjacency from each ref's consecutive interchange pairs
  const neigh = new Map(), icRefs = new Map()
  const addRef = (root, ref) => { if (!icRefs.has(root)) icRefs.set(root, new Set()); icRefs.get(root).add(ref) }
  for (const [ref, seq] of refStations) {
    for (let i = 0; i < seq.length; i++) {
      addRef(seq[i], ref)
      if (i + 1 < seq.length) {
        if (!neigh.has(seq[i])) neigh.set(seq[i], new Set())
        if (!neigh.has(seq[i + 1])) neigh.set(seq[i + 1], new Set())
        neigh.get(seq[i]).add(seq[i + 1]); neigh.get(seq[i + 1]).add(seq[i])
      }
    }
  }

  const refTags = new Map()
  for (const [ref, refWays] of byRef) {
    refTags.set(ref, refWays.slice().sort((x, y) => Object.keys(y.tags).length - Object.keys(x.tags).length)[0].tags)
  }
  const routeMeta = (ref) => {
    const t = refTags.get(ref)
    return {
      route_id: `hw-${slug}-${ref}`,
      route_name: refLabel(t, country),
      route_name_local: t['ref:zh'] || t['name:zh'] || t.name || refLabel(t, country),
      route_ref: ref,
      route_color: refColor(ref),
      network: t.network || `${country} Motorways`,
      network_local: t['network:zh'] || null,
      operator: t.operator || null,
      wikidata: t.wikidata || null,
      wikipedia: t.wikipedia || null,
      status: null,
      order_suspect: 0,
    }
  }
  const refStationList = (ref) => (refStations.get(ref) || []).map((root) => {
    const e = ic.get(root)
    return { station_id: e.id, station_name: e.name }
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
        station_role: isInter ? 'interchange' : (isTerm ? 'terminus' : 'normal'),
        station_degree: degree, is_interchange: isInter, is_terminus: isTerm,
        merged_from: e.members.length,
        merged_names: e.names.size > 1 ? [...e.names.values()] : null,
        wikidata: e.wikidata, wikipedia: e.wikipedia,
      },
      geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
    })
  }
  // one continuous line per 國道
  let segN = 0, segTotal = 0
  for (const [ref, seq] of refStations) {
    if (seq.length < 2) continue
    const coords = seq.map((root) => { const e = ic.get(root); return [e.lon, e.lat] })
    const routes = [{ ...routeMeta(ref), stations: refStationList(ref), pass_stations: [] }]
    features.push({
      type: 'Feature',
      properties: {
        seg_id: `${slug}-${segN++}`,
        routes, route_count: 1, route_refs: [ref],
        route_colors: [routes[0].route_color], route_color: routes[0].route_color,
        city, country,
      },
      geometry: { type: 'MultiLineString', coordinates: [coords] },
    })
    segTotal += coords.length - 1
  }

  const refCount = [...refStations.values()].filter((s) => s.length >= 2).length
  const meta = {
    continent, country, city,
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

  const allLines = [], allIc = [], systems = []
  let lineTotal = 0, stationTotal = 0
  for (const f of files.sort()) {
    const raw = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    const fc = buildSystem(raw)
    if (!fc.features.length) { console.log(`  ${raw.cc}: 0 features, skip`); continue }
    const cont = CONTINENT_DIR[raw.continent] || 'other'
    const rel = `systems/${cont}/${countrySlug(raw.country)}/${raw.cc}.geojson`
    await mkdir(dirname(join(HIGHWAY, rel)), { recursive: true })
    await writeFile(join(HIGHWAY, rel), JSON.stringify(fc))
    const m = fc.highway_system
    systems.push({
      file: rel, continent: raw.continent, country: raw.country, city: raw.country,
      osm_networks: m.osm_networks, operator: m.operator,
      line_count: m.line_count, segment_count: m.segment_count, station_count: m.station_count,
    })
    lineTotal += m.line_count; stationTotal += m.station_count
    for (const feat of fc.features) (feat.geometry.type === 'Point' ? allIc : allLines).push(feat)
    console.log(`  ${raw.cc} (${raw.country}): ${m.line_count} motorways, ${m.station_count} interchanges`)
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
