// Verify data/railway correctness & completeness — the "audit" half of the railway
// fetch⇄audit loop (mirrors verifyHighways.mjs / verifyMetro.mjs). Runs the
// structural invariants (railway-osm-fetch 不變式) over every built system, folds in
// the per-line Wikipedia station-count check (wikiRailwayLines.mjs →
// line_check_report.json), writes the result into each geojson's
// `railway_system.audit`, and prints a per-system report. Findings feed back into
// railway-osm-fetch (refetch / _overrides) — see the railway-audit skill.
//
//   node scripts/verifyRailways.mjs           # all systems
//   node scripts/verifyRailways.mjs jpn       # file-path substring (as-jpn…)
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RAILWAY = join(__dirname, '..', 'data', 'railway')
const filter = (process.argv[2] ?? '').toLowerCase()

function haversine(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0])
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
// per-class 斷口門檻＝build 的 capFor（一般 30km／高鐵 70km）：畫直線只連「軌道上真正
// 相鄰」的兩站，超過即排序退化的假長線。高鐵站間距大，門檻放寬。
const capKm = (cls) => (cls === 'high_speed' ? 70 : 30)
const norm = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')

// One system's structural checks. Returns { passed, checks:[{id,ok,level,detail}] }.
function audit(fc, wikiFlagsForFile) {
  const pts = fc.features.filter((f) => f.geometry.type === 'Point')
  const lines = fc.features.filter((f) => f.geometry.type === 'MultiLineString')
  const cls = fc.railway_system?.rail_class ?? 'conventional'
  const checks = []
  const add = (id, ok, level, detail) => checks.push({ id, ok, level, detail })

  // 1) 有內容
  add('has_lines', lines.length > 0, 'error', `${lines.length} 條路線`)
  add('has_stations', pts.length > 0, 'error', `${pts.length} 個車站`)

  // 2) 不變式①：每車站 ≥1 條所屬線
  const noLine = pts.filter((p) => !(p.properties.lines || []).length)
  add('stations_have_lines', noLine.length === 0, 'error',
    noLine.length ? `${noLine.length} 個車站無所屬線` : `${pts.length}/${pts.length} 車站皆有線`)

  // 3) 不變式②：每段 ≥2 站、兩端幾何為車站點
  const stKeys = new Set(pts.map((p) => p.geometry.coordinates.map((v) => v.toFixed(6)).join(',')))
  let badLines = 0, offDot = 0
  for (const l of lines) {
    const stns = l.properties.routes?.[0]?.stations ?? []
    if (new Set(stns.map((s) => s.station_id)).size < 2) badLines++
    for (const part of l.geometry.coordinates) for (const v of part)
      if (!stKeys.has(v.map((x) => x.toFixed(6)).join(','))) offDot++
  }
  add('lines_have_stations', badLines === 0, 'error',
    badLines ? `${badLines} 條線少於 2 站` : '每條線皆 ≥2 站')
  add('vertices_on_stations', offDot === 0, 'error',
    offDot ? `${offDot} 個折點不在車站上` : '所有折點皆為車站點')

  // 4) 無假長線：相鄰兩站直線距離 > per-class cap ⇒ 排序退化跳到並行線／缺口硬接
  let maxSeg = 0, longSegs = 0
  for (const l of lines) for (const part of l.geometry.coordinates) for (let i = 1; i < part.length; i++) {
    const d = haversine(part[i - 1], part[i])
    if (d > maxSeg) maxSeg = d
    if (d > capKm(cls)) longSegs++
  }
  add('no_fake_long_segment', longSegs === 0, 'error',
    longSegs ? `${longSegs} 段 >${capKm(cls)}km（疑似假長線），最長 ${maxSeg.toFixed(1)}km`
      : `最長段 ${maxSeg.toFixed(1)}km（皆為真實站間距）`)

  // 5) 不變式④：degree 分佈以 2 為主；出現 10+ 度＝逐線排序退化成 mesh
  {
    const deg = new Map()
    for (const p of pts) deg.set(p.properties.station_id, p.properties.station_degree ?? 0)
    const hi = [...deg.entries()].filter(([, d]) => d >= 10)
    add('degree_distribution', hi.length === 0, 'warn',
      hi.length ? `${hi.length} 站 degree ≥10（疑似 mesh 退化）` : 'degree 分佈正常（以 2 為主）')
  }

  // 6) 相鄰同名站未併：一條線序列裡連續兩站同名（>150m 沒併成一點）
  {
    const dup = []
    for (const l of lines) {
      const st = l.properties.routes?.[0]?.stations ?? []
      for (let i = 1; i < st.length; i++) {
        const a = st[i - 1], b = st[i]
        if (!b.station_name || norm(b.station_name) !== norm(a.station_name) || b.station_id === a.station_id) continue
        dup.push(`${l.properties.routes[0].route_name}:${b.station_name}`)
      }
    }
    add('no_adjacent_dup_names', dup.length === 0, 'error',
      dup.length ? `相鄰同名站未併：${[...new Set(dup)].slice(0, 6).join('、')}` : '無相鄰同名未併站')
  }

  // 7) 逐線 wiki 站數（wikiRailwayLines.mjs 產出，跨社聚合後比全線）。error＝我們 > wiki
  //    （誤併/多抓）；warn＝我們 < wiki（多為 OSM 關聯停站不全，待人工以 wiki 站單確認）。
  if (wikiFlagsForFile) {
    const errs = wikiFlagsForFile.filter((f) => f.severity === 'error')
    const warns = wikiFlagsForFile.filter((f) => f.severity === 'warn')
    const fmt = (f) => `${f.route_name}(我${f.ours}/wiki${f.wiki_stations})`
    add('line_wiki_stations_over', errs.length === 0, 'error',
      errs.length ? `${errs.length} 線站數多於 wiki（誤併/多抓）：${errs.slice(0, 6).map(fmt).join('、')}` : '無多於 wiki 的線')
    add('line_wiki_stations_under', warns.length === 0, 'warn',
      warns.length ? `${warns.length} 線站數少於 wiki（OSM 關聯不全？）：${warns.slice(0, 6).map(fmt).join('、')}` : '各線站數與 wiki 相符')
  }

  const passed = checks.filter((c) => c.level === 'error').every((c) => c.ok)
  return { passed, checks }
}

