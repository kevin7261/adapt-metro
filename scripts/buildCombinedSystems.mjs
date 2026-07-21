// Additive combined-variant systems: metro base ＋ 附加鐵路（既有 railway 資料 or OSM），
// 產生全新的 `*-...` 系統檔（不改動任何現有 metro/railway 管線腳本、現有 systems 檔、
// metro_lines / metro_stations 全球層）。與 buildJrCombined / buildLandmarkCombined /
// buildSingaporeVariants 同性質——independent additive builder，stale-cleanup 與 index
// 保留正則對這些 slug 豁免、絕不刪。schema 與 metro 系統檔一致，`combined: true`、
// `audit: null`（未經 metro:audit）。
//
//   as-kor-seoul-incheon  首爾＋仁川：as-kor-seoul ＋ 仁川 1/2 號線（整併）＋ AREX 機場鐵路
//                                     （공항철도 일반열차，OSM rel 7919000；機場輕軌셔틀트레인
//                                      已由 isAirportApm 排除、不含）
//   as-twn-taipei-rail    台北＋台鐵＋高鐵：as-twn-taipei ＋ 大台北都會區內的 TRA/HSR
//                                     （data/railway，bbox 過濾）
//   as-jpn-tokyo-rail     東京＋JR＋私鐵：as-jpn-tokyo ＋ 大東京都心的 JR 與私鐵
//                                     （data/railway，bbox 過濾；私鐵本就混在 JR 各社檔內）
//
// 鐵路站與 metro 站「完整整合」——同站合併成單一轉乘點（共站紅點）、計入 station_count。
//
//   node scripts/buildCombinedSystems.mjs
//
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { query } from './overpass.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const METRO = join(ROOT, 'data', 'metro')
const RAILWAY = join(ROOT, 'data', 'railway')

// 大台北都會區（台北市＋新北市；排除基隆/桃園）＝ Taipei metro bbox ＋ 0.03° 邊界
const TAIPEI_BBOX = [121.17, 24.90, 121.69, 25.23]
// 大東京都心 ＝ Tokyo metro bbox ＋ 0.05° 邊界（私鐵/JR 於此範圍截斷成都心段）
const TOKYO_BBOX = [139.56, 35.54, 140.01, 35.84]

const TARGETS = [
  {
    slug: 'as-kor-seoul-incheon',
    base: 'systems/asia/south-korea/as-kor-seoul.geojson',
    outDir: 'systems/asia/south-korea',
    cityEn: 'Seoul + Incheon',
    cityZh: '首爾＋仁川',
    countryZh: '南韓',
    mergeMetro: ['systems/asia/south-korea/as-kor-incheon.geojson'],
    osmLines: [{
      rel: 7919000, // AREX 일반열차（all-stop）서울역 → 인천공항2터미널（站序 Seoul→Airport）
      ref: 'A', name: '공항철도', nameLocal: '공항철도', nameEn: 'AREX (Airport Railroad)',
      color: '#0079AC',
      network: 'Airport Railroad', networkLocal: '공항철도',
      operator: '공항철도주식회사', wikidata: 'Q485846', wikipedia: 'ko:인천국제공항철도',
    }],
    // AREX/Incheon 站名 → Seoul metro 站名（羅馬字異拼的知名轉乘站）
    aliases: { "Hongik Univ.": "Hongik Univ.", "Digital Media City": "Digital Media City" },
  },
  {
    slug: 'as-twn-taipei-rail',
    base: 'systems/asia/taiwan/as-twn-taipei.geojson',
    outDir: 'systems/asia/taiwan',
    cityEn: 'Taipei + TRA + HSR',
    cityZh: '台北＋台鐵＋高鐵',
    countryZh: '台灣',
    railway: [
      { file: 'systems/asia/taiwan/as-twn-rail.geojson', bbox: TAIPEI_BBOX },
      { file: 'systems/asia/taiwan/as-twn-hsr.geojson', bbox: TAIPEI_BBOX },
    ],
  },
  {
    slug: 'as-jpn-tokyo-rail',
    base: 'systems/asia/japan/as-jpn-tokyo.geojson',
    outDir: 'systems/asia/japan',
    cityEn: 'Tokyo + JR + Private',
    cityZh: '東京＋JR＋私鐵',
    countryZh: '日本',
    railway: [
      { file: 'systems/asia/japan/as-jpn-east-rail.geojson', bbox: TOKYO_BBOX },
      { file: 'systems/asia/japan/as-jpn-central-rail.geojson', bbox: TOKYO_BBOX },
      { file: 'systems/asia/japan/as-jpn-hsr.geojson', bbox: TOKYO_BBOX },
    ],
  },
]

