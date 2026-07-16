// Fetch NATIONAL railway networks worldwide from OpenStreetMap — ONE geojson per
// country (使用者: 一國家一檔). Railway is the metro/highway counterpart at COUNTRY
// scope; see skill railway-osm-fetch.
//
// Scope (authoritative heuristic, 使用者選: OSM 標籤啟發式, 不看營運商):
//   include  railway=rail + usage=main|branch  (running lines of the national /
//            state railway + dedicated high-speed track highspeed=yes)
//   exclude  railway=subway | tram | light_rail | monorail  (railway=rail only)
//   exclude  yards/sidings/spurs (any service=* on the way), industrial usage
//   Private railways stay in by default; a per-country operator-exclusion list
//   (data/railway/_overrides/{cc}_exclude.json) drops them where needed (JP 私鉄).
//
// Track-based (like highway=motorway): the station network follows REAL track —
// rail ways carry the LINE NAME (縱貫線, 屏東線…), usage & highspeed; stations are
// snapped onto the track graph and connected in track order (complete coverage;
// route=train relations are per-train and cover only a fraction of stations).
// Anchored on a whole COUNTRY via the OSM boundary area (ISO3166-1), no geocoding.
//
//   node scripts/fetchRailways.mjs                 # every country in the list
//   node scripts/fetchRailways.mjs twn             # cc/name substrings
//   node scripts/fetchRailways.mjs as-jpn,eu-fra   # many (comma-separated)
//   node scripts/fetchRailways.mjs twn --force     # ignore cache, refetch
//
// Then run: node scripts/buildRailwayGeojson.mjs
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { query } from './overpass.mjs'
import { countryList } from './railwayCountries.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const RAILWAY = join(ROOT, 'data', 'railway')
const CACHE = join(RAILWAY, '_cache')

const args = process.argv.slice(2)
const force = args.includes('--force')
const filters = (args.find((a) => !a.startsWith('--')) ?? '')
  .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)

async function exists(p) { try { return (await stat(p)).size > 0 } catch { return false } }

// Running-line track: railway=rail with usage=main|branch (excludes subway/tram/
// light_rail/monorail — those are other railway=* values — and yards/sidings which
// carry service=*). out geom tags → full vertex geometry + line name / usage /
// highspeed / maxspeed / operator for classification and line grouping.
const tracksQuery = (iso2) => `[out:json][timeout:900];
area["ISO3166-1"="${iso2}"][admin_level=2]->.a;
way["railway"="rail"]["usage"~"^(main|branch)$"][!"service"](area.a);
out geom tags;`

// Named stations (railway=station / halt) + station areas (ways). Excludes
// subway/light_rail/monorail station flavours; snapped onto the track graph.
const stationsQuery = (iso2) => `[out:json][timeout:600];
area["ISO3166-1"="${iso2}"][admin_level=2]->.a;
(
  node["railway"~"^(station|halt)$"]["station"!~"^(subway|light_rail|monorail)$"](area.a);
);
out;
way["railway"="station"]["station"!~"^(subway|light_rail|monorail)$"](area.a);
out center tags;`

async function main() {
  await mkdir(CACHE, { recursive: true })
  let countries = countryList()
  if (filters.length) countries = countries.filter((c) => {
    const hay = `${c.cc} ${c.name} ${c.name_zh} ${c.iso2}`.toLowerCase()
    return filters.some((f) => hay.includes(f))
  })
  console.log(`railway fetch: ${countries.length} country(ies)` +
    (filters.length ? ` matching ${filters.join(',')}` : ''))

  let ok = 0, skipped = 0
  for (const c of countries) {
    const out = join(CACHE, `rw_${c.cc}.json`)
    if (!force && (await exists(out))) { skipped++; continue }

    process.stdout.write(`  ${c.cc} ${c.name} … `)
    let trackElements, stationElements
    try {
      trackElements = (await query(tracksQuery(c.iso2), { timeout: 900000, maxAttempts: 8 })).elements
      stationElements = (await query(stationsQuery(c.iso2), { timeout: 600000, maxAttempts: 8 })).elements
    } catch (e) { console.log(`FAILED: ${e.message}`); continue }

    await writeFile(out, JSON.stringify({
      cc: c.cc, iso2: c.iso2, continent: c.continent,
      country: c.name, country_zh: c.name_zh,
      trackElements, stationElements,
    }))
    const ways = trackElements.filter((e) => e.type === 'way').length
    const sts = stationElements.filter((e) => e.type !== 'relation').length
    console.log(`${ways} track ways, ${sts} stations`)
    ok++
  }
  console.log(`done: ${ok} fetched, ${skipped} cached`)
}

main().catch((e) => { console.error(e); process.exit(1) })
