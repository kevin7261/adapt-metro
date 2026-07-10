// 德國 S-Bahn 抓取（使用者規則：德國 U-Bahn＋S-Bahn 都要）。
// OSM 標法混雜：柏林/漢堡 route=light_rail、慕尼黑/法蘭克福/紐倫堡 route=train——
// 共通辨識是 ref=S 開頭＋operator/系統名含 S-Bahn。route=train 不在基準查詢範圍，
// 故以德國 metro 城市為中心的 bbox 補抓，寫 gap_* 快取（後載者勝，見 buildGeojson）。
// 城市綁定：NETWORK_CITY 以 operator（S-Bahn Berlin/Hamburg/München/Rhein-Main/Nürnberg）pin。
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'

// bbox 環繞五個德國 metro 城市（S-Bahn 放射 ~40 km，relation 任一成員入框即命中）
const BOXES = [
  ['berlin', '(52.2,12.9,52.8,13.9)'],
  ['hamburg', '(53.3,9.6,53.8,10.4)'],
  ['munich', '(47.9,11.2,48.4,11.9)'],
  ['frankfurt', '(49.9,8.2,50.3,9.0)'],
  ['nuremberg', '(49.2,10.8,49.7,11.4)'],
]

const routes = [], geoms = [], stations = []
const seenRel = new Set(), seenNode = new Set()
for (const [city, bb] of BOXES) {
  const q = `[out:json][timeout:180];relation["type"="route"]["route"~"^(train|light_rail)$"]["ref"~"^S[0-9]+$"]${bb}->.r;.r out body;node(r.r);out body;`
  const d = await overpass.query(q, { timeout: 180000, maxAttempts: 6 })
  let nr = 0, nn = 0
  for (const e of d.elements ?? []) {
    if (e.type === 'relation') {
      if (seenRel.has(e.id)) continue
      seenRel.add(e.id)
      const t = e.tags ?? {}
      // 只收 S-Bahn 本體：operator 或 name 沾到 S-Bahn（斯圖加特 VVS 等 operator
      // 只寫 DB Regio——不在五城 bbox，天然不會進來）
      if (!/s-bahn/i.test(`${t.operator ?? ''} ${t.network ?? ''} ${t.name ?? ''}`)) continue
      nr++
      routes.push({ type: 'relation', id: e.id, tags: t })
      geoms.push({ type: 'relation', id: e.id, tags: t,
        members: (e.members ?? []).filter((m) => m.type === 'node') })
    } else if (e.type === 'node') {
      if (seenNode.has(e.id)) continue
      seenNode.add(e.id)
      geoms.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon })
      if (e.tags?.name) {
        nn++
        stations.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: e.tags })
      }
    }
  }
  console.log(`${city}: +${nr} S-Bahn relations, +${nn} named nodes`)
}
await writeFile(join(overpass.CACHE, 'gap_routes_sbahn_de.json'), JSON.stringify({ elements: routes }))
await writeFile(join(overpass.CACHE, 'gap_geom_sbahn_de.json'), JSON.stringify({ elements: geoms }))
await writeFile(join(overpass.CACHE, 'gap_stations_sbahn_de.json'), JSON.stringify({ elements: stations }))
console.log(`total: ${routes.length} relations, ${stations.length} named nodes -> gap_*_sbahn_de.json`)
