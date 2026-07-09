// Cross-check the built metro data (data/metro/index.json) against the
// Wikipedia "List of metro systems" baseline (+ urbanrail.net reference links).
// Emits a discrepancy report that feeds back into the fetch pipeline (metro-osm-fetch):
//   data/metro/verify_report.json  (structured)  +  verify_report.md  (human summary)
// Run after buildGeojson.mjs. See skill metro-data-verify.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '..', 'data', 'metro')
const CACHE = join(BASE, '_cache')

// tolerance: our station count vs Wikipedia's before we flag it
const LOW_RATIO = 0.6    // ours < 60% of wiki -> under-covered
const HIGH_RATIO = 1.6   // ours > 160% of wiki -> over-counted (light rail merged in?)

const norm = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '')
const toInt = (s) => { const m = /([\d,]+)/.exec(s || ''); return m ? parseInt(m[1].replace(/,/g, ''), 10) : null }
const toFloat = (s) => { const m = /([\d,]+(?:\.\d+)?)/.exec(s || ''); return m ? parseFloat(m[1].replace(/,/g, '')) : null }
const countryOk = (a, b) => {
  const na = norm(a), nb = norm(b)
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na))
}

// urbanrail.net has no clean API; give a reference link for manual confirmation.
const urbanrailSearch = (city) =>
  `https://www.google.com/search?q=${encodeURIComponent('site:urbanrail.net ' + (city || ''))}`

