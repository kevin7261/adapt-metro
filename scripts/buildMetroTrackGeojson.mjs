// Build per-system actual OSM track geometry GeoJSON for the optional map
// underlay. It never changes data/metro/systems or the primary network schema.
//
// Sources（依序合併，先到先得）：
//   1. data/metro/_cache/tracks_v*.json —— metro:fetchtracks（route relation out geom）
//   2. data/railway/_cache/rw_*.json —— railway 抓取快取（combined 附加的台鐵／高鐵
//      等 route=railway 常只在這裡有 way 幾何；metro tracks 快取沒抓過）
//
// 輸出會依該系統車站 bbox（+ pad）裁切——避免全國幹線 relation（縱貫線／高鐵）
// 把整條西海岸都畫進都會區 underlay。
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const BASE = join('data', 'metro')
const CACHE = join(BASE, '_cache')
const RAIL_CACHE = join('data', 'railway', '_cache')
const TRACKS = join(BASE, 'tracks')
const RAILWAYS = new Set(['rail', 'subway', 'light_rail', 'monorail', 'narrow_gauge'])
const BBOX_PAD = 0.03 // ~3 km：端點站外的一小段軌道仍保留

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  }))).flat()
}

function absorbWay(ways, id, geometry, tags) {
  if (!geometry || geometry.length < 2) return
  if (tags?.railway && !RAILWAYS.has(tags.railway)) return
  if (!ways.has(id)) ways.set(id, { id, geometry, tags })
}

function absorbRelation(relationWays, ways, el) {
  const members = (el.members || []).filter((member) => member.type === 'way')
  if (!relationWays.has(el.id)) relationWays.set(el.id, members.map((member) => member.ref))
  for (const member of members) {
    if (member.geometry?.length > 1) absorbWay(ways, member.ref, member.geometry, member.tags)
  }
}

async function loadMetroTrackCache(relationWays, ways) {
  let files = []
  try { files = (await readdir(CACHE)).filter((name) => /^tracks_v\d+_\d+\.json$/.test(name)) }
  catch (error) { if (error.code !== 'ENOENT') throw error; return }
  for (const file of files) {
    const data = JSON.parse(await readFile(join(CACHE, file), 'utf8'))
    for (const el of data.elements || []) {
      if (el.type === 'relation') absorbRelation(relationWays, ways, el)
      else if (el.type === 'way') absorbWay(ways, el.id, el.geometry, el.tags)
    }
  }
}

// railway 快取：combined 附加幹線（台鐵／高鐵…）的 way 幾何多半只在這裡。
async function loadRailwayTrackCache(relationWays, ways) {
  let files = []
  try { files = (await readdir(RAIL_CACHE)).filter((name) => /^rw_.*\.json$/.test(name)) }
  catch (error) { if (error.code !== 'ENOENT') throw error; return }
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(RAIL_CACHE, file), 'utf8'))
    for (const el of raw.trackElements || []) {
      absorbWay(ways, el.id, el.geometry, el.tags)
    }
    for (const el of raw.relElements || []) {
      if (el.type === 'relation') absorbRelation(relationWays, ways, el)
    }
  }
}

function stationBbox(features, pad = BBOX_PAD) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const f of features || []) {
    if (f.geometry?.type !== 'Point') continue
    const [lon, lat] = f.geometry.coordinates || []
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    if (lon < minLon) minLon = lon
    if (lat < minLat) minLat = lat
    if (lon > maxLon) maxLon = lon
    if (lat > maxLat) maxLat = lat
  }
  if (!Number.isFinite(minLon)) return null
  return [minLon - pad, minLat - pad, maxLon + pad, maxLat + pad]
}

// 全國幹線 relation 的單條 way 可能很長——只要一端擦到都會區 bbox 就整段留下
// 會把軌道畫到城外很遠。改成「多數頂點落在 bbox 內」才收。
function wayHitsBbox(geometry, bbox) {
  if (!bbox) return true
  const [w, s, e, n] = bbox
  let hit = 0
  for (const p of geometry) {
    const lon = p.lon ?? p[0], lat = p.lat ?? p[1]
    if (lon >= w && lon <= e && lat >= s && lat <= n) hit++
  }
  return hit >= Math.max(1, Math.ceil(geometry.length * 0.5))
}

async function main() {
  const relationWays = new Map()
  const ways = new Map()
  await loadMetroTrackCache(relationWays, ways)
  await loadRailwayTrackCache(relationWays, ways)

  const index = JSON.parse(await readFile(join(BASE, 'index.json'), 'utf8'))
  const wanted = new Set()
  let featuresWritten = 0
  for (const sys of index.systems || []) {
    const sourcePath = join(BASE, sys.file)
    const data = JSON.parse(await readFile(sourcePath, 'utf8'))
    const bbox = stationBbox(data.features)
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
        const way = ways.get(wid)
        if (!wayHitsBbox(way.geometry, bbox)) continue
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
