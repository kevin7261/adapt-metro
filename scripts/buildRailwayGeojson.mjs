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
    .replace(/^JR\s*/i, '') // JR東北本線 ≡ 東北本線 — same line, two OSM labels → merge (串接)
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

function buildSystem(raw, override) {
  const { continent, country } = raw
  const country_zh = raw.country_zh ?? country
  const cc = raw.cc
  // Two per-country operator filters (data/railway/_overrides/{cc}_exclude.json),
  // both matched against operator/network/name. Priority: PROTECT > DROP > keep.
  //   include — PROTECT list (highest priority): keep whatever matches even if the
  //             DROP list would catch it. Japan 只收 JR＋新幹線: include the JR
  //             markers (旅客鉄道/JR/新幹線) so JR track survives when its way is
  //             mislabelled with a parallel 私鐵 line name (op=東海旅客鉄道
  //             nm=名古屋鉄道名古屋本線) or on JR/私鐵 shared track
  //             (op=西日本旅客鉄道;井原鉄道, 関西空港線, 肥薩/くま川).
  //   exclude — DROP list: 私鐵/第三セクター/貨物/觀光/保存 (freight 臨港線, 台糖…),
  //             also catches no-operator ways whose name embeds the company
  //             (南海電気鉄道南海本線).
  //   default — KEEP (bare-named JR lines with no operator, e.g. 東海道本線, survive).
  const protectRe = override?.include ? new RegExp(override.include, 'i') : null
  const excludeRe = override?.exclude ? new RegExp(override.exclude, 'i') : null
  const dropped = (op, net, nm, nmZh = '') => {
    const hay = `${op || ''} ${net || ''} ${nm || ''} ${nmZh || ''}`
    if (protectRe && protectRe.test(hay)) return false
    if (excludeRe && excludeRe.test(hay)) return true
    return false
  }

  // ── 1. parse track ways, grouped by (normalized) LINE name ─────────────────
  const ways = [] // { coords:[[lon,lat]…], cls, line }
  for (const w of raw.trackElements) {
    if (w.type !== 'way' || !w.geometry || w.geometry.length < 2) continue
    const t = w.tags || {}
    // filter track by operator/network/name (exclude freight 臨港線/台糖; or, with an
    // include whitelist, keep only JR＋新幹線). HSR track (highspeed=yes) is always
    // kept: 日本所有高鐵＝新幹線＝JR, so it survives the JR whitelist even if the way
    // is tagged with the infrastructure holder (JRTT) rather than the JR operator.
    if (t.highspeed !== 'yes' && dropped(t.operator, t.network, t.name, t['name:zh'])) continue
    ways.push({
      coords: w.geometry.map((p) => [p.lon, p.lat]),
      cls: t.highspeed === 'yes' ? 'high_speed' : 'conventional',
      line: lineName(t, country),
    })
  }
  if (!ways.length) return { type: 'FeatureCollection', railway_system: null, features: [] }
  // Merge high-speed line-NAME variants where one name contains another
  // (台灣高速鐵路 ⊇ 高速鐵路 → one line) — relabel the ways so the track graph sees a
  // single HSR line. Distinct Shinkansen (東海道 vs 山陽, neither a substring of the
  // other) are unaffected → safe for Japan.
  const hsCount = new Map()
  for (const w of ways) if (w.line && w.cls === 'high_speed') hsCount.set(w.line, (hsCount.get(w.line) || 0) + 1)
  const hsNames = [...hsCount.keys()]
  const remap = new Map()
  for (const short of hsNames) {
    const longer = hsNames.find((l) => l !== short && l.includes(short) && hsCount.get(l) >= hsCount.get(short))
    if (longer) remap.set(short, longer)
  }
  if (remap.size) for (const w of ways) if (w.line && remap.has(w.line)) w.line = remap.get(w.line)

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
    // Same operator/network/name filter as track (exclude, or JR＋新幹線 whitelist).
    // Stations that survive but don't snap onto kept track are dropped later anyway
    // (invariant: no station without a line) — so 私鐵 platforms at a JR interchange
    // that share a name still fall away if no JR track passes.
    if (dropped(e.tags.operator, e.tags.network, e.tags.name)) continue
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

  // ── 3. EVERY line is built from its OWN OSM route=railway relation, per-line — NOT
  // a global track-walk. The global walk conflates STACKED PARALLEL lines (東京–横浜 =
  // 東海道/横須賀/京浜東北) → scrambled sequence + wrong stations (東海道本線 came out as
  // 20 fragments with 相鉄 西横浜 in it). And OSM lists relation members in NON-geographic
  // order, so we can't just read the sequence off. Instead, per relation: build THAT
  // line's own track graph → main path (graph diameter; a loop → walk the cycle) →
  // order the line's stations by arc-length along it → connect consecutive. This is
  // 台灣 台鐵's track method, scoped per line (使用者：參考台灣畫法、同一路線一定串接). ──
  const ekey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const lineHs = new Map()
  for (const w of ways) if (w.line) lineHs.set(w.line, (lineHs.get(w.line) || false) || w.cls === 'high_speed')
  const clsOfLine = (ln) => (ln?.startsWith('__') ? ln.slice(2) : (lineHs.get(ln) ? 'high_speed' : 'conventional'))

  // way geometry + highspeed flag by OSM id (relations reference member ways by id)
  const trackGeom = new Map(); const hsWayIds = new Set()
  for (const w of raw.trackElements) if (w.type === 'way' && w.geometry?.length >= 2) {
    trackGeom.set(w.id, w.geometry)
    if ((w.tags || {}).highspeed === 'yes') hsWayIds.add(w.id)
  }
  const rawIdx = new Map(rawSt.map((s, i) => [s.id, i]))
  const stIdx = gridIndex(stations.map((s) => ({ lon: s.lon, lat: s.lat })))
  const created = []
  // map an OSM member stop-node → our merged station. strict = exact OSM-id match
  // only (used for 一般國鐵: a PRIVATE line's member stations were excluded at parse,
  // so they miss → the private line ends up with <2 stops → dropped, no pollution).
  // lenient (高鐵) also snaps ≤2.5 km / mints a new station so no HSR stop is lost.
  const nodeToStation = (n, strict) => {
    const idx = rawIdx.get(`n${n.id}`)
    if (idx !== undefined) return `s${rawSt[find(idx)].id}`
    const near = stIdx.nearest(n.lon, n.lat, strict ? 200 : 2500)
    if (near.i >= 0) return stations[near.i].id
    if (strict) return null
    for (const c of created) if (haversine([n.lon, n.lat], [c.lon, c.lat]) < 800) return c.id
    const nm = nameFor(n.tags, country); if (!nm) return null
    const st = { id: `s${n.type?.[0] ?? 'n'}${n.id}`, name: nm, tags: n.tags || {}, hsr: true, lon: n.lon, lat: n.lat }
    stations.push(st); stById.set(st.id, st); created.push(st)
    return st.id
  }

  // Build ONE relation's track into an ordered polyline (the line's main path). Grid
  // key ~18 m collapses parallel up/down tracks into one centreline. Open line →
  // graph diameter (2× Dijkstra between the farthest leaves); loop → walk the cycle.
  const GRID = 0.0002
  const gkey = (lon, lat) => `${Math.round(lon / GRID)}:${Math.round(lat / GRID)}`
  const trackOrder = (wayIds) => {
    const adj = new Map(); const pos = new Map()
    const V = (lon, lat) => { const k = gkey(lon, lat); if (!adj.has(k)) { adj.set(k, new Map()); pos.set(k, [lon, lat]) } return k }
    for (const wid of wayIds) {
      const g = trackGeom.get(wid); if (!g) continue
      for (let i = 0; i + 1 < g.length; i++) {
        const a = V(g[i].lon, g[i].lat), b = V(g[i + 1].lon, g[i + 1].lat)
        if (a === b) continue
        const d = haversine(pos.get(a), pos.get(b))
        const ea = adj.get(a); if (!(ea.get(b) <= d)) ea.set(b, d)
        const eb = adj.get(b); if (!(eb.get(a) <= d)) eb.set(a, d)
      }
    }
    if (adj.size < 2) return null
    // largest connected component
    const seen = new Set(); let comp = []
    for (const start of adj.keys()) {
      if (seen.has(start)) continue
      const c = []; const stack = [start]; seen.add(start)
      while (stack.length) { const u = stack.pop(); c.push(u); for (const v of adj.get(u).keys()) if (!seen.has(v)) { seen.add(v); stack.push(v) } }
      if (c.length > comp.length) comp = c
    }
    const dij = (src) => {
      const dist = new Map([[src, 0]]); const prev = new Map(); const H = [[0, src]]
      const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (H[p][0] <= H[i][0]) break;[H[p], H[i]] = [H[i], H[p]]; i = p } }
      const pop = () => { const t = H[0], l = H.pop(); if (H.length) { H[0] = l; let i = 0; for (;;) { let a = 2 * i + 1, b = 2 * i + 2, s = i; if (a < H.length && H[a][0] < H[s][0]) s = a; if (b < H.length && H[b][0] < H[s][0]) s = b; if (s === i) break;[H[s], H[i]] = [H[i], H[s]]; i = s } } return t }
      while (H.length) { const [d, u] = pop(); if (d > (dist.get(u) ?? Infinity)) continue; for (const [v, w] of adj.get(u)) { const nd = d + w; if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); H.push([nd, v]); up(H.length - 1) } } }
      return { dist, prev }
    }
    const deg1 = comp.filter((k) => adj.get(k).size === 1)
    let path
    if (deg1.length >= 2) {
      const A = dij(deg1[0]); let a1 = deg1[0], ad = -1; for (const [n, d] of A.dist) if (d > ad) { ad = d; a1 = n }
      const B = dij(a1); let b1 = a1, bd = -1; for (const [n, d] of B.dist) if (d > bd) { bd = d; b1 = n }
      path = []; let cur = b1; while (cur !== undefined) { path.push(cur); cur = B.prev.get(cur) }
    } else { // loop / no clean endpoints → walk the cycle greedily
      const used = new Set([comp[0]]); path = [comp[0]]; let cur = comp[0]
      for (;;) { let nx; for (const v of adj.get(cur).keys()) if (!used.has(v)) { nx = v; break } if (nx === undefined) break; used.add(nx); path.push(nx); cur = nx }
    }
    const pts = path.map((k) => pos.get(k))
    const arc = [0]; for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + haversine(pts[i - 1], pts[i]))
    return { pts, arc }
  }

  // ── 4. per-relation line assembly ──
  const relEls = raw.relElements || []
  const relNodeById = new Map()
  for (const e of relEls) if (e.type === 'node') relNodeById.set(e.id, e)
  // coarse cell index of stations for cheap "near this path" membership prefiltering
  const SCELL = 0.0012 // ~130 m
  const scell = (lon, lat) => `${Math.round(lon / SCELL)}:${Math.round(lat / SCELL)}`
  const stByCell = new Map()
  for (const s of stations) { const k = scell(s.lon, s.lat); if (!stByCell.has(k)) stByCell.set(k, []); stByCell.get(k).push(s) }
  const edges = new Map() // "sa|sb" → { a, b, lines:Map(name→votes), hs }
  // Group ALL relations of the same line name and UNION their member track/stops, so
  // a line split across several route=railway relations (東海道本線 = JR 東/海/西 三社
  // 三個關聯) becomes ONE graph → ONE main path → ONE contiguous ordering, not one
  // fragment per relation. Private LINE relations (operator=京王電鉄…) are dropped here
  // — so snapping stations to a kept line's track never pulls in 私鐵 stops.
  const lineRel = new Map() // rname → { ways:Set, nodes:[] }
  for (const rel of relEls) {
    if (rel.type !== 'relation' || !rel.members) continue
    const rname = lineName(rel.tags, country); if (!rname) continue
    if (dropped(rel.tags.operator, rel.tags.network, rel.tags.name, rel.tags['name:zh'])) continue
    const g = lineRel.get(rname) || { ways: new Set(), nodes: [] }
    for (const m of rel.members) {
      if (m.type === 'way' && trackGeom.has(m.ref)) g.ways.add(m.ref)
      else if (m.type === 'node') { const n = relNodeById.get(m.ref); if (n) g.nodes.push(n) }
    }
    lineRel.set(rname, g)
  }
  for (const [rname, g] of lineRel) {
    if (g.ways.size === 0) continue
    let tot = 0, hs = 0
    for (const wid of g.ways) { tot++; if (hsWayIds.has(wid)) hs++ }
    const cls = hs / tot >= 0.5 ? 'high_speed' : 'conventional'
    const ord = trackOrder([...g.ways]); if (!ord) continue
    // membership: (a) member stop nodes — most JR line relations actually list NONE
    // (東北本線/山手線/中央本線 have 0), so (b) also snap our merged stations that lie
    // within SNAP m of THIS line's own path. The path is only this line's track, so
    // parallel lines (京浜東北 beside 東北本線) don't contaminate — except where their
    // tracks physically overlap, which is a shared station anyway.
    const member = new Set(); const cand = new Set()
    for (const n of g.nodes) {
      const t = n.tags || {}
      if (!/^(station|halt|stop)$/.test(t.railway || '')) continue
      if (/线路所|線路所|信号場|信號場|信号所|信號所/.test(t.name || t['name:ja'] || t['name:zh'] || '')) continue
      const sid = nodeToStation(n, false); if (sid) { member.add(sid); cand.add(sid) }
    }
    const pathCells = new Set(); for (const p of ord.pts) pathCells.add(scell(p[0], p[1]))
    for (const cellKey of pathCells) {
      const [cx, cy] = cellKey.split(':').map(Number)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const s of stByCell.get(`${cx + dx}:${cy + dy}`) || []) cand.add(s.id)
    }
    // order candidates by arc along the path; keep member nodes always, snapped ones
    // only if truly on the track (≤ SNAP), drop mis-snaps
    const SNAP = 260
    const proj = []
    for (const sid of cand) {
      const s = stById.get(sid); let ba = 0, md = Infinity
      for (let i = 0; i < ord.pts.length; i++) { const d = haversine([s.lon, s.lat], ord.pts[i]); if (d < md) { md = d; ba = ord.arc[i] } }
      if (md > (member.has(sid) ? 3000 : SNAP)) continue
      proj.push({ sid, arc: ba })
    }
    if (proj.length < 2) continue
    proj.sort((a, b) => a.arc - b.arc)
    // dedupe same-name / co-located stops (JR East vs JR Central 米原 that didn't
    // merge globally would otherwise appear twice and branch the chain → fragments)
    const seenNm = []; const uniq = []
    for (const p of proj) {
      const s = stById.get(p.sid)
      if (seenNm.some((q) => norm(q.name) === norm(s.name) && haversine([s.lon, s.lat], [q.lon, q.lat]) < 3000)) continue
      seenNm.push(s); uniq.push(p.sid)
    }
    if (uniq.length < 2) continue
    lineHs.set(rname, cls === 'high_speed')
    // connect consecutive (authoritative order → ONE contiguous line). Multiple
    // relations of the same line share boundary stations → they join into one run.
    for (let i = 0; i + 1 < uniq.length; i++) {
      const a = uniq[i], b = uniq[i + 1]; if (a === b) continue
      const k = ekey(a, b)
      if (!edges.has(k)) edges.set(k, { a, b, lines: new Map(), hs: cls === 'high_speed' })
      const e = edges.get(k); e.lines.set(rname, (e.lines.get(rname) || 0) + 10); if (cls === 'high_speed') e.hs = true
    }
  }
  // dominant NAMED line of an edge (majority track vote); its group key falls back
  // to the class when the track was unnamed (a connector), so it is still drawn.
  const domLine = (rec) => [...rec.lines.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const groupKey = (rec) => domLine(rec) ?? `__${rec.hs ? 'high_speed' : 'conventional'}`

  // A route's class is the class of the FILE it lands in (cls), decided per edge by
  // rec.hs (relation-built 高鐵 vs walk-built 一般國鐵) — NOT by the line name. A
  // conventional line that carries some KTX/highspeed track (Korea Honam Line) must
  // stay 一般國鐵, not jump to 高鐵 just because clsOfLine() sees a highspeed way.
  const routeMeta = (ln, idCc, cls) => {
    const name = ln.startsWith('__') ? classLabel(country, cls) : ln
    return {
      route_id: `rw-${idCc}-${encodeURIComponent(name)}`,
      route_name: name, route_name_local: name, route_ref: null,
      route_color: classColor(country, cls), rail_class: cls,
      network: `${country} Railways`, network_local: null, operator: null,
      wikidata: null, wikipedia: null, status: null, order_suspect: 0,
    }
  }
  const stringPaths = (es) => {
    const g = new Map(); const add = (x, y) => { if (!g.has(x)) g.set(x, new Set()); g.get(x).add(y) }
    for (const [a, b] of es) { add(a, b); add(b, a) }
    const usedE = new Set(); const runs = []
    const walk = (start) => {
      const path = [start]; let cur = start
      for (;;) { const nx = [...(g.get(cur) || [])].find((m) => !usedE.has(ekey(cur, m))); if (nx === undefined) break; usedE.add(ekey(cur, nx)); path.push(nx); cur = nx }
      if (path.length > 1) runs.push(path)
    }
    for (const n of g.keys()) if ((g.get(n).size % 2) === 1) walk(n)
    for (const [a, b] of es) if (!usedE.has(ekey(a, b))) walk(a)
    return runs
  }
  const coordOf = (sid) => { const s = stById.get(sid); return [s.lon, s.lat] }

  // ── 6. assemble ONE FeatureCollection from a subset of the station edges. Called
  // once per rail class so 高鐵 (high_speed) and 一般國鐵 (conventional) become
  // SEPARATE systems/files (使用者：把高鐵和一般國鐵分開，一國拆兩檔兩圖層). A station
  // that serves both classes appears in BOTH files, each with the subset of lines /
  // degree / interchange computed WITHIN that class' sub-network. ids are prefixed
  // by sysCc (`{cc}-hsr` / `{cc}-rail`) so seg_id/route_id stay unique when the two
  // files are merged into the global railway_lines/stations aggregate. ────────────
  const assemble = (edgeList, sysCc, cls) => {
    // 6a. station Point features + degree / interchange (within this class subset)
    const neigh = new Map(); const stLines = new Map()
    const link = (a, b) => { if (!neigh.has(a)) neigh.set(a, new Set()); if (!neigh.has(b)) neigh.set(b, new Set()); neigh.get(a).add(b); neigh.get(b).add(a) }
    const addLn = (sid, ln) => { if (ln && !ln.startsWith('__')) { if (!stLines.has(sid)) stLines.set(sid, new Set()); stLines.get(sid).add(ln) } }
    for (const rec of edgeList) { link(rec.a, rec.b); const ln = domLine(rec); addLn(rec.a, ln); addLn(rec.b, ln) }
    const drawn = new Set([...neigh.keys()])
    const features = []
    for (const sid of drawn) {
      const s = stById.get(sid); if (!s) continue
      let lns = [...(stLines.get(sid) || [])]
      if (!lns.length) lns = [classLabel(country, cls)] // a connector-only station still needs ≥1 line
      const degree = neigh.get(sid)?.size ?? 0
      const isInter = new Set(lns).size >= 2 || degree > 2
      const isTerm = degree === 1
      features.push({
        type: 'Feature',
        properties: {
          station_id: sid, station_name: s.name, station_name_local: s.name,
          network: `${country} Railways`, network_local: null, operator: s.tags.operator || null,
          city: country, country,
          lines: lns, line_ids: lns.map((ln) => `rw-${sysCc}-${encodeURIComponent(ln)}`), line_names: lns,
          station_role: isInter ? 'interchange' : (isTerm ? 'terminus' : 'normal'),
          station_degree: degree, is_interchange: isInter, is_terminus: isTerm,
          wikidata: s.tags.wikidata || null, wikipedia: s.tags.wikipedia || null,
        },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })
    }
    // 6b. line features: ONE feature per line (metro-style). Group edges by their
    // dominant line; string them into maximal paths (a line that is physically two
    // pieces — 縱貫線 兩端 — becomes 2 LineStrings in one feature).
    // Group each edge under EVERY named line that runs over it (not just the dominant
    // one) — a shared trunk (東海道本線 ∥ 京浜東北線 東京–横浜) then stays contiguous for
    // BOTH lines instead of one of them dropping the shared segment and fragmenting.
    const byLine = new Map()
    for (const rec of edgeList) {
      const named = [...rec.lines.keys()].filter((k) => k && !k.startsWith('__'))
      const keys = named.length ? named : [`__${rec.hs ? 'high_speed' : 'conventional'}`]
      for (const key of keys) { if (!byLine.has(key)) byLine.set(key, []); byLine.get(key).push([rec.a, rec.b]) }
    }
    let segN = 0, segTotal = 0
    for (const [ln, es] of byLine) {
      const runs = stringPaths(es)
      if (!runs.length) continue
      const stationIds = [...new Set(runs.flat())]
      const rm = { ...routeMeta(ln, sysCc, cls), stations: stationIds.map((sid) => ({ station_id: sid, station_name: stById.get(sid)?.name ?? sid, mileage: null })), pass_stations: [] }
      const coords = runs.map((path) => path.map(coordOf))
      features.push({
        type: 'Feature',
        properties: {
          seg_id: `${sysCc}-${segN++}`,
          routes: [rm], route_count: 1,
          route_refs: [rm.route_name], route_colors: [rm.route_color], route_color: rm.route_color,
          rail_class: rm.rail_class, city: country, country,
        },
        geometry: { type: 'MultiLineString', coordinates: coords },
      })
      segTotal += coords.reduce((a, p) => a + p.length - 1, 0)
    }
    const namedLines = [...byLine.keys()].filter((k) => !k.startsWith('__'))
    const meta = {
      continent, country, country_zh, city: country, city_zh: country_zh, unit: 'country',
      osm_networks: namedLines.slice().sort().slice(0, 60),
      operator: null,
      line_count: namedLines.length, segment_count: segTotal,
      station_count: drawn.size,
      interchange_count: [...drawn].filter((sid) => (neigh.get(sid)?.size ?? 0) > 2 || (stLines.get(sid)?.size ?? 0) >= 2).length,
    }
    return { features, meta }
  }

  // Partition edges by rail class and emit one subsystem per non-empty class. An
  // edge's class is decided by HOW it was built (rec.hs: relation-built 高鐵 vs
  // walk-built 一般國鐵), NOT by clsOfLine(line name) — so a conventional line that
  // carries some highspeed track (Korea Honam Line) stays wholly 一般國鐵.
  const edgeClass = (rec) => (rec.hs ? 'high_speed' : 'conventional')
  const CLASSES = [
    { suffix: 'hsr', cls: 'high_speed', zh: '高鐵', en: 'High-speed' },
    { suffix: 'rail', cls: 'conventional', zh: '一般國鐵', en: 'Conventional' },
  ]
  const out = []
  for (const C of CLASSES) {
    const sub = [...edges.values()].filter((r) => edgeClass(r) === C.cls)
    if (!sub.length) continue
    const sysCc = `${cc}-${C.suffix}`
    const { features, meta } = assemble(sub, sysCc, C.cls)
    if (!features.length) continue
    const m = { ...meta, rail_class: C.cls, class_zh: C.zh, class_en: C.en }
    out.push({
      suffix: C.suffix, rail_class: C.cls, class_zh: C.zh, class_en: C.en,
      fc: { type: 'FeatureCollection', railway_system: m, metro_system: { ...m, kind: 'railway' }, features },
    })
  }
  return out
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
    const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let override = null
    try {
      const ov = JSON.parse(await readFile(join(OVERRIDES, `${raw.cc}_exclude.json`), 'utf8'))
      override = {
        exclude: ov.operators?.length ? ov.operators.map(reEsc).join('|') : null,
        include: ov.include?.length ? ov.include.map(reEsc).join('|') : null,
      }
    } catch { /* no override */ }

    // buildSystem now returns an ARRAY of subsystems (高鐵 / 一般國鐵 split, 使用者:
    // 一國拆兩檔兩圖層). Write ONE file per subsystem: {cc}-hsr / {cc}-rail.
    const subs = buildSystem(raw, override)
    if (!subs.length) { console.log(`  ${raw.cc}: 0 features, skip`); continue }
    const cont = CONTINENT_DIR[raw.continent] || 'other'
    const parts = []
    for (const sub of subs) {
      const sysCc = `${raw.cc}-${sub.suffix}`
      const rel = `systems/${cont}/${countrySlug(raw.country)}/${sysCc}.geojson`
      await mkdir(dirname(join(RAILWAY, rel)), { recursive: true })
      await writeFile(join(RAILWAY, rel), JSON.stringify(sub.fc))
      const m = sub.fc.railway_system
      systems.push({
        file: rel, continent: raw.continent, country: raw.country, country_zh: m.country_zh,
        city: m.city, city_zh: m.city_zh, unit: m.unit,
        rail_class: sub.rail_class, class_zh: sub.class_zh, class_en: sub.class_en,
        osm_networks: m.osm_networks, operator: m.operator,
        line_count: m.line_count, segment_count: m.segment_count, station_count: m.station_count,
      })
      lineTotal += m.line_count; stationTotal += m.station_count
      for (const feat of sub.fc.features) (feat.geometry.type === 'Point' ? allStations : allLines).push(feat)
      parts.push(`${sub.class_zh} ${m.line_count}線/${m.station_count}站`)
    }
    console.log(`  ${raw.cc} (${raw.country_zh}): ${parts.join('，')}`)
  }

  await writeFile(join(RAILWAY, 'railway_lines.geojson'), JSON.stringify({ type: 'FeatureCollection', features: allLines }))
  await writeFile(join(RAILWAY, 'railway_stations.geojson'), JSON.stringify({ type: 'FeatureCollection', features: allStations }))
  await writeFile(join(RAILWAY, 'index.json'), JSON.stringify({
    generated_from: 'OpenStreetMap railway=rail usage=main|branch (national/state railways + high-speed); stations snapped onto the track graph; TWO files per country split by rail class — {cc}-hsr (高鐵) and {cc}-rail (一般國鐵)',
    system_count: systems.length, line_total: lineTotal, station_total: stationTotal, systems,
  }, null, 1))
  console.log(`\ndone: ${systems.length} countries, ${lineTotal} lines, ${stationTotal} stations`)
}

main().catch((e) => { console.error(e); process.exit(1) })
