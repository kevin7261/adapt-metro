// Verify data/highway correctness & completeness — the "audit" half of the
// highway fetch⇄audit loop (mirrors verifyMetro.mjs / metro-audit). Runs the
// structural invariants over every built system, writes the result into each
// geojson's `highway_system.audit`, and prints a per-system report. Findings
// feed back into highway-osm-fetch (adjust the query / refetch) — see the
// highway-audit skill.
//
//   node scripts/verifyHighways.mjs           # all systems
//   node scripts/verifyHighways.mjs twn       # slug/country substring
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HIGHWAY = join(__dirname, '..', 'data', 'highway')

const filter = (process.argv[2] ?? '').toLowerCase()

function haversine(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0])
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

// One system's checks. Returns { passed, checks:[{id,ok,level,detail}] }.
function audit(fc) {
  const pts = fc.features.filter((f) => f.geometry.type === 'Point')
  const lines = fc.features.filter((f) => f.geometry.type === 'MultiLineString')
  const checks = []
  const add = (id, ok, level, detail) => checks.push({ id, ok, level, detail })

  // 1) has content
  add('has_lines', lines.length > 0, 'error', `${lines.length} 條封閉式道路`)
  add('has_interchanges', pts.length > 0, 'error', `${pts.length} 個交流道`)

  // 2) every interchange belongs to ≥1 line
  const noLine = pts.filter((p) => !(p.properties.lines || []).length)
  add('interchanges_have_lines', noLine.length === 0, 'error',
    noLine.length ? `${noLine.length} 個交流道無所屬道路` : `${pts.length}/${pts.length} 交流道皆有道路`)

  // 3) every line ≥2 interchanges, geometry endpoints are interchange dots
  const icKeys = new Set(pts.map((p) => p.geometry.coordinates.map((v) => v.toFixed(6)).join(',')))
  let badLines = 0, offDot = 0
  for (const l of lines) {
    const stns = l.properties.routes?.[0]?.stations ?? []
    if (new Set(stns.map((s) => s.station_id)).size < 2) badLines++
    for (const part of l.geometry.coordinates) for (const v of part)
      if (!icKeys.has(v.map((x) => x.toFixed(6)).join(','))) offDot++
  }
  add('lines_have_interchanges', badLines === 0, 'error',
    badLines ? `${badLines} 條道路少於 2 交流道` : '每條道路皆 ≥2 交流道')
  add('vertices_on_interchanges', offDot === 0, 'error',
    offDot ? `${offDot} 個折點不在交流道上` : '所有折點皆為交流道點')

  // 4) NO fake bridging long line (drawn straight seg must be a real adjacency).
  //    Real motorway spacing rarely exceeds ~30 km; longer ⇒ suspect ordering.
  let maxSeg = 0, longSegs = 0
  for (const l of lines) for (const part of l.geometry.coordinates)
    for (let i = 1; i < part.length; i++) {
      const d = haversine(part[i - 1], part[i])
      if (d > maxSeg) maxSeg = d
      if (d > 30) longSegs++
    }
  add('no_fake_long_segment', longSegs === 0, 'error',
    longSegs ? `${longSegs} 段 >30km（疑似跨越假長線），最長 ${maxSeg.toFixed(1)}km`
      : `最長段 ${maxSeg.toFixed(1)}km（皆為真實交流道間距）`)

  // 4b) no triangles — three interchanges mutually connected (parallel-road /
  //     near-duplicate artefacts); build de-triangulates, so any left is a bug.
  {
    const nn = (c) => c.map((v) => v.toFixed(6)).join(',')
    const g = new Map()
    const gl = (a, b) => { if (!g.has(a)) g.set(a, new Set()); g.get(a).add(b) }
    for (const l of lines) for (const part of l.geometry.coordinates) {
      const a = nn(part[0]), b = nn(part[part.length - 1]); gl(a, b); gl(b, a)
    }
    let tris = 0
    for (const a of g.keys()) for (const b of g.get(a)) { if (b <= a) continue; for (const c of g.get(b)) { if (c <= b) continue; if (g.get(a).has(c)) tris++ } }
    add('no_triangles', tris === 0, 'error', tris ? `${tris} 個三角形（去三角化未清乾淨）` : '無三角形')
  }

  // 5) closed-access only: every line is motorway or expressway class
  const badClass = lines.filter((l) => !['motorway', 'expressway'].includes(l.properties.routes?.[0]?.road_class))
  add('closed_access_only', badClass.length === 0, 'error',
    badClass.length ? `${badClass.length} 條道路 road_class 異常` : '皆為 motorway/expressway 封閉式')

  // 6) interchange naming coverage (warn; highways aren't 100% like metro)
  const named = pts.filter((p) => p.properties.station_name && !/^交流道 ?\d*$/.test(p.properties.station_name))
  const pct = pts.length ? Math.round((named.length / pts.length) * 100) : 0
  add('interchanges_named', pct >= 60, 'warn', `${named.length}/${pts.length} 交流道具名（${pct}%）`)

  // 7) mileage monotonicity per line (ordering sanity; warn only)
  let suspectLines = 0
  for (const l of lines) {
    const ms = (l.properties.routes?.[0]?.stations ?? []).map((s) => s.mileage).filter((m) => m != null)
    if (ms.length < 4) continue
    let rev = 0
    for (let i = 2; i < ms.length; i++) if ((ms[i - 1] - ms[i - 2]) * (ms[i] - ms[i - 1]) < 0) rev++
    if (rev > ms.length * 0.25) suspectLines++
  }
  add('mileage_order', suspectLines === 0, 'warn',
    suspectLines ? `${suspectLines} 條道路里程序不單調（排序待查）` : '各道路里程序單調（排序合理）')

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
  try { await walk(join(HIGHWAY, 'systems')) } catch { /* none */ }
  if (filter) files = files.filter((f) => f.toLowerCase().includes(filter))
  if (!files.length) { console.error('no built systems in data/highway/systems — run npm run highway:build first'); process.exit(1) }

  let pass = 0, fail = 0
  for (const f of files.sort()) {
    const fc = JSON.parse(await readFile(f, 'utf8'))
    const res = audit(fc)
    fc.highway_system = { ...fc.highway_system, audit: { ...res, audited_at: null } }
    await writeFile(f, JSON.stringify(fc))
    const label = fc.highway_system.city_zh || fc.highway_system.city || f.split('/').pop()
    const fails = res.checks.filter((c) => c.level === 'error' && !c.ok)
    const warns = res.checks.filter((c) => c.level === 'warn' && !c.ok)
    console.log(`${res.passed ? '✅' : '❌'} ${label}` +
      (fails.length ? `  ✗ ${fails.map((c) => c.detail).join('; ')}` : '') +
      (warns.length ? `  ⚠ ${warns.map((c) => c.detail).join('; ')}` : ''))
    res.passed ? pass++ : fail++
  }
  console.log(`\ndone: ${pass} passed, ${fail} failed / ${files.length} systems`)
}

main().catch((e) => { console.error(e); process.exit(1) })
