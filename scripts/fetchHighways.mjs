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
//   node scripts/fetchHighways.mjs                       # all countries
//   node scripts/fetchHighways.mjs twn                   # one country (cc/name substring)
//   node scripts/fetchHighways.mjs as-chn,as-jpn,eu-     # many; "eu-" = all of Europe
//   node scripts/fetchHighways.mjs twn --force           # ignore cache, refetch
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
// comma-separated substrings matched against cc or country name; "eu-" = all
// of Europe, "as-chn,as-jpn" = China + Japan, empty = every country.
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
    if (bbox) byCountry.get(cc).members.push({
      slug: sys.file.split('/').pop().replace(/\.geojson$/, ''), city: sys.city, bbox,
    })
  }

  let countries = [...byCountry.values()].filter((c) => c.members.length)
  if (filters.length) countries = countries.filter((c) =>
    filters.some((f) => c.cc.includes(f) || c.country.toLowerCase().includes(f)))
  console.log(`highway fetch: ${countries.length} country(ies)` + (filters.length ? ` matching ${filters.join(',')}` : ''))

  const writeCache = async (name, obj) => {
    const ways = obj.elements.filter((e) => e.type === 'way').length
    const jns = obj.elements.filter((e) => e.type === 'node').length
    await writeFile(join(CACHE, name), JSON.stringify(obj))
    console.log(`${ways} motorway ways, ${jns} junctions`)
  }

  let ok = 0, skipped = 0
  for (const c of countries) {
    const uni = unionBbox(c.members.map((m) => m.bbox))
    const wholeCountry = (uni[2] - uni[0]) <= SPAN_CAP && (uni[3] - uni[1]) <= SPAN_CAP

    if (wholeCountry) {
      // small country → ONE file per country, whole-country query
      const out = join(CACHE, `hw_${c.cc}.json`)
      if (!force && (await exists(out))) { skipped++; continue }
      process.stdout.write(`  ${c.cc} (${c.country}) whole-country … `)
      try {
        const elements = await fetchBox(uni)
        await writeCache(`hw_${c.cc}.json`, {
          cc: c.cc, slug: c.cc, unit: 'country', continent: c.continent,
          country: c.country, city: c.country, bbox: uni, elements,
        })
        ok++
      } catch (e) { console.log(`FAILED: ${e.message}`) }
    } else {
      // large country (span > SPAN_CAP) → one file PER METRO AREA (使用者: 太大
      // 的話用都會區為單位). Each metro area is fetched and cached separately.
      console.log(`  ${c.cc} (${c.country}) too wide → ${c.members.length} metro areas:`)
      for (const m of c.members) {
        const out = join(CACHE, `hw_${m.slug}.json`)
        if (!force && (await exists(out))) { skipped++; continue }
        process.stdout.write(`    ${m.slug} … `)
        try {
          const elements = await fetchBox(m.bbox)
          await writeCache(`hw_${m.slug}.json`, {
            cc: c.cc, slug: m.slug, unit: 'metro', continent: c.continent,
            country: c.country, city: m.city, bbox: m.bbox, elements,
          })
          ok++
        } catch (e) { console.log(`FAILED: ${e.message}`) }
      }
    }
  }
  console.log(`done: ${ok} fetched, ${skipped} cached`)
}

main().catch((e) => { console.error(e); process.exit(1) })