async function main() {
  let files = []
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.name.endsWith('.geojson')) files.push(p)
    }
  }
  try { await walk(join(RAILWAY, 'systems')) } catch { /* none */ }
  if (filter) files = files.filter((f) => f.toLowerCase().includes(filter))
  if (!files.length) { console.error('no built systems in data/railway/systems — run npm run railway:build first'); process.exit(1) }

  // wiki 逐線報告（可選；沒跑過 railway:wikilines 就只做結構檢查）。flags 依線名所在檔分派。
  let wikiByFile = null
  try {
    const rep = JSON.parse(await readFile(join(RAILWAY, 'line_check_report.json'), 'utf8'))
    wikiByFile = new Map()
    for (const f of rep.flags ?? []) for (const fn of f.files ?? []) {
      if (!wikiByFile.has(fn)) wikiByFile.set(fn, [])
      wikiByFile.get(fn).push(f)
    }
  } catch { /* optional — run railway:wikilines first for the wiki layer */ }

  let pass = 0, fail = 0
  for (const f of files.sort()) {
    const fc = JSON.parse(await readFile(f, 'utf8'))
    const flagsForFile = wikiByFile?.get(f.split('/').pop()) ?? (wikiByFile ? [] : null)
    const res = audit(fc, flagsForFile)
    fc.railway_system = { ...fc.railway_system, audit: { ...res, audited_at: null } }
    if (fc.metro_system) fc.metro_system = { ...fc.metro_system, audit: { ...res, audited_at: null } }
    await writeFile(f, JSON.stringify(fc))
    const label = fc.railway_system.country_zh + (fc.railway_system.company_zh ? ` ${fc.railway_system.company_zh}` : '') + ` ${fc.railway_system.class_zh || ''}`
    const fails = res.checks.filter((c) => c.level === 'error' && !c.ok)
    const warns = res.checks.filter((c) => c.level === 'warn' && !c.ok)
    console.log(`${res.passed ? '✅' : '❌'} ${label.trim()}` +
      (fails.length ? `  ✗ ${fails.map((c) => c.detail).join('; ')}` : '') +
      (warns.length ? `  ⚠ ${warns.map((c) => c.detail).join('; ')}` : ''))
    res.passed ? pass++ : fail++
  }
  console.log(`\ndone: ${pass} passed, ${fail} failed / ${files.length} systems`)
}

main().catch((e) => { console.error(e); process.exit(1) })
