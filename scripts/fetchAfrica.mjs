// 非洲電車／輕軌城市的定向補抓（route=tram）。
// 使用者裁決 2026-07-23：「模里西斯和一些非洲國家好像也有輕軌」，依
// urbanrail.net/af/africa.htm 的城市清單收錄。
//
// 分工：
//   * route=light_rail 的系統（阿迪斯阿貝巴 AA-LRT、阿布加 Abuja Rail Mass Transit、
//     突尼斯 métro léger＋TGM、模里西斯 Metro Express）本來就在 fetchMetro.mjs 的全球
//     基準查詢內，這裡不抓——它們只是被 buildGeojson 的「純 LRT 剔除」規則丟掉，
//     改由 TRAM_RAIL_CITIES 白名單＋NETWORK_CITY／_overrides 綁城救回。
//   * route=tram（卡薩布蘭卡、拉巴特、亞歷山卓、阿爾及利亞七城）不在基準查詢內，
//     比照廣島（fetchHiroden.mjs）以城市 bbox＋operator 比對補抓，寫 gap_* 快取。
//
// 城市綁定：阿爾及利亞七城的電車 operator 全是 SETRAM（或完全無標籤），network/operator
// 無法分辨城市 → 本檔在抓完後**自動產生 _overrides/<country>-<city>.json**（格式同
// auditLoop.mjs 寫的城市綁定 override：relation id → 城市），buildGeojson 讀 override
// 直接 pin 城市、且豁免 LRT 範圍規則。
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'
import { fetchMastersFor, assignRefsFromMasters } from './fetchGapMasters.mjs'
import { synthStopsFromWays } from './gapStopsFromWays.mjs'

const OVERRIDES = join(overpass.CACHE, '..', '_overrides')
const LIFE = '["state"!~"^(proposed|construction)$"][!"construction"][!"proposed"][!"disused"][!"abandoned"]'

const SETRAM = /SETRAM|Société d'Exploitation des Tramways/i

// bbox 只框都會區——阿爾及利亞各城電車彼此相距數百公里，框不重疊即可分城。
const TASKS = [
  // ── 市郊鐵路（route=train）──────────────────────────────────────────────
  // 南非 PRASA Metrorail 三個都會區網＋Gautrain（urbanrail 的 Cape Town／Durban／
  // Johannesburg／Pretoria 頁）。這些 route relation **完全沒有 ref**，分線全靠
  // route_master（fetchGapMasters）。Pretoria 與約堡同屬一個 Metrorail Gauteng 網
  // （Gautrain 也直通兩市），拆城會把同一路網切斷 → 併成一個 Johannesburg 檔。
  { key: 'johannesburg', mode: 'train', city: 'Johannesburg', country: 'South Africa',
    bbox: '(-26.60,27.60,-25.55,28.55)', stations: 'rail',
    keep: (t) => /Metrorail Gauteng|Gautrain/i.test(`${t.network ?? ''} ${t.operator ?? ''}`) &&
      !/bus/i.test(`${t.name ?? ''}`) },
  { key: 'capetown', mode: 'train', city: 'Cape Town', country: 'South Africa',
    bbox: '(-34.15,18.25,-33.55,19.15)', stations: 'rail',
    keep: (t) => /Metrorail Western Cape/i.test(`${t.network ?? ''} ${t.operator ?? ''}`) },
  { key: 'durban', mode: 'train', city: 'Durban', country: 'South Africa',
    bbox: '(-30.15,30.65,-29.55,31.15)', stations: 'rail',
    keep: (t) => /Metrorail KwaZulu-Natal/i.test(`${t.network ?? ''} ${t.operator ?? ''}`) },
  // 達卡 TER（Train Express Régional，Dakar–Diamniadio–AIBD）
  { key: 'dakar', mode: 'train', city: 'Dakar', country: 'Senegal',
    bbox: '(14.55,-17.60,14.90,-16.95)', stations: 'rail',
    keep: (t) => /Train Express Régional|TER Dakar|SETER/i.test(
      `${t.network ?? ''} ${t.operator ?? ''} ${t.name ?? ''}`) },
  // ── 電車（route=tram）─────────────────────────────────────────────────
  { key: 'casablanca', city: 'Casablanca', country: 'Morocco', bbox: '(33.40,-7.90,33.75,-7.25)',
    keep: (t) => /Casa Tram|RATP Dev/i.test(`${t.network ?? ''} ${t.operator ?? ''}`) },
  { key: 'rabat', city: 'Rabat', country: 'Morocco', bbox: '(33.85,-7.00,34.15,-6.55)',
    keep: (t) => /STRS|Transdev|Rabat/i.test(`${t.network ?? ''} ${t.operator ?? ''} ${t.name ?? ''}`) },
  { key: 'alexandria', city: 'Alexandria', country: 'Egypt', bbox: '(31.10,29.75,31.35,30.15)',
    keep: (t) => /Alexandria Passenger Transport/i.test(`${t.operator ?? ''} ${t.network ?? ''}`) },
  // 阿爾及利亞（Alger 的地鐵已在基準查詢內；這裡只補該城電車，override 綁回同一個
  // Algiers 桶，兩者合成一檔）
  { key: 'algiers', city: 'Algiers', country: 'Algeria', bbox: '(36.60,2.85,36.90,3.35)',
    keep: (t) => SETRAM.test(`${t.operator ?? ''} ${t.network ?? ''}`) },
  { key: 'oran', city: 'Oran', country: 'Algeria', bbox: '(35.55,-0.80,35.85,-0.45)', keep: () => true },
  { key: 'constantine', city: 'Constantine', country: 'Algeria', bbox: '(36.20,6.45,36.50,6.80)', keep: () => true },
  { key: 'setif', city: 'Sétif', country: 'Algeria', bbox: '(36.05,5.25,36.30,5.55)', keep: () => true },
  { key: 'sidibelabbes', city: 'Sidi Bel Abbès', country: 'Algeria', bbox: '(35.10,-0.80,35.35,-0.50)', keep: () => true },
  { key: 'ouargla', city: 'Ouargla', country: 'Algeria', bbox: '(31.80,5.20,32.10,5.50)', keep: () => true },
  { key: 'mostaganem', city: 'Mostaganem', country: 'Algeria', bbox: '(35.80,-0.05,36.05,0.25)', keep: () => true },
]

