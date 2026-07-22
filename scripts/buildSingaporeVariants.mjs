// One-off additive/subtractive builder: 新加坡拆成兩個系統（使用者裁決）。
//
// buildGeojson 照舊產出「MRT＋LRT」的完整 as-sgp-singapore.geojson；本腳本在其後
// 執行，把它拆成兩檔（不動 buildGeojson 的脆弱 LRT 仲裁邏輯）：
//
//   新加坡（as-sgp-singapore，覆寫）         ＝ 純 MRT（6 線：NSL/EWL/CCL/DTL/NEL/TEL）
//   新加坡＋LRT（as-sgp-singapore-lrt，新增）  ＝ MRT ＋ 三條市區 LRT（BPLRT/PGLRT/SKLRT）
//                                             ＋ Sentosa Express（聖淘沙捷運）
//
// Sentosa Express 的 VivoCity 站（怡豐城）併入現有 HarbourFront MRT 轉乘站（港灣，
// CC29/NE1），使聖淘沙線經怡豐城接上路網、成為共站轉乘（非孤立離島線）。
//
// schema 與 metro 系統檔完全一致；比照 buildJrCombined.mjs（東京＋山手）。不進
// metro:all 的「取得」段，但接在 buildGeojson 之後、buildViews 之前（見 package.json）。
//
//   node scripts/buildSingaporeVariants.mjs
//
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { query } from './overpass.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const METRO = join(__dirname, '..', 'data', 'metro')
const BASE_FILE = 'metro-maps/asia/singapore/as-sgp-singapore.geojson'
const LRT_FILE = 'metro-maps/asia/singapore/as-sgp-singapore-lrt.geojson'

// 純市區 LRT 線 ref（拆基底時剔除；+LRT 變體保留）。
const LRT_REFS = new Set(['BPLRT', 'PGLRT', 'SKLRT'])
// LRT 官方站碼字首（剔 LRT 時連站碼一起去；STC/PTC 為完整碼）。
const LRT_CODE = /^(BP|PE|PW|SE|SW)\d+$/i
const LRT_CODE_EXACT = /^(STC|PTC)$/i
const isLrtCode = (c) => LRT_CODE.test(c) || LRT_CODE_EXACT.test(c)

// Sentosa Express（route=monorail，relation 2353581：VivoCity→Resorts World→Imbiah→Beach）。
const SENTOSA = {
  rel: 2353581,
  ref: 'SE', name: 'Sentosa Express', nameEn: 'Sentosa Express',
  color: '#a56cc1', // 官方無 OSM colour；取與 NEL 紫（#9016b2）有別的淡紫，供辨識
  network: 'Sentosa', networkLocal: null, operator: 'Sentosa Development Corporation',
  wikidata: null, wikipedia: 'en:Sentosa Express',
  // Sentosa VivoCity 站 → 併入 metro 的 HarbourFront（怡豐城位於港灣站上方）
  aliases: { VivoCity: 'HarbourFront' },
}

// ---- helpers（比照 buildJrCombined.mjs）----------------------------------
const R = 6371000
const rad = (d) => (d * Math.PI) / 180
function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
const normName = (s) => (s || '').toLowerCase().replace(/\s+/g, '').trim()
const clone = (o) => JSON.parse(JSON.stringify(o))

// route relation 抽「依成員順序」的停靠站（node role=stop）
function orderedStops(rel, nodes) {
  const out = []
  for (const m of rel.members || []) {
    if (m.type !== 'node' || !/stop/.test(m.role)) continue
    const n = nodes.get(m.ref)
    if (!n) continue
    const nm = (n.tags || {}).name || (n.tags || {})['name:en']
    if (!nm) continue
    const prev = out[out.length - 1]
    if (prev && prev.osmId === m.ref) continue
    out.push({ osmId: m.ref, name: nm, code: (n.tags || {}).ref || null, coord: [n.lon, n.lat] })
  }
  return out
}

