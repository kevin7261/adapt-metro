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

// ── 日本一國拆六社（使用者：日本國鐵不要全部一起，改成 JR東日本/西日本/北海道…）────────
// Japan is NOT one system: partition the country into the six JR passenger
// companies BEFORE buildSystem, each company then becoming its own system pair
// (as-jpn-{east|west|central|hokkaido|shikoku|kyushu}-{hsr|rail}). Assignment:
//   way      → operator regex (earliest match wins for joint "東;西" ways)
//              → shinkansen line-name map (no-op 東海道新幹線 ways, op=九州新幹線 quirk)
//              → nearest already-assigned way (geo fallback for 湖西線/unnamed no-op)
//   relation → operator / shinkansen name; else MEMBER-WAY SHARE: a trunk line that
//              is ONE relation spanning companies (東海道本線 = 4140 members 東/海/西)
//              is given to EVERY company holding ≥15% (or ≥10) of its member ways —
//              each company's build only sees its own ways, so trackOrder yields
//              that company's stretch (largest component) with correct ordering.
// 北陸新幹線 (joint 東;西) goes wholly to JR東日本 (earliest-listed operator) — known v1
// simplification. 私鐵 ways may get geo-assigned here but the jpn exclude override
// still drops them inside buildSystem (partition ≠ inclusion).
const JP_COMPANIES = [
  { slug: 'hokkaido', zh: 'JR北海道', en: 'JR Hokkaido', re: /北海道旅客鉄道|JR\s*Hokkaido/i },
  { slug: 'east', zh: 'JR東日本', en: 'JR East', re: /東日本旅客鉄道|JR\s*East/i },
  { slug: 'central', zh: 'JR東海', en: 'JR Central', re: /東海旅客鉄道|JR\s*Central|JR東海/i },
  { slug: 'west', zh: 'JR西日本', en: 'JR West', re: /西日本旅客鉄道|JR\s*West/i },
  { slug: 'shikoku', zh: 'JR四國', en: 'JR Shikoku', re: /四国旅客鉄道|JR\s*Shikoku/i },
  { slug: 'kyushu', zh: 'JR九州', en: 'JR Kyushu', re: /九州旅客鉄道|JR\s*Kyushu/i },
]
const JP_SHINKANSEN = [ // longest keys first (西九州新幹線 ⊃ 九州新幹線)
  ['西九州新幹線', 'kyushu'], ['九州新幹線', 'kyushu'], ['北海道新幹線', 'hokkaido'],
  ['東海道新幹線', 'central'], ['山陽新幹線', 'west'], ['東北新幹線', 'east'],
  ['上越新幹線', 'east'], ['山形新幹線', 'east'], ['秋田新幹線', 'east'], ['北陸新幹線', 'east'],
]
function jpCompanyOfOp(op) {
  if (!op) return null
  let best = null, bi = Infinity
  for (const c of JP_COMPANIES) { const m = op.search(c.re); if (m >= 0 && m < bi) { bi = m; best = c.slug } }
  return best
}
function jpShinkansenOf(name) {
  if (!name) return null
  for (const [k, slug] of JP_SHINKANSEN) if (name.includes(k)) return slug
  return null
}
function splitJapanByCompany(raw) {
  const wayCo = new Map()
  const assigned = [] // way midpoints of company-known ways, for the geo fallback
  const pend = []
  for (const w of raw.trackElements) {
    if (w.type !== 'way' || !w.geometry?.length) continue
    const t = w.tags || {}
    const co = jpCompanyOfOp(t.operator) ?? jpShinkansenOf(t.name || t['name:ja'])
    if (co) {
      wayCo.set(w.id, co)
      const p = w.geometry[w.geometry.length >> 1]
      assigned.push({ lon: p.lon, lat: p.lat, slug: co })
    } else pend.push(w)
  }
  // Geo fallback, PROPAGATED: assign each pending way to the company of the nearest
  // already-assigned way, then feed the new assignments back into the index and
  // repeat — a fully untagged branch line (鹿島線/久留里線: no operator on ANY way)
  // is reached chain-wise from its junction with tagged track, not just within one
  // grid cell of it.
  let queue = pend
  for (let pass = 0; pass < 12 && queue.length; pass++) {
    const idx = gridIndex(assigned, 0.05)
    const next = []
    for (const w of queue) {
      const p = w.geometry[w.geometry.length >> 1]
      const { i } = idx.nearest(p.lon, p.lat, 15000)
      if (i >= 0) {
        wayCo.set(w.id, assigned[i].slug)
        assigned.push({ lon: p.lon, lat: p.lat, slug: assigned[i].slug })
      } else next.push(w)
    }
    if (next.length === queue.length) break // nothing new reached — stop
    queue = next
  }
  if (queue.length) console.log(`  ${raw.cc}: ${queue.length} unassigned ways (no JR operator, no assigned track nearby) — dropped from all companies`)
  // relation → set of companies (usually 1; trunk relations spanning companies →
  // several). Operator match collects EVERY matching company, not just the first:
  // a jointly-operated relation (北陸新幹線 op=東日本;西日本) must land in BOTH
  // builds — each company's trackGeom only holds its own ways, so each gets its own
  // stretch (東京–上越妙高 / 上越妙高–敦賀), same mechanism as the 東海道本線 trunk.
  const relCo = new Map()
  for (const e of raw.relElements || []) {
    if (e.type !== 'relation') continue
    const t = e.tags || {}
    const opCos = new Set()
    for (const c of JP_COMPANIES) if (t.operator && c.re.test(t.operator)) opCos.add(c.slug)
    if (opCos.size) { relCo.set(e.id, opCos); continue }
    const co = jpShinkansenOf(t.name || t['name:ja'])
    if (co) { relCo.set(e.id, new Set([co])); continue }
    const cnt = new Map(); let tot = 0
    for (const m of e.members || []) if (m.type === 'way' && wayCo.has(m.ref)) { tot++; cnt.set(wayCo.get(m.ref), (cnt.get(wayCo.get(m.ref)) || 0) + 1) }
    if (!tot) continue
    const keep = new Set()
    for (const [slug, n] of cnt) if (n / tot >= 0.15 || n >= 10) keep.add(slug)
    if (!keep.size) keep.add([...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0])
    relCo.set(e.id, keep)
  }
  // 新幹線只要一個檔（使用者：沒這麼多，不拆社）: first variant = the FULL country
  // restricted to the hsr output (one as-jpn-hsr with all 10 Shinkansen, exactly the
  // pre-split build) — then the six company variants, each restricted to -rail.
  return [
    { ...raw, classOnly: 'hsr' },
    ...JP_COMPANIES.map((c) => ({
      ...raw,
      cc: `${raw.cc}-${c.slug}`,
      classOnly: 'rail',
      company: { slug: c.slug, zh: c.zh, en: c.en },
      trackElements: raw.trackElements.filter((w) => w.type !== 'way' || wayCo.get(w.id) === c.slug),
      relElements: (raw.relElements || []).filter((e) => e.type !== 'relation' || relCo.get(e.id)?.has(c.slug)),
    })),
  ]
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
  const HSR_OP_RE = /高速鐵|高铁|高鐵|高速鉄|고속|new ?transit|shinkansen|新幹線|high[\s_-]?speed|\btgv\b|\bice\b|\bave\b|\bktx\b|\bsrt\b|renfe ave/i
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
  //
  // A line's own member ways almost never form ONE connected graph at 18 m: bridges,
  // level crossings and station areas leave small gaps, so 山陰本線's 1784 ways split
  // into 22 components (largest only 38%). Taking just the largest component's diameter
  // dropped 60% of the line → its stations projected onto nothing → dumped into the
  // 一般鐵路 connector bag (the 斷開/抓錯 the user saw). Fix: order EVERY component's
  // own path, then CHAIN the components end-to-end by nearest endpoint (the gaps are
  // the same physical line), so the main path spans the whole line. Only the line's own
  // ways are used — no parallel-line pollution, no name-variant duplication, one path
  // (no branching → no fragmentation). Genuinely-too-large hops are still split later by
  // capFor at the feature level.
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
    const dij = (src) => {
      const dist = new Map([[src, 0]]); const prev = new Map(); const H = [[0, src]]
      const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (H[p][0] <= H[i][0]) break;[H[p], H[i]] = [H[i], H[p]]; i = p } }
      const pop = () => { const t = H[0], l = H.pop(); if (H.length) { H[0] = l; let i = 0; for (;;) { let a = 2 * i + 1, b = 2 * i + 2, s = i; if (a < H.length && H[a][0] < H[s][0]) s = a; if (b < H.length && H[b][0] < H[s][0]) s = b; if (s === i) break;[H[s], H[i]] = [H[i], H[s]]; i = s } } return t }
      while (H.length) { const [d, u] = pop(); if (d > (dist.get(u) ?? Infinity)) continue; for (const [v, w] of adj.get(u)) { const nd = d + w; if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); H.push([nd, v]); up(H.length - 1) } } }
      return { dist, prev }
    }
    // enumerate ALL components
    const seen = new Set(); const comps = []
    for (const start of adj.keys()) {
      if (seen.has(start)) continue
      const c = []; const stack = [start]; seen.add(start)
      while (stack.length) { const u = stack.pop(); c.push(u); for (const v of adj.get(u).keys()) if (!seen.has(v)) { seen.add(v); stack.push(v) } }
      comps.push(c)
    }
    // ordered node path within one component (diameter for an open chain, cycle walk otherwise)
    const orderComp = (comp) => {
      const deg1 = comp.filter((k) => adj.get(k).size === 1)
      if (deg1.length >= 2) {
        const A = dij(deg1[0]); let a1 = deg1[0], ad = -1; for (const n of comp) { const d = A.dist.get(n); if (d != null && d > ad) { ad = d; a1 = n } }
        const B = dij(a1); let b1 = a1, bd = -1; for (const n of comp) { const d = B.dist.get(n); if (d != null && d > bd) { bd = d; b1 = n } }
        const path = []; let cur = b1; while (cur !== undefined) { path.push(cur); cur = B.prev.get(cur) }
        return path
      }
      const used = new Set([comp[0]]); const path = [comp[0]]; let cur = comp[0]
      for (;;) { let nx; for (const v of adj.get(cur).keys()) if (!used.has(v)) { nx = v; break } if (nx === undefined) break; used.add(nx); path.push(nx); cur = nx }
      return path
    }
    // each component → ordered pts; keep only pieces of ≥2 pts
    const segs = comps.filter((c) => c.length >= 2).map((c) => orderComp(c).map((k) => pos.get(k))).filter((p) => p.length >= 2)
    if (!segs.length) return null
    const segLen = (p) => { let L = 0; for (let i = 1; i < p.length; i++) L += haversine(p[i - 1], p[i]); return L }
    segs.sort((a, b) => segLen(b) - segLen(a))
    // chain pieces greedily by nearest endpoint, flipping orientation as needed. Only
    // bridge a gap that is a real track-continuity break (a bridge / station area /
    // level crossing splits a line's ways into pieces metres–~1 km apart); a piece
    // whose nearest end is farther than CHAIN_GAP is a DISCONNECTED fragment (a stray
    // way, a distant branch) — chaining it would draw a false 50–200 km straight hop,
    // so leave it out (its stations fall back to the 一般鐵路 connector, as before).
    const CHAIN_GAP = 9000
    const used = new Array(segs.length).fill(false); used[0] = true
    let chain = segs[0].slice()
    for (let iter = 1; iter < segs.length; iter++) {
      const head = chain[0], tail = chain[chain.length - 1]
      let best = -1, bestD = Infinity, flip = false, atHead = false
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue
        const s = segs[i], s0 = s[0], s1 = s[s.length - 1]
        const opts = [
          [haversine(tail, s0), false, false], // append as-is
          [haversine(tail, s1), true, false],  // append reversed
          [haversine(head, s1), false, true],  // prepend as-is
          [haversine(head, s0), true, true],   // prepend reversed
        ]
        for (const [d, fl, ah] of opts) if (d < bestD) { bestD = d; best = i; flip = fl; atHead = ah }
      }
      if (best < 0 || bestD > CHAIN_GAP) break // nearest remaining piece is a disconnected fragment → stop
      const s = flip ? segs[best].slice().reverse() : segs[best].slice()
      used[best] = true
      chain = atHead ? s.concat(chain) : chain.concat(s)
    }
    const pts = chain
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
  // stations indexed by an HSR-line network tag (品川 network=東海道新幹線) — the ONLY
  // extra membership 高鐵 gets, since snapping to HSR track grabs the local stations a
  // Shinkansen VIADUCT passes over (武蔵小杉/西谷).
  const netToStations = new Map()
  for (let i = 0; i < rawSt.length; i++) {
    const nw = rawSt[i].tags.network
    if (!nw || (!HSR_OP_RE.test(nw) && rawSt[i].tags.highspeed !== 'yes')) continue
    const k = norm(nw); if (!netToStations.has(k)) netToStations.set(k, new Set())
    netToStations.get(k).add(`s${rawSt[find(i)].id}`)
  }
  // 高鐵 by line NAME (新幹線/高铁/高速线/客运专线/城际/HSL…), else conventional. NOT by
  // highspeed-way fraction — that mislabels a 一般線 sharing one HSR viaduct way
  // (高崎線/京浜東北線) as 高鐵. Fraction ≥0.8 is a safety net for oddly-named HSR.
  const HSR_NAME_RE = /新幹線|新干线|高速鉄|高速鐵|高铁|高鐵|高速線|高速线|客运专线|客運專線|城际|城際|고속|shinkansen|high[\s_-]?speed|\bhsl\b|\bktx\b/i
  for (const [rname, g] of lineRel) {
    if (g.ways.size === 0) continue
    let tot = 0, hs = 0
    for (const wid of g.ways) { tot++; if (hsWayIds.has(wid)) hs++ }
    const cls = (HSR_NAME_RE.test(rname) || hs / tot >= 0.8) ? 'high_speed' : 'conventional'
    const ord = trackOrder([...g.ways]); if (!ord) continue
    // membership: member stop nodes always; PLUS (一般國鐵 only) snap our merged
    // stations that lie within SNAP m of THIS line's own path — most JR conventional
    // relations list 0 member nodes (東北本線/山手線), so snapping gives coverage. 高鐵
    // does NOT snap (viaduct pollution); it uses member nodes ∪ network-tagged stops.
    const member = new Set(); const cand = new Set()
    for (const n of g.nodes) {
      const t = n.tags || {}
      if (!/^(station|halt|stop)$/.test(t.railway || '')) continue
      if (/线路所|線路所|信号場|信號場|信号所|信號所/.test(t.name || t['name:ja'] || t['name:zh'] || '')) continue
      const sid = nodeToStation(n, false); if (sid) { member.add(sid); cand.add(sid) }
    }
    if (cls === 'high_speed') {
      for (const sid of netToStations.get(norm(rname)) || []) { member.add(sid); cand.add(sid) }
    } else {
      const pathCells = new Set(); for (const p of ord.pts) pathCells.add(scell(p[0], p[1]))
      for (const cellKey of pathCells) {
        const [cx, cy] = cellKey.split(':').map(Number)
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const s of stByCell.get(`${cx + dx}:${cy + dy}`) || []) cand.add(s.id)
      }
    }
    // order candidates by arc along the path; keep member nodes always, snapped ones
    // only if truly on the track (≤ SNAP), drop mis-snaps
    const SNAP = 140
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
  // Fallback: a country whose 高鐵 has NO usable named route=railway relation (韓國 KTX
  // — OSM relates it oddly) → NN-chain the HSR-operator-flagged stations into one
  // 高速鐵路 line so the network at least appears (merged, not per-line — imperfect).
  // NOT for a per-company build (raw.company, 日本拆六社): stations are unfiltered
  // there, so JR四國 (genuinely no shinkansen) would fabricate a nationwide chain
  // from other companies' HSR-flagged stations — no HSR relations means no HSR file.
  if (!raw.company && ![...edges.values()].some((e) => e.hs)) {
    const hsrSt = stations.filter((s) => s.hsr)
    if (hsrSt.length >= 2) {
      const far = (from, arr) => arr.reduce((b, p) => haversine([from.lon, from.lat], [p.lon, p.lat]) > haversine([from.lon, from.lat], [b.lon, b.lat]) ? p : b, arr[0])
      const start = far(far(hsrSt[0], hsrSt), hsrSt)
      const used = new Set([start.id]); const order = [start]; let cur = start
      while (order.length < hsrSt.length) { let best = null, bd = Infinity; for (const p of hsrSt) { if (used.has(p.id)) continue; const d = haversine([cur.lon, cur.lat], [p.lon, p.lat]); if (d < bd) { bd = d; best = p } } if (!best) break; used.add(best.id); order.push(best); cur = best }
      const nm = classLabel(country, 'high_speed')
      for (let i = 0; i + 1 < order.length; i++) {
        if (haversine([order[i].lon, order[i].lat], [order[i + 1].lon, order[i + 1].lat]) > 70000) continue
        const k = ekey(order[i].id, order[i + 1].id)
        if (!edges.has(k)) edges.set(k, { a: order[i].id, b: order[i + 1].id, lines: new Map(), hs: true })
        const e = edges.get(k); e.lines.set(nm, (e.lines.get(nm) || 0) + 10); e.hs = true
      }
    }
  }

  // ── connectivity pass (使用者：軌道連通＋關聯排序) ─────────────────────────────────
  // The per-relation lines above are correctly ORDERED but only touch stations a
  // relation lists/snaps → the network is left in disconnected pieces and stations on
  // no relation are dropped (台灣 245→184 站/1→7 元件). So ALSO walk the GLOBAL track
  // graph 台鐵-style, station→station, and add any pair NOT already named by a relation
  // as an UNNAMED connector (`__conventional`). This stitches the network connected and
  // pulls in orphan stations WITHOUT disturbing the relations' correct ordering. HSR
  // corridors are skipped (relation-built; viaduct pollution); capped at MAX_EDGE_M so
  // there is no wrong long hop.
  const gkey6 = (x, y) => `${x.toFixed(6)},${y.toFixed(6)}`
  const gvId = new Map(); const gvc = []; const gadj = []
  const gV = (x, y) => { const k = gkey6(x, y); let i = gvId.get(k); if (i === undefined) { i = gvc.length; gvId.set(k, i); gvc.push([x, y]); gadj.push([]) } return i }
  for (const w of ways) for (let i = 0; i + 1 < w.coords.length; i++) {
    const a = gV(...w.coords[i]), b = gV(...w.coords[i + 1]); if (a === b) continue
    gadj[a].push({ to: b, hs: w.cls === 'high_speed' }); gadj[b].push({ to: a, hs: w.cls === 'high_speed' })
  }
  const gIdx = gridIndex(gvc.map(([x, y]) => ({ lon: x, lat: y })))
  for (const s of stations) { const { i } = gIdx.nearest(s.lon, s.lat, LINE_SNAP); s.gv = i >= 0 ? i : undefined }
  const sIdxG = gridIndex(stations.map((s) => ({ lon: s.lon, lat: s.lat })))
  const stAtV = new Map()
  for (let v = 0; v < gvc.length; v++) { const { i } = sIdxG.nearest(gvc[v][0], gvc[v][1], 250); if (i >= 0) stAtV.set(v, stations[i].id) }
  const angleAt = (p, c, n) => { const v1x = gvc[c][0] - gvc[p][0], v1y = gvc[c][1] - gvc[p][1], v2x = gvc[n][0] - gvc[c][0], v2y = gvc[n][1] - gvc[c][1]; const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1e-12; return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / m))) }
  for (const s of stations) {
    if (s.gv === undefined) continue
    for (const first of [...new Set(gadj[s.gv].map((e) => e.to))]) {
      const e0 = gadj[s.gv].find((e) => e.to === first); if (e0.hs) continue
      const seen = new Set([s.gv, first]); let prev = s.gv, cur = first, guard = 0
      while (guard++ < 4000) {
        const sid = stAtV.get(cur)
        if (sid !== undefined && sid !== s.id) {
          if (haversine([s.lon, s.lat], gvc[cur]) <= MAX_EDGE_M) {
            const k = ekey(s.id, sid)
            if (!edges.has(k)) edges.set(k, { a: s.id, b: sid, lines: new Map(), hs: false }) // connector only where no named relation edge
          }
          break
        }
        const nbrs = [...new Set(gadj[cur].map((e) => e.to))].filter((v) => v !== prev && !seen.has(v))
        if (!nbrs.length) break
        let nxt = nbrs[0]
        if (nbrs.length > 1) { nxt = nbrs.reduce((b, v) => (angleAt(prev, cur, v) < angleAt(prev, cur, b) ? v : b), nbrs[0]); if (angleAt(prev, cur, nxt) > 1.05) break }
        const e = gadj[cur].find((x) => x.to === nxt); if (e.hs) break
        seen.add(nxt); prev = cur; cur = nxt
      }
    }
  }

  // dominant NAMED line of an edge (majority track vote); its group key falls back
  // to the class when the track was unnamed (a connector), so it is still drawn.
  const domLine = (rec) => [...rec.lines.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const groupKey = (rec) => domLine(rec) ?? `__${rec.hs ? 'high_speed' : 'conventional'}`

  // A NAMED line belongs to ONE class — unify each line's edges to the class the
  // MAJORITY of its edges have. Without this, a conventional main line that shares a
  // little highspeed track (奥羽本線 carrying the 山形新幹線 mini-shinkansen; the shared
  // 福島–新庄 way is tagged highspeed) leaks a 2-station duplicate into the 新幹線 file
  // while its full self stays conventional — a cross-file 重覆. Majority vote keeps
  // 山形新幹線 (all-hs) in HSR and 温福线/衡柳铁路 (China, all-hs, no conventional file)
  // in HSR, but pulls 奥羽本線 (2 hs vs 102 conventional edges) wholly into 一般國鐵.
  {
    const vote = new Map() // line → {hs, cv}
    for (const rec of edges.values()) {
      const ln = domLine(rec); if (!ln) continue
      const v = vote.get(ln) || { hs: 0, cv: 0 }
      rec.hs ? v.hs++ : v.cv++
      vote.set(ln, v)
    }
    for (const rec of edges.values()) {
      const ln = domLine(rec); if (!ln) continue
      const v = vote.get(ln); if (v) rec.hs = v.hs > v.cv
    }
  }

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
      // per-company build (日本拆六社): carry the JR company so 前端 can label the
      // layer "JR東日本 一般國鐵" instead of the bare country name.
      company: raw.company?.slug ?? null,
      company_zh: raw.company?.zh ?? null, company_en: raw.company?.en ?? null,
      osm_networks: namedLines.slice().sort().slice(0, 60),
      operator: raw.company?.en ?? null,
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
  // 日本高鐵＝新幹線（使用者：日本是新幹線不是高鐵），其餘國家用「高鐵」。class_en 同理。
  const hsrZh = isJP(country) ? '新幹線' : '高鐵'
  const hsrEn = isJP(country) ? 'Shinkansen' : 'High-speed'
  const CLASSES = [
    { suffix: 'hsr', cls: 'high_speed', zh: hsrZh, en: hsrEn },
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

    // 日本拆六社 (JR東日本/西日本/…): expand the country into per-company variants
    // BEFORE building; every other country stays one variant. buildSystem then
    // returns an ARRAY of subsystems (高鐵 / 一般國鐵 split, 使用者: 一國拆兩檔兩圖層).
    // Write ONE file per subsystem: {cc}[-{company}]-{hsr|rail}.
    const variants = raw.cc === 'as-jpn' ? splitJapanByCompany(raw) : [raw]
    for (const v of variants) {
      // classOnly (日本): the full-country variant only emits -hsr (新幹線一個檔,
      // 不拆社), the per-company variants only emit -rail.
      const subs = buildSystem(v, override).filter((s) => !v.classOnly || s.suffix === v.classOnly)
      if (!subs.length) { console.log(`  ${v.cc}: 0 features, skip`); continue }
      const cont = CONTINENT_DIR[v.continent] || 'other'
      const parts = []
      for (const sub of subs) {
        const sysCc = `${v.cc}-${sub.suffix}`
        const rel = `systems/${cont}/${countrySlug(v.country)}/${sysCc}.geojson`
        await mkdir(dirname(join(RAILWAY, rel)), { recursive: true })
        await writeFile(join(RAILWAY, rel), JSON.stringify(sub.fc))
        const m = sub.fc.railway_system
        systems.push({
          file: rel, continent: v.continent, country: v.country, country_zh: m.country_zh,
          city: m.city, city_zh: m.city_zh, unit: m.unit,
          company: m.company, company_zh: m.company_zh, company_en: m.company_en,
          rail_class: sub.rail_class, class_zh: sub.class_zh, class_en: sub.class_en,
          osm_networks: m.osm_networks, operator: m.operator,
          line_count: m.line_count, segment_count: m.segment_count, station_count: m.station_count,
        })
        lineTotal += m.line_count; stationTotal += m.station_count
        for (const feat of sub.fc.features) (feat.geometry.type === 'Point' ? allStations : allLines).push(feat)
        parts.push(`${sub.class_zh} ${m.line_count}線/${m.station_count}站`)
      }
      console.log(`  ${v.cc} (${v.company?.zh ?? v.country_zh}): ${parts.join('，')}`)
    }
  }

  await writeFile(join(RAILWAY, 'railway_lines.geojson'), JSON.stringify({ type: 'FeatureCollection', features: allLines }))
  await writeFile(join(RAILWAY, 'railway_stations.geojson'), JSON.stringify({ type: 'FeatureCollection', features: allStations }))
  await writeFile(join(RAILWAY, 'index.json'), JSON.stringify({
    generated_from: 'OpenStreetMap railway=rail usage=main|branch (national/state railways + high-speed); stations snapped onto the track graph; TWO files per country split by rail class — {cc}-hsr (高鐵) and {cc}-rail (一般國鐵); Japan is further split into the six JR passenger companies ({cc}-{east|west|central|hokkaido|shikoku|kyushu}-…)',
    system_count: systems.length, line_total: lineTotal, station_total: stationTotal, systems,
  }, null, 1))
  console.log(`\ndone: ${systems.length} countries, ${lineTotal} lines, ${stationTotal} stations`)
}

main().catch((e) => { console.error(e); process.exit(1) })
