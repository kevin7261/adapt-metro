// 定向補抓的 route_master 補齊（gap_masters_*.json）。
//
// 為什麼需要：buildGeojson 的路線分組優先用 route_master（`m|<id>`），沒有 master 才
// 退回 network+ref、再退回單一 relation。fetchMetro.mjs 只抓 subway|light_rail 的
// master，故 route=train／tram 的定向補抓（fetchOceania／fetchAfrica／fetchSydneyTrains…）
// 拿不到 master：南非 Metrorail 的 route relation **完全沒有 ref**，沒有 master 就會
// 一個方向自成一條線（約堡 56 條、開普敦 30 條）；墨爾本 Metro Tunnel 貫通運營的
// relation 用「EPH => SUY」這種箭頭 ref，也只有 master 能把它收回 Pakenham 線。
//
// 用法：
//   node scripts/fetchGapMasters.mjs                 # 全部 gap_routes_*.json
//   node scripts/fetchGapMasters.mjs melbourne perth # 指定 key
// 亦可由其他 fetch 腳本 import { fetchMastersFor } 直接呼叫。
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'

// 抓「以這些 route relation 為成員」的 route_master（Overpass 的 br＝backwards relation）。
export async function fetchMastersFor(routeIds, key) {
  if (!routeIds.length) return []
  const masters = []
  const seen = new Set()
  // relation(id:...) 一次上限保守切塊，避免 URL/查詢過長
  for (let i = 0; i < routeIds.length; i += 200) {
    const chunk = routeIds.slice(i, i + 200)
    const q = `[out:json][timeout:180];relation(id:${chunk.join(',')})->.r;rel(br.r);out body;`
    const d = await overpass.query(q, { timeout: 180000, maxAttempts: 6 })
    for (const e of d.elements ?? []) {
      if (e.type !== 'relation' || e.tags?.type !== 'route_master' || seen.has(e.id)) continue
      seen.add(e.id)
      masters.push({ type: 'relation', id: e.id, tags: e.tags,
        members: (e.members ?? []).filter((m) => m.type === 'relation') })
    }
  }
  await writeFile(join(overpass.CACHE, `gap_masters_${key}.json`),
    JSON.stringify({ elements: masters }))
  return masters
}

// 直接執行（非 import）時：對現有的 gap_routes_*.json 逐檔補 master
if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv.slice(2)
  const files = (await readdir(overpass.CACHE)).filter((n) => /^gap_routes_.+\.json$/.test(n))
  for (const f of files) {
    const key = f.replace(/^gap_routes_|\.json$/g, '')
    if (only.length && !only.includes(key)) continue
    const d = JSON.parse(await readFile(join(overpass.CACHE, f), 'utf8'))
    const ids = (d.elements ?? []).filter((e) => e.type === 'relation').map((e) => e.id)
    const masters = await fetchMastersFor(ids, key)
    const names = masters.map((m) => m.tags.ref || m.tags.name || m.id).slice(0, 30)
    console.log(`${key}: ${ids.length} routes -> ${masters.length} masters` +
      (masters.length ? `\n  ${names.join(', ')}` : ''))
  }
}
