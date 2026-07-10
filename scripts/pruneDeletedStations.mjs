// 站源殭屍清理：stations.json 快取裡「上游已刪除」的節點（如香港 n184284403、
// n712449914 舊 stop_position）會被頂點吸附撿走、變成多出來的站。
// 用法：node scripts/pruneDeletedStations.mjs <city-geojson> [...]（驗證該城所有站點）
//       node scripts/pruneDeletedStations.mjs --ids <nid> [...]（驗證指定節點）
// 上游查無的 id 寫入 _cache/deleted_nodes.json（墓碑）；buildGeojson 的站源拒收墓碑。
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'

const TOMB = join(overpass.CACHE, 'deleted_nodes.json')
const args = process.argv.slice(2)

let ids = []
if (args[0] === '--ids') {
  ids = args.slice(1).map((s) => Number(s.replace(/^n/, ''))).filter(Boolean)
} else {
  for (const f of args) {
    const g = JSON.parse(await readFile(f, 'utf8'))
    for (const feat of g.features)
      if (feat.geometry.type === 'Point' && /^n\d+$/.test(feat.properties.station_id))
        ids.push(Number(feat.properties.station_id.slice(1)))
  }
}
if (!ids.length) { console.error('no node ids to verify'); process.exit(1) }

let tomb = []
try { tomb = JSON.parse(await readFile(TOMB, 'utf8')).deleted ?? [] } catch { /* none yet */ }
const known = new Set(tomb)

const missing = []
for (let i = 0; i < ids.length; i += 500) {
  const batch = ids.slice(i, i + 500)
  const d = await overpass.query(
    `[out:json][timeout:120];node(id:${batch.join(',')});out body;`,
    { timeout: 120000, maxAttempts: 5 })
  // 活著＝上游還在**且還有名字**——節點存在但被拆掉標籤/名稱（香港
  // Kowloon Bay Station 案例）等同不再是車站（站名 100% 語義一致）
  const alive = new Set((d.elements ?? []).filter((e) => e.tags?.name).map((e) => e.id))
  for (const id of batch) if (!alive.has(id)) missing.push(id)
  console.log(`  ${Math.min(i + 500, ids.length)}/${ids.length} checked, ${missing.length} dead so far`)
}
for (const id of missing) known.add(id)
await writeFile(TOMB, JSON.stringify({
  _comment: '上游已刪除的節點（scripts/pruneDeletedStations.mjs 驗證）；buildGeojson 站源拒收',
  deleted: [...known].sort((a, b) => a - b),
}))
console.log(`${missing.length} deleted upstream${missing.length ? ': n' + missing.join(', n') : ''}`)
console.log(`tombstones total: ${known.size} -> ${TOMB}`)