// 以「各 route 的完整站序」建無向圖，重算 degree / interchange / terminus。
function recomputeFlags(features) {
  const stations = features.filter((f) => f.geometry?.type === 'Point')
  const routeSeq = new Map(), routeLoop = new Map()
  for (const f of features) {
    if (f.geometry?.type !== 'MultiLineString') continue
    for (const r of f.properties.routes || []) {
      if (routeSeq.has(r.route_id)) continue
      const seq = (r.stations || []).filter((s) => !s.pass).map((s) => s.station_id)
      routeSeq.set(r.route_id, seq)
      routeLoop.set(r.route_id, seq.length > 2 && seq[0] === seq[seq.length - 1])
    }
  }
  const nbrs = new Map(), termCount = new Map()
  const add = (a, b) => { if (!a || !b || a === b) return; if (!nbrs.has(a)) nbrs.set(a, new Set()); nbrs.get(a).add(b) }
  for (const [rid, seq] of routeSeq) {
    for (let i = 0; i + 1 < seq.length; i++) { add(seq[i], seq[i + 1]); add(seq[i + 1], seq[i]) }
    const loop = routeLoop.get(rid)
    if (loop && seq.length > 2) { add(seq[0], seq[seq.length - 2]); add(seq[seq.length - 2], seq[0]) }
    else if (seq.length >= 2) for (const end of [seq[0], seq[seq.length - 1]]) termCount.set(end, (termCount.get(end) || 0) + 1)
  }
  for (const f of stations) {
    const id = f.properties.station_id
    const degree = nbrs.get(id)?.size || 0
    const lineIds = new Set((f.properties.routes || []).filter((r) => !r.pass).map((r) => `${r.ref}|${r.name}`))
    const term = termCount.get(id) || 0
    const isTerm = term > 0
    const isInterchange = degree > 2 || term >= 2 || (isTerm && lineIds.size >= 2)
    f.properties.station_degree = degree
    f.properties.is_terminus = isTerm
    f.properties.is_interchange = isInterchange
    f.properties.station_role = isInterchange ? 'interchange' : isTerm ? 'terminus' : 'normal'
  }
}

function stationCount(features) { return features.filter((f) => f.geometry?.type === 'Point').length }
function segCount(features) { return features.filter((f) => f.geometry?.type === 'MultiLineString').length }
function lineCount(features) {
  const ids = new Set()
  for (const f of features) if (f.geometry?.type === 'MultiLineString') for (const r of f.properties.routes || []) ids.add(r.route_id)
  return ids.size
}

// ---- MRT-only 基底（剔除市區 LRT 線）------------------------------------
function buildMrtOnly(full) {
  const features = []
  for (const f of clone(full.features)) {
    if (f.geometry?.type === 'MultiLineString') {
      const routes = (f.properties.routes || []).filter((r) => !LRT_REFS.has(r.route_ref))
      if (!routes.length) continue // 純 LRT 段整段丟棄
      f.properties.routes = routes
      f.properties.route_count = routes.length
      f.properties.route_refs = routes.map((r) => r.route_ref)
      f.properties.route_colors = routes.map((r) => r.route_color)
      features.push(f)
    } else if (f.geometry?.type === 'Point') {
      const p = f.properties
      p.routes = (p.routes || []).filter((r) => !LRT_REFS.has(r.ref))
      p.lines = (p.lines || []).filter((ref) => !LRT_REFS.has(ref))
      if (Array.isArray(p.codes)) { p.codes = p.codes.filter((c) => !isLrtCode(c)); if (!p.codes.length) p.codes = null }
      if (!p.lines.length) continue // 純 LRT 站（去掉 LRT 後無線）→ 刪站
      features.push(f)
    } else features.push(f)
  }
  recomputeFlags(features)
  const m = full.metro_system
  return {
    type: 'FeatureCollection',
    metro_system: {
      ...m,
      line_count: lineCount(features),
      segment_count: segCount(features),
      station_count: stationCount(features),
      audit: null,
    },
    features,
  }
}

