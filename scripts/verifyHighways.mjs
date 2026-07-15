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

// Wiki 交叉比對（台灣，對照 _overrides/wiki_mileage_tw.json 的各路交流道里程表；
// 對應 metro-audit 的 wiki 站表比對）。回傳 checks 陣列。
function wikiCrossCheck(fc, wikiRefs) {
  const norm = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/^高架道路/, '')
  const lines = fc.features.filter((f) => f.geometry.type === 'MultiLineString')
  const ptCoord = new Map(fc.features.filter((f) => f.geometry.type === 'Point')
    .map((p) => [p.properties.station_id, p.geometry.coordinates]))
  const perRef = new Map()
  for (const l of lines) for (const r of l.properties.routes) if (!perRef.has(r.route_ref)) perRef.set(r.route_ref, r.stations)
  const missing = [], extra = [], orderBad = [], geomBad = []
  const baseOf = (s) => (s || '').replace(/(系統交流道|出口匝道|交流道|服務區|休息站|轉接道|端)$/, '')
  for (const [ref, stations] of perRef) {
    const wiki = wikiRefs?.[ref]?.list
    if (!wiki) continue
    const wm = new Map(), wb = new Map()
    for (const r of wiki) {
      wm.set(norm(r.name), r.km)
      const b = norm(baseOf(r.name))
      if (b) wb.set(b, wb.has(b) ? null : r.km)
    }
    // 名稱吻合者的 wiki km（依我們的站序；含基底名別名——瑞隆路出口匝道＝瑞隆路交流道）
    const seq = stations.map((s) => ({
      ...s,
      wkm: wm.get(norm(s.station_name)) ?? wb.get(norm(baseOf(s.station_name))) ?? null,
    }))
    const matched = seq.filter((s) => s.wkm != null)
    if (matched.length < 2) continue
    // 1) 順序：吻合站的 wiki km 必須單調（容許環線回折一次以外全升/全降）
    let inv = 0
    for (let i = 2; i < matched.length; i++) {
      if ((matched[i - 1].wkm - matched[i - 2].wkm) * (matched[i].wkm - matched[i - 1].wkm) < 0) inv++
    }
    if (inv) orderBad.push(`${ref}(${inv}處)`)
    // 2) 缺站：bbox 內 km 範圍中、wiki 有但我們沒有的「交流道/系統交流道」（服務區/休息站常無 junction 節點→不計）
    const lo = Math.min(...matched.map((s) => s.wkm)), hi = Math.max(...matched.map((s) => s.wkm))
    const ourNames = new Set()
    for (const s of seq) { ourNames.add(norm(s.station_name)); ourNames.add(norm(baseOf(s.station_name))) }
    for (const w of wiki) {
      if (w.km <= lo + 0.1 || w.km >= hi - 0.1) continue
      if (!/交流道$/.test(w.name)) continue
      if (!ourNames.has(norm(w.name)) && !ourNames.has(norm(baseOf(w.name)))) missing.push(`${ref}:${w.name}(${w.km}K)`)
    }
    // 3) 多站：我們有名字、卻不在 wiki 表上（可能掛錯路／上游髒資料；無名佔位不計）
    for (const s of seq) {
      if (s.wkm != null) continue
      const n = norm(s.station_name)
      if (!n || /^交流道/.test(s.station_name) || /^n\d+$/.test(s.station_name)) continue
      extra.push(`${ref}:${s.station_name}`)
    }
    // 4) 幾何不可能：相鄰兩站的直線距離 > 里程差×1.3+1.2（路只會比直線長；
    //    寬放係數容忍「交流道點在匝道端 vs wiki 樁位」±數百公尺的量測差）
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1], b = seq[i]
      if (a.wkm == null || b.wkm == null) continue
      const ca = ptCoord.get(a.station_id), cb = ptCoord.get(b.station_id)
      if (!ca || !cb) continue
      const straight = haversine(ca, cb), dkm = Math.abs(b.wkm - a.wkm)
      if (straight > dkm * 1.3 + 1.2) geomBad.push(`${ref}:${a.station_name}→${b.station_name}(直線${straight.toFixed(1)}k>里程差${dkm.toFixed(1)}k)`)
    }
  }
  const checks = []
  checks.push({ id: 'wiki_order', ok: !orderBad.length, level: 'error',
    detail: orderBad.length ? `站序與 wiki 里程不符：${orderBad.join('、')}` : '各路站序與 wiki 里程一致' })
  checks.push({ id: 'wiki_geometry', ok: !geomBad.length, level: 'error',
    detail: geomBad.length ? `${geomBad.length} 段直線距離大於里程差（接錯線）：${geomBad.slice(0, 4).join('；')}` : '各段幾何與里程差相容' })
  checks.push({ id: 'wiki_missing', ok: !missing.length, level: 'warn',
    detail: missing.length ? `wiki 有、我們缺 ${missing.length} 站：${missing.slice(0, 8).join('、')}` : 'bbox 內 wiki 交流道皆在' })
  checks.push({ id: 'wiki_extra', ok: !extra.length, level: 'warn',
    detail: extra.length ? `不在 wiki 表上 ${extra.length} 站：${extra.slice(0, 8).join('、')}` : '無 wiki 表外站' })
  return checks
}

