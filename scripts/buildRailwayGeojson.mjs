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

  // ── 3. GLOBAL TRACK GRAPH — connectivity comes from REAL track, not line names.
  // OSM names change at junctions (台中線→「山線、海線共用路段」→彰化; 臺東線→南迴線
  // near 臺東), so grouping only by name leaves the network 中斷 at every boundary. ─
  const ekey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const gk = (x, y) => `${x.toFixed(6)},${y.toFixed(6)}`
  const gvId = new Map(); const gvc = []; const gadj = []
  const gV = (x, y) => { const k = gk(x, y); let i = gvId.get(k); if (i === undefined) { i = gvc.length; gvId.set(k, i); gvc.push([x, y]); gadj.push([]) } return i }
  for (const w of ways) for (let i = 0; i + 1 < w.coords.length; i++) {
    const a = gV(...w.coords[i]), b = gV(...w.coords[i + 1])
    if (a === b) continue
    gadj[a].push({ to: b, line: w.line, hs: w.cls === 'high_speed' })
    gadj[b].push({ to: a, line: w.line, hs: w.cls === 'high_speed' })
  }
  // class per line name (high_speed if any of its ways is high-speed)
  const lineHs = new Map()
  for (const w of ways) if (w.line) lineHs.set(w.line, (lineHs.get(w.line) || false) || w.cls === 'high_speed')
  const clsOfLine = (ln) => (ln?.startsWith('__') ? ln.slice(2) : (lineHs.get(ln) ? 'high_speed' : 'conventional'))
  const hsLineNames = [...lineHs.entries()].filter(([, h]) => h).map(([n]) => n)
  // 高鐵 (high_speed) is NOT built by track-walk: HSR viaducts pass OVER dense local
  // stations (東海道新幹線 track ← 東急武蔵小杉 32m away), which a walk with the 250m
  // tolerance wrongly grabs. Instead the walk SKIPS all HSR corridors and 高鐵 is
  // built from OSM route=railway relations' ordered stop members (below) — the real
  // stops, excluding viaduct passovers (see skill railway-osm-fetch). So the walk
  // here produces the CONVENTIONAL (一般國鐵) network only, exactly like 台灣 台鐵.

  // ── 4. snap stations onto the track graph ──
  const gIdx = gridIndex(gvc.map(([x, y]) => ({ lon: x, lat: y })))
  for (const s of stations) { const { i } = gIdx.nearest(s.lon, s.lat, LINE_SNAP); if (i >= 0) s.gv = i } // start vertex
  // Map EVERY track vertex to the nearest station within STATION_TOL, so a walk
  // registers a station whenever it enters that station's vicinity — robust to
  // which exact vertex the station node snapped to (platform vs through track);
  // otherwise the walk sails past 八堵/branch junctions and the network fragments.
  const STATION_TOL = 250
  const stIdx = gridIndex(stations.map((s) => ({ lon: s.lon, lat: s.lat })))
  const stAtV = new Map() // vertexIdx → stationId
  for (let v = 0; v < gvc.length; v++) { const { i } = stIdx.nearest(gvc[v][0], gvc[v][1], STATION_TOL); if (i >= 0) stAtV.set(v, stations[i].id) }

  // ── 5. station adjacency: from each station, walk each track corridor to the
  // NEXT station, continuing STRAIGHT through un-stationed merge/split points (so
  // 山/海線 rejoin 縱貫線 at 彰化 and 台東線 reaches 臺東). Parallel up/down tracks
  // reach the same next station → deduped by the undirected pair. HSR-flag widening
  // is dropped: connectivity is purely track-based. ───────────────────────────────
  const angleAt = (p, c, n) => {
    const v1x = gvc[c][0] - gvc[p][0], v1y = gvc[c][1] - gvc[p][1]
    const v2x = gvc[n][0] - gvc[c][0], v2y = gvc[n][1] - gvc[c][1]
    const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1e-12
    return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / m)))
  }
  const edges = new Map() // "sa|sb" → { a, b, lines:Map(name→votes), hs }
  for (const s of stations) {
    if (s.gv === undefined) continue
    for (const first of [...new Set(gadj[s.gv].map((e) => e.to))]) {
      const e0 = gadj[s.gv].find((e) => e.to === first)
      if (e0.hs) continue // HSR corridors are built from relations, not the walk (viaduct pollution)
      const seen = new Set([s.gv, first]); let prev = s.gv, cur = first, guard = 0
      const votes = new Map()
      if (e0.line) votes.set(e0.line, 1)
      while (guard++ < 4000) {
        const sid = stAtV.get(cur)
        if (sid !== undefined && sid !== s.id) {
          if (haversine([s.lon, s.lat], gvc[cur]) <= capFor('conventional')) {
            const k = ekey(s.id, sid)
            if (!edges.has(k)) edges.set(k, { a: s.id, b: sid, lines: new Map(), hs: false })
            const rec = edges.get(k)
            for (const [ln, c] of votes) rec.lines.set(ln, (rec.lines.get(ln) || 0) + c)
          }
          break
        }
        const nbrs = [...new Set(gadj[cur].map((e) => e.to))].filter((v) => v !== prev && !seen.has(v))
        if (!nbrs.length) break
        let nxt = nbrs[0]
        if (nbrs.length > 1) { // junction: keep going straight, else stop
          nxt = nbrs.reduce((b, v) => (angleAt(prev, cur, v) < angleAt(prev, cur, b) ? v : b), nbrs[0])
          if (angleAt(prev, cur, nxt) > 1.05) break // > ~60° turn → ambiguous
        }
        const e = gadj[cur].find((x) => x.to === nxt)
        if (e.hs) break // ran onto HSR track — stop; HSR is relation-built
        if (e.line) votes.set(e.line, (votes.get(e.line) || 0) + 1)
        seen.add(nxt); prev = cur; cur = nxt
      }
    }
  }
  // Order a set of stations into ONE contiguous chain by nearest-neighbour from a
  // geographic extreme, then connect consecutive ones (straight segment, like 縱貫線).
  const nnChain = (pts, lineNm, cap) => {
    if (pts.length < 2) return
    const far = (from, arr) => arr.reduce((b, p) => haversine([from.lon, from.lat], [p.lon, p.lat]) > haversine([from.lon, from.lat], [b.lon, b.lat]) ? p : b, arr[0])
    const start = far(far(pts[0], pts), pts)
    const used = new Set([start.id]); const order = [start]; let curS = start
    while (order.length < pts.length) {
      let best = null, bd = Infinity
      for (const p of pts) { if (used.has(p.id)) continue; const d = haversine([curS.lon, curS.lat], [p.lon, p.lat]); if (d < bd) { bd = d; best = p } }
      if (!best) break
      used.add(best.id); order.push(best); curS = best
    }
    let added = 0
    for (let i = 0; i + 1 < order.length; i++) {
      const a = order[i], b = order[i + 1]
      if (haversine([a.lon, a.lat], [b.lon, b.lat]) > cap) continue
      const k = ekey(a.id, b.id)
      if (!edges.has(k)) edges.set(k, { a: a.id, b: b.id, lines: new Map(), hs: true })
      const rec = edges.get(k); rec.lines.set(lineNm, (rec.lines.get(lineNm) || 0) + 10); rec.hs = true
      added++
    }
    return added
  }

  // ── 5b. 高鐵 lines from OSM route=railway relations' ORDERED STOP MEMBERS. These
  // are the real stops — a track-walk over HSR viaducts wrongly grabs local stations
  // underneath (東海道新幹線 ← 東急武蔵小杉) and the highspeed=yes station tag is too
  // sparse (China ~none), but the relation members include the tag-less majors
  // (小田原/名古屋) and exclude the passovers. Map each stop node → merged station,
  // NN-order, connect consecutive → ONE CONTIGUOUS line (使用者：同一路線一定串接). ──
  const relEls = raw.relElements || []
  const relNodeById = new Map()
  for (const e of relEls) if (e.type === 'node') relNodeById.set(e.id, e)
  const rawIdx = new Map(rawSt.map((s, i) => [s.id, i]))
  const nodeToStation = (n) => {
    const idx = rawIdx.get(`n${n.id}`)
    if (idx !== undefined) return `s${rawSt[find(idx)].id}`
    const { i } = stIdx.nearest(n.lon, n.lat, 1500) // stop node filtered from station set → nearest
    return i >= 0 ? stations[i].id : null
  }
  let relHsAdded = 0
  for (const rel of relEls) {
    if (rel.type !== 'relation' || !rel.members) continue
    const rname = lineName(rel.tags, country)
    if (!rname) continue // bridge/tunnel sub-relations (…高架橋) fall out here
    const stopIds = []; const seenSid = new Set()
    for (const m of rel.members) {
      if (m.type !== 'node') continue
      const n = relNodeById.get(m.ref); if (!n) continue
      const t = n.tags || {}
      if (!/^(station|halt|stop)$/.test(t.railway || '')) continue
      if (/线路所|線路所|信号場|信號場|信号所|信號所|線区|渡り線/.test(t.name || t['name:zh'] || t['name:ja'] || '')) continue // 号志站/junction, not a stop
      const sid = nodeToStation(n); if (!sid || seenSid.has(sid)) continue
      seenSid.add(sid); stopIds.push(sid)
    }
    if (stopIds.length < 2) continue
    lineHs.set(rname, true)
    const pts = stopIds.map((id) => stById.get(id)).filter(Boolean)
    relHsAdded += nnChain(pts, rname, capFor('high_speed')) || 0
  }

  // Fallback: a country with HSR track but NO usable relations (e.g. 台灣高鐵 if its
  // relation is missing) → build the single HSR line by NN over HSR-operator stations.
  if (!relHsAdded && hsLineNames.length === 1) {
    nnChain(stations.filter((s) => s.hsr), hsLineNames[0], capFor('high_speed'))
  }
  // dominant NAMED line of an edge (majority track vote); its group key falls back
  // to the class when the track was unnamed (a connector), so it is still drawn.
  const domLine = (rec) => [...rec.lines.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const groupKey = (rec) => domLine(rec) ?? `__${rec.hs ? 'high_speed' : 'conventional'}`

  const routeMeta = (ln, idCc) => {
    const cls = clsOfLine(ln)
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
  const assemble = (edgeList, sysCc) => {
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
      if (!lns.length) lns = [classLabel(country, 'conventional')] // a connector-only station still needs ≥1 line
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
    const byLine = new Map()
    for (const rec of edgeList) {
      const key = groupKey(rec)
      if (!byLine.has(key)) byLine.set(key, [])
      byLine.get(key).push([rec.a, rec.b])
    }
    let segN = 0, segTotal = 0
    for (const [ln, es] of byLine) {
      const runs = stringPaths(es)
      if (!runs.length) continue
      const stationIds = [...new Set(runs.flat())]
      const rm = { ...routeMeta(ln, sysCc), stations: stationIds.map((sid) => ({ station_id: sid, station_name: stById.get(sid)?.name ?? sid, mileage: null })), pass_stations: [] }
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

  // Partition edges by rail class and emit one subsystem per non-empty class.
  const edgeClass = (rec) => clsOfLine(groupKey(rec))
  const CLASSES = [
    { suffix: 'hsr', cls: 'high_speed', zh: '高鐵', en: 'High-speed' },
    { suffix: 'rail', cls: 'conventional', zh: '一般國鐵', en: 'Conventional' },
  ]
  const out = []
  for (const C of CLASSES) {
    const sub = [...edges.values()].filter((r) => edgeClass(r) === C.cls)
    if (!sub.length) continue
    const sysCc = `${cc}-${C.suffix}`
    const { features, meta } = assemble(sub, sysCc)
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