// 可只跑指定城市：node scripts/fetchAfrica.mjs alexandria dakar
const only = process.argv.slice(2)
for (const task of TASKS.filter((t) => !only.length || only.includes(t.key))) {
  const { key, city, country, bbox, keep, mode = 'tram', stations: stMode = 'members' } = task
  const routes = [], geoms = [], stations = []
  const geomByRel = new Map()
  const q = `[out:json][timeout:180];relation["type"="route"]["route"="${mode}"]${LIFE}${bbox}->.r;` +
    '.r out body;node(r.r);out body;'
  const d = await overpass.query(q, { timeout: 180000, maxAttempts: 6 })

  const needed = new Set()
  let skipped = 0
  for (const e of d.elements ?? []) {
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
  const seenNode = new Set()
  for (const e of d.elements ?? []) {
    if (e.type !== 'node' || !needed.has(e.id) || seenNode.has(e.id)) continue
    seenNode.add(e.id)
    geoms.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon })
    // 電車停留場多標 railway=tram_stop（非 station=*），基準站源查詢撈不到 → 取有名成員
    if (stMode === 'members' && e.tags?.name)
      stations.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: e.tags })
  }

  // 電車：另抓 bbox 內的具名 railway=tram_stop——亞歷山卓的 21 條電車 relation 幾乎
  // 沒有 stop 成員（21 條合計只有 7 個節點成員），只靠成員取站會整城剩 5 站。無路線
  // 歸屬的站在 buildGeojson 會以 nearbyLineRefs 依幾何就近綁線（見該處）。
  if (stMode === 'members') {
    const q2 = `[out:json][timeout:180];node["railway"="tram_stop"]["name"]${LIFE}${bbox};out body;`
    const d2 = await overpass.query(q2, { timeout: 180000, maxAttempts: 6 })
    for (const e of d2.elements ?? []) {
      if (e.type !== 'node' || !e.tags?.name || seenNode.has(e.id)) continue
      seenNode.add(e.id)
      stations.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: e.tags })
      geoms.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon })
    }
  }

  // 重軌：另抓乾淨站源（railway=station|halt 的節點與 way 中心）——route 成員是月台
  // stop_position，站名常帶月台後綴會把一站拆成多點（見 fetchSydneyTrains）。
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

  // 只掛 way、沒有 stop 節點的 relation（亞歷山卓 21 條電車 route 合計只有 7 個 node
  // 成員）：由 way 幾何把站點投影回線上合成停靠序，否則整城只剩零星幾站
  // （見 gapStopsFromWays.mjs）。
  const noStops = routes.map((r) => r.id).filter((id) => !geomByRel.get(id)?.members?.length)
  let synthN = 0
  if (noStops.length) {
    const synth = await synthStopsFromWays(noStops, stations)
    for (const [rid, members] of synth) { geomByRel.get(rid).members = members; synthN++ }
  }

  // route_master：分組第一順位（南非 Metrorail 的 route 沒有 ref，只有 master 分得出線）
  const masters = await fetchMastersFor(routes.map((r) => r.id), key)
  // 沒有 ref 的 route 依 master／顏色／名稱基底補 ref，讓上下行與區間車收斂成一條線
  // （必須在寫檔前——tags 物件同時被 routes 與 geoms 參照）
  const refAdded = assignRefsFromMasters(routes, masters)

  await writeFile(join(overpass.CACHE, `gap_routes_${key}.json`), JSON.stringify({ elements: routes }))
  await writeFile(join(overpass.CACHE, `gap_geom_${key}.json`), JSON.stringify({ elements: geoms }))
  await writeFile(join(overpass.CACHE, `gap_stations_${key}.json`), JSON.stringify({ elements: stations }))

  // 城市綁定 override（自動產生）：這些系統的 network/operator 不足以分辨城市
  if (routes.length) {
    const slug = `${country}-${city}`.normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    await writeFile(join(OVERRIDES, `${slug}.json`), `${JSON.stringify({
      city, country, continent: 'africa',
      osm_route_ids: routes.map((r) => r.id).sort((a, b) => a - b),
      source: 'https://www.urbanrail.net/af/africa.htm',
      note: `${city}（route=${mode}）——由 scripts/fetchAfrica.mjs 自動產生。` +
        'operator（SETRAM／RATP Dev／Transdev／Metrorail…）跨城通用或完全無標籤，' +
        '無法以 network 綁城，故以 relation id 直綁；override 同時豁免 buildGeojson 的' +
        '「純 LRT 剔除」規則。重跑 fetchAfrica.mjs 會依最新 OSM 覆寫本檔。',
    }, null, 2)}\n`)
  }
  console.log(`${key}: ${routes.length} ${mode} relations (${skipped} skipped), ` +
    `${stations.length} stops, ${masters.length} masters` +
    (refAdded ? `, ${refAdded} refs 補齊` : '') +
    (synthN ? `, ${synthN}/${noStops.length} way-only relations 合成停靠序` : ''))
}
