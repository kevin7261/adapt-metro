// Fetch worldwide motorway networks around each metro area (see skill
// highway-osm-fetch). Anchors on data/metro/index.json: every metro system
// already knows its continent/country/city and slug, so highways need NO
// geocoding — we reuse the metro area as the "system" unit (一都會區一檔).
//
// For each anchor we take the metro stations' bbox, expand it by MARGIN_DEG,
// and pull highway=motorway ways (with geometry) + highway=motorway_junction
// nodes (the 交流道) inside that box. Raw Overpass responses are cached one
// file per system under data/highway/_cache/; buildHighwayGeojson.mjs turns
// them into the GeoJSON.
//
//   node scripts/fetchHighways.mjs            # all metro areas
//   node scripts/fetchHighways.mjs twn        # only files whose slug matches
//   node scripts/fetchHighways.mjs twn --force # ignore cache, refetch
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { query } from './overpass.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const METRO = join(ROOT, 'data', 'metro')
const HIGHWAY = join(ROOT, 'data', 'highway')
const CACHE = join(HIGHWAY, '_cache')

// How far around the metro stations' bbox to reach for motorways. ~0.30° is
// roughly 33 km — enough to catch a metro area's ring roads and the nearest
// interchanges of the intercity motorways that pass through it.
const MARGIN_DEG = 0.30

const args = process.argv.slice(2)
const force = args.includes('--force')
const filter = args.find((a) => !a.startsWith('--')) ?? ''

async function exists(p) {
  try { return (await stat(p)).size > 0 } catch { return false }
}

// bbox of a metro system's station points → [S, W, N, E].
function stationBbox(geo) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const f of geo.features ?? []) {
    if (f.geometry?.type !== 'Point') continue
    const [x, y] = f.geometry.coordinates
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!isFinite(minX)) return null
  return [minY - MARGIN_DEG, minX - MARGIN_DEG, maxY + MARGIN_DEG, maxX + MARGIN_DEG]
}

function overpassQuery([S, W, N, E]) {
  return `[out:json][timeout:180];
way["highway"="motorway"](${S},${W},${N},${E})->.mw;
node(w.mw)["highway"="motorway_junction"]->.jn;
.mw out geom tags;
.jn out;`
}

async function main() {
  await mkdir(CACHE, { recursive: true })
  const index = JSON.parse(await readFile(join(METRO, 'index.json'), 'utf8'))
  const systems = index.systems.filter((s) => !filter || s.file.includes(filter))
  console.log(`highway fetch: ${systems.length} metro area(s)` +
    (filter ? ` matching "${filter}"` : '') + `, margin ${MARGIN_DEG}°`)

  let ok = 0, skipped = 0, empty = 0
  for (const sys of systems) {
    const slug = sys.file.split('/').pop().replace(/\.geojson$/, '')
    const out = join(CACHE, `hw_${slug}.json`)
    if (!force && (await exists(out))) { skipped++; continue }

    const geo = JSON.parse(await readFile(join(METRO, sys.file), 'utf8'))
    const bbox = stationBbox(geo)
    if (!bbox) { console.log(`  ${slug}: no station points, skip`); empty++; continue }

    process.stdout.write(`  ${slug} … `)
    let res
    try {
      res = await query(overpassQuery(bbox), { timeout: 180000, maxAttempts: 8 })
    } catch (e) {
      console.log(`FAILED: ${e.message}`)
      continue
    }
    const ways = res.elements.filter((e) => e.type === 'way').length
    const jns = res.elements.filter((e) => e.type === 'node').length
    await writeFile(out, JSON.stringify({
      slug,
      continent: sys.continent,
      country: sys.country,
      city: sys.city,
      metro_file: sys.file,
      bbox,
      elements: res.elements,
    }))
    console.log(`${ways} motorway ways, ${jns} junctions`)
    ok++
  }
  console.log(`done: ${ok} fetched, ${skipped} cached, ${empty} empty`)
}

main().catch((e) => { console.error(e); process.exit(1) })