// ---- +LRT 變體（完整檔 ＋ Sentosa Express，VivoCity 併 HarbourFront）------
async function buildWithLrt(full) {
  const q = `[out:json][timeout:180];rel(id:${SENTOSA.rel})->.r;.r out body;node(r.r);out body;`
  const res = await query(q, { cacheName: `sentosa_members_${SENTOSA.rel}.json` })
  const nodes = new Map()
  let rel = null
  for (const e of res.elements) { if (e.type === 'node') nodes.set(e.id, e); else if (e.type === 'relation' && e.id === SENTOSA.rel) rel = e }
  if (!rel) throw new Error(`Sentosa relation ${SENTOSA.rel} not found`)
  const stops = orderedStops(rel, nodes)
  console.log(`\n[as-sgp-singapore-lrt] Sentosa Express: ${stops.length} stops (${stops.map((s) => s.name).join(' → ')})`)

  const features = clone(full.features)
  const stations = features.filter((f) => f.geometry?.type === 'Point')
  // metro 站名索引（含 merged_names 別名）
  const nameIdx = new Map()
  const addIdx = (name, f) => { const k = normName(name); if (!k) return; if (!nameIdx.has(k)) nameIdx.set(k, []); if (!nameIdx.get(k).includes(f)) nameIdx.get(k).push(f) }
  for (const f of stations) { addIdx(f.properties.station_name, f); for (const mm of f.properties.merged_names || []) addIdx(mm.station_name, f) }

  const country = full.metro_system.country, city = full.metro_system.city
  const seRoute = { ref: SENTOSA.ref, name: SENTOSA.name, route_color: SENTOSA.color }
  const routeId = `sentosa${SENTOSA.rel}`
  const vertexById = new Map(), routeStations = []
  let merged = 0, added = 0

  for (const s of stops) {
    const target = SENTOSA.aliases[s.name] || s.name
    const k = normName(target)
    let hit = null
    for (const cand of nameIdx.get(k) || []) {
      const d = haversine(s.coord, cand.geometry.coordinates)
      if (d <= 1200 && (!hit || d < hit.d)) hit = { f: cand, d } // HarbourFront↔VivoCity 站體約 <300m；放寬到 1.2km 保險
    }
    let feat
    if (hit) {
      feat = hit.f
      const p = feat.properties
      const origLines = [...(p.lines || [])]
      if (!(p.routes || []).some((r) => r.ref === seRoute.ref && r.name === seRoute.name)) p.routes = [...(p.routes || []), { ...seRoute }]
      if (!(p.lines || []).includes(SENTOSA.ref)) p.lines = [...(p.lines || []), SENTOSA.ref]
      if (s.code) p.codes = [...(p.codes || []), s.code].filter((v, i, a) => a.indexOf(v) === i)
      // 共站列（Metro↔Sentosa 轉乘，即使 alias 後同名亦另立一列顯示共站）
      if (!Array.isArray(p.merged_names) || p.merged_names.length === 0) {
        p.merged_names = [{ station_id: p.station_id, station_name: p.station_name, station_name_local: p.station_name_local ?? p.station_name, lines: origLines }]
      }
      p.merged_names.push({ station_id: `n${s.osmId}`, station_name: s.name, station_name_local: s.name, lines: [SENTOSA.ref] })
      merged++
    } else {
      feat = {
        type: 'Feature', geometry: { type: 'Point', coordinates: s.coord },
        properties: {
          station_id: `n${s.osmId}`, station_name: s.name, station_name_local: s.name, station_name_en: s.name,
          network: SENTOSA.network, network_local: SENTOSA.networkLocal, operator: SENTOSA.operator, city, country,
          lines: [SENTOSA.ref], wikidata: null, wikipedia: null, merged_from: 1, merged_names: null,
          is_terminus: false, codes: s.code ? [s.code] : null, routes: [{ ...seRoute }],
          pass_count: 0, station_degree: 0, is_interchange: false, station_role: 'normal',
        },
      }
      features.push(feat)
      added++
    }
    vertexById.set(s.osmId, feat)
    routeStations.push({ station_id: feat.properties.station_id, station_name: feat.properties.station_name, ...(s.code ? { code: s.code } : {}) })
  }

  const coords = stops.map((s) => vertexById.get(s.osmId).geometry.coordinates)
  features.push({
    type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [coords] },
    properties: {
      seg_id: 'as-sgp-singapore-lrt-sentosa-0',
      routes: [{
        route_id: routeId, route_name: SENTOSA.name, route_name_local: SENTOSA.name, route_name_en: SENTOSA.nameEn,
        route_ref: SENTOSA.ref, route_color: SENTOSA.color, network: SENTOSA.network, network_local: SENTOSA.networkLocal,
        operator: SENTOSA.operator, wikidata: SENTOSA.wikidata, wikipedia: SENTOSA.wikipedia,
        osm_route_ids: [SENTOSA.rel], status: null, order_suspect: 0, stations: routeStations,
      }],
      route_count: 1, route_refs: [SENTOSA.ref], route_colors: [SENTOSA.color], city, country,
    },
  })

  recomputeFlags(features)
  const m = full.metro_system
  console.log(`  Sentosa: merged ${merged} (VivoCity→HarbourFront), new ${added}`)
  return {
    type: 'FeatureCollection',
    metro_system: {
      ...m, city: 'Singapore + LRT',
      osm_networks: [...m.osm_networks, 'Sentosa Express'].filter((v, i, a) => a.indexOf(v) === i),
      line_count: lineCount(features), segment_count: segCount(features), station_count: stationCount(features),
      combined: true, combined_note: 'Singapore MRT＋LRT（BPLRT/PGLRT/SKLRT）＋ Sentosa Express（一次性附加，未經 metro:audit）',
      audit: null,
    },
    features,
  }
}