// ---- geo helpers --------------------------------------------------------
const R = 6371000
const rad = (d) => (d * Math.PI) / 180
function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
const inBbox = ([lon, lat], [w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n
// 站名正規化：小寫、去空白/句點、去尾綴（駅/站/역/station）、去消歧義括號
function normName(s) {
  return (s || '')
    .replace(/\(.*?\)/g, '')
    .replace(/[’'`.]/g, '')
    .replace(/(駅|站|역|station)$/i, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
}

// ---- SourceLine 抽取 -----------------------------------------------------
// 統一表示：{ routeId, ref, name, nameLocal, nameEn, color, network, networkLocal,
//            operator, wikidata, wikipedia, osmIds:[], loop,
//            stations:[{ id, name, nameLocal, nameEn, code, coord }] }

// 從既有 metro/railway geojson 抽出各條線（依 route.stations 完整站序），可 bbox 過濾。
function extractLinesFromGeojson(gj, { bbox = null } = {}) {
  const ptById = new Map()
  for (const f of gj.features) {
    if (f.geometry?.type !== 'Point') continue
    ptById.set(f.properties.station_id, {
      coord: f.geometry.coordinates,
      name: f.properties.station_name,
      nameLocal: f.properties.station_name_local ?? f.properties.station_name,
      nameEn: f.properties.station_name_en ?? null,
    })
  }
  const lines = []
  const seen = new Set()
  for (const f of gj.features) {
    if (f.geometry?.type !== 'MultiLineString') continue
    for (const r of f.properties.routes || []) {
      if (seen.has(r.route_id)) continue
      seen.add(r.route_id)
      const rawSeq = (r.stations || []).filter((s) => !s.pass)
      const stations = []
      for (const s of rawSeq) {
        const pt = ptById.get(s.station_id)
        if (!pt) continue
        if (bbox && !inBbox(pt.coord, bbox)) continue
        stations.push({
          id: s.station_id, name: pt.name, nameLocal: pt.nameLocal,
          nameEn: pt.nameEn, code: s.code || null, coord: pt.coord,
        })
      }
      // 去掉 bbox 過濾後相鄰重複
      const seq = stations.filter((s, i) => i === 0 || s.id !== stations[i - 1].id)
      if (seq.length < 2) continue
      const loop = rawSeq.length > 2 && rawSeq[0].station_id === rawSeq[rawSeq.length - 1].station_id
        && seq.length > 2
      lines.push({
        routeId: r.route_id, ref: r.route_ref || r.route_name, name: r.route_name,
        nameLocal: r.route_name_local ?? r.route_name, nameEn: r.route_name_en ?? null,
        color: r.route_color || (f.properties.route_colors || [])[0] || '#888888',
        network: r.network, networkLocal: r.network_local, operator: r.operator,
        wikidata: r.wikidata, wikipedia: r.wikipedia,
        osmIds: r.osm_route_ids || [], loop, stations: seq,
      })
    }
  }
  return lines
}

// 從 OSM route relation 抽一條線（依成員 role=stop 順序）。Korea 顯示名用 name:en。
async function extractLineFromOsm(spec) {
  const q = `[out:json][timeout:180];
rel(id:${spec.rel})->.r;
.r out body;
node(r.r);
out body;`
  const res = await query(q, { cacheName: `combined_osm_${spec.rel}.json` })
  const nodes = new Map()
  let rel = null
  for (const e of res.elements) {
    if (e.type === 'node') nodes.set(e.id, e)
    else if (e.type === 'relation' && e.id === spec.rel) rel = e
  }
  if (!rel) throw new Error(`relation ${spec.rel} not found`)
  const stations = []
  for (const m of rel.members) {
    if (m.type !== 'node' || !/stop/.test(m.role)) continue
    const n = nodes.get(m.ref)
    if (!n) continue
    const t = n.tags || {}
    const nameEn = t['name:en'] || null
    const nameLocal = t['name:ko'] || t.name || null
    const disp = nameEn || nameLocal
    if (!disp) continue
    const prev = stations[stations.length - 1]
    if (prev && prev.id === `n${m.ref}`) continue
    stations.push({
      id: `n${m.ref}`, name: disp, nameLocal: nameLocal || disp,
      nameEn, code: t.ref || null, coord: [n.lon, n.lat],
    })
  }
  if (stations.length > 2 && stations[0].id === stations[stations.length - 1].id) stations.pop()
  return {
    routeId: `osm${spec.rel}`, ref: spec.ref, name: spec.name,
    nameLocal: spec.nameLocal, nameEn: spec.nameEn, color: spec.color,
    network: spec.network, networkLocal: spec.networkLocal, operator: spec.operator,
    wikidata: spec.wikidata, wikipedia: spec.wikipedia,
    osmIds: [spec.rel], loop: false, stations,
  }
}

// ---- graph recompute（degree / interchange / terminus，同 buildJrCombined）--------
function recomputeFlags(features) {
  const stations = features.filter((f) => f.geometry?.type === 'Point')
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
  const nbrs = new Map(), termCount = new Map()
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
}

// ---- per-target build ---------------------------------------------------
async function build(t) {
  const gj = JSON.parse(await readFile(join(METRO, t.base), 'utf8'))
  const features = gj.features.map((f) => JSON.parse(JSON.stringify(f)))
  const country = gj.metro_system.country
  const city = gj.metro_system.city
  const baseStationCount = features.filter((f) => f.geometry?.type === 'Point').length

  // 收集所有要附加的 SourceLine
  const addLines = []
  for (const rel of t.mergeMetro || []) {
    const src = JSON.parse(await readFile(join(METRO, rel), 'utf8'))
    addLines.push(...extractLinesFromGeojson(src))
  }
  for (const rw of t.railway || []) {
    const src = JSON.parse(await readFile(join(RAILWAY, rw.file), 'utf8'))
    addLines.push(...extractLinesFromGeojson(src, { bbox: rw.bbox }))
  }
  for (const spec of t.osmLines || []) addLines.push(await extractLineFromOsm(spec))

  console.log(`\n[${t.slug}] base ${gj.metro_system.city} (${baseStationCount} st) + ${addLines.length} lines`)

  // 站名索引（含 merged_names 別名）——含 base 與後續新增的站
  const nameIdx = new Map()
  const addIdx = (name, f) => {
    const k = normName(name)
    if (!k) return
    if (!nameIdx.has(k)) nameIdx.set(k, [])
    if (!nameIdx.get(k).includes(f)) nameIdx.get(k).push(f)
  }
  const indexStation = (f) => {
    addIdx(f.properties.station_name, f)
    addIdx(f.properties.station_name_en, f)
    for (const m of f.properties.merged_names || []) addIdx(m.station_name, f)
  }
  for (const f of features) if (f.geometry?.type === 'Point') indexStation(f)

  const aliases = t.aliases || {}
  const noMerge = new Set((t.noMerge || []).map(normName))

  // 合併/新增一個 SourceLine 的站，回傳可畫線用的 station feature
  function resolveStation(s, line) {
    const target = aliases[s.name] || s.name
    const keys = [normName(target), normName(s.nameEn)].filter(Boolean)
    let hit = null
    if (!noMerge.has(normName(s.name))) {
      const cands = new Set()
      for (const k of keys) for (const c of nameIdx.get(k) || []) cands.add(c)
      for (const cand of cands) {
        const d = haversine(s.coord, cand.geometry.coordinates)
        if (d <= 800 && (!hit || d < hit.d)) hit = { f: cand, d }
      }
      // 名稱對不上（跨資料集羅馬字/讀音異拼）時的純座標近距後備
      if (!hit) {
        for (const f of features) {
          if (f.geometry?.type !== 'Point') continue
          const d = haversine(s.coord, f.geometry.coordinates)
          if (d <= 150 && (!hit || d < hit.d)) hit = { f, d }
        }
      }
    }
    const lineRef = line.ref
    if (hit) {
      const p = hit.f.properties
      const origLines = [...(p.lines || [])]
      if (!(p.routes || []).some((r) => r.ref === lineRef && r.name === line.name))
        p.routes = [...(p.routes || []), { ref: lineRef, name: line.name }]
      if (!(p.lines || []).includes(lineRef)) p.lines = [...(p.lines || []), lineRef]
      if (s.code) p.codes = [...(p.codes || []), s.code].filter((v, i, a) => a.indexOf(v) === i)
      // 共站：附加線一律在 merged_names 標成共站（即使同名），才會顯示轉乘區塊
      if (!Array.isArray(p.merged_names) || p.merged_names.length === 0) {
        p.merged_names = [{
          station_id: p.station_id, station_name: p.station_name,
          station_name_local: p.station_name_local ?? p.station_name, lines: origLines,
        }]
      }
      const rep = p.merged_names[0]
      const ex = p.merged_names.find((m) => m !== rep && normName(m.station_name) === normName(s.name))
      if (ex) { if (!(ex.lines || []).includes(lineRef)) ex.lines = [...(ex.lines || []), lineRef] }
      else p.merged_names.push({
        station_id: s.id, station_name: s.name,
        station_name_local: s.nameLocal ?? s.name, lines: [lineRef],
      })
      return hit.f
    }
    // 新站
    const feat = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: s.coord },
      properties: {
        station_id: s.id, station_name: s.name,
        station_name_local: s.nameLocal ?? s.name, station_name_en: s.nameEn ?? null,
        network: line.network, network_local: line.networkLocal, operator: line.operator,
        city, country, lines: [lineRef], wikidata: null, wikipedia: null,
        merged_from: 1, merged_names: null, is_terminus: false,
        codes: s.code ? [s.code] : null, routes: [{ ref: lineRef, name: line.name }],
        station_degree: 0, is_interchange: false, station_role: 'normal',
      },
    }
    features.push(feat)
    indexStation(feat)
    return feat
  }

  // 逐條附加線：合併站 → 建線段 feature
  let segIdx = 0
  let merged = 0, added = 0
  const before = features.filter((f) => f.geometry?.type === 'Point').length
  for (const line of addLines) {
    const vtx = []
    const routeStations = []
    for (const s of line.stations) {
      const f = resolveStation(s, line)
      if (f.properties.merged_from === 1 && f.properties.station_id === s.id) added++
      else merged++
      vtx.push(f.geometry.coordinates)
      routeStations.push({
        station_id: f.properties.station_id, station_name: f.properties.station_name,
        ...(s.code ? { code: s.code } : {}),
      })
    }
    if (line.loop && routeStations.length > 2) {
      routeStations.push({ ...routeStations[0] })
      vtx.push(vtx[0])
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: [vtx] },
      properties: {
        seg_id: `${t.slug}-add-${segIdx++}`,
        routes: [{
          route_id: line.routeId, route_name: line.name, route_name_local: line.nameLocal,
          route_name_en: line.nameEn, route_ref: line.ref, route_color: line.color,
          network: line.network, network_local: line.networkLocal, operator: line.operator,
          wikidata: line.wikidata, wikipedia: line.wikipedia, osm_route_ids: line.osmIds,
          status: null, order_suspect: 0, stations: routeStations,
        }],
        route_count: 1, route_refs: [line.ref], route_colors: [line.color],
        city, country,
      },
    })
  }
  const afterPts = features.filter((f) => f.geometry?.type === 'Point').length
  console.log(`  merged ${merged}, new stations +${afterPts - before}`)

  recomputeFlags(features)

  const totalStations = features.filter((f) => f.geometry?.type === 'Point').length
  const totalSegs = features.filter((f) => f.geometry?.type === 'MultiLineString').length
  const nInterchange = features.filter((f) => f.geometry?.type === 'Point' && f.properties.is_interchange).length
  const m = gj.metro_system
  const addNets = [...new Set(addLines.map((l) => l.networkLocal || l.network).filter(Boolean))]
  const out = {
    type: 'FeatureCollection',
    metro_system: {
      ...m, city: t.cityEn,
      osm_networks: [...new Set([...(m.osm_networks || []), ...addNets])],
      line_count: (m.line_count || 0) + addLines.length,
      segment_count: totalSegs, station_count: totalStations,
      combined: true,
      combined_note: `Metro（${m.city}）＋附加鐵路 ${addLines.length} 線（一次性附加，未經 metro:audit）`,
      audit: null,
    },
    features,
  }
  const outPath = join(METRO, t.outDir, `${t.slug}.geojson`)
  await writeFile(outPath, JSON.stringify(out))
  console.log(`  stations ${baseStationCount}→${totalStations}, segs ${totalSegs}, lines ${out.metro_system.line_count}, interchanges ${nInterchange}`)
  console.log(`  wrote ${outPath}`)
  return {
    file: `${t.outDir}/${t.slug}.geojson`,
    continent: m.continent, country: m.country, city: t.cityEn,
    osm_networks: out.metro_system.osm_networks, operator: m.operator,
    official_website: m.official_website, official_map: m.official_map,
    wikidata: m.wikidata, line_count: out.metro_system.line_count,
    segment_count: totalSegs, station_count: totalStations,
    cityZh: t.cityZh, countryZh: t.countryZh, slug: t.slug,
  }
}

// ---- main ---------------------------------------------------------------
const entries = []
for (const t of TARGETS) entries.push(await build(t))

// index.json：附加/覆蓋新系統
const idxPath = join(METRO, 'index.json')
const idx = JSON.parse(await readFile(idxPath, 'utf8'))
for (const e of entries) {
  const { cityZh, countryZh, slug, ...sys } = e
  const rec = { ...sys, audit: null }
  const at = idx.systems.findIndex((s) => s.file === sys.file)
  if (at >= 0) idx.systems[at] = rec
  else idx.systems.push(rec)
}
idx.system_count = idx.systems.length
await writeFile(idxPath, JSON.stringify(idx, null, 2))
console.log(`\nindex.json: ${idx.systems.length} systems`)

// cityNamesZh.json：中文城市名
const zhPath = join(ROOT, 'src', 'stores', 'cityNamesZh.json')
const zh = JSON.parse(await readFile(zhPath, 'utf8'))
for (const e of entries) zh[e.slug] = { country: e.countryZh, city: e.cityZh }
await writeFile(zhPath, JSON.stringify(zh, null, 2) + '\n')
console.log(`cityNamesZh.json: added ${entries.map((e) => e.slug).join(', ')}`)
