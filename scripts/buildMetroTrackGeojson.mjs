// Build per-system actual OSM track geometry GeoJSON for the optional map
// underlay. It never changes data/metro/systems or the primary network schema.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const BASE = join('data', 'metro')
const CACHE = join(BASE, '_cache')
const TRACKS = join(BASE, 'tracks')
const RAILWAYS = new Set(['rail', 'subway', 'light_rail', 'monorail', 'narrow_gauge'])

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  }))).flat()
}

async function main() {
  const relationWays = new Map()
  const ways = new Map()
  for (const file of (await readdir(CACHE)).filter((name) => /^tracks_v\d+_\d+\.json$/.test(name))) {
    const data = JSON.parse(await readFile(join(CACHE, file), 'utf8'))
    for (const el of data.elements || []) {
      if (el.type === 'relation') {
        const members = (el.members || []).filter((member) => member.type === 'way')
        relationWays.set(el.id, members.map((member) => member.ref))
        // v2 cache uses relation `out geom`, which nests a way's geometry in
        // its member. v1 stored those same ways as top-level elements.
        for (const member of members) {
          if (member.geometry?.length > 1 &&
              (!member.tags?.railway || RAILWAYS.has(member.tags.railway))) {
            ways.set(member.ref, { id: member.ref, geometry: member.geometry, tags: member.tags })
          }
        }
      } else if (el.type === 'way' && el.geometry?.length > 1 && RAILWAYS.has(el.tags?.railway)) {
        ways.set(el.id, el)
      }
    }
  }

  const index = JSON.parse(await readFile(join(BASE, 'index.json'), 'utf8'))
  const wanted = new Set()
  let featuresWritten = 0
  for (const sys of index.systems || []) {
    const sourcePath = join(BASE, sys.file)
    const data = JSON.parse(await readFile(sourcePath, 'utf8'))
    const routes = new Map()
    for (const feature of data.features || []) {
      for (const route of feature.properties?.routes || []) {
        for (const rid of route.osm_route_ids || []) {
          const id = Number(rid)
          if (!routes.has(id)) routes.set(id, [])
          routes.get(id).push(route)
        }
      }
    }

    const use = new Map()
    for (const [rid, routeList] of routes) {
      for (const wid of relationWays.get(rid) || []) {
        if (!ways.has(wid)) continue
        if (!use.has(wid)) use.set(wid, [])
        use.get(wid).push(...routeList)
      }
    }
    const features = [...use].map(([wid, routeList]) => {
      const routeColors = [...new Set(routeList.map((r) => r.route_color).filter(Boolean))]
      const routeRefs = [...new Set(routeList.map((r) => r.route_ref || r.route_name).filter(Boolean))]
      const way = ways.get(wid)
      return {
        type: 'Feature',
        properties: { way_id: wid, route_colors: routeColors, route_refs: routeRefs },
        geometry: { type: 'LineString', coordinates: way.geometry.map((point) => [point.lon, point.lat]) },
      }
    })
    if (!features.length) continue
    const rel = sys.file.replace(/^systems\//, '')
    const output = join(TRACKS, rel)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify({ type: 'FeatureCollection', features }))
    wanted.add(output)
    featuresWritten += features.length
  }

  // Do not leave stale underlay files after a system changes identity.
  try {
    for (const file of await walk(TRACKS)) {
      if (file.endsWith('.geojson') && !wanted.has(file)) await rm(file, { force: true })
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  console.log(`Wrote ${featuresWritten} OSM track features for ${wanted.size} metro systems`)
}

main().catch((error) => { console.error(error); process.exit(1) })
