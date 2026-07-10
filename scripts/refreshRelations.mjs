// 定向刷新 route relations（成員/標籤已在上游更新、但幾何快取只認 id 集合不會
// 重抓的情況——如新加坡環狀線 2026 閉合後 relation 新增 Keppel/Cantonment/
// Prince Edward Road 停靠成員）。用法：
//   node scripts/refreshRelations.mjs <slug> <rid> [rid...]
// 寫 gap_routes_refresh_{slug} / gap_geom_refresh_{slug} / gap_stations_refresh_{slug}；
// buildGeojson 載入 gap_* 於主快取之後且「後載者勝」，故刷新資料覆蓋舊快取。
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'

const [slug, ...ridArgs] = process.argv.slice(2)
const rids = ridArgs.map(Number).filter(Boolean)
if (!slug || !rids.length) {
  console.error('usage: node scripts/refreshRelations.mjs <slug> <rid> [rid...]')
  process.exit(1)
}

const ids = rids.join(',')
// relation 本體（tags＋成員）＋所有 node 成員（座標＋tags，具名者作站源）
const q = `[out:json][timeout:120];relation(id:${ids});out body;relation(id:${ids});node(r);out body;`
const d = await overpass.query(q, { timeout: 120000, maxAttempts: 6 })

const routes = [], geoms = [], stations = []
for (const e of d.elements ?? []) {
  if (e.type === 'relation') {
    routes.push({ type: 'relation', id: e.id, tags: e.tags ?? {} })
    geoms.push({ type: 'relation', id: e.id, tags: e.tags ?? {},
      members: (e.members ?? []).filter((m) => m.type === 'node') })
    console.log(`r${e.id} ${(e.tags?.name ?? '').slice(0, 50)}: ` +
      `${(e.members ?? []).filter((m) => m.type === 'node').length} node members`)
  } else if (e.type === 'node') {
    geoms.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon })
    if (e.tags?.name) stations.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: e.tags })
  }
}
await writeFile(join(overpass.CACHE, `gap_routes_refresh_${slug}.json`), JSON.stringify({ elements: routes }))
await writeFile(join(overpass.CACHE, `gap_geom_refresh_${slug}.json`), JSON.stringify({ elements: geoms }))
await writeFile(join(overpass.CACHE, `gap_stations_refresh_${slug}.json`), JSON.stringify({ elements: stations }))
console.log(`refreshed ${routes.length} relations, ${stations.length} named nodes -> gap_*_refresh_${slug}.json`)
