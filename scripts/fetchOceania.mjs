// 大洋洲（澳洲／紐西蘭）市郊鐵路＋電車抓取。
// 使用者裁決 2026-07-23（依 urbanrail.net/au/oceania.htm）：「澳洲紐西蘭是 suburban rail
// 和 tram，除了 Sydney 外要重抓」、且「市郊鐵路＋電車都收」。
//
// 這些城市的都市軌道全是 route=train（市郊鐵路）或 route=tram（電車），不在
// fetchMetro.mjs 的全球基準查詢（subway|light_rail）範圍內——比照雪梨
// （fetchSydneyTrains.mjs）與廣島（fetchHiroden.mjs）以「城市 bbox＋network/operator
// 比對」定向補抓，寫 gap_* 快取（後載者勝，見 buildGeojson）。
//   * route=light_rail 的三城（坎培拉／紐卡索／黃金海岸 G:link）已在基準查詢內，
//     這裡不抓，只在 buildGeojson 以 NETWORK_CITY pin 城市＋範圍白名單保留。
//   * 城市綁定一律 pin（NETWORK_CITY）——這些城不在 wiki List of metro systems，
//     geocode 會落在行政區名（如 North Canberra），不 pin 會產生怪檔名。
//
// 服務變體收斂：OSM 把每條線拆成往返／快慢／經 City Loop 等多個 relation，多數同 ref
// （build 端以 network+ref 分組自動收斂）；少數同一條線兩個方向用不同 ref（布里斯本
// Airport 線 BRBD/BDBR、卡布爾徹 CABR/BRCA…）或短程/延伸段自成 ref（伯斯 AIR:P、
// 阿德萊德 SALIS…），由 _overrides/route_tag_patches.json 正規化成幹線 ref。
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'
import { fetchMastersFor } from './fetchGapMasters.mjs'
import { synthStopsFromWays } from './gapStopsFromWays.mjs'

// 與基準查詢同一組 lifecycle 護欄：未通車/廢線不得進資料
const LIFE = '["state"!~"^(proposed|construction)$"][!"construction"][!"proposed"][!"disused"][!"abandoned"]'

const net = (t) => `${t.network ?? ''}`
const op = (t) => `${t.operator ?? ''}`

// 墨爾本 Metro Tunnel（2025 通車）貫通運營：Sunbury ⇄ Cranbourne／East Pakenham 的
// 幹線 relation 用箭頭 ref（"EPH => SUY"…），乾淨三碼 ref 只剩支線接駁段——不收幹線
// 會讓 Cranbourne/Pakenham 兩線與市中心斷開（連通分量破裂）。故一併收下，ref 由
// route_tag_patches 正規化成 CBE／PKM。
const MELB_TRUNK = new Set([
  'CBE => WFY', 'WFY => CBE', 'WGS=>CBE', 'CBE => WGS',
  'EPH => SUY', 'SUY => EPH', 'SUY=>EPH', 'EPH=>WGS',
])

