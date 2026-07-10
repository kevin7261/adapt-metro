// Fetch all metro (subway + light rail) route + station data worldwide from
// OpenStreetMap. Writes raw Overpass responses to data/metro/_cache/. Resumable.
//
// Scope (authoritative rule, see .claude/skills/metro-osm-fetch/SKILL.md):
//   include route=subway and route=light_rail (LRT)
//   exclude route=train / plain railway / route=tram
//
// Failure handling: a step that had to fall back to partial data writes a
// `<name>.partial` marker next to its cache file; the next run sees the marker,
// discards the partial cache and refetches — failures are never cached as done.
//
// Then run: node scripts/buildGeojson.mjs
import { readFile, writeFile, stat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'

const BATCH = 120
// Bump when the Overpass predicates change — stale tag/station caches from an
// older query shape are discarded automatically (geometry stays incremental).
const QUERY_VERSION = 4

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (m) => console.log(`\n=== ${m} ===`)

const cachePath = (name) => join(overpass.CACHE, name)

async function cached(name) {
  try {
    if ((await stat(cachePath(name + '.partial'))).isFile()) return false
  } catch { /* no marker */ }
  try { return (await stat(cachePath(name))).size > 0 } catch { return false }
}

async function markPartial(name, info) {
  await writeFile(cachePath(name + '.partial'), JSON.stringify(info ?? {}))
}
async function clearPartial(name) {
  await rm(cachePath(name + '.partial'), { force: true })
}

async function checkQueryVersion() {
  const metaPath = cachePath('fetch_meta.json')
  let meta = null
  try { meta = JSON.parse(await readFile(metaPath, 'utf8')) } catch { /* first run */ }
  if (meta?.query_version !== QUERY_VERSION) {
    step(`query version ${meta?.query_version ?? 'none'} -> ${QUERY_VERSION}: ` +
      'discarding tag/station caches (geometry cache stays, it is per-relation)')
    for (const f of ['routes_tags.json', 'route_masters.json', 'stations.json',
      'stop_areas.json']) {
      await rm(cachePath(f), { force: true })
      await rm(cachePath(f + '.partial'), { force: true })
    }
    await writeFile(metaPath, JSON.stringify({
      query_version: QUERY_VERSION, updated: new Date().toISOString() }))
  }
}

// Operational-only guard: a lifecycle tag (state=construction, construction=*,
// proposed=*, ...) means not in service yet. Lifecycle-prefixed tagging
// (construction:route=subway) never matches the base queries.
const LIFE = '["state"!~"^(proposed|construction)$"][!"construction"][!"proposed"][!"disused"][!"abandoned"]'
// Include subway + LRT; exclude train / plain railway / tram (authoritative scope).
const MODES = '["route"~"^(subway|light_rail)$"]'
const MASTER_MODES = '["route_master"~"^(subway|light_rail)$"]'

async function fetchRouteTags() {
  step('1/5  route=subway|light_rail relation tags (operational only)')
  const q = `[out:json][timeout:300];relation${MODES}${LIFE};out tags;`
  const data = await overpass.query(q, { cacheName: 'routes_tags.json', timeout: 300000 })
  const ids = data.elements.filter((e) => e.type === 'relation').map((e) => e.id)
  console.log(`  ${ids.length} subway/light_rail route relations`)
  return ids
}

async function fetchRouteMasters() {
  step('2/5  route_master=subway|light_rail relations (line grouping)')
  if (await cached('route_masters.json')) { console.log('  cached'); return }
  const q = `[out:json][timeout:180];relation${MASTER_MODES};out body;`
  try {
    const data = await overpass.query(q,
      { cacheName: 'route_masters.json', timeout: 150000, maxAttempts: 6 })
    const n = data.elements.filter((e) => e.type === 'relation').length
    console.log(`  ${n} route_master relations`)
    await clearPartial('route_masters.json')
  } catch (e) {
    // Fall back to network+ref grouping this run, but leave a .partial marker
    // so the next run retries instead of trusting the empty file forever.
    console.log(`  !! route_master fetch failed (${e.message}); ` +
      'continuing with network+ref grouping (marked .partial — next run retries)')
    await writeFile(cachePath('route_masters.json'), JSON.stringify({ elements: [] }))
    await markPartial('route_masters.json', { reason: e.message })
  }
}

// stop_area relations group the nodes of one physical station (platforms,
// stop_positions, station nodes of several lines) — the authoritative signal
// for the interchange (共站) merge in buildGeojson. Non-fatal on failure:
// the merge falls back to the same-name heuristic.
async function fetchStopAreas() {
  step('5/5  public_transport=stop_area relations (interchange grouping)')
  if (await cached('stop_areas.json')) {
    const d = JSON.parse(await readFile(cachePath('stop_areas.json'), 'utf8'))
    console.log(`  cached: ${d.elements.length} stop_area relations`)
    return
  }
  const q = '[out:json][timeout:300];(' +
    `node["station"~"^(subway|light_rail)$"]${LIFE};` +
    `node["railway"="station"]["subway"="yes"]${LIFE};` +
    `node["railway"="station"]["light_rail"="yes"]${LIFE};` +
    ')->.s;relation["public_transport"="stop_area"](bn.s);out body;'
  try {
    const data = await overpass.query(q,
      { cacheName: 'stop_areas.json', timeout: 300000, maxAttempts: 6 })
    console.log(`  ${data.elements.length} stop_area relations`)
    await clearPartial('stop_areas.json')
  } catch (e) {
    console.log(`  !! stop_area fetch failed (${e.message}); ` +
      'interchange merge falls back to same-name (marked .partial — next run retries)')
    await writeFile(cachePath('stop_areas.json'), JSON.stringify({ elements: [] }))
    await markPartial('stop_areas.json', { reason: e.message })
  }
}

async function fetchStations() {
  step('3/5  subway/light_rail stations (nodes + station areas)')
  if (await cached('stations.json')) {
    const d = JSON.parse(await readFile(cachePath('stations.json'), 'utf8'))
    console.log(`  cached: ${d.elements.length} station elements`)
    return
  }
  // station=subway|light_rail, plus railway=station explicitly flagged
  // subway=yes / light_rail=yes, plus NAMED stop_positions of those modes
  // (newly opened lines often have named stops mapped before station nodes —
  // 三鶯線 opened 2026-06 with 12 named stops but only 10 station nodes).
  // Deliberately NOT plain railway=station (that would pull in mainline rail).
  const ST = '["railway"!~"^(proposed|construction|disused|abandoned|razed)$"]'
  const nodeQ = '[out:json][timeout:240];(' +
    `node["station"~"^(subway|light_rail)$"]${ST}${LIFE};` +
    `node["railway"="station"]["subway"="yes"]${LIFE};` +
    `node["railway"="station"]["light_rail"="yes"]${LIFE};` +
    `node["railway"="stop"]["subway"="yes"]["name"]${LIFE};` +
    `node["railway"="stop"]["light_rail"="yes"]["name"]${LIFE};` +
    ');out;'
  const wayQ = '[out:json][timeout:240];(' +
    `way["station"~"^(subway|light_rail)$"]${ST}${LIFE};` +
    `way["railway"="station"]["subway"="yes"]${LIFE};` +
    `way["railway"="station"]["light_rail"="yes"]${LIFE};` +
    ');out center tags;'
  const nodes = await overpass.query(nodeQ, { timeout: 240000 })
  let waysFailed = null
  const ways = await overpass.query(wayQ, { timeout: 240000, maxAttempts: 6 })
    .catch((e) => { waysFailed = e.message; return { elements: [] } })
  const elements = [...nodes.elements, ...ways.elements]
  await writeFile(cachePath('stations.json'), JSON.stringify({ elements }))
  if (waysFailed) {
    console.log(`  !! station areas fetch failed (${waysFailed}) — nodes only, ` +
      'marked .partial so the next run refetches')
    await markPartial('stations.json', { reason: waysFailed })
  } else {
    await clearPartial('stations.json')
  }
  console.log(`  ${nodes.elements.length} station nodes + ${ways.elements.length} station areas`)
}

async function fetchGeomBatchData(ids, failedIds) {
  // No track (way) geometry: lines are later drawn by connecting the route's
  // stops in member order, so we only need the ordered member lists (out body)
  // plus coordinates of the member nodes (stops/platforms).
  const q = `[out:json][timeout:300];relation(id:${ids.join(',')})->.r;` +
    '.r out body;node(r.r);out skel qt;'
  try {
    return (await overpass.query(q, { timeout: 300000, maxAttempts: 5 })).elements
  } catch (e) {
    if (ids.length <= 1) {
      console.log(`  !! giving up on ${ids}`)
      failedIds.push(...ids)
      return []
    }
    const mid = ids.length >> 1
    console.log(`  .. splitting batch of ${ids.length} after failure`)
    return [...await fetchGeomBatchData(ids.slice(0, mid), failedIds),
            ...await fetchGeomBatchData(ids.slice(mid), failedIds)]
  }
}

// Incremental geometry: fetch only relations not present in any geom_*.json.
// Batch files are content-addressed by their id list, so scope changes (e.g.
// adding light_rail) only fetch the delta — old batches stay valid.
async function fetchGeometry(routeIds) {
  step(`4/5  route members + stop nodes (${routeIds.length} relations)`)
  const have = new Set()
  const files = (await readdir(overpass.CACHE)).filter((n) => /^geom_.+\.json$/.test(n))
  for (const f of files) {
    // A .partial marker names relation ids that never got fetched — re-add them.
    if (f.endsWith('.partial')) continue
    const d = JSON.parse(await readFile(cachePath(f), 'utf8'))
    for (const e of d.elements || []) if (e.type === 'relation') have.add(e.id)
  }
  const retry = new Set()
  for (const f of files.filter((n) => n.endsWith('.partial'))) {
    try {
      const d = JSON.parse(await readFile(cachePath(f), 'utf8'))
      for (const id of d.failed || []) retry.add(id)
    } catch { /* ignore malformed marker */ }
  }
  const todo = routeIds.filter((id) => !have.has(id) || retry.has(id))
  console.log(`  ${have.size} relations already cached, ${todo.length} to fetch`)
  if (!todo.length) return

  const batches = []
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH))
  for (let bi = 0; bi < batches.length; bi++) {
    const hash = String(
      batches[bi].reduce((a, id) => (a * 31 + id) % 0xffffffff, 7) >>> 0,
    ).padStart(10, '0')
    const name = `geom_v${QUERY_VERSION}_${hash}.json`
    if (await cached(name)) { console.log(`  batch ${bi + 1}/${batches.length}: cached`); continue }
    const failedIds = []
    const elements = await fetchGeomBatchData(batches[bi], failedIds)
    await writeFile(cachePath(name), JSON.stringify({ elements }))
    if (failedIds.length) await markPartial(name, { failed: failedIds })
    else await clearPartial(name)
    console.log(`  batch ${bi + 1}/${batches.length}: ${batches[bi].length} relations -> ${name}` +
      (failedIds.length ? ` (${failedIds.length} failed, marked .partial)` : ''))
    await sleep(2000)
  }
}

async function main() {
  const t0 = Date.now()
  await checkQueryVersion()
  const routeIds = await fetchRouteTags()
  await fetchRouteMasters()
  await fetchStations()
  await fetchGeometry(routeIds)
  await fetchStopAreas()
  console.log(`\nDONE fetching in ${((Date.now() - t0) / 1000).toFixed(0)}s. ` +
    `Raw cache: ${overpass.CACHE}\nNext: node scripts/buildGeojson.mjs`)
}

main().catch((e) => { console.error(e); process.exit(1) })
