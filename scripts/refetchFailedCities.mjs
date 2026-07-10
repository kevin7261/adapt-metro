// 未通過城市自動重抓（使用者規則：資料驗證未通過的城市應該要重抓、重 audit）。
// 對 audit_state 每個 failed 城市做兩件 token-free 的事：
//   1. 定向刷新：重抓該城所有 route relation（tags＋成員＋具名節點）→ gap_*_refresh_
//      快取（後載者勝）——治「上游更新了、content-addressed 快取不會變新」的舊成員問題
//   2. 墓碑驗證：該城所有站點 id 上游批次查存在，已刪節點進 deleted_nodes.json——
//      治「站源殭屍被頂點吸附撿走」的多站問題（香港 KTL 案例）
// 之後重跑 build → wikilines → audit（呼叫端負責）。每城刷新記錄在
// _cache/refetch_state.json，重複執行只處理「上次刷新後仍 failed」的城市。
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as overpass from './overpass.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = join(ROOT, 'data', 'metro')
const TOMB = join(overpass.CACHE, 'deleted_nodes.json')
const STATE = join(overpass.CACHE, 'refetch_state.json')

const auditState = JSON.parse(await readFile(join(overpass.CACHE, 'audit_state.json'), 'utf8'))
const index = JSON.parse(await readFile(join(BASE, 'index.json'), 'utf8'))
const systems = index.systems ?? index
let refetchState = {}
try { refetchState = JSON.parse(await readFile(STATE, 'utf8')) } catch { /* first run */ }
let tomb = []
try { tomb = JSON.parse(await readFile(TOMB, 'utf8')).deleted ?? [] } catch { /* none */ }
const tombSet = new Set(tomb)

const norm = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
const failed = Object.entries(auditState).filter(([, v]) => !v.passed)
console.log(`${failed.length} failed cities in audit state`)

let done = 0
for (const [key] of failed) {
  const [city] = key.split('|')
  if (refetchState[key]) { console.log(`- ${city}: already refetched, skip`); continue }
  const sys = systems.find((s) => norm(s.city) === norm(city))
  if (!sys) { console.log(`- ${city}: no system file, skip`); continue }
  const g = JSON.parse(await readFile(join(BASE, sys.file), 'utf8'))

  // 收集該城全部 route relation id 與站點 node id
  const rids = new Set(), nids = []
  for (const f of g.features) {
    if (f.geometry.type === 'Point') {
      if (/^n\d+$/.test(f.properties.station_id)) nids.push(Number(f.properties.station_id.slice(1)))
    } else {
      for (const r of f.properties.routes ?? []) for (const id of r.osm_route_ids ?? []) rids.add(id)
    }
  }
  console.log(`- ${city}: ${rids.size} relations, ${nids.length} station nodes`)

  try {
    // 1. relation 刷新（分批 60 個以控查詢大小）
    const ridArr = [...rids]
    const routes = [], geoms = [], stns = []
    for (let i = 0; i < ridArr.length; i += 60) {
      const ids = ridArr.slice(i, i + 60).join(',')
      const q = `[out:json][timeout:180];relation(id:${ids});out body;relation(id:${ids});node(r);out body;`
      const d = await overpass.query(q, { timeout: 180000, maxAttempts: 5 })
      for (const e of d.elements ?? []) {
        if (e.type === 'relation') {
          routes.push({ type: 'relation', id: e.id, tags: e.tags ?? {} })
          geoms.push({ type: 'relation', id: e.id, tags: e.tags ?? {},
            members: (e.members ?? []).filter((m) => m.type === 'node') })
        } else if (e.type === 'node') {
          geoms.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon })
          if (e.tags?.name) stns.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: e.tags })
        }
      }
    }
    const slug = norm(city)
    await writeFile(join(overpass.CACHE, `gap_routes_refresh_${slug}.json`), JSON.stringify({ elements: routes }))
    await writeFile(join(overpass.CACHE, `gap_geom_refresh_${slug}.json`), JSON.stringify({ elements: geoms }))
    await writeFile(join(overpass.CACHE, `gap_stations_refresh_${slug}.json`), JSON.stringify({ elements: stns }))

    // 2. 墓碑驗證（該城站點上游是否還存在）
    let newTombs = 0
    for (let i = 0; i < nids.length; i += 500) {
      const batch = nids.slice(i, i + 500)
      const d = await overpass.query(
        `[out:json][timeout:120];node(id:${batch.join(',')});out ids;`,
        { timeout: 120000, maxAttempts: 5 })
      const alive = new Set((d.elements ?? []).map((e) => e.id))
      for (const id of batch) if (!alive.has(id) && !tombSet.has(id)) { tombSet.add(id); newTombs++ }
    }
    await writeFile(TOMB, JSON.stringify({
      _comment: '上游已刪除的節點；buildGeojson 站源拒收',
      deleted: [...tombSet].sort((a, b) => a - b),
    }))
    refetchState[key] = { refetched: true, relations: rids.size, tombstones: newTombs }
    await writeFile(STATE, JSON.stringify(refetchState, null, 2))
    done++
    console.log(`  ok: ${routes.length} relations refreshed, ${newTombs} tombstones`)
  } catch (e) {
    console.log(`  !! ${city} failed: ${e.message}`)
  }
}
console.log(`refetched ${done} cities. Next: metro:build && metro:wikilines && metro:audit`)
