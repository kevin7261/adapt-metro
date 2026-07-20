// 広島電鉄（廣電）路面電車抓取——**全球唯一收 route=tram 的城市**。
// 使用者裁決 2026-07-21：廣島要收路面電車，且只有廣島特例
// （見 .claude/skills/metro-city-hiroshima/SKILL.md）。
//
// route=tram 不在 fetchMetro.mjs 的全球基準查詢範圍內（MODES 只收 subway|light_rail，
// 那是上位不變式、不得放寬），故比照德國 S-Bahn（fetchSbahnDe.mjs）以「城市 bbox
// ＋營運者比對」定向補抓，寫 gap_* 快取（後載者勝，見 buildGeojson）。
// 城市綁定：NETWORK_CITY 以 operator/network 含 広島電鉄|Hiroden pin 到 Hiroshima，
// 不靠 geocode 重心（廣電重心偏西南，會把 Astram Line 拖離廣島）。
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'

// 廣島市電＋宮島線：東到広島駅(132.48)、西到広電宮島口(132.30)、北到白島(34.41)、
// 南到広島港(34.35)。relation 任一成員入框即命中，邊界留餘裕。
const BBOX = '(34.25,132.25,34.47,132.53)'
// 與基準查詢同一組 lifecycle 護欄：未通車/廢線不得進資料
const LIFE = '["state"!~"^(proposed|construction)$"][!"construction"][!"proposed"][!"disused"][!"abandoned"]'
// 只收廣電本體。広島高速交通（Astram Line）是 route=light_rail，走基準查詢，不在此。
const HIRODEN = /広島電鉄|廣島電鉄|hiroden|hiroshima electric railway/i

const q = `[out:json][timeout:180];relation["type"="route"]["route"="tram"]${LIFE}${BBOX}->.r;` +
  '.r out body;node(r.r);out body;'

const d = await overpass.query(q, { timeout: 180000, maxAttempts: 6 })

const routes = [], geoms = [], stations = []
const keptRel = new Set()
let skipped = 0
for (const e of d.elements ?? []) {
  if (e.type !== 'relation') continue
  const t = e.tags ?? {}
  if (!HIRODEN.test(`${t.operator ?? ''} ${t.network ?? ''} ${t.name ?? ''}`)) { skipped++; continue }
  keptRel.add(e.id)
  routes.push({ type: 'relation', id: e.id, tags: t })
  geoms.push({ type: 'relation', id: e.id, tags: t,
    members: (e.members ?? []).filter((m) => m.type === 'node') })
}
// 只收被留下的 relation 用到的節點——bbox 內還有其他業者的 tram 節點
const needed = new Set()
for (const g of geoms) for (const m of g.members ?? []) needed.add(m.ref)
const seenNode = new Set()
for (const e of d.elements ?? []) {
  if (e.type !== 'node' || !needed.has(e.id) || seenNode.has(e.id)) continue
  seenNode.add(e.id)
  geoms.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon })
  // 路面停留場多標 railway=tram_stop（非 station=subway|light_rail），基準站源查詢
  // 撈不到——這裡直接由 relation 成員取有名節點當站源。
  if (e.tags?.name) stations.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: e.tags })
}

await writeFile(join(overpass.CACHE, 'gap_routes_hiroden.json'), JSON.stringify({ elements: routes }))
await writeFile(join(overpass.CACHE, 'gap_geom_hiroden.json'), JSON.stringify({ elements: geoms }))
await writeFile(join(overpass.CACHE, 'gap_stations_hiroden.json'), JSON.stringify({ elements: stations }))
console.log(`広島電鉄: ${routes.length} tram relations, ${stations.length} named nodes ` +
  `(${skipped} non-Hiroden tram relations in bbox skipped) -> gap_*_hiroden.json`)