// stations:'rail' → 另抓乾淨的 railway=station 節點/way 中心當站源（月台 stop_position
//   多帶「, Platform 3」後綴，會把一站拆成多點，見 fetchSydneyTrains）。
// stations:'members' → 站源取 relation 的有名成員節點（電車停留場多標 railway=tram_stop，
//   基準站源查詢撈不到，見 fetchHiroden）。
const TASKS = [
  // ── 澳洲 ──────────────────────────────────────────────────────────────
  // Cross City（Williamstown⇄Sandringham 貫通班）與 City Circle（空車／Loop 運轉）
  // 不是官方幹線圖上的獨立線——若收進來會污染 SHM／WIL 站序（Sandringham 被接到
  // Williamstown）。官方圖見 Transport Victoria victorian-train-network-map.pdf。
  { key: 'melbourne', mode: 'train', bbox: '(-38.5,144.3,-37.4,145.8)', stations: 'rail',
    keep: (t) => /^PTV - Metropolitan Trains$/i.test(net(t)) &&
      (/^[A-Z]{3}$/.test(t.ref ?? '') || MELB_TRUNK.has(t.ref ?? '')) &&
      !/cross\s*city|city\s*circle/i.test(t.name ?? '') },
  // 墨爾本電車（Yarra Trams，24 條路線 ~1700 停留場）：使用者裁決 2026-07-23
  // 「墨爾本分 Metro Trains 和 tram」——照抓，但 buildGeojson 之後由
  // scripts/buildMelbourneVariants.mjs 拆成兩個系統檔（比照新加坡 MRT／MRT+LRT）：
  //   oc-aus-melbourne（覆寫）＝ Metro Trains 16 線
  //   oc-aus-melbourne-tram（新增）＝ Yarra Trams 24 路線
  { key: 'melbournetram', mode: 'tram', bbox: '(-38.1,144.6,-37.5,145.4)', stations: 'members',
    keep: (t) => /PTV - Metropolitan Trams|Yarra Trams/i.test(`${net(t)} ${op(t)}`) &&
      /^\d+$/.test(t.ref ?? '') },
  { key: 'brisbane', mode: 'train', bbox: '(-28.3,152.4,-26.4,153.6)', stations: 'rail',
    keep: (t) => /^Translink$/i.test(net(t)) && /Queensland Rail/i.test(op(t)) },
  { key: 'perth', mode: 'train', bbox: '(-32.8,115.4,-31.4,116.5)', stations: 'rail',
    // FSG＝Showgrounds Express（皇家秀特別班），非常設路線，不收
    keep: (t) => /^Transperth$/i.test(net(t)) && !/^FSG$/.test(t.ref ?? '') },
  { key: 'adelaide', mode: 'train', bbox: '(-35.4,138.3,-34.5,139.0)', stations: 'rail',
    keep: (t) => /^Adelaide Metro$/i.test(net(t)) },
  { key: 'adelaidetram', mode: 'tram', bbox: '(-35.1,138.4,-34.8,138.8)', stations: 'members',
    keep: (t) => /^Adelaide Metro$/i.test(net(t)) },
  // ── 紐西蘭 ────────────────────────────────────────────────────────────
  // 奧克蘭 Auckland One Rail（network=AT）4 線；Te Huia（network "AT;BUSIT"，
  // Waikato 區域城際）不是市郊鐵路，排除
  { key: 'auckland', mode: 'train', bbox: '(-37.3,174.4,-36.5,175.2)', stations: 'rail',
    keep: (t) => /^AT$/.test(net(t)) },
  // 威靈頓 Metlink 5 線（含 Wairarapa Connection，urbanrail 列為威靈頓通勤線）。
  // KPL（Kapiti 線）的 22 個成員是月台 stop_position、對不上乾淨站源，snap 後站序錯亂
  // 且只到 Paremata（Tawa 被排到最後、Waikanae 段整段掉了，metro:verify 標 order 可疑）
  // → forceSynth 指定改用 way 幾何重建停靠序（見 gapStopsFromWays.mjs）。
  { key: 'wellington', mode: 'train', bbox: '(-41.5,174.6,-40.7,175.9)', stations: 'rail',
    keep: (t) => /^Metlink$/i.test(net(t)),
    forceSynth: (t) => /^KPL$/.test(t.ref ?? '') },
]

