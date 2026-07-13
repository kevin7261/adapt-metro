// 雪梨 Sydney Trains（舊稱 CityRail）市郊鐵路抓取（使用者規則：雪梨要抓 CityRail）。
// Sydney Trains 的市郊 T 線（T1–T9）在 OSM 標 route=train（重軌），不在基準查詢
// （subway|light_rail）範圍——故以雪梨 bbox 補抓，寫 gap_* 快取（後載者勝，見
// buildGeojson）。辨識：ref=T 開頭且 network=Sydney Trains（NSW TrainLink 城際線
// ref 非 T#，天然排除）。城市綁定：NETWORK_CITY 以 network/operator「Sydney Trains」pin。
// 對應德國 S-Bahn 的 fetchSbahnDe.mjs（route=train 的城市層 scope 例外）。
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'

// bbox 環繞大雪梨（Sydney Trains 放射 ~50 km：北 Berowra/Richmond、南 Waterfall/
// Macarthur、西 Emu Plains/Leppington；relation 任一成員入框即命中）
const BBOX = '(-34.3,150.5,-33.4,151.5)'

const routes = [], geoms = [], stations = []
const seenRel = new Set(), seenNode = new Set()

// 1) T 線 route relations ＋ 全部成員節點（月台 stop_position 逐個具名，僅供幾何頂點）。
const q1 = `[out:json][timeout:180];relation["type"="route"]["route"="train"]["ref"~"^T[0-9]"]${BBOX}->.r;.r out body;node(r.r);out body;`
const d1 = await overpass.query(q1, { timeout: 180000, maxAttempts: 6 })
let nr = 0
for (const e of d1.elements ?? []) {
  if (e.type === 'relation') {
    if (seenRel.has(e.id)) continue
    seenRel.add(e.id)
    const t = e.tags ?? {}
    // 只收 Sydney Trains 本體：network 或 operator 沾到 Sydney Trains/CityRail
    // （T# ref 已在查詢過濾；此處再排除任何非 Sydney Trains 的殘留）
    if (!/sydney trains|cityrail/i.test(`${t.network ?? ''} ${t.operator ?? ''} ${t.name ?? ''}`)) continue
    nr++
    routes.push({ type: 'relation', id: e.id, tags: t })
    geoms.push({ type: 'relation', id: e.id, tags: t,
      members: (e.members ?? []).filter((m) => m.type === 'node') })
  } else if (e.type === 'node') {
    if (seenNode.has(e.id)) continue
    seenNode.add(e.id)
    // 成員節點只當幾何頂點——**不**當站源（月台名如「Central, Platform 18」會把
    // 一站拆成多個月台點）。站源改用下方乾淨的 railway=station 節點。
    geoms.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon })
  }
}

// 2) 乾淨站源：railway=station + train=yes（站名無月台後綴，如「Central」「Parramatta」）。
//    route 成員（月台 stop）在 build 端會 snap 到最近的乾淨站點，同站多月台自動併一。
const q2 = `[out:json][timeout:180];node["railway"="station"]["train"="yes"]${BBOX};out body;`
const d2 = await overpass.query(q2, { timeout: 180000, maxAttempts: 6 })
let ns = 0
for (const e of d2.elements ?? []) {
  if (e.type !== 'node' || !e.tags?.name) continue
  ns++
  stations.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: e.tags })
  // 站點座標也進 geom，讓成員 stop 的 snap 目標有座標可用
  if (!seenNode.has(e.id)) { seenNode.add(e.id); geoms.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon }) }
}
// 3) 站體以 way 表示者（如 Olympic Park，way railway=station train=yes 的建物範圍）——
//    node 查詢抓不到，補 way 中心點查詢（out center），中心座標當站點，否則 T7
//    Olympic Park Line 會因 Olympic Park 站無 snap 目標而只剩 1 站被丟。
const seenWay = new Set()
const q3 = `[out:json][timeout:180];way["railway"="station"]["train"="yes"]${BBOX};out center tags;`
const d3 = await overpass.query(q3, { timeout: 180000, maxAttempts: 6 })
let nw = 0
for (const e of d3.elements ?? []) {
  if (e.type !== 'way' || !e.tags?.name || !e.center || seenWay.has(e.id)) continue
  seenWay.add(e.id)
  nw++
  stations.push({ type: 'node', id: e.id, lat: e.center.lat, lon: e.center.lon, tags: e.tags })
  geoms.push({ type: 'node', id: e.id, lat: e.center.lat, lon: e.center.lon })
}
console.log(`Sydney Trains: +${nr} T-line relations, +${ns} station nodes, +${nw} station ways`)

await writeFile(join(overpass.CACHE, 'gap_routes_sydney.json'), JSON.stringify({ elements: routes }))
await writeFile(join(overpass.CACHE, 'gap_geom_sydney.json'), JSON.stringify({ elements: geoms }))
await writeFile(join(overpass.CACHE, 'gap_stations_sydney.json'), JSON.stringify({ elements: stations }))
console.log(`total: ${routes.length} relations, ${stations.length} clean stations -> gap_*_sydney.json`)
