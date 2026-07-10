// 一次性：補抓三鶯線 route tags（鏡像同步落差漏掉）→ gap_routes 快取
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'

const q = '[out:json][timeout:60];relation(id:5341250,21066080);out tags;'
const d = await overpass.query(q, { timeout: 60000, maxAttempts: 6 })
const ok = d.elements.filter((e) => e.type === 'relation')
console.log('fetched:', ok.map((e) => `${e.id} ${e.tags?.name} state=${e.tags?.state ?? '-'}`))
await writeFile(join(overpass.CACHE, 'gap_routes_taiwan-sanying.json'),
  JSON.stringify({ elements: ok }))
console.log('written gap_routes_taiwan-sanying.json')
