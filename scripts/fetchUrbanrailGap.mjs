// 依 urbanrail.net 缺城清單批次補抓（route=subway|light_rail|tram）。
// 不做 route=train（國鐵會灌爆 bbox）；市郊鐵路已由 fetchOceania／fetchAfrica／
// fetchSydney／fetchSbahnDe 等專用腳本處理。
//
// 用法：
//   node scripts/fetchUrbanrailGap.mjs                 # 跑全部 tasks
//   node scripts/fetchUrbanrailGap.mjs aarhus angers    # 只跑指定 key
//   node scripts/fetchUrbanrailGap.mjs --limit=20       # 最多 N 城
//
// 任務表：data/metro/_urbanrail_gap_tasks.json
//   [{ key, city, country, continent, bbox, modes?, url }]
// bbox 格式同 fetchAfrica：'(south,west,north,east)'
//
// 寫入 gap_* 快取＋自動 _overrides/<country>-<city>.json（豁免純 LRT 剔除）。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as overpass from './overpass.mjs'
import { fetchMastersFor, assignRefsFromMasters } from './fetchGapMasters.mjs'
import { synthStopsFromWays } from './gapStopsFromWays.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const __dirname = dirname(fileURLToPath(import.meta.url))
const TASKS_PATH = join(__dirname, '..', 'data', 'metro', '_urbanrail_gap_tasks.json')
const OVERRIDES = join(overpass.CACHE, '..', '_overrides')
const LIFE = '["state"!~"^(proposed|construction)$"][!"construction"][!"proposed"][!"disused"][!"abandoned"]'
const DEFAULT_MODES = ['subway', 'light_rail', 'tram']

const args = process.argv.slice(2)
const only = args.filter((a) => !a.startsWith('--'))
const limitArg = args.find((a) => a.startsWith('--limit='))
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity
const skipExisting = args.includes('--skip-existing')

const allTasks = JSON.parse(await readFile(TASKS_PATH, 'utf8'))
let tasks = allTasks.filter((t) => !only.length || only.includes(t.key))
if (Number.isFinite(limit)) tasks = tasks.slice(0, limit)

await mkdir(OVERRIDES, { recursive: true })

async function alreadyFetched(key) {
  try {
    const p = join(overpass.CACHE, `gap_routes_${key}.json`)
    const d = JSON.parse(await readFile(p, 'utf8'))
    return (d.elements?.length ?? 0) > 0
  } catch { return false }
}

for (const task of tasks) {
  const {
    key, city, country, continent, bbox, url,
    modes = DEFAULT_MODES,
  } = task
  if (!bbox) {
    console.log(`${key}: SKIP no bbox`)
    continue
  }
  if (skipExisting && await alreadyFetched(key)) {
    console.log(`${key}: SKIP already has gap_routes`)
    continue
  }

  const routes = []
  const geoms = []
  const stations = []
  const geomByRel = new Map()
  const needed = new Set()
  const seenNode = new Set()
  let skipped = 0

  // 單一查詢收齊 subway|light_rail|tram + 成員節點 + tram_stop／station 站源
  const modeRe = modes.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const q =
    `[out:json][timeout:180];` +
    `(` +
    `relation["type"="route"]["route"~"^(${modeRe})$"]${LIFE}${bbox};` +
    `)->.r;` +
    `.r out body;` +
    `node(r.r); out body;` +
    `node["railway"="tram_stop"]["name"]${LIFE}${bbox}; out body;` +
    `node["station"~"^(subway|light_rail)$"]["name"]${LIFE}${bbox}; out body;`
  let d
  try {
    d = await overpass.query(q, { timeout: 180000, maxAttempts: 8 })
  } catch (e) {
    console.log(`${key}: query failed: ${e.message}`)
    await sleep(3000)
    continue
  }
  for (const e of d.elements ?? []) {
    if (e.type !== 'relation') continue
    const t = e.tags ?? {}
    const blob = `${t.network ?? ''} ${t.operator ?? ''} ${t.name ?? ''} ${t.route ?? ''}`
    if (/funicular|aerialway|monorail|bus|ferry/i.test(t.route ?? '')) { skipped++; continue }
    if (/tourist|heritage tram|museum/i.test(blob) && !/urban|city|metro|municipal/i.test(blob)) {
      skipped++; continue
    }
    routes.push({ type: 'relation', id: e.id, tags: t })
    const members = (e.members ?? []).filter((m) => m.type === 'node')
    const gr = { type: 'relation', id: e.id, tags: t, members }
    geoms.push(gr)
    geomByRel.set(e.id, gr)
    for (const m of members) needed.add(m.ref)
  }
  for (const e of d.elements ?? []) {
    if (e.type !== 'node' || seenNode.has(e.id)) continue
    const isMember = needed.has(e.id)
    const isStop = !!(e.tags?.name && (
      e.tags.railway === 'tram_stop' ||
      /^(subway|light_rail)$/.test(e.tags.station ?? '') ||
      isMember
    ))
    if (!isMember && !isStop) continue
    seenNode.add(e.id)
    geoms.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon })
    if (e.tags?.name)
      stations.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: e.tags })
  }

  const noStops = routes.map((r) => r.id).filter((id) => !geomByRel.get(id)?.members?.length)
  let synthN = 0
  if (noStops.length) {
    try {
      const synth = await synthStopsFromWays(noStops, stations)
      for (const [rid, members] of synth) {
        geomByRel.get(rid).members = members
        synthN++
      }
    } catch (e) {
      console.log(`${key}: synthStops failed: ${e.message}`)
    }
  }

  let masters = []
  let refAdded = 0
  if (routes.length) {
    try {
      masters = await fetchMastersFor(routes.map((r) => r.id), key)
      refAdded = assignRefsFromMasters(routes, masters)
    } catch (e) {
      console.log(`${key}: masters failed: ${e.message}`)
    }
  }

  await writeFile(join(overpass.CACHE, `gap_routes_${key}.json`), JSON.stringify({ elements: routes }))
  await writeFile(join(overpass.CACHE, `gap_geom_${key}.json`), JSON.stringify({ elements: geoms }))
  await writeFile(join(overpass.CACHE, `gap_stations_${key}.json`), JSON.stringify({ elements: stations }))

  if (routes.length) {
    const slug = `${country}-${city}`.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    await writeFile(join(OVERRIDES, `${slug}.json`), `${JSON.stringify({
      city,
      country,
      continent,
      osm_route_ids: routes.map((r) => r.id).sort((a, b) => a - b),
      source: url || 'https://www.urbanrail.net/',
      note: `${city}（urbanrail gap；modes=${modes.join('|')}）——由 scripts/fetchUrbanrailGap.mjs 自動產生。` +
        'bbox 內 subway|light_rail|tram；override 豁免 buildGeojson「純 LRT 剔除」。重跑會覆寫本檔。',
    }, null, 2)}\n`)
  }

  console.log(`${key}: ${routes.length} relations (${skipped} skipped), ` +
    `${stations.length} stops, ${masters.length} masters` +
    (refAdded ? `, ${refAdded} refs` : '') +
    (synthN ? `, ${synthN}/${noStops.length} synth` : '') +
    (routes.length ? '' : ' — EMPTY'))
  // 降低 Overpass 429／504：城與城之間稍歇
  await sleep(1500)
}
