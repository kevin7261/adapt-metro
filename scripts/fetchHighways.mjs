// Fetch worldwide motorway networks — ONE geojson per country (使用者: 台灣只要
// 一個 geojson). Anchors on data/metro/index.json: metro systems give each
// country its continent + the metro-area bboxes to cover, so highways need NO
// geocoding. Interchanges = highway=motorway_junction (交流道); lines =
// highway=motorway grouped by ref (國道X號).
//
// Per country we union its metro areas' station bboxes (each expanded by
// MARGIN_DEG). If that union is small enough (SPAN_CAP) we pull the whole
// country in one query so each 國道 is complete end-to-end (Taiwan, Korea…);
// for a huge country (USA, China) that would be an enormous query, so we fall
// back to one query per metro area — build.mjs still merges them into one
// country file (with gaps between far-apart metro areas).
//
//   node scripts/fetchHighways.mjs            # all countries
//   node scripts/fetchHighways.mjs twn        # only countries matching (cc/name)
//   node scripts/fetchHighways.mjs twn --force # ignore cache, refetch
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { query } from './overpass.mjs'
import { iocCode, continentCode } from './countryCodes.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const METRO = join(ROOT, 'data', 'metro')
const HIGHWAY = join(ROOT, 'data', 'highway')
const CACHE = join(HIGHWAY, '_cache')

const MARGIN_DEG = 0.30   // pad each metro-area station bbox (~33 km)
const SPAN_CAP = 6.0      // union bbox wider than this (°) → fetch per metro area

const args = process.argv.slice(2)
const force = args.includes('--force')
const filter = (args.find((a) => !a.startsWith('--')) ?? '').toLowerCase()

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
const unionBbox = (boxes) => [
  Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
  Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3])),
]
const overpassQuery = ([S, W, N, E]) => `[out:json][timeout:300];
way["highway"="motorway"](${S},${W},${N},${E})->.mw;
node(w.mw)["highway"="motorway_junction"]->.jn;
.mw out geom tags;
.jn out;`

async function fetchBox(bbox) {
  const res = await query(overpassQuery(bbox), { timeout: 300000, maxAttempts: 8 })
  return res.elements
}

async function main() {
  await mkdir(CACHE, { recursive: true })
  const index = JSON.parse(await readFile(join(METRO, 'index.json'), 'utf8'))

  // group metro systems by country → { cc, continent, country, members:[{slug,bbox}] }
  const byCountry = new Map()
  for (const sys of index.systems) {
    if (!sys.continent || !sys.country) continue
    const cc = `${continentCode(sys.continent)}-${iocCode(sys.country)}`
    if (!byCountry.has(cc)) byCountry.set(cc, { cc, continent: sys.continent, country: sys.country, members: [] })
    const geo = JSON.parse(await readFile(join(METRO, sys.file), 'utf8'))
    const bbox = stationBbox(geo)
    if (bbox) byCountry.get(cc).members.push({ slug: sys.file.split('/').pop().replace(/\.geojson$/, ''), bbox })
  }

  let countries = [...byCountry.values()].filter((c) => c.members.length)
  if (filter) countries = countries.filter((c) => c.cc.includes(filter) || c.country.toLowerCase().includes(filter))
  console.log(`highway fetch: ${countries.length} country(ies)` + (filter ? ` matching "${filter}"` : ''))

  let ok = 0, skipped = 0
  for (const c of countries) {
    const out = join(CACHE, `hw_${c.cc}.json`)
    if (!force && (await exists(out))) { skipped++; continue }

    const uni = unionBbox(c.members.map((m) => m.bbox))
    const wholeCountry = (uni[2] - uni[0]) <= SPAN_CAP && (uni[3] - uni[1]) <= SPAN_CAP
    process.stdout.write(`  ${c.cc} (${c.country}) `)
    let elements
    try {
      if (wholeCountry) {
        process.stdout.write(`whole-country bbox … `)
        elements = await fetchBox(uni)
      } else {
        // huge country → per metro area, merge, dedupe by type+id
        process.stdout.write(`${c.members.length} metro-area bboxes … `)
        const seen = new Set(), merged = []
        for (const m of c.members) {
          for (const el of await fetchBox(m.bbox)) {
            const k = `${el.type}${el.id}`
            if (!seen.has(k)) { seen.add(k); merged.push(el) }
          }
        }
        elements = merged
      }
    } catch (e) { console.log(`FAILED: ${e.message}`); continue }

    const ways = elements.filter((e) => e.type === 'way').length
    const jns = elements.filter((e) => e.type === 'node').length
    await writeFile(out, JSON.stringify({
      cc: c.cc, continent: c.continent, country: c.country,
      whole_country: wholeCountry, bbox: uni, elements,
    }))
    console.log(`${ways} motorway ways, ${jns} junctions`)
    ok++
  }
  console.log(`done: ${ok} fetched, ${skipped} cached`)
}

main().catch((e) => { console.error(e); process.exit(1) })
