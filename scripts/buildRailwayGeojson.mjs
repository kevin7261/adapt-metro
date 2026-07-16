// Assemble the NATIONAL railway networks fetched by fetchRailways.mjs into GeoJSON
// that mirrors the metro schema (see skill railway-osm-fetch), so the same D3 /
// MapLibre renderers and the schematic pipeline consume it unchanged:
//
//   車站 (railway=station)                 ≙ metro station  (Point feature)
//   路線 (rail way name, e.g. 縱貫線)        ≙ metro line     (routes[] on segments)
//   相鄰車站沿軌道以直線相接                 ≙ 線壓站點        (segment geometry)
//
// ONE geojson per COUNTRY (使用者: 一國家一檔). TRACK-BASED, like highway=motorway:
// build a graph from railway=rail (usage=main|branch) ways, snap each station onto
// it, then contract to STATION-to-STATION edges (walk the track between adjacent
// stations). Complete coverage; the ways carry the line name (縱貫線 …), usage and
// highspeed. Coloured by RAIL CLASS (high-speed / conventional) like highway
// colours by road level. Output → data/railway/{systems,index.json,*.geojson}.
//
//   node scripts/buildRailwayGeojson.mjs            # every fetched country
//   node scripts/buildRailwayGeojson.mjs twn        # cc/name substrings
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const RAILWAY = join(ROOT, 'data', 'railway')
const CACHE = join(RAILWAY, '_cache')
const OVERRIDES = join(RAILWAY, '_overrides')

const LINE_SNAP = 400     // a station belongs to a line if within this of its track
const MERGE_M = 150       // merge two stations closer than this (duplicate mapping)
const NAME_MERGE_M = 2500 // ...or same normalized name within this (台北 TRA+HSR → 1)
const HSR_MERGE_M = 500   // ...or an HSR + conventional co-located 共站 within this
// Split a line at a station-to-station gap longer than this. PER-CLASS: HSR stations
// sit 30–60 km apart on continuous dedicated track (high cap → one line); but a big
// gap on a CONVENTIONAL line means there is no track there — e.g. 縱貫線 has no track
// 竹南↔彰化 (that stretch IS 山線 台中線 / 海線 海岸線), so it must break, not draw a
// straight 60 km hop. So conventional breaks at a smaller cap.
const MAX_EDGE_M = 30000       // conventional lines
const MAX_EDGE_HSR_M = 70000   // high-speed lines
const capFor = (cls) => (cls === 'high_speed' ? MAX_EDGE_HSR_M : MAX_EDGE_M)

// Two classes, coloured like highway colours by road level (同一層同色):
// high_speed (highspeed=yes: 新幹線/高鐵/TGV/ICE/AVE/KTX) vs conventional.
const RAIL_COLORS = {
  Taiwan: { high_speed: '#e9530e', conventional: '#1f4e96' },       // 高鐵橘・台鐵藍
  Japan: { high_speed: '#1f8a4c', conventional: '#1666b0' },        // 新幹線綠
  China: { high_speed: '#c0392b', conventional: '#1666b0' },
  'South Korea': { high_speed: '#0b57a4', conventional: '#1666b0' },
  France: { high_speed: '#c0392b', conventional: '#1666b0' },       // TGV 紅
  Germany: { high_speed: '#c0392b', conventional: '#1666b0' },      // ICE 紅
  default: { high_speed: '#c0392b', conventional: '#1666b0' },
}
function classColor(country, cls) {
  const t = RAIL_COLORS[country] || RAIL_COLORS.default
  return t[cls] || RAIL_COLORS.default[cls]
}
const CLASS_LABEL = {
  high_speed: { zh: '高速鐵路', en: 'High-speed Rail' },
  conventional: { zh: '一般鐵路', en: 'Conventional Rail' },
}
function classLabel(country, cls) {
  const t = CLASS_LABEL[cls] || CLASS_LABEL.conventional
  return (isCJK(country) || isJP(country)) ? t.zh : t.en
}

