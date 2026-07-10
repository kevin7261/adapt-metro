// Cross-check the built metro data (data/metro/index.json) against the
// Wikipedia "List of metro systems" baseline (+ urbanrail.net reference links).
// Emits a discrepancy report that feeds back into the fetch pipeline (metro-osm-fetch):
//   data/metro/verify_report.json  (structured)  +  verify_report.md  (human summary)
// Run after buildGeojson.mjs. See skill metro-audit.
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

// --- station-order sanity check -------------------------------------------
// Line geometry is the stops connected in OSM relation-member order; a shuffled
// relation shows up as a path far longer than the minimum spanning tree over
// the same stops. Flagged lines MUST then be manually confirmed against the
// line's Wikipedia article and urbanrail.net (see skill metro-audit).
const ORDER_RATIO = 1.6
const dist = (a, b) => {
  const dx = (a[0] - b[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180)
  const dy = a[1] - b[1]
  return Math.sqrt(dx * dx + dy * dy)
}
const pathLen = (pts) => {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i])
  return s
}
const mstLen = (pts) => {  // Prim, O(n^2) — stop counts are small
  const d = pts.map(() => Infinity)
  const used = pts.map(() => false)
  d[0] = 0
  let total = 0
  for (let k = 0; k < pts.length; k++) {
    let u = -1
    for (let i = 0; i < pts.length; i++) if (!used[i] && (u < 0 || d[i] < d[u])) u = i
    used[u] = true; total += d[u]
    for (let i = 0; i < pts.length; i++) if (!used[i]) d[i] = Math.min(d[i], dist(pts[u], pts[i]))
  }
  return total
}
const suspectOrder = (lineFeat) => {
  let worst = 0
  for (const seq of lineFeat.geometry?.coordinates || []) {
    if (seq.length < 4) continue
    const mst = mstLen(seq)
    if (mst < 0.01) continue  // ~1 km network: too small to judge
    worst = Math.max(worst, pathLen(seq) / mst)
  }
  return worst > ORDER_RATIO ? +worst.toFixed(2) : 0
}

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

  // ---- per-system feature scans ----
  // invariant: a station can never be without a line. Every station must
  // belong to >=1 operational route; an empty `lines` means the fetch/build
  // side failed to associate it (stop_position mismatch, route missing).
  // order:     station-order of every line must be plausible; suspects need
  //            manual confirmation against Wikipedia + urbanrail.net.
  for (const s of index.systems) {
    let sys
    try { sys = JSON.parse(await readFile(join(BASE, s.file), 'utf8')) } catch { continue }
    const pts = (sys.features || []).filter((f) => f.geometry?.type === 'Point')
    const orphans = pts.filter((f) => !(f.properties?.lines || []).length)
    if (orphans.length) {
      flags.push({ severity: 'no_line', city: s.city, country: s.country,
        our_file: s.file, our_stations: s.station_count, our_lines: s.line_count,
        stations_without_line: orphans.length,
        samples: orphans.slice(0, 5).map((f) => f.properties?.station_name || f.properties?.station_id),
        note: `${orphans.length}/${pts.length} 站不屬於任何路線（違反不變式：車站必有路線）`,
        urbanrail: urbanrailSearch(s.city) })
    }
    const suspects = (sys.features || [])
      .filter((f) => f.geometry?.type === 'MultiLineString')
      .map((f) => ({ name: f.properties?.route_name || f.properties?.route_id,
        ratio: suspectOrder(f) }))
      .filter((l) => l.ratio > 0)
      .sort((a, b) => b.ratio - a.ratio)
    if (suspects.length) {
      flags.push({ severity: 'order', city: s.city, country: s.country,
        our_file: s.file, our_stations: s.station_count, our_lines: s.line_count,
        suspect_lines: suspects,
        note: `${suspects.length} 條線站序可疑（路徑長 > ${ORDER_RATIO}× MST）：` +
          suspects.slice(0, 4).map((l) => `${l.name} ${l.ratio}×`).join('、') +
          (suspects.length > 4 ? '…' : '') + '，需以 Wikipedia 線路條目與 urbanrail 人工確認站序',
        urbanrail: urbanrailSearch(s.city) })
    }
  }

  // our systems that matched no Wikipedia system (likely non-metro or fragments)
  const extras = index.systems
    .filter((s) => !matchedFiles.has(s.file))
    .map((s) => ({ file: s.file, city: s.city, country: s.country,
      station_count: s.station_count, line_count: s.line_count }))

  // invariants (硬規則，違反即資料錯，必須回 fetch 端修)：
  //   1. wiki 有列的城市不可能沒資料  -> severity `missing`
  //   2. 車站不可能沒有路線          -> severity `no_line`
  // 必驗項目：站序可疑 (`order`) -> 用 Wikipedia + urbanrail 人工確認
  const order = { missing: 0, no_line: 1, order: 2, zero: 3, low: 4, high: 5 }
  flags.sort((a, b) => (order[a.severity] - order[b.severity]) ||
    ((b.wiki_stations || 0) - (a.wiki_stations || 0)))

  const nSev = (s) => flags.filter((f) => f.severity === s).length
  const summary = {
    generated_against: 'Wikipedia: List of metro systems (+ urbanrail.net reference)',
    wikipedia_systems: wiki.length,
    our_systems: index.systems.length,
    matched_ok: okCount,
    flagged: flags.length,
    invariant_violations: {
      wiki_city_without_data: nSev('missing'),
      stations_without_line: flags.filter((f) => f.severity === 'no_line')
        .reduce((n, f) => n + f.stations_without_line, 0),
      systems_with_stations_without_line: nSev('no_line'),
    },
    order_suspect_systems: nSev('order'),
    by_severity: {
      missing: nSev('missing'),
      no_line: nSev('no_line'),
      order: nSev('order'),
      zero: nSev('zero'),
      low: nSev('low'),
      high: nSev('high'),
    },
    extras: extras.length,
  }

  await writeFile(join(BASE, 'verify_report.json'),
    JSON.stringify({ summary, flags, extras }, null, 2))
  await writeFile(join(BASE, 'verify_report.md'), toMarkdown(summary, flags, extras))

  console.log('=== metro-audit ===')
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
  L.push(`| 標記待查 | ${summary.flagged}（missing ${summary.by_severity.missing}／no_line ${summary.by_severity.no_line}／order ${summary.by_severity.order}／zero ${summary.by_severity.zero}／low ${summary.by_severity.low}／high ${summary.by_severity.high}） |`)
  L.push(`| 額外（不在 wiki 清單） | ${summary.extras} |`, '')
  L.push('## 不變式（invariants，違反＝資料一定有錯，必須驗證修正）', '')
  L.push('1. **wiki 有列的城市不可能沒資料**：違反數 ' +
    `**${summary.invariant_violations.wiki_city_without_data}**（severity \`missing\`）`)
  L.push('2. **車站不可能沒有路線**：' +
    `**${summary.invariant_violations.systems_with_stations_without_line}** 個系統、共 ` +
    `**${summary.invariant_violations.stations_without_line}** 站的 \`lines\` 為空（severity \`no_line\`）`)
  L.push('3. **站序必須正確**：' +
    `**${summary.order_suspect_systems}** 個系統有站序可疑的線（severity \`order\`）——` +
    '一律以該線 **Wikipedia 條目**的車站列表與 **urbanrail.net** 的線路站序人工確認', '')
  L.push('## 待查系統（fetch⇄verify 迴圈的回饋清單）', '')
  L.push('| 嚴重度 | 城市 | 國家 | 本站數 | wiki站數 | 比值 | 說明 | 參考 |')
  L.push('|---|---|---|---|---|---|---|---|')
  for (const f of flags) {
    const ref = [f.wiki_url && `[wiki](${f.wiki_url})`, `[urbanrail](${f.urbanrail})`]
      .filter(Boolean).join(' · ')
    L.push(`| ${f.severity} | ${f.city} | ${f.country} | ${f.our_stations ?? '—'} | ${f.wiki_stations ?? '—'} | ${f.ratio ?? '—'} | ${f.note} | ${ref} |`)
  }
  L.push('', '## 額外系統（本資料有、Wikipedia 清單無）', '')
  L.push('多為 OSM 標為 subway 但非 Wikipedia 定義的地鐵、或城市名變體/切分。', '')
  L.push('| 檔案 | 城市 | 國家 | 站 | 線 |', '|---|---|---|---|---|')
  for (const e of extras) L.push(`| ${e.file} | ${e.city ?? '—'} | ${e.country ?? '—'} | ${e.station_count} | ${e.line_count} |`)
  return L.join('\n') + '\n'
}

main().catch((e) => { console.error(e); process.exit(1) })