async function main() {
  const index = JSON.parse(await readFile(join(BASE, 'index.json'), 'utf8'))
  const wiki = JSON.parse(await readFile(join(CACHE, 'wiki_metro_systems.json'), 'utf8'))
  let maps = {}
  try { maps = JSON.parse(await readFile(join(BASE, 'maps', 'maps_index.json'), 'utf8')) } catch { /* optional */ }

  // Index our systems by normalized city (a city may host >1 osm system file).
  const oursByCity = new Map()
  for (const s of index.systems) {
    const k = norm(s.city)
    if (!k) continue
    if (!oursByCity.has(k)) oursByCity.set(k, [])
    oursByCity.get(k).push(s)
  }
  const matchedFiles = new Set()

  const flags = []
  let okCount = 0
  for (const w of wiki) {
    const wStations = toInt(w.stations)
    const wLength = toFloat(w.system_length)
    const cands = oursByCity.get(norm(w.city)) || []
    // prefer a same-country candidate
    const ours = cands.find((c) => countryOk(c.country, w.country)) || cands[0] || null

    if (!ours) {
      flags.push({ severity: 'missing', city: w.city, country: w.country, system: w.name,
        our_stations: null, wiki_stations: wStations, wiki_length_km: wLength,
        note: '本資料無此系統（OSM 未以 route=subway 標記，或城市名不同）',
        wiki_url: `https://en.wikipedia.org/wiki/${(w.name || '').replace(/\s+/g, '_')}`,
        urbanrail: urbanrailSearch(w.city) })
      continue
    }
    matchedFiles.add(ours.file)
    const ratio = wStations ? +(ours.station_count / wStations).toFixed(2) : null
    let severity = 'ok'
    let note = ''
    if (ours.station_count === 0) { severity = 'zero'; note = '本資料 0 站（車站未指派到此系統）' }
    else if (ratio != null && ratio < LOW_RATIO) { severity = 'low'; note = `站數偏少（${ours.station_count} vs wiki ${wStations}）` }
    else if (ratio != null && ratio > HIGH_RATIO) { severity = 'high'; note = `站數偏多（${ours.station_count} vs wiki ${wStations}），可能混入輕軌` }
    else { okCount++; continue }

    flags.push({ severity, city: w.city, country: w.country, system: w.name,
      our_file: ours.file, our_stations: ours.station_count, our_lines: ours.line_count,
      wiki_stations: wStations, wiki_length_km: wLength, ratio, note,
      has_map: !!maps[ours.file?.replace(/^systems\//, '').replace(/\.geojson$/, '')]?.map_file,
      wiki_url: `https://en.wikipedia.org/wiki/${(w.name || '').replace(/\s+/g, '_')}`,
      urbanrail: urbanrailSearch(w.city) })
  }

  // our systems that matched no Wikipedia system (likely non-metro or fragments)
  const extras = index.systems
    .filter((s) => !matchedFiles.has(s.file))
    .map((s) => ({ file: s.file, city: s.city, country: s.country,
      station_count: s.station_count, line_count: s.line_count }))

  const order = { zero: 0, missing: 1, low: 2, high: 3 }
  flags.sort((a, b) => (order[a.severity] - order[b.severity]) ||
    ((b.wiki_stations || 0) - (a.wiki_stations || 0)))

  const summary = {
    generated_against: 'Wikipedia: List of metro systems (+ urbanrail.net reference)',
    wikipedia_systems: wiki.length,
    our_systems: index.systems.length,
    matched_ok: okCount,
    flagged: flags.length,
    by_severity: {
      zero: flags.filter((f) => f.severity === 'zero').length,
      missing: flags.filter((f) => f.severity === 'missing').length,
      low: flags.filter((f) => f.severity === 'low').length,
      high: flags.filter((f) => f.severity === 'high').length,
    },
    extras: extras.length,
  }

  await writeFile(join(BASE, 'verify_report.json'),
    JSON.stringify({ summary, flags, extras }, null, 2))
  await writeFile(join(BASE, 'verify_report.md'), toMarkdown(summary, flags, extras))

  console.log('=== metro-data-verify ===')
  console.log(summary)
  console.log(`report -> ${join(BASE, 'verify_report.json')} / .md`)
}

function toMarkdown(summary, flags, extras) {
  const L = []
  L.push('# Metro data verification report', '')
  L.push('對照 **Wikipedia List of metro systems**（站數）＋ urbanrail.net 參考連結。', '')
  L.push('| 指標 | 值 |', '|---|---|')
  L.push(`| Wikipedia 系統數 | ${summary.wikipedia_systems} |`)
  L.push(`| 本資料系統數 | ${summary.our_systems} |`)
  L.push(`| 站數相符 (ok) | ${summary.matched_ok} |`)
  L.push(`| 標記待查 | ${summary.flagged}（zero ${summary.by_severity.zero}／missing ${summary.by_severity.missing}／low ${summary.by_severity.low}／high ${summary.by_severity.high}） |`)
  L.push(`| 額外（不在 wiki 清單） | ${summary.extras} |`, '')
  L.push('## 待查系統（fetch⇄verify 迴圈的回饋清單）', '')
  L.push('| 嚴重度 | 城市 | 國家 | 本站數 | wiki站數 | 比值 | 說明 | 參考 |')
  L.push('|---|---|---|---|---|---|---|---|')
  for (const f of flags) {
    const ref = `[wiki](${f.wiki_url}) · [urbanrail](${f.urbanrail})`
    L.push(`| ${f.severity} | ${f.city} | ${f.country} | ${f.our_stations ?? '—'} | ${f.wiki_stations ?? '—'} | ${f.ratio ?? '—'} | ${f.note} | ${ref} |`)
  }
  L.push('', '## 額外系統（本資料有、Wikipedia 清單無）', '')
  L.push('多為 OSM 標為 subway 但非 Wikipedia 定義的地鐵、或城市名變體/切分。', '')
  L.push('| 檔案 | 城市 | 國家 | 站 | 線 |', '|---|---|---|---|---|')
  for (const e of extras) L.push(`| ${e.file} | ${e.city ?? '—'} | ${e.country ?? '—'} | ${e.station_count} | ${e.line_count} |`)
  return L.join('\n') + '\n'
}

main().catch((e) => { console.error(e); process.exit(1) })
