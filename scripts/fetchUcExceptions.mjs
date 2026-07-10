// 未通車例外抓取（使用者裁決：只畫有通車的，但台北例外納入 桃捷綠線/萬大線/汐東線）。
// 讀 data/metro/_overrides/uc_exceptions.json 的 enabled 項目，抓 relation 全文
// （tags + 成員 + stop 節點座標與 tags），「抓取時就正規化」lifecycle 標籤：
//   - relation: 套 tag_overrides（route=subway、補 network 供 NETWORK_CITY 綁城市），
//     移除 construction/proposed/state 等 NONOP 鍵
//   - stop 節點: railway=construction+construction=station → railway=station
// 之後 buildGeojson 以一般 gap_* 供給路徑載入，僅需標 status=under_construction。
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as overpass from './overpass.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OVR = join(ROOT, 'data', 'metro', '_overrides', 'uc_exceptions.json')

const NONOP_KEYS = ['construction', 'proposed', 'planned', 'disused', 'abandoned',
  'construction:route', 'proposed:route', 'planned:route', 'state']

async function main() {
  const conf = JSON.parse(await readFile(OVR, 'utf8'))
  const active = (conf.exceptions ?? []).filter((x) => x.enabled)
  if (!active.length) {
    console.log('no enabled UC exceptions; writing empty gap files')
    await writeFile(join(overpass.CACHE, 'gap_routes_uc.json'), JSON.stringify({ elements: [] }))
    await writeFile(join(overpass.CACHE, 'gap_geom_uc.json'), JSON.stringify({ elements: [] }))
    await writeFile(join(overpass.CACHE, 'gap_stations_uc.json'), JSON.stringify({ elements: [] }))
    return
  }
  const ids = active.map((x) => x.relation).join(',')
  const q = `[out:json][timeout:120];relation(id:${ids});out body;relation(id:${ids});node(r);out body;`
  const d = await overpass.query(q, { timeout: 120000, maxAttempts: 6 })

  const byId = new Map(active.map((x) => [x.relation, x]))
  const routes = [], geoms = [], stations = []
  for (const e of d.elements ?? []) {
    if (e.type === 'relation' && byId.has(e.id)) {
      const ex = byId.get(e.id)
      const tags = { ...(e.tags ?? {}), ...(ex.tag_overrides ?? {}) }
      for (const k of NONOP_KEYS) delete tags[k]
      // stop 成員 only（線＝車站序連線；way 成員與畫線無關）
      const members = (e.members ?? []).filter((m) => m.type === 'node')
      routes.push({ type: 'relation', id: e.id, tags })
      geoms.push({ type: 'relation', id: e.id, tags, members })
      console.log(`r${e.id} ${ex.label}: ${members.length} stop nodes`)
    } else if (e.type === 'node') {
      const t = { ...(e.tags ?? {}) }
      if (!t.name) { console.log(`  !! node ${e.id} has no name — skipped`); continue }
      if (t.railway === 'construction' || t.railway === 'proposed') t.railway = 'station'
      for (const k of NONOP_KEYS) delete t[k]
      t.station ??= 'subway'
      stations.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: t })
      // buildGeojson 讀 gap_geom 的 node 元素進 memberXY（成員座標）
      geoms.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon })
    }
  }
  await writeFile(join(overpass.CACHE, 'gap_routes_uc.json'), JSON.stringify({ elements: routes }))
  await writeFile(join(overpass.CACHE, 'gap_geom_uc.json'), JSON.stringify({ elements: geoms }))
  await writeFile(join(overpass.CACHE, 'gap_stations_uc.json'), JSON.stringify({ elements: stations }))
  console.log(`UC gap files written: ${routes.length} routes, ${stations.length} named stations`)
}

main().catch((e) => { console.error(e); process.exit(1) })
