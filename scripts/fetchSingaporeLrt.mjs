// 新加坡 LRT 補抓（使用者：新加坡加上抓 LRT）。
// 新加坡三條 LRT：Sengkang（SKLRT）標 route=light_rail（基準查詢已抓到）；但
// **Bukit Panjang（BPLRT）與 Punggol（PGLRT）標 route=monorail**，不在基準查詢範圍，
// 故以新加坡 bbox 補抓，寫 gap_* 快取（後載者勝，見 buildGeojson）。辨識：route=monorail
// ＋名稱含 LRT（network=Singapore Rail）；**排除 Changi 機場 Skytrain**（也是 monorail，
// 但是航廈接駁人流電車，isAirportApm 會擋、此處名稱過濾亦排除）。
// route=monorail 不被 lrtOnly 標記（非 light_rail）→ build 端不被 LRT 範圍規則剔除、自動保留；
// Sengkang（light_rail）由 LRT_ADDON_CITIES 含 singapore 保留。
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'

const BBOX = '(1.20,103.60,1.50,104.10)'
const routes = [], geoms = [], stations = []
const seenRel = new Set(), seenNode = new Set()

const q = `[out:json][timeout:180];relation["type"="route"]["route"="monorail"]${BBOX}->.r;.r out body;node(r.r);out body;`
const d = await overpass.query(q, { timeout: 180000, maxAttempts: 6 })
let nr = 0, nn = 0
for (const e of d.elements ?? []) {
  if (e.type === 'relation') {
    if (seenRel.has(e.id)) continue
    seenRel.add(e.id)
    const t = e.tags ?? {}
    // 只收 LRT 本體：名稱/ref 含 LRT（BPLRT/PGLRT），排除 Skytrain（機場接駁）
    const s = `${t.name ?? ''} ${t['name:en'] ?? ''} ${t.ref ?? ''}`
    if (!/lrt/i.test(s) || /skytrain/i.test(s)) continue
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
console.log(`Singapore LRT (monorail): +${nr} relations, +${nn} named nodes`)

await writeFile(join(overpass.CACHE, 'gap_routes_singapore_lrt.json'), JSON.stringify({ elements: routes }))
await writeFile(join(overpass.CACHE, 'gap_geom_singapore_lrt.json'), JSON.stringify({ elements: geoms }))
await writeFile(join(overpass.CACHE, 'gap_stations_singapore_lrt.json'), JSON.stringify({ elements: stations }))
console.log(`total: ${routes.length} relations, ${stations.length} named nodes -> gap_*_singapore_lrt.json`)