// 可只跑指定城市：node scripts/fetchOceania.mjs adelaide
const only = process.argv.slice(2)
for (const task of TASKS.filter((t) => !only.length || only.includes(t.key))) {
  const { key, mode, bbox, stations: stMode, keep, forceSynth } = task
  const routes = [], geoms = [], stations = []
  const seenNode = new Set()
  const geomByRel = new Map()

  // 1) route relations ＋ 全部成員節點
  const q1 = `[out:json][timeout:180];relation["type"="route"]["route"="${mode}"]${LIFE}${bbox}->.r;` +
    '.r out body;node(r.r);out body;'
  const d1 = await overpass.query(q1, { timeout: 180000, maxAttempts: 6 })
  const needed = new Set()
  let skipped = 0
  for (const e of d1.elements ?? []) {
    if (e.type !== 'relation') continue
    const t = e.tags ?? {}
    if (!keep(t)) { skipped++; continue }
    routes.push({ type: 'relation', id: e.id, tags: t })
    const members = (e.members ?? []).filter((m) => m.type === 'node')
    const gr = { type: 'relation', id: e.id, tags: t, members }
    geoms.push(gr)
    geomByRel.set(e.id, gr)
    for (const m of members) needed.add(m.ref)
  }
  for (const e of d1.elements ?? []) {
    if (e.type !== 'node' || !needed.has(e.id) || seenNode.has(e.id)) continue
    seenNode.add(e.id)
    geoms.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon })
    // 電車：成員裡的有名節點就是停留場（基準站源查詢撈不到 railway=tram_stop）
    if (stMode === 'members' && e.tags?.name)
      stations.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: e.tags })
  }

  // 2) 重軌：乾淨站源（railway=station|halt 的節點與 way 中心，站名無月台後綴）
  if (stMode === 'rail') {
    const q2 = `[out:json][timeout:180];node["railway"~"^(station|halt)$"]${LIFE}${bbox};out body;`
    const d2 = await overpass.query(q2, { timeout: 180000, maxAttempts: 6 })
    for (const e of d2.elements ?? []) {
      if (e.type !== 'node' || !e.tags?.name) continue
      stations.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: e.tags })
      if (!seenNode.has(e.id)) {
        seenNode.add(e.id)
        geoms.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon })
      }
    }
    const q3 = `[out:json][timeout:180];way["railway"~"^(station|halt)$"]${LIFE}${bbox};out center tags;`
    const d3 = await overpass.query(q3, { timeout: 180000, maxAttempts: 6 })
    const seenWay = new Set()
    for (const e of d3.elements ?? []) {
      if (e.type !== 'way' || !e.tags?.name || !e.center || seenWay.has(e.id)) continue
      seenWay.add(e.id)
      stations.push({ type: 'node', id: e.id, lat: e.center.lat, lon: e.center.lon, tags: e.tags })
      geoms.push({ type: 'node', id: e.id, lat: e.center.lat, lon: e.center.lon })
    }
  }

  // 只掛 way、沒有任何 stop 節點的 relation（阿德萊德 Adelaide Metro 全部 21 條）：
  // 由 way 幾何把上面抓到的站點投影回線上、依里程排序合成停靠序，否則整組會變成
  // 「沒有站的線」被丟掉（見 gapStopsFromWays.mjs）。
  const noStops = routes
    .filter((r) => !geomByRel.get(r.id)?.members?.length || forceSynth?.(r.tags))
    .map((r) => r.id)
  let synthN = 0
  if (noStops.length) {
    const synth = await synthStopsFromWays(noStops, stations)
    for (const [rid, members] of synth) {
      geomByRel.get(rid).members = members
      synthN++
    }
  }

  await writeFile(join(overpass.CACHE, `gap_routes_${key}.json`), JSON.stringify({ elements: routes }))
  await writeFile(join(overpass.CACHE, `gap_geom_${key}.json`), JSON.stringify({ elements: geoms }))
  await writeFile(join(overpass.CACHE, `gap_stations_${key}.json`), JSON.stringify({ elements: stations }))
  // route_master：分組的第一順位（墨爾本 Metro Tunnel 的箭頭 ref 靠 master 收回幹線）
  const masters = await fetchMastersFor(routes.map((r) => r.id), key)
  const refs = [...new Set(routes.map((r) => r.tags.ref ?? '(no ref)'))].sort()
  console.log(`${key}: ${routes.length} ${mode} relations (${skipped} skipped), ` +
    `${stations.length} stations, ${masters.length} masters` +
    (synthN ? `, ${synthN}/${noStops.length} way-only relations 合成停靠序` : '') +
    ` -> gap_*_${key}.json\n  refs: ${refs.join(', ')}`)
}
