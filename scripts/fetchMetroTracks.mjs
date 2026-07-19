// Fetch actual OSM track-way geometry for every route used by the current
// metro-system files. This is deliberately separate from fetchMetro.mjs:
// the primary metro network remains the station-to-station schematic layer.
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as overpass from './overpass.mjs'

const BASE = join('data', 'metro')
// Smaller than the regular route-member fetch: `out geom` can expand one
// route into thousands of vertices, and global Overpass mirrors time out on
// large mixed-city batches.
const BATCH = 50
const VERSION = 2
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function exists(path) {
  try { return (await stat(path)).size > 0 } catch { return false }
}

async function routeIds() {
  const index = JSON.parse(await readFile(join(BASE, 'index.json'), 'utf8'))
  const ids = new Set()
  for (const sys of index.systems || []) {
    const data = JSON.parse(await readFile(join(BASE, sys.file), 'utf8'))
    for (const feature of data.features || []) {
      for (const route of feature.properties?.routes || []) {
        for (const id of route.osm_route_ids || []) ids.add(Number(id))
      }
    }
  }
  return [...ids].filter(Number.isFinite).sort((a, b) => a - b)
}

async function cachedRouteIds() {
  const ids = new Set()
  const files = await readdir(overpass.CACHE)
  for (const name of files.filter((n) => /^tracks_v\d+_\d+\.json$/.test(n))) {
    const data = JSON.parse(await readFile(join(overpass.CACHE, name), 'utf8'))
    for (const el of data.elements || []) if (el.type === 'relation') ids.add(el.id)
  }
  return ids
}

async function main() {
  const ids = await routeIds()
  const have = await cachedRouteIds()
  const todo = ids.filter((id) => !have.has(id))
  console.log(`${ids.length} route relations referenced by metro systems; ${todo.length} need track geometry`)
  for (let start = 0; start < todo.length; start += BATCH) {
    const batch = todo.slice(start, start + BATCH)
    const name = `tracks_v${VERSION}_${String(batch[0]).padStart(10, '0')}.json`
    const path = join(overpass.CACHE, name)
    if (await exists(path)) continue
    // `out geom` embeds a member way's vertices inside each relation. It avoids
    // materialising a second global set of ways, which makes large cross-city
    // batches time out on Overpass mirrors.
    const query = `[out:json][timeout:180];relation(id:${batch.join(',')});out geom;`
    const data = await overpass.query(query, { timeout: 180000, maxAttempts: 6 })
    await writeFile(path, JSON.stringify(data))
    console.log(`  ${Math.floor(start / BATCH) + 1}/${Math.ceil(todo.length / BATCH)}: ${batch.length} routes`)
    await sleep(1500)
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
