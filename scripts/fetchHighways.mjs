// Fetch the CLOSED-ACCESS road network (使用者: 只要封閉道路就要抓) around each
// metro area — ONE geojson per city/都會區 (使用者: 台灣也要分城市). Anchors on
// data/metro/index.json: every metro system gives its continent/country/city and
// slug, so highways need NO geocoding.
//
// 封閉式道路 (closed / controlled-access) in OSM =
//   highway=motorway                              (國道 / Interstate / Autobahn)
//   highway=trunk + expressway=yes | motorroad=yes (封閉式快速公路, 台61/64/…)
// Interchanges = highway=motorway_junction (交流道) on any of those ways.
//
//   node scripts/fetchHighways.mjs                       # every metro area
//   node scripts/fetchHighways.mjs twn                   # slug/country/cc substrings
//   node scripts/fetchHighways.mjs as-twn,am-usa-chicago # many (comma-separated)
//   node scripts/fetchHighways.mjs twn --force           # ignore cache, refetch
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { query } from './overpass.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const METRO = join(ROOT, 'data', 'metro')
const HIGHWAY = join(ROOT, 'data', 'highway')
const CACHE = join(HIGHWAY, '_cache')

const MARGIN_DEG = 0.30 // pad each metro-area station bbox (~33 km)

const args = process.argv.slice(2)
const force = args.includes('--force')
const filters = (args.find((a) => !a.startsWith('--')) ?? '')
  .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)

async function exists(p) { try { return (await stat(p)).size > 0 } catch { return false } }

function stationBbox(geo) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const f of geo.features ?? []) {
    if (f.geometry?.type !== 'Point') continue
    const [x, y] = f.geometry.coordinates
    if (x < minX) minX = x; if (y < minY) minY = y
    if (x > maxX) maxX = x; if (y > maxY) maxY = y
  }
  if (!isFinite(minX)) return null
  return [minY - MARGIN_DEG, minX - MARGIN_DEG, maxY + MARGIN_DEG, maxX + MARGIN_DEG]
}

const overpassQuery = ([S, W, N, E]) => `[out:json][timeout:300];
(
  way["highway"="motorway"](${S},${W},${N},${E});
  way["highway"="trunk"]["expressway"="yes"](${S},${W},${N},${E});
  way["highway"="trunk"]["motorroad"="yes"](${S},${W},${N},${E});
)->.mw;
node(w.mw)["highway"="motorway_junction"]->.jn;
.mw out geom tags;
.jn out;`

async function main() {
  await mkdir(CACHE, { recursive: true })
  const index = JSON.parse(await readFile(join(METRO, 'index.json'), 'utf8'))
  let systems = index.systems.filter((s) => s.continent && s.country)
  if (filters.length) systems = systems.filter((s) => {
    const slug = s.file.split('/').pop().replace(/\.geojson$/, '')
    const hay = `${slug} ${s.country} ${s.city}`.toLowerCase()
    return filters.some((f) => hay.includes(f))
  })
  console.log(`highway fetch: ${systems.length} metro area(s)` + (filters.length ? ` matching ${filters.join(',')}` : ''))

  let ok = 0, skipped = 0, empty = 0
  for (const sys of systems) {
    const slug = sys.file.split('/').pop().replace(/\.geojson$/, '')
    const out = join(CACHE, `hw_${slug}.json`)
    if (!force && (await exists(out))) { skipped++; continue }

    const geo = JSON.parse(await readFile(join(METRO, sys.file), 'utf8'))
    const bbox = stationBbox(geo)
    if (!bbox) { empty++; continue }

    process.stdout.write(`  ${slug} … `)
    let elements
    try {
      elements = (await query(overpassQuery(bbox), { timeout: 300000, maxAttempts: 8 })).elements
    } catch (e) { console.log(`FAILED: ${e.message}`); continue }

    await writeFile(out, JSON.stringify({
      slug, unit: 'metro', continent: sys.continent, country: sys.country, city: sys.city,
      bbox, elements,
    }))
    const ways = elements.filter((e) => e.type === 'way').length
    const jns = elements.filter((e) => e.type === 'node').length
    console.log(`${ways} ways, ${jns} junctions`)
    ok++
  }
  console.log(`done: ${ok} fetched, ${skipped} cached, ${empty} empty`)
}

main().catch((e) => { console.error(e); process.exit(1) })
