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
//
// Per-country scope override (使用者選). China: only the HIGH-SPEED network
// (中國高鐵路網) — the full conventional net is enormous and would time out on
// Overpass, and 使用者 only wants 高鐵. Restrict tracks to highspeed=yes and drop
// the usage gate (some PDL/客运专线 track omits usage=main); stations stay full and
// are dropped in build if they don't snap onto kept HSR track (no station w/o line).
const trackWaySelector = (iso2) =>
  iso2 === 'CN'
    ? `way["railway"="rail"]["highspeed"="yes"][!"service"](area.a);`
    : `way["railway"="rail"]["usage"~"^(main|branch)$"][!"service"](area.a);`
const tracksQuery = (iso2) => `[out:json][timeout:900];
area["ISO3166-1"="${iso2}"][admin_level=2]->.a;
${trackWaySelector(iso2)}
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

// HIGH-SPEED LINE relations (route=railway) that run on highspeed track, plus their
// member STOP nodes. Used to build 高鐵 lines from the authoritative ordered stop
// list — a track-walk over HSR viaducts wrongly grabs local stations passing
// underneath (東海道新幹線 ← 東急武蔵小杉), and the highspeed=yes station tag is too
// sparse (China ~none). The relation member stops ARE the real stops (excludes the
// viaduct passovers, includes tag-less majors like 小田原/名古屋), so 高鐵 is built
// from them (see skill railway-osm-fetch). We only need names+coords+order, not the
// (huge) track geometry — the pipeline draws straight station-to-station segments.
const relationsQuery = (iso2) => `[out:json][timeout:600];
area["ISO3166-1"="${iso2}"][admin_level=2]->.a;
way["railway"="rail"]["highspeed"="yes"](area.a)->.hsw;
rel(bw.hsw)["route"="railway"]->.hsrel;
.hsrel out body;
node(r.hsrel)["railway"~"^(station|halt|stop)$"];
out;`

async function main() {
  await mkdir(CACHE, { recursive: true })
  let countries = countryList()
  if (filters.length) countries = countries.filter((c) => {
    const hay = `${c.cc} ${c.name} ${c.name_zh} ${c.iso2}`.toLowerCase()
    return filters.some((f) => hay.includes(f))
  })
  console.log(`railway fetch: ${countries.length} country(ies)` +
    (filters.length ? ` matching ${filters.join(',')}` : ''))

  let ok = 0, skipped = 0, patched = 0
  for (const c of countries) {
    const out = join(CACHE, `rw_${c.cc}.json`)

    // Incremental patch: if tracks/stations are already cached but the newer HSR
    // relations are missing, fetch ONLY the relations and merge — no re-downloading
    // the (huge) track data. --force still refetches everything.
    if (!force && (await exists(out))) {
      let cached
      try { cached = JSON.parse(await readFile(out, 'utf8')) } catch { cached = null }
      if (cached && !cached.relElements) {
        process.stdout.write(`  ${c.cc} ${c.name} … +relations `)
        try {
          const relElements = (await query(relationsQuery(c.iso2), { timeout: 600000, maxAttempts: 8 })).elements
          await writeFile(out, JSON.stringify({ ...cached, relElements }))
          const rels = relElements.filter((e) => e.type === 'relation').length
          console.log(`${rels} HSR line relations`)
          patched++
        } catch (e) { console.log(`FAILED: ${e.message}`) }
        continue
      }
      skipped++; continue
    }

    process.stdout.write(`  ${c.cc} ${c.name} … `)
    let trackElements, stationElements, relElements
    try {
      trackElements = (await query(tracksQuery(c.iso2), { timeout: 900000, maxAttempts: 8 })).elements
      stationElements = (await query(stationsQuery(c.iso2), { timeout: 600000, maxAttempts: 8 })).elements
      relElements = (await query(relationsQuery(c.iso2), { timeout: 600000, maxAttempts: 8 })).elements
    } catch (e) { console.log(`FAILED: ${e.message}`); continue }

    await writeFile(out, JSON.stringify({
      cc: c.cc, iso2: c.iso2, continent: c.continent,
      country: c.name, country_zh: c.name_zh,
      trackElements, stationElements, relElements,
    }))
    const ways = trackElements.filter((e) => e.type === 'way').length
    const sts = stationElements.filter((e) => e.type !== 'relation').length
    const rels = relElements.filter((e) => e.type === 'relation').length
    console.log(`${ways} track ways, ${sts} stations, ${rels} HSR line relations`)
    ok++
  }
  console.log(`done: ${ok} fetched, ${patched} +relations, ${skipped} cached`)
}

main().catch((e) => { console.error(e); process.exit(1) })
