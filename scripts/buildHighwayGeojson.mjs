// Assemble the motorway networks fetched by fetchHighways.mjs into GeoJSON that
// mirrors the metro schema (see skill highway-osm-fetch), so the same D3 /
// MapLibre renderers and the schematic pipeline can consume it unchanged:
//
//   交流道 (highway=motorway_junction)     ≙ metro station  (Point feature)
//   編號高速公路 (highway=motorway, by ref) ≙ metro line     (segment routes[])
//   交流道依序以直線相接                    ≙ 線壓站點        (segment geometry)
//
// Like metro, segments are STRAIGHT lines between consecutive interchanges — the
// real road polyline is fetched only to derive interchange order, never drawn.
//
// The "system" unit is one metro area (一都會區一檔); continent/country/city
// come straight from the metro anchor cached with each fetch, so there is no
// geocoding here. Output → data/highway/{systems,index.json,*.geojson}.
//
//   node scripts/buildHighwayGeojson.mjs
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const HIGHWAY = join(ROOT, 'data', 'highway')
const CACHE = join(HIGHWAY, '_cache')

// Deterministic per-ref colour palette (motorways carry no official colour like
// metro lines do). Hash the ref → a stable slot so re-runs are reproducible.
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

// ---- coordinate helpers -----------------------------------------------------
const key = (x, y) => `${x.toFixed(7)},${y.toFixed(7)}`
function haversine(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0])
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

// ---- display-name language (mirrors metro nameFor) --------------------------
const isCJK = (c) => /Taiwan|China|Hong Kong|Macau/i.test(c)
const isJP = (c) => /Japan/i.test(c)
function nameFor(tags, country) {
  if (!tags) return null
  const zh = tags['name:zh'] || tags['name:zh-Hant'] || tags['name:zh-Hans']
  if (isCJK(country)) return zh || tags.name || tags['name:en'] || null
  if (isJP(country)) return tags['name:ja'] || tags.name || null
  return tags['name:en'] || tags.name || zh || null
}
// The motorway "line label" — 國道X號 / Freeway X, prefer the numbered ref name.
function refLabel(tags, country) {
  const zh = tags['ref:zh'], en = tags['ref:en'], ja = tags['ref:ja']
  const fallback = `Motorway ${tags.ref}`
  if (isCJK(country)) return zh || en || nameFor(tags, country) || fallback
  if (isJP(country)) return ja || en || zh || fallback
  return en || zh || nameFor(tags, country) || fallback
}

// Chain a ref's motorway ways into maximal polylines by shared endpoints. Each
// carriageway (they are oneway) becomes one polyline; NB/SB → two polylines.
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
    // extend tail, then head
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
          const ordered = headMatch ? s : s.slice().reverse() // now ordered[0] === anchor
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

