// One-off additive builder: 「東京＋JR」「大阪＋JR」combined systems.
//
// 使用者裁決（2026-07-16）：在既有 metro 系統上「附加」一條 JR 環線，產生 2 個
// 全新的系統檔（不改動任何現有 metro 管線腳本、現有 systems 檔、metro_lines/
// metro_stations 全球層）。JR 環線的車站與 metro 車站「完整整合」——同站合併成
// 單一轉乘點（共站紅點）、計入 station_count。
//
//   東京＋JR：as-jpn-tokyo  + JR 山手線（route_master 1139468 / inner 1972960）
//   大阪＋JR：as-jpn-osaka  + JR 大阪環状線（inner 10073683）
//
// JR 是 route=train，metro 管線本來刻意排除（見 metro-osm-fetch）；此檔是獨立的
// 一次性附加，故不進 metro:all，也不動 SKILL。schema 與 metro 系統檔完全一致。
//
//   node scripts/buildJrCombined.mjs
//
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { query } from './overpass.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const METRO = join(__dirname, '..', 'data', 'metro')

const TARGETS = [
  {
    slug: 'as-jpn-tokyo-jr',
    base: 'systems/asia/japan/as-jpn-tokyo.geojson',
    cityEn: 'Tokyo + JR',
    cityZh: '東京＋JR',
    rel: 1972960, // JR山手線 (inner) — codes ascend, clean order
    line: {
      ref: 'JY', name: '山手線', nameEn: 'Yamanote Line', color: '#B1CB39',
      network: 'JR East', networkLocal: '東日本旅客鉄道', operator: '東日本旅客鉄道',
      wikidata: 'Q216580', wikipedia: 'ja:山手線',
    },
    // JR 站名 → metro 站名（不同名的知名轉乘複合站）
    aliases: { 浜松町: '大門' },
  },
  {
    slug: 'as-jpn-osaka-jr',
    base: 'systems/asia/japan/as-jpn-osaka.geojson',
    cityEn: 'Osaka + JR',
    cityZh: '大阪＋JR',
    rel: 10073683, // JR大阪環状線 (内回り)
    line: {
      ref: 'O', name: '大阪環状線', nameEn: 'Osaka Loop Line', color: '#E80000',
      network: 'JR West', networkLocal: '西日本旅客鉄道', operator: '西日本旅客鉄道',
      wikidata: 'Q1065007', wikipedia: 'ja:大阪環状線',
    },
    aliases: { 大阪: '梅田' }, // JR 大阪 ↔ Osaka Metro 梅田
  },
]

// ---- helpers ------------------------------------------------------------
const R = 6371000
const rad = (d) => (d * Math.PI) / 180
function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
// 站名正規化：去 JR/空白/駅 尾綴，供同站比對
function normName(s) {
  return (s || '').replace(/^JR/i, '').replace(/駅$/, '').replace(/\s+/g, '').trim()
}
const nameJa = (t) => t['name:ja'] || t.name || t['name:en'] || null

// 由 route relation 抽出「依成員順序」的停靠站（node role=stop）
function orderedStops(rel, nodes) {
  const out = []
  for (const m of rel.members) {
    if (m.type !== 'node' || !/stop/.test(m.role)) continue
    const n = nodes.get(m.ref)
    if (!n) continue
    const nm = nameJa(n.tags || {})
    if (!nm) continue
    const prev = out[out.length - 1]
    if (prev && prev.osmId === m.ref) continue // 同節點重複
    out.push({
      osmId: m.ref,
      name: nm,
      code: (n.tags || {}).ref || null,
      coord: [n.lon, n.lat],
    })
  }
  // 環線閉合：若首尾同站，去掉尾端（幾何另外補閉合）
  if (out.length > 2 && out[0].osmId === out[out.length - 1].osmId) out.pop()
  return out
}