// One system's checks. Returns { passed, checks:[{id,ok,level,detail}] }.
function audit(fc, wikiRefs) {
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

  // 4b) single line per ref — within one road, every interchange links to at most
  //     2 neighbours (a path, or a closed ring). Degree >2 inside a ref means the
  //     road braided into parallel chains (主線 vs 高架) — the build's
  //     sequence-per-ref ordering makes this structurally impossible; any hit is a bug.
  {
    const nn = (c) => c.map((v) => v.toFixed(6)).join(',')
    const perRef = new Map() // ref → Map(node → Set(node))
    for (const l of lines) {
      for (const ref of l.properties.route_refs ?? []) {
        if (!perRef.has(ref)) perRef.set(ref, new Map())
        const g = perRef.get(ref)
        for (const part of l.geometry.coordinates) {
          const a = nn(part[0]), b = nn(part[part.length - 1])
          if (!g.has(a)) g.set(a, new Set()); if (!g.has(b)) g.set(b, new Set())
          g.get(a).add(b); g.get(b).add(a)
        }
      }
    }
    const badRefs = []
    for (const [ref, g] of perRef) {
      let bad = 0
      for (const s of g.values()) if (s.size > 2) bad++
      if (bad) badRefs.push(`${ref}(${bad})`)
    }
    add('single_line_per_ref', badRefs.length === 0, 'error',
      badRefs.length ? `${badRefs.length} 條道路有分叉/辮子：${badRefs.slice(0, 5).join('、')}` : '每條道路皆為單一路徑/環')
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

  // 7b) 相鄰同名站：一條路的序列裡連續兩站同名＝同一交流道的匝道群沒併成一點
  //     （宜蘭交流道 6.1km 案例；不靠 wiki 表也抓得到）
  {
    const dup = []
    for (const l of lines) {
      const st = l.properties.routes?.[0]?.stations ?? []
      for (let i = 1; i < st.length; i++) {
        const a = st[i - 1], b = st[i]
        if (!b.station_name || b.station_name !== a.station_name || b.station_id === a.station_id) continue
        if (/^交流道/.test(b.station_name)) continue // 無名佔位，同名不代表同座
        // 兩站里程都有且差 ≥1km ＝上游刻意分開的不同出口（台61 林口 14/16）→ 合法
        if (a.mileage != null && b.mileage != null && Math.abs(a.mileage - b.mileage) >= 1) continue
        dup.push(`${l.properties.route_refs[0]}:${b.station_name}`)
      }
    }
    add('no_adjacent_dup_names', dup.length === 0, 'error',
      dup.length ? `相鄰同名站未併：${[...new Set(dup)].join('、')}` : '無相鄰同名未併站')
  }

  // 8) wiki 交叉比對（有 wiki 里程表的國家：台灣）
  if (wikiRefs && fc.highway_system?.country === 'Taiwan') checks.push(...wikiCrossCheck(fc, wikiRefs))

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

  let wikiRefs = null
  try { wikiRefs = JSON.parse(await readFile(join(HIGHWAY, '_overrides', 'wiki_mileage_tw.json'), 'utf8')).refs } catch { /* optional */ }

  let pass = 0, fail = 0
  for (const f of files.sort()) {
    const fc = JSON.parse(await readFile(f, 'utf8'))
    const res = audit(fc, wikiRefs)
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