// ---- per-system assembly ----------------------------------------------------
function buildSystem(raw) {
  const { slug, continent, country, city } = raw
  const ways = raw.elements.filter((e) => e.type === 'way' && e.tags?.ref)
  const junctions = raw.elements.filter((e) => e.type === 'node' && e.tags?.highway === 'motorway_junction')

  // Group ways by ref (the 國道 number). "3甲" etc. stay their own line.
  const byRef = new Map()
  for (const w of ways) {
    const r = w.tags.ref
    if (!byRef.has(r)) byRef.set(r, [])
    byRef.get(r).push(w)
  }

  // --- merge junction nodes into interchanges (交流道) ------------------------
  // NB/SB carriageways carry one junction node each for the same interchange
  // (same name, exit refs like 49/49A/49B). Union them by normalised name +
  // proximity; different names within 150 m also merge (rare mis-tagging).
  const norm = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  const parent = junctions.map((_, i) => i)
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a }
  const union = (a, b) => { parent[find(a)] = find(b) }
  const named = junctions.map((j) => ({
    name: nameFor(j.tags, country), lon: j.lon, lat: j.lat,
  }))
  for (let i = 0; i < junctions.length; i++) {
    for (let k = i + 1; k < junctions.length; k++) {
      const d = haversine([named[i].lon, named[i].lat], [named[k].lon, named[k].lat])
      const sameName = named[i].name && named[k].name && norm(named[i].name) === norm(named[k].name)
      if ((sameName && d < 2500) || d < 150) union(i, k)
    }
  }
  // interchange record per union-find root
  const ic = new Map() // root → { id, members:[jIdx], name, lon, lat, refs:Set, wikidata, wikipedia, exit_refs:Set }
  junctions.forEach((j, i) => {
    const r = find(i)
    if (!ic.has(r)) ic.set(r, { members: [], names: new Map(), lons: [], lats: [], refs: new Set(), exitRefs: new Set(), wikidata: null, wikipedia: null })
    const e = ic.get(r)
    e.members.push(i)
    e.lons.push(j.lon); e.lats.push(j.lat)
    const nm = nameFor(j.tags, country)
    if (nm) e.names.set(norm(nm), nm)
    if (j.tags.ref) e.exitRefs.add(j.tags.ref)
    if (j.tags.wikidata && !e.wikidata) e.wikidata = j.tags.wikidata
    if (j.tags.wikipedia && !e.wikipedia) e.wikipedia = j.tags.wikipedia
  })
  // finalise interchange geometry + id (id = smallest member node id)
  const jIdxToIc = new Map()
  for (const [root, e] of ic) {
    e.lon = e.lons.reduce((a, b) => a + b, 0) / e.lons.length
    e.lat = e.lats.reduce((a, b) => a + b, 0) / e.lats.length
    const minId = Math.min(...e.members.map((i) => junctions[i].id))
    e.id = `n${minId}`
    e.name = [...e.names.values()][0] || `交流道 ${[...e.exitRefs][0] ?? ''}`.trim() || e.id
    for (const i of e.members) jIdxToIc.set(i, root)
  }
  // fast junction-coord → jIdx (junction is a vertex of its carriageway)
  const coordToJ = new Map()
  junctions.forEach((j, i) => coordToJ.set(key(j.lon, j.lat), i))

  // --- per-ref: order interchanges along the road, emit edges ----------------
  const edges = new Map() // "icRootA|icRootB" (sorted) → { a, b, refs:Set, geometry:[[x,y]...] }
  const refStations = new Map() // ref → ordered [icRoot] (from its longest carriageway)
  for (const [ref, refWays] of byRef) {
    const polys = buildPolylines(refWays)
    let bestOrder = []
    for (const poly of polys) {
      // interchanges on this polyline, ordered by vertex index
      const hits = []
      poly.forEach((v, idx) => {
        const jIdx = coordToJ.get(key(v[0], v[1]))
        if (jIdx !== undefined && jIdxToIc.has(jIdx)) hits.push({ idx, root: jIdxToIc.get(jIdx) })
      })
      // drop consecutive duplicates of the same interchange
      const seq = hits.filter((h, n) => n === 0 || h.root !== hits[n - 1].root)
      for (let n = 0; n + 1 < seq.length; n++) {
        const a = seq[n], b = seq[n + 1]
        if (a.root === b.root) continue
        const ek = [a.root, b.root].sort().join('|')
        if (!edges.has(ek)) edges.set(ek, { a: a.root, b: b.root, refs: new Set() })
        edges.get(ek).refs.add(ref)
      }
      if (seq.length > bestOrder.length) bestOrder = seq.map((h) => h.root)
    }
    refStations.set(ref, bestOrder)
  }

  // --- interchange degree / role from the edge graph -------------------------
  const neigh = new Map() // icRoot → Set(icRoot)
  const icRefs = new Map() // icRoot → Set(ref)
  for (const e of edges.values()) {
    if (!neigh.has(e.a)) neigh.set(e.a, new Set())
    if (!neigh.has(e.b)) neigh.set(e.b, new Set())
    neigh.get(e.a).add(e.b); neigh.get(e.b).add(e.a)
    for (const root of [e.a, e.b]) {
      if (!icRefs.has(root)) icRefs.set(root, new Set())
      for (const r of e.refs) icRefs.get(root).add(r)
    }
  }

  // representative tags per ref (first way that has the richest tags)
  const refTags = new Map()
  for (const [ref, refWays] of byRef) {
    const best = refWays.slice().sort((x, y) =>
      Object.keys(y.tags).length - Object.keys(x.tags).length)[0]
    refTags.set(ref, best.tags)
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
  // ordered interchange list per ref → {station_id, station_name}. Some motorways
  // (e.g. National Freeway 1 with its parallel elevated roadway, same ref) chain
  // back on themselves, so the longest carriageway can revisit an interchange;
  // keep first occurrence only so each interchange appears once (order_suspect
  // covers the residual ordering imperfection, as in the metro pipeline).
  const refStationList = (ref) => {
    const seen = new Set(), out = []
    for (const root of refStations.get(ref) || []) {
      if (seen.has(root)) continue
      seen.add(root)
      const e = ic.get(root)
      out.push({ station_id: e.id, station_name: e.name })
    }
    return out
  }

  // --- features --------------------------------------------------------------
  const features = []
  // interchange points
  const usedIc = new Set([...neigh.keys()]) // only interchanges that lie on a drawn edge
  for (const root of usedIc) {
    const e = ic.get(root)
    const refs = [...(icRefs.get(root) || [])].sort()
    const degree = neigh.get(root)?.size ?? 0
    const isInter = refs.length >= 2 || degree > 2
    const isTerm = degree === 1
    const mergedNames = e.names.size > 1 ? [...e.names.values()] : null
    features.push({
      type: 'Feature',
      properties: {
        station_id: e.id,
        station_name: e.name,
        station_name_local: e.name,
        network: `${country} Motorways`,
        network_local: null,
        operator: null,
        city, country,
        lines: refs.map((r) => routeMeta(r).route_name),
        line_ids: refs.map((r) => `hw-${slug}-${r}`),
        line_names: refs.map((r) => routeMeta(r).route_name),
        exit_refs: [...e.exitRefs].sort(),
        station_role: isInter ? 'interchange' : (isTerm ? 'terminus' : 'normal'),
        station_degree: degree,
        is_interchange: isInter,
        is_terminus: isTerm,
        merged_from: e.members.length,
        merged_names: mergedNames,
        wikidata: e.wikidata,
        wikipedia: e.wikipedia,
      },
      geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
    })
  }
  // motorway segments (edges) — like metro, the geometry is a STRAIGHT line
  // between the two consecutive interchanges (線壓交流道), NOT the real road
  // shape. The road polyline was only used to derive interchange ORDER above;
  // drawing straight lines keeps every segment meeting exactly at the (merged)
  // interchange dots, so the network is continuous instead of cut into pieces.
  let segN = 0
  for (const e of edges.values()) {
    const refs = [...e.refs].sort()
    const routes = refs.map((ref) => ({
      ...routeMeta(ref),
      stations: refStationList(ref),
      pass_stations: [],
    }))
    const colors = routes.map((r) => r.route_color)
    const a = ic.get(e.a), b = ic.get(e.b)
    features.push({
      type: 'Feature',
      properties: {
        seg_id: `${slug}-${segN++}`,
        routes,
        route_count: routes.length,
        route_refs: refs,
        route_colors: colors,
        route_color: colors[0],
        city, country,
      },
      geometry: { type: 'MultiLineString', coordinates: [[[a.lon, a.lat], [b.lon, b.lat]]] },
    })
  }

  const refCount = byRef.size
  const meta = {
    continent, country, city,
    osm_networks: [...byRef.keys()].sort(),
    operator: null,
    line_count: refCount,
    segment_count: edges.size,
    station_count: usedIc.size,
    interchange_count: usedIc.size,
  }
  return {
    type: 'FeatureCollection',
    // `highway_system` is the semantic key; `metro_system` is an alias so the
    // existing front-end panels (Info, counts) that read metro_system work
    // unchanged — highways deliberately mirror the metro schema.
    highway_system: meta,
    metro_system: { ...meta, kind: 'highway' },
    features,
  }
}