// ---- graph recompute（重算 degree / interchange / terminus）--------------
// 以「各 route 的完整站序」建無向圖，degree = 相異鄰站數。
function recomputeFlags(features) {
  const stations = features.filter((f) => f.geometry?.type === 'Point')
  const byId = new Map(stations.map((f) => [f.properties.station_id, f]))

  // route_id -> 站序（station_id list），取第一個出現的段
  const routeSeq = new Map()
  const routeLoop = new Map()
  for (const f of features) {
    if (f.geometry?.type !== 'MultiLineString') continue
    for (const r of f.properties.routes || []) {
      if (routeSeq.has(r.route_id)) continue
      const seq = (r.stations || []).filter((s) => !s.pass).map((s) => s.station_id)
      routeSeq.set(r.route_id, seq)
      routeLoop.set(r.route_id, seq.length > 2 && seq[0] === seq[seq.length - 1])
    }
  }

  const nbrs = new Map() // station_id -> Set(neighbor id)
  const termCount = new Map() // station_id -> #routes terminating here
  const add = (a, b) => {
    if (!a || !b || a === b) return
    if (!nbrs.has(a)) nbrs.set(a, new Set())
    nbrs.get(a).add(b)
  }
  for (const [rid, seq] of routeSeq) {
    for (let i = 0; i + 1 < seq.length; i++) { add(seq[i], seq[i + 1]); add(seq[i + 1], seq[i]) }
    const loop = routeLoop.get(rid)
    if (loop && seq.length > 2) { add(seq[0], seq[seq.length - 2]); add(seq[seq.length - 2], seq[0]) }
    else if (seq.length >= 2) {
      for (const end of [seq[0], seq[seq.length - 1]]) termCount.set(end, (termCount.get(end) || 0) + 1)
    }
  }

  for (const f of stations) {
    const id = f.properties.station_id
    const degree = nbrs.get(id)?.size || 0
    // 停靠（非 pass）的相異線身分數
    const lineIds = new Set((f.properties.routes || [])
      .filter((r) => !r.pass).map((r) => `${r.ref}|${r.name}`))
    const term = termCount.get(id) || 0
    const isTerm = term > 0
    const isInterchange = degree > 2 || term >= 2 || (isTerm && lineIds.size >= 2)
    f.properties.station_degree = degree
    f.properties.is_terminus = isTerm
    f.properties.is_interchange = isInterchange
    f.properties.station_role = isInterchange ? 'interchange' : isTerm ? 'terminus' : 'normal'
  }
  return { byId }
}