// ---- main ---------------------------------------------------------------
const full = JSON.parse(await readFile(join(METRO, BASE_FILE), 'utf8'))
console.log(`base(full) loaded: ${full.metro_system.line_count} lines / ${full.metro_system.station_count} stations`)

const withLrt = await buildWithLrt(full)
await writeFile(join(METRO, LRT_FILE), JSON.stringify(withLrt))
console.log(`  wrote ${LRT_FILE}: ${withLrt.metro_system.line_count} lines / ${withLrt.metro_system.station_count} stations`)

const mrtOnly = buildMrtOnly(full)
await writeFile(join(METRO, BASE_FILE), JSON.stringify(mrtOnly))
console.log(`  wrote ${BASE_FILE} (MRT-only): ${mrtOnly.metro_system.line_count} lines / ${mrtOnly.metro_system.station_count} stations`)

// index.json：基底覆蓋、附加 -lrt（比照 buildJrCombined 末段）
const idxPath = join(METRO, 'index.json')
const idx = JSON.parse(await readFile(idxPath, 'utf8'))
const m = full.metro_system
const baseEntry = idx.systems.find((s) => s.file === BASE_FILE)
if (baseEntry) { baseEntry.line_count = mrtOnly.metro_system.line_count; baseEntry.segment_count = mrtOnly.metro_system.segment_count; baseEntry.station_count = mrtOnly.metro_system.station_count; baseEntry.audit = null }
const lrtRec = {
  file: LRT_FILE, continent: m.continent, country: m.country, city: 'Singapore + LRT',
  osm_networks: withLrt.metro_system.osm_networks, operator: m.operator,
  official_website: m.official_website, official_map: m.official_map, wikidata: m.wikidata,
  line_count: withLrt.metro_system.line_count, segment_count: withLrt.metro_system.segment_count,
  station_count: withLrt.metro_system.station_count, audit: null,
}
const at = idx.systems.findIndex((s) => s.file === LRT_FILE)
if (at >= 0) idx.systems[at] = lrtRec; else idx.systems.push(lrtRec)
idx.system_count = idx.systems.length
await writeFile(idxPath, JSON.stringify(idx, null, 2))
console.log(`\nindex.json: ${idx.systems.length} systems (base MRT-only updated, -lrt appended)`)

// cityNamesZh.json：中文名
const zhPath = join(__dirname, '..', 'src', 'stores', 'cityNamesZh.json')
const zh = JSON.parse(await readFile(zhPath, 'utf8'))
zh['as-sgp-singapore-lrt'] = { country: '新加坡', city: '新加坡＋LRT' }
if (!zh['as-sgp-singapore']) zh['as-sgp-singapore'] = { country: '新加坡', city: '新加坡' }
await writeFile(zhPath, JSON.stringify(zh, null, 2) + '\n')
console.log('cityNamesZh.json: as-sgp-singapore-lrt → 新加坡＋LRT')