// ---- directory layout mirrors metro (systems/{continent}/{country}/{slug}) --
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
  if (!files.length) { console.error('no fetched systems in data/highway/_cache — run npm run highway:fetch first'); process.exit(1) }

  const allLines = [], allIc = [], systems = []
  let lineTotal = 0, stationTotal = 0
  for (const f of files.sort()) {
    const raw = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    const fc = buildSystem(raw)
    if (!fc.features.length) { console.log(`  ${raw.slug}: 0 features, skip`); continue }
    const cont = CONTINENT_DIR[raw.continent] || 'other'
    const rel = `systems/${cont}/${countrySlug(raw.country)}/${raw.slug}.geojson`
    await mkdir(dirname(join(HIGHWAY, rel)), { recursive: true })
    await writeFile(join(HIGHWAY, rel), JSON.stringify(fc))
    const m = fc.highway_system
    systems.push({
      file: rel, continent: raw.continent, country: raw.country, city: raw.city,
      osm_networks: m.osm_networks, operator: m.operator,
      line_count: m.line_count, segment_count: m.segment_count, station_count: m.station_count,
    })
    lineTotal += m.line_count; stationTotal += m.station_count
    for (const feat of fc.features) {
      if (feat.geometry.type === 'Point') allIc.push(feat)
      else allLines.push(feat)
    }
    console.log(`  ${raw.slug}: ${m.line_count} motorways, ${m.segment_count} segments, ${m.station_count} interchanges`)
  }

  await writeFile(join(HIGHWAY, 'highway_lines.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features: allLines }))
  await writeFile(join(HIGHWAY, 'highway_interchanges.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features: allIc }))
  await writeFile(join(HIGHWAY, 'index.json'), JSON.stringify({
    generated_from: 'OpenStreetMap highway=motorway + motorway_junction; anchored on data/metro',
    system_count: systems.length,
    line_total: lineTotal,
    station_total: stationTotal,
    systems,
  }, null, 1))
  console.log(`\ndone: ${systems.length} systems, ${lineTotal} motorways, ${stationTotal} interchanges`)
}

main().catch((e) => { console.error(e); process.exit(1) })