// ---- per-target build ---------------------------------------------------
async function build(t) {
  const q = `[out:json][timeout:180];
rel(id:${t.rel})->.r;
.r out body;
node(r.r);
out body;`
  const res = await query(q, { cacheName: `jr_members_${t.slug}.json` })
  const nodes = new Map()
  let rel = null
  for (const e of res.elements) {
    if (e.type === 'node') nodes.set(e.id, e)
    else if (e.type === 'relation' && e.id === t.rel) rel = e
  }
  if (!rel) throw new Error(`relation ${t.rel} not found`)
  const stops = orderedStops(rel, nodes)
  console.log(`\n[${t.slug}] ${t.line.name}: ${stops.length} stops`)

  const gj = JSON.parse(await readFile(join(METRO, t.base), 'utf8'))
  const features = gj.features.map((f) => JSON.parse(JSON.stringify(f))) // deep clone
  const metroStations = features.filter((f) => f.geometry?.type === 'Point')

  // metro 站名索引（normName -> features）
  const nameIdx = new Map()
  for (const f of metroStations) {
    const k = normName(f.properties.station_name)
    if (!k) continue
    if (!nameIdx.has(k)) nameIdx.set(k, [])
    nameIdx.get(k).push(f)
  }

  const country = gj.metro_system.country
  const city = gj.metro_system.city
  const jrRoute = {
    ref: t.line.ref, name: t.line.name, // 車站 routes[] 形式
  }
  const routeId = `jr${t.rel}`

  // 逐 JR 站：合併 or 新增
  const vertexById = new Map() // osmId -> 用來畫線的 station feature
  const routeStations = [] // route.stations（完整站序）
  let merged = 0, added = 0
  const mergeLog = []
  for (const s of stops) {
    const target = t.aliases[s.name] || s.name
    const k = normName(target)
    let hit = null
    for (const cand of nameIdx.get(k) || []) {
      const d = haversine(s.coord, cand.geometry.coordinates)
      if (d <= 800 && (!hit || d < hit.d)) hit = { f: cand, d }
    }
    let feat
    if (hit) {
      feat = hit.f
      const p = feat.properties
      // 附加 JR 線
      if (!(p.routes || []).some((r) => r.ref === jrRoute.ref && r.name === jrRoute.name))
        p.routes = [...(p.routes || []), { ...jrRoute }]
      if (!(p.lines || []).includes(t.line.ref)) p.lines = [...(p.lines || []), t.line.ref]
      if (s.code) p.codes = [...(p.codes || []), s.code].filter((v, i, a) => a.indexOf(v) === i)
      merged++
      mergeLog.push(`  merge  JR ${s.name} → ${p.station_name}`)
    } else {
      // 新站
      feat = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: s.coord },
        properties: {
          station_id: `n${s.osmId}`,
          station_name: s.name,
          station_name_local: s.name,
          station_name_en: null,
          network: t.line.network,
          network_local: t.line.networkLocal,
          operator: t.line.operator,
          city, country,
          lines: [t.line.ref],
          wikidata: null,
          wikipedia: null,
          merged_from: 1,
          merged_names: null,
          is_terminus: false,
          codes: s.code ? [s.code] : null,
          routes: [{ ...jrRoute }],
          pass_count: 0,
          station_degree: 0,
          is_interchange: false,
          station_role: 'normal',
        },
      }
      features.push(feat)
      added++
    }
    vertexById.set(s.osmId, feat)
    routeStations.push({
      station_id: feat.properties.station_id,
      station_name: feat.properties.station_name,
      ...(s.code ? { code: s.code } : {}),
    })
  }
  // 環線閉合：站序回到第一站
  if (routeStations.length > 2) routeStations.push({ ...routeStations[0] })

  // JR 線段 feature（自有幾何，不與 metro 共段）
  const coords = stops.map((s) => vertexById.get(s.osmId).geometry.coordinates)
  if (coords.length > 2) coords.push(coords[0]) // 閉合
  const seg = {
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: [coords] },
    properties: {
      seg_id: `${t.slug}-jr-0`,
      routes: [{
        route_id: routeId,
        route_name: t.line.name,
        route_name_local: t.line.name,
        route_name_en: t.line.nameEn,
        route_ref: t.line.ref,
        route_color: t.line.color,
        network: t.line.network,
        network_local: t.line.networkLocal,
        operator: t.line.operator,
        wikidata: t.line.wikidata,
        wikipedia: t.line.wikipedia,
        osm_route_ids: [t.rel],
        status: null,
        order_suspect: 0,
        stations: routeStations,
      }],
      route_count: 1,
      route_refs: [t.line.ref],
      route_colors: [t.line.color],
      city, country,
    },
  }
  features.push(seg)

  // 重算旗標（含 metro，讓共站升級為紅點）
  recomputeFlags(features)

  // 系統 meta
  const baseStations = metroStations.length
  const totalStations = features.filter((f) => f.geometry?.type === 'Point').length
  const totalSegs = features.filter((f) => f.geometry?.type === 'MultiLineString').length
  const m = gj.metro_system
  const out = {
    type: 'FeatureCollection',
    metro_system: {
      ...m,
      city: t.cityEn,
      osm_networks: [...m.osm_networks, t.line.networkLocal].filter((v, i, a) => a.indexOf(v) === i),
      line_count: (m.line_count || 0) + 1,
      segment_count: totalSegs,
      station_count: totalStations,
      combined: true,
      combined_note: `Metro（${m.city}）＋ JR ${t.line.name}（一次性附加，未經 metro:audit）`,
      audit: null,
    },
    features,
  }
  const nInterchange = features.filter((f) => f.geometry?.type === 'Point' && f.properties.is_interchange).length
  console.log(`  merged ${merged}, new ${added}; stations ${baseStations}→${totalStations}, segs ${totalSegs}, interchanges ${nInterchange}`)
  mergeLog.forEach((l) => console.log(l))

  const outPath = join(METRO, 'systems/asia/japan', `${t.slug}.geojson`)
  await writeFile(outPath, JSON.stringify(out))
  console.log(`  wrote ${outPath}`)
  return {
    file: `systems/asia/japan/${t.slug}.geojson`,
    continent: m.continent, country: m.country, city: t.cityEn,
    osm_networks: out.metro_system.osm_networks, operator: m.operator,
    official_website: m.official_website, official_map: m.official_map,
    wikidata: m.wikidata, line_count: out.metro_system.line_count,
    segment_count: totalSegs, station_count: totalStations, cityZh: t.cityZh, slug: t.slug,
  }
}

// ---- main ---------------------------------------------------------------
const entries = []
for (const t of TARGETS) entries.push(await build(t))

// index.json：附加新系統（若已存在則覆蓋）
const idxPath = join(METRO, 'index.json')
const idx = JSON.parse(await readFile(idxPath, 'utf8'))
for (const e of entries) {
  const { cityZh, slug, ...sys } = e
  const at = idx.systems.findIndex((s) => s.file === sys.file)
  const rec = { ...sys, audit: null }
  if (at >= 0) idx.systems[at] = rec
  else idx.systems.push(rec)
}
idx.system_count = idx.systems.length
await writeFile(idxPath, JSON.stringify(idx, null, 2))
console.log(`\nindex.json: ${idx.systems.length} systems`)

// cityNamesZh.json：中文城市名
const zhPath = join(__dirname, '..', 'src', 'stores', 'cityNamesZh.json')
const zh = JSON.parse(await readFile(zhPath, 'utf8'))
for (const e of entries) zh[e.slug] = { country: '日本', city: e.cityZh }
await writeFile(zhPath, JSON.stringify(zh, null, 2) + '\n')
console.log(`cityNamesZh.json: added ${entries.map((e) => e.slug).join(', ')}`)