const key = (x, y) => `${x.toFixed(6)},${y.toFixed(6)}`
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
const norm = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')

// A rail way's LINE name, normalized so multi-track variants collapse: 縱貫線西正線
// / 縱貫線東正線 / 縱貫線(南段) → 縱貫線; 臺→台. Structure names (bridges/tunnels) and
// missing names return null → the edge falls back to its class label.
function lineName(tags, country) {
  let n = nameFor(tags, country)
  if (!n) return null
  n = n.replace(/臺/g, '台')
    .replace(/（[^）]*）\s*$/g, '').replace(/\([^)]*\)\s*$/g, '')
    .replace(/(西|東|中|南|北|上|下|快速|貨物)?正線$/g, '')
    .replace(/(上り|下り)線?$/g, '')
    .trim()
  if (!n || /(橋|隧道|高架橋?|線橋|渡線|聯絡線)$/.test(n)) return null
  return n
}

// Simple grid index for nearest lookup.
function gridIndex(pts, cellDeg = 0.01) {
  const cells = new Map()
  const ck = (x, y) => `${Math.floor(x / cellDeg)},${Math.floor(y / cellDeg)}`
  pts.forEach((p, i) => { const k = ck(p.lon, p.lat); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i) })
  const nearest = (lon, lat, maxM) => {
    const cx = Math.floor(lon / cellDeg), cy = Math.floor(lat / cellDeg)
    let best = -1, bestD = maxM
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of cells.get(`${cx + dx},${cy + dy}`) || []) {
        const d = haversine([lon, lat], [pts[i].lon, pts[i].lat])
        if (d < bestD) { bestD = d; best = i }
      }
    }
    return { i: best, d: best < 0 ? Infinity : bestD }
  }
  return { nearest }
}

