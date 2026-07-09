// Fetch all metro (subway) route + station data worldwide from OpenStreetMap.
// Writes raw Overpass responses to data/metro/_cache/. Resumable.
// Then run: node scripts/buildGeojson.mjs
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'

const BATCH = 120
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (m) => console.log(`\n=== ${m} ===`)

async function cached(name) {
  try { return (await stat(join(overpass.CACHE, name))).size > 0 } catch { return false }
}

// Operational-only guard: route=subway / station=subway with a lifecycle tag
// (state=construction, construction=*, proposed=*, ...) is not in service yet.
// Lifecycle-prefixed tagging (construction:route=subway) never matches the
// base queries, so these predicates only catch the mixed-tagging leftovers.
const LIFE = '["state"!~"^(proposed|construction)$"][!"construction"][!"proposed"][!"disused"][!"abandoned"]'

async function fetchRouteTags() {
  step('1/4  route=subway relation tags (operational only)')
  const q = `[out:json][timeout:300];relation["route"="subway"]${LIFE};out tags;`
  const data = await overpass.query(q, { cacheName: 'routes_tags.json', timeout: 300000 })
  const ids = data.elements.filter((e) => e.type === 'relation').map((e) => e.id)
  console.log(`  ${ids.length} subway route relations`)
  return ids
}

async function fetchRouteMasters() {
  step('2/4  route_master=subway relations (line grouping)')
  const q = '[out:json][timeout:180];relation["route_master"="subway"];out body;'
  try {
    const data = await overpass.query(q,
      { cacheName: 'route_masters.json', timeout: 150000, maxAttempts: 6 })
    const n = data.elements.filter((e) => e.type === 'relation').length
    console.log(`  ${n} route_master relations`)
  } catch (e) {
    // Non-fatal: line grouping falls back to network+ref when masters are absent.
    console.log(`  !! route_master fetch failed (${e.message}); ` +
      `continuing with network+ref grouping`)
    await writeFile(join(overpass.CACHE, 'route_masters.json'),
      JSON.stringify({ elements: [] }))
  }
}

async function fetchStations() {
  step('3/4  subway stations (nodes + station areas)')
  if (await cached('stations.json')) {
    const d = JSON.parse(await readFile(join(overpass.CACHE, 'stations.json'), 'utf8'))
    console.log(`  cached: ${d.elements.length} station elements`)
    return
  }
  // Split into two lighter queries: nodes carry lat/lon directly; station
  // areas (ways) need center. Lighter queries survive loaded public mirrors.
  const ST = '["railway"!~"^(proposed|construction|disused|abandoned|razed)$"]'
  const nodeQ = '[out:json][timeout:180];(' +
    `node["station"="subway"]${ST}${LIFE};node["railway"="station"]["subway"="yes"]${LIFE};);out;`
  const wayQ = '[out:json][timeout:180];(' +
    `way["station"="subway"]${ST}${LIFE};way["railway"="station"]["subway"="yes"]${LIFE};);out center tags;`
  const nodes = await overpass.query(nodeQ, { timeout: 180000 })
  const ways = await overpass.query(wayQ, { timeout: 180000, maxAttempts: 6 })
    .catch((e) => { console.log(`  !! station areas fetch failed (${e.message})`); return { elements: [] } })
  const elements = [...nodes.elements, ...ways.elements]
  await writeFile(join(overpass.CACHE, 'stations.json'), JSON.stringify({ elements }))
  console.log(`  ${nodes.elements.length} station nodes + ${ways.elements.length} station areas`)
}

async function fetchGeomBatchData(ids) {
  // No track (way) geometry: lines are later drawn by connecting the route's
  // stops in member order, so we only need the ordered member lists (out body)
  // plus coordinates of the member nodes (stops/platforms).
  const q = `[out:json][timeout:300];relation(id:${ids.join(',')})->.r;` +
    '.r out body;node(r.r);out skel qt;'
  try {
    return (await overpass.query(q, { timeout: 300000, maxAttempts: 5 })).elements
  } catch (e) {
    if (ids.length <= 1) { console.log(`  !! giving up on ${ids}`); return [] }
    const mid = ids.length >> 1
    console.log(`  .. splitting batch of ${ids.length} after failure`)
    return [...await fetchGeomBatchData(ids.slice(0, mid)),
            ...await fetchGeomBatchData(ids.slice(mid))]
  }
}

async function fetchGeometry(routeIds) {
  step(`4/4  route members + stop nodes (${routeIds.length} relations, batches of ${BATCH})`)
  const batches = []
  for (let i = 0; i < routeIds.length; i += BATCH) batches.push(routeIds.slice(i, i + BATCH))
  for (let bi = 0; bi < batches.length; bi++) {
    const name = `geom_${String(bi).padStart(3, '0')}.json`
    if (await cached(name)) { console.log(`  batch ${bi + 1}/${batches.length}: cached`); continue }
    const elements = await fetchGeomBatchData(batches[bi])
    await writeFile(join(overpass.CACHE, name), JSON.stringify({ elements }))
    console.log(`  batch ${bi + 1}/${batches.length}: ${batches[bi].length} relations -> ${name}`)
    await sleep(2000)
  }
}

async function main() {
  const t0 = Date.now()
  const routeIds = await fetchRouteTags()
  await fetchRouteMasters()
  await fetchStations()
  await fetchGeometry(routeIds)
  console.log(`\nDONE fetching in ${((Date.now() - t0) / 1000).toFixed(0)}s. ` +
    `Raw cache: ${overpass.CACHE}\nNext: node scripts/buildGeojson.mjs`)
}

main().catch((e) => { console.error(e); process.exit(1) })