function buildSystem(raw, exclude) {
  const { continent, country } = raw
  const country_zh = raw.country_zh ?? country
  const cc = raw.cc
  const excludeRe = exclude ? new RegExp(exclude, 'i') : null

  // ── 1. parse track ways, grouped by (normalized) LINE name ─────────────────
  const ways = [] // { coords:[[lon,lat]…], cls, line }
  for (const w of raw.trackElements) {
    if (w.type !== 'way' || !w.geometry || w.geometry.length < 2) continue
    const t = w.tags || {}
    // exclude non-passenger track by operator/network/name (freight 臨港線, 台糖…)
    if (excludeRe && excludeRe.test(`${t.operator || ''} ${t.network || ''} ${t.name || ''} ${t['name:zh'] || ''}`)) continue
    ways.push({
      coords: w.geometry.map((p) => [p.lon, p.lat]),
      cls: t.highspeed === 'yes' ? 'high_speed' : 'conventional',
      line: lineName(t, country),
    })
  }
  if (!ways.length) return { type: 'FeatureCollection', railway_system: null, features: [] }
  const waysByLine = new Map()
  for (const w of ways) {
    if (!w.line) continue
    if (!waysByLine.has(w.line)) waysByLine.set(w.line, [])
    waysByLine.get(w.line).push(w)
  }
  // Merge line-NAME variants where one name contains another on high-speed track
  // (台灣高速鐵路 ⊇ 高速鐵路 → one line). Distinct named lines (東海道新幹線 vs
  // 山陽新幹線, neither a substring of the other) are unaffected → safe for Japan.
  const hsNames = [...waysByLine.keys()].filter((ln) => waysByLine.get(ln).some((w) => w.cls === 'high_speed'))
  for (const short of hsNames) {
    if (!waysByLine.has(short)) continue
    const longer = hsNames.find((l) => l !== short && waysByLine.has(l) && l.includes(short) &&
      waysByLine.get(l).length >= waysByLine.get(short).length)
    if (longer) { waysByLine.get(longer).push(...waysByLine.get(short)); waysByLine.delete(short) }
  }

  // ── 2. stations → MERGE duplicates (台北 TRA + 台北 HSR + platform ways → one
  // physical station) ────────────────────────────────────────────────────────
  const rawSt = []
  for (const e of raw.stationElements) {
    let lon, lat
    if (e.type === 'node') { lon = e.lon; lat = e.lat }
    else if (e.type === 'way' && e.center) { lon = e.center.lon; lat = e.center.lat }
    else continue
    const nm = nameFor(e.tags, country)
    if (!nm) continue
    if (excludeRe && excludeRe.test(`${e.tags.operator || ''} ${e.tags.network || ''} ${e.tags.name || ''}`)) continue
    rawSt.push({ id: `${e.type[0]}${e.id}`, name: nm, lon, lat, tags: e.tags || {} })
  }
  const parent = rawSt.map((_, i) => i)
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
  const union = (a, b) => { parent[find(a)] = find(b) }
  // an HSR-platform station carries a high-speed operator/network (新幹線/高鐵/
  // 高速鉄道/TGV…); flags transfer complexes and drives HSR-line membership.
  const HSR_OP_RE = /高速鐵|高铁|高鐵|高速鉄|new ?transit|shinkansen|新幹線|high[\s_-]?speed|\btgv\b|\bice\b|\bave\b|\bktx\b|renfe ave/i
  const isHsr = rawSt.map((s) => HSR_OP_RE.test(`${s.tags.operator || ''} ${s.tags.network || ''}`))
  const cellDeg = 0.03, buckets = new Map()
  rawSt.forEach((s, i) => { const k = `${Math.floor(s.lon / cellDeg)},${Math.floor(s.lat / cellDeg)}`; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(i) })
  for (let i = 0; i < rawSt.length; i++) {
    const s = rawSt[i], cx = Math.floor(s.lon / cellDeg), cy = Math.floor(s.lat / cellDeg)
    for (let dx = 0; dx <= 1; dx++) for (let dy = (dx === 0 ? 0 : -1); dy <= 1; dy++) {
      for (const j of buckets.get(`${cx + dx},${cy + dy}`) || []) {
        if (j <= i) continue
        const o = rawSt[j], d = haversine([s.lon, s.lat], [o.lon, o.lat])
        if (d > NAME_MERGE_M) continue
        const sameName = norm(s.name) === norm(o.name)
        // 共站 (co-located transfer complex): an HSR station and an adjacent
        // conventional station are ONE physical station though differently named
        // (高鐵台中↔新烏日, 高鐵新竹↔六家, 高鐵台南↔沙崙, 高鐵高雄↔新左營, 高鐵苗栗↔豐富).
        const coStation = (isHsr[i] !== isHsr[j]) && d < HSR_MERGE_M
        if (d < MERGE_M || (sameName && d < NAME_MERGE_M) || coStation) union(i, j)
      }
    }
  }
  const clusters = new Map()
  rawSt.forEach((s, i) => {
    const r = find(i)
    if (!clusters.has(r)) clusters.set(r, { ids: [], names: new Map(), lons: [], lats: [], tags: {}, hsr: false })
    const c = clusters.get(r)
    c.ids.push(s.id); c.lons.push(s.lon); c.lats.push(s.lat)
    c.names.set(norm(s.name), (c.names.get(norm(s.name)) || { name: s.name, n: 0 }))
    c.names.get(norm(s.name)).n++
    if (HSR_OP_RE.test(`${s.tags.operator || ''} ${s.tags.network || ''}`)) c.hsr = true
    for (const kk of ['wikidata', 'wikipedia', 'operator']) if (s.tags[kk] && !c.tags[kk]) c.tags[kk] = s.tags[kk]
  })
  const stations = []
  const stById = new Map()
  for (const [r, c] of clusters) {
    const best = [...c.names.values()].sort((a, b) => b.n - a.n)[0]
    const s = {
      id: `s${rawSt[r].id}`, name: best.name, tags: c.tags, hsr: c.hsr,
      lon: c.lons.reduce((a, b) => a + b, 0) / c.lons.length,
      lat: c.lats.reduce((a, b) => a + b, 0) / c.lats.length,
    }
    stations.push(s); stById.set(s.id, s)
  }

  // ── 3. SEQUENCE stations along each LINE (like metro/highway order stations
  // along a route): chain the line's ways into a spine, project each nearby
  // station onto it, sort by arc-position, connect consecutive. Junctions arise
  // only where lines share a station — no BFS flood over parallel-track meshes. ─
  const ekey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  // Order a line's member stations into a single path via nearest-neighbour from a
  // diameter endpoint — robust for long/curved/branched lines (縱貫線) where 1-D
  // spine projection scrambles (projects distant stations to the same arc-pos).
  const farthest = (from, pts) => pts.reduce((b, p) =>
    haversine([from.lon, from.lat], [p.lon, p.lat]) > haversine([from.lon, from.lat], [b.lon, b.lat]) ? p : b, pts[0])
  const orderNN = (pts) => {
    if (pts.length <= 2) return pts
    const start = farthest(farthest(pts[0], pts), pts) // one end of the diameter
    const used = new Set([start]); const order = [start]; let cur = start
    while (order.length < pts.length) {
      let best = null, bd = Infinity
      for (const p of pts) {
        if (used.has(p)) continue
        const d = haversine([cur.lon, cur.lat], [p.lon, p.lat])
        if (d < bd) { bd = d; best = p }
      }
      used.add(best); order.push(best); cur = best
    }
    return order
  }

  const edges = new Map() // "sidA|sidB" → { a, b, cls:Set, lines:Set }
  const lineCls = new Map() // line → 'high_speed' | 'conventional'
  // Pass A: for each line, find member stations (within LINE_SNAP of its track).
  const lineData = new Map() // line → { cls, members:[{s,d}] }
  const stMin = new Map()    // stationId → nearest-line distance
  for (const [ln, wl] of waysByLine) {
    const cls = wl.some((w) => w.cls === 'high_speed') ? 'high_speed' : 'conventional'
    lineCls.set(ln, cls)
    const verts = []
    for (const w of wl) for (const c of w.coords) verts.push({ lon: c[0], lat: c[1] })
    if (verts.length < 2) continue
    const vidx = gridIndex(verts)
    const members = []
    for (const s of stations) {
      // An HSR-platform station (operator flag) is a real HSR stop but may sit far
      // from the sparse tunnel geometry (台北/桃園/台中) — widen its gate so it joins
      // the NEAREST high-speed line's track (per-line, so multiple Shinkansen stay
      // distinct). Non-HSR stations near HSR track are filtered out in Pass B.
      const gate = (cls === 'high_speed' && s.hsr) ? 6000 : LINE_SNAP
      const { d } = vidx.nearest(s.lon, s.lat, gate)
      if (d === Infinity) continue
      members.push({ s, d })
      if (d < (stMin.get(s.id) ?? Infinity)) stMin.set(s.id, d)
    }
    lineData.set(ln, { cls, members })
  }
  // Pass B: filter membership, then order the line's stations into ONE path (NN).
  // Conventional lines use plain proximity (keeps TRA↔TRA junctions like 八堵).
  // HIGH-SPEED lines additionally require HSR to be the station's NEAREST line (or
  // an HSR-platform station) — drops TRA stations wrongly pulled onto the 高鐵 line
  // in the shared corridor (松山/萬華…).
  const lineSeq = new Map() // line → ordered [station]
  for (const [ln, { cls, members }] of lineData) {
    const on = members.filter((m) => cls !== 'high_speed'
      ? m.d <= LINE_SNAP
      : (m.s.hsr || m.d <= (stMin.get(m.s.id) ?? m.d) * 1.15 + 5))
    const seq = orderNN(on.map((m) => m.s))
    if (seq.length < 2) continue
    lineSeq.set(ln, seq)
    // consecutive pairs → edges (for station degree / interchange detection)
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = seq[i], b = seq[i + 1]
      if (haversine([a.lon, a.lat], [b.lon, b.lat]) > capFor(cls)) continue
      const k = ekey(a.id, b.id)
      if (!edges.has(k)) edges.set(k, { a: a.id, b: b.id, cls: new Set(), lines: new Set() })
      const rec = edges.get(k); rec.cls.add(cls); rec.lines.add(ln)
    }
  }

  // ── 4. line (route) metadata by normalized line name; colour by class ──────
  const routeMeta = (ln) => {
    const cls = lineCls.get(ln) || 'conventional'
    return {
      route_id: `rw-${cc}-${encodeURIComponent(ln)}`,
      route_name: ln, route_name_local: ln, route_ref: null,
      route_color: classColor(country, cls), rail_class: cls,
      network: `${country} Railways`, network_local: null, operator: null,
      wikidata: null, wikipedia: null, status: null, order_suspect: 0,
    }
  }

  // ── 5. station Point features + degree / interchange ───────────────────────
  const neigh = new Map(); const stLines = new Map()
  const link = (a, b) => { if (!neigh.has(a)) neigh.set(a, new Set()); if (!neigh.has(b)) neigh.set(b, new Set()); neigh.get(a).add(b); neigh.get(b).add(a) }
  const addLn = (sid, ln) => { if (!stLines.has(sid)) stLines.set(sid, new Set()); if (ln) stLines.get(sid).add(ln) }
  for (const rec of edges.values()) {
    link(rec.a, rec.b)
    for (const ln of rec.lines) { addLn(rec.a, ln); addLn(rec.b, ln) }
  }
  const drawn = new Set([...neigh.keys()])
  const features = []
  for (const sid of drawn) {
    const s = stById.get(sid); if (!s) continue
    const lns = [...(stLines.get(sid) || [])]
    const lnLabels = lns.map((ln) => routeMeta(ln).route_name)
    const degree = neigh.get(sid)?.size ?? 0
    const isInter = new Set(lnLabels).size >= 2 || degree > 2
    const isTerm = degree === 1
    features.push({
      type: 'Feature',
      properties: {
        station_id: sid, station_name: s.name, station_name_local: s.name,
        network: `${country} Railways`, network_local: null, operator: s.tags.operator || null,
        city: country, country,
        lines: lnLabels, line_ids: lns.map((ln) => `rw-${cc}-${encodeURIComponent(ln)}`), line_names: lnLabels,
        station_role: isInter ? 'interchange' : (isTerm ? 'terminus' : 'normal'),
        station_degree: degree, is_interchange: isInter, is_terminus: isTerm,
        wikidata: s.tags.wikidata || null, wikipedia: s.tags.wikipedia || null,
      },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    })
  }

  // ── 6. line features: ONE feature per line (like metro — the whole line is a
  // single continuous polyline of its stations in order, NOT chopped per shared
  // corridor). Overlapping lines each draw their own full feature. A line only
  // splits into multiple LineStrings (within one feature) at a real >MAX_EDGE_M gap.
  let segN = 0, segTotal = 0
  for (const [ln, seq] of lineSeq) {
    const meta = { ...routeMeta(ln), stations: seq.map((s) => ({ station_id: s.id, station_name: s.name, mileage: null })), pass_stations: [] }
    const parts = []; let cur = []
    for (const s of seq) {
      if (cur.length && haversine(cur[cur.length - 1], [s.lon, s.lat]) > capFor(meta.rail_class)) { parts.push(cur); cur = [] }
      cur.push([s.lon, s.lat])
    }
    if (cur.length) parts.push(cur)
    const coords = parts.filter((p) => p.length >= 2)
    if (!coords.length) continue
    features.push({
      type: 'Feature',
      properties: {
        seg_id: `${cc}-${segN++}`,
        routes: [meta], route_count: 1,
        route_refs: [ln], route_colors: [meta.route_color], route_color: meta.route_color,
        rail_class: meta.rail_class, city: country, country,
      },
      geometry: { type: 'MultiLineString', coordinates: coords },
    })
    segTotal += coords.reduce((a, p) => a + p.length - 1, 0)
  }

  const namedLines = [...lineSeq.keys()]
  const meta = {
    continent, country, country_zh, city: country, city_zh: country_zh, unit: 'country',
    osm_networks: namedLines.slice().sort().slice(0, 60),
    operator: null,
    line_count: namedLines.length, segment_count: segTotal,
    station_count: drawn.size,
    interchange_count: [...drawn].filter((sid) => (new Set([...(stLines.get(sid) || [])]).size) >= 2).length,
  }
  return { type: 'FeatureCollection', railway_system: meta, metro_system: { ...meta, kind: 'railway' }, features }
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
  const filters = (process.argv[2] ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
  let files
  try { files = (await readdir(CACHE)).filter((f) => f.startsWith('rw_') && f.endsWith('.json')) }
  catch { files = [] }
  if (filters.length) files = files.filter((f) => filters.some((x) => f.toLowerCase().includes(x)))
  if (!files.length) { console.error('no fetched countries in data/railway/_cache — run npm run railway:fetch first'); process.exit(1) }

  const allLines = [], allStations = [], systems = []
  let lineTotal = 0, stationTotal = 0
  for (const f of files.sort()) {
    const raw = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    let exclude = null
    try {
      const ov = JSON.parse(await readFile(join(OVERRIDES, `${raw.cc}_exclude.json`), 'utf8'))
      if (ov.operators?.length) exclude = ov.operators.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    } catch { /* no override */ }

    const fc = buildSystem(raw, exclude)
    if (!fc.features.length) { console.log(`  ${raw.cc}: 0 features, skip`); continue }
    const cont = CONTINENT_DIR[raw.continent] || 'other'
    const rel = `systems/${cont}/${countrySlug(raw.country)}/${raw.cc}.geojson`
    await mkdir(dirname(join(RAILWAY, rel)), { recursive: true })
    await writeFile(join(RAILWAY, rel), JSON.stringify(fc))
    const m = fc.railway_system
    systems.push({
      file: rel, continent: raw.continent, country: raw.country, country_zh: m.country_zh,
      city: m.city, city_zh: m.city_zh, unit: m.unit,
      osm_networks: m.osm_networks, operator: m.operator,
      line_count: m.line_count, segment_count: m.segment_count, station_count: m.station_count,
    })
    lineTotal += m.line_count; stationTotal += m.station_count
    for (const feat of fc.features) (feat.geometry.type === 'Point' ? allStations : allLines).push(feat)
    console.log(`  ${raw.cc} (${m.country_zh}): ${m.line_count} lines, ${m.station_count} stations`)
  }

  await writeFile(join(RAILWAY, 'railway_lines.geojson'), JSON.stringify({ type: 'FeatureCollection', features: allLines }))
  await writeFile(join(RAILWAY, 'railway_stations.geojson'), JSON.stringify({ type: 'FeatureCollection', features: allStations }))
  await writeFile(join(RAILWAY, 'index.json'), JSON.stringify({
    generated_from: 'OpenStreetMap railway=rail usage=main|branch (national/state railways + high-speed); stations snapped onto the track graph; one file per country',
    system_count: systems.length, line_total: lineTotal, station_total: stationTotal, systems,
  }, null, 1))
  console.log(`\ndone: ${systems.length} countries, ${lineTotal} lines, ${stationTotal} stations`)
}

main().catch((e) => { console.error(e); process.exit(1) })
