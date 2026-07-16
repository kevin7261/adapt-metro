// Per-city audit + repair loop (strategy ladder, zero-LLM, resumable).
//
//   for each city:  audit → (fail?) apply next strategy → rebuild → re-audit
//                   … until pass, or the ladder is exhausted (verdict recorded)
//
// Cities are audited one by one right after their data lands — not in one big
// batch at the end. Verdicts (pass/fail + reasons) are written to
// _cache/audit_state.json; buildGeojson embeds them into each system's
// metro_system.audit so the UI's Info tab can display them.
//
// Strategy ladders (see .claude/skills/metro-audit/SKILL.md):
//   missing wiki system:  S1 bind cached routes near city  → override
//                         S2 targeted fetch r=40 km (name-token gated)
//                         S3 targeted fetch r=80 km (city-token gated)
//   too few stations:     Z1 targeted station fetch around the system
//                         Z2 derive stations from named stop_position nodes
//   stray 0-station sys:  Z0 merge into a canonical neighbour city (≤25 km)
//
// Scope rule everywhere: route=subway|light_rail only — never train/railway/tram.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as overpass from './overpass.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '..', 'data', 'metro')
const CACHE = overpass.CACHE
const OVERRIDES_DIR = join(BASE, '_overrides')
const STATE_PATH = join(CACHE, 'audit_state.json')
const UA = 'adapt-metro-thesis/1.0 (metro data audit; knowledge.nomads.tw2@gmail.com)'

const LIFE = '["state"!~"^(proposed|construction)$"][!"construction"][!"proposed"][!"disused"][!"abandoned"]'
const MODES = '["route"~"^(subway|light_rail)$"]'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const slugify = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
const normCity = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '')
const kmDist = (aLat, aLon, bLat, bLon) => {
  const dx = (aLon - bLon) * Math.cos(((aLat + bLat) / 2) * Math.PI / 180)
  return Math.sqrt(dx * dx + (aLat - bLat) ** 2) * 111
}
const STOP_TOKENS = new Set(['metro', 'subway', 'underground', 'u-bahn', 'the', 'of',
  'rapid', 'transit', 'railway', 'rail', 'mrt', 'lrt', 'light', 'system', 'line', 'lines'])
const tokens = (s) => {
  const out = new Set()
  for (const t of (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().split(/[^a-z0-9]+/))
    if (t && t.length > 1 && !STOP_TOKENS.has(t)) out.add(t)
  return out
}
const shareToken = (a, b) => { for (const x of a) if (b.has(x)) return true; return false }
// Known country-name variants (reverse-geocode vs Wikipedia wording) —
// keep in sync with buildGeojson.mjs.
const COUNTRY_ALIAS = {
  czechia: 'czechrepublic',
  turkiye: 'turkey',
  unitedstatesofamerica: 'unitedstates',
  republicofkorea: 'southkorea',
  russianfederation: 'russia',
  myanmarburma: 'myanmar',
}
const normCountry = (s) => {
  const n = (s || '').toLowerCase().replace(/[^a-z]/g, '')
  return COUNTRY_ALIAS[n] ?? n
}
const countryOk = (a, b) => {
  if (!a || !b) return false
  const na = normCountry(a), nb = normCountry(b)
  return na === nb || na.includes(nb) || nb.includes(na)
}

const readJSON = async (p, fallback) => {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return fallback }
}

/* ---------------- shared context (reloaded after each rebuild) ---------------- */

const ctx = {
  wiki: [], wikiXY: {}, state: {},
  index: null,          // data/metro/index.json
  ridCity: new Map(),   // osm relation id -> current bucket city
  ridCentroid: new Map(), // osm relation id -> {lat, lon} (from geom cache)
  knownRids: new Set(),
}

async function loadStatic() {
  ctx.wiki = await readJSON(join(CACHE, 'wiki_metro_systems.json'), [])
  ctx.wikiXY = await readJSON(join(CACHE, 'wiki_city_coords.json'), {})
  ctx.state = await readJSON(STATE_PATH, {})
  // per-line Wikipedia verification report (scripts/wikiLineCheck.mjs, optional;
  // system-article guards live THERE — audit reads the adjudicated report)
  ctx.lineReport = await readJSON(join(BASE, 'line_check_report.json'), null)

  // relation centroids from every geometry cache file
  const files = (await readdir(CACHE)).filter((n) =>
    /^(geom_.+|gap_geom_.+)\.json$/.test(n) && !n.endsWith('.partial'))
  for (const f of files) {
    const d = await readJSON(join(CACHE, f), {})
    const nodeXY = new Map()
    for (const e of d.elements || [])
      if (e.type === 'node' && e.lat != null) nodeXY.set(e.id, [e.lon, e.lat])
    for (const e of d.elements || []) {
      if (e.type !== 'relation') continue
      let sx = 0, sy = 0, n = 0
      for (const m of e.members || []) {
        if (m.type !== 'node') continue
        const c = m.lat != null ? [m.lon, m.lat] : nodeXY.get(m.ref)
        if (c) { sx += c[0]; sy += c[1]; n++ }
      }
      if (n) ctx.ridCentroid.set(e.id, { lon: sx / n, lat: sy / n })
    }
  }
  const rt = await readJSON(join(CACHE, 'routes_tags.json'), { elements: [] })
  for (const e of rt.elements) if (e.type === 'relation') ctx.knownRids.add(e.id)
}

async function reloadIndex() {
  ctx.index = await readJSON(join(BASE, 'index.json'), null)
  ctx.ridCity = new Map()
  const lines = await readJSON(join(BASE, 'metro_lines.geojson'), { features: [] })
  for (const f of lines.features) {
    // segment features carry their routes' relation ids inside routes[]
    const routes = f.properties.routes ?? [f.properties]
    for (const r of routes)
      for (const rid of r.osm_route_ids || [])
        ctx.ridCity.set(rid, f.properties.city)
  }
}

function rebuild() {
  execFileSync('node', [join(__dirname, 'buildGeojson.mjs')], { stdio: 'pipe' })
}

async function saveState() {
  await writeFile(STATE_PATH, JSON.stringify(ctx.state, null, 2))
}

/* ---------------- audit ---------------- */

const parseIntLoose = (s) => {
  const m = /\d[\d,]*/.exec(String(s ?? ''))
  return m ? parseInt(m[0].replace(/,/g, ''), 10) : null
}

function findSystem(city, country) {
  return ctx.index.systems.find((s) =>
    normCity(s.city) === normCity(city) && countryOk(s.country, country)) ?? null
}

// --- station-order sanity (same rule as scripts/verifyMetro.mjs) ---
const ORDER_RATIO = 1.6
const segDist = (a, b) => {
  const dx = (a[0] - b[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180)
  return Math.sqrt(dx * dx + (a[1] - b[1]) ** 2)
}
const pathLen = (pts) => {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += segDist(pts[i - 1], pts[i])
  return s
}
const mstLen = (pts) => {
  const d = pts.map(() => Infinity), used = pts.map(() => false)
  d[0] = 0
  let total = 0
  for (let k = 0; k < pts.length; k++) {
    let u = -1
    for (let i = 0; i < pts.length; i++) if (!used[i] && (u < 0 || d[i] < d[u])) u = i
    used[u] = true; total += d[u]
    for (let i = 0; i < pts.length; i++)
      if (!used[i]) d[i] = Math.min(d[i], segDist(pts[u], pts[i]))
  }
  return total
}
const suspectOrder = (f) => {
  let worst = 0
  for (const seq of f.geometry?.coordinates || []) {
    if (seq.length < 4) continue
    const mst = mstLen(seq)
    if (mst < 0.01) continue
    worst = Math.max(worst, pathLen(seq) / mst)
  }
  return worst > ORDER_RATIO ? +worst.toFixed(2) : 0
}

// Audit one city. Mirrors the metro-audit invariants:
//   error → fails the audit (missing / zero / no_line / low coverage)
//   warn  → passes but is surfaced (high count / suspect station order)
// wikiRow is null for extra (non-baseline) systems.
const LOW_RATIO = 0.6, HIGH_RATIO = 1.6
async function audit(city, country, wikiRow) {
  const checks = []
  const push = (id, ok, detail, level = 'error') => checks.push({ id, ok, detail, level })
  const sys = findSystem(city, country)

  if (wikiRow) {
    push('system_exists', !!sys,
      sys ? `matched OSM system ${sys.file}` : 'no OSM system matched to this city')
  }
  if (!sys) {
    return { passed: false, checks,
      reasons: ['OSM 中找不到對應系統（route=subway|light_rail 皆無匹配）'] }
  }

  push('has_lines', sys.line_count >= 1, `${sys.line_count} lines`)
  push('has_stations', sys.station_count >= 1, `${sys.station_count} stations`)

  // 系統級站數不算比值（使用者規則：全部以 wiki 為準）——站數的硬判定在
  // 逐線檢查 line_wiki_stations（當地語言 wiki 條目，站數必須相等）。
  // 系統級數字僅作參考資訊（wiki List 的計法與共站合併天然不同）。
  if (wikiRow) {
    const wikiN = parseIntLoose(wikiRow.stations)
    if (wikiN) {
      push('station_count_info', true,
        `OSM ${sys.station_count} 站（wiki List 記 ${wikiN}，計法含轉乘重複，僅參考）`, 'warn')
    }
  }

  const g = await readJSON(join(BASE, sys.file), null)
  if (g) {
    const pts = g.features.filter((f) => f.geometry.type === 'Point')
    // invariant 2: a station can never be without a line
    const orphans = pts.filter((f) => !(f.properties.lines || []).length)
    if (pts.length) {
      push('stations_have_lines', orphans.length === 0,
        orphans.length
          ? `${orphans.length}/${pts.length} 站不屬於任何路線（違反不變式）`
          : `${pts.length}/${pts.length} 站皆有所屬路線`)
    }
    // invariants 4-6: every line has ≥2 stations; every vertex (bend) of a
    // line IS a station; both endpoints ARE stations. The build guarantees
    // this by construction (geometry = station points in stop order) — this
    // check verifies the shipped output actually holds it.
    const stationCoords = new Set(pts.map((f) => f.geometry.coordinates.join(',')))
    let badVerts = 0, shortSeqs = 0, totalVerts = 0
    for (const f of g.features) {
      if (f.geometry?.type !== 'MultiLineString') continue
      for (const seq of f.geometry.coordinates) {
        if (seq.length < 2) { shortSeqs++; continue }
        for (const c of seq) {
          totalVerts++
          if (!stationCoords.has(c.join(','))) badVerts++
        }
      }
    }
    if (totalVerts) {
      push('line_geometry_stations', badVerts === 0 && shortSeqs === 0,
        badVerts || shortSeqs
          ? `${badVerts} 個折點非車站、${shortSeqs} 段少於 2 站（違反不變式：折點/端點必為車站、線必有站）`
          : `${totalVerts} 個折點/端點皆為車站`)
    }

    // 不變式：route 的 stations 列表必須與圖面（該線所有路段的頂點）一致——
    // 「列表跟圖不同是不可能的」。以站 id 集合比對。
    {
      const coordToId = new Map(pts.map((f) =>
        [f.geometry.coordinates.join(','), f.properties.station_id]))
      const geomIds = new Map()   // route_id -> Set(station ids from geometry)
      const listIds = new Map()   // route_id -> Set(station ids from stations[])
      for (const f of g.features) {
        if (f.geometry?.type !== 'MultiLineString') continue
        for (const r of f.properties?.routes || []) {
          if (!geomIds.has(r.route_id)) {
            geomIds.set(r.route_id, new Set())
            // stations＝完整行經序（含 pass）——幾何頂點本就含 pass 站，兩者天然一致
            listIds.set(r.route_id, new Set((r.stations || []).map((s) => s.station_id)))
          }
        }
        for (const seq of f.geometry.coordinates)
          for (const c of seq) {
            const id = coordToId.get(c.join(','))
            if (!id) continue
            for (const r of f.properties?.routes || []) geomIds.get(r.route_id).add(id)
          }
      }
      const bad = []
      for (const [rid, gset] of geomIds) {
        const lset = listIds.get(rid)
        const miss = [...gset].filter((x) => !lset.has(x)).length
        const extra = [...lset].filter((x) => !gset.has(x)).length
        if (miss || extra) bad.push(`${rid}(圖${gset.size}/表${lset.size})`)
      }
      push('route_stations_match_geometry', bad.length === 0,
        bad.length
          ? `${bad.length} 條線的車站列表與圖面不一致（不可能狀態）：` + bad.slice(0, 3).join('、')
          : '各線車站列表與圖面一致')
    }

    // 不變式：interchange ⇔ 網絡圖度數 >2（分歧/交會）或 端點站停靠 ≥2 線
    // （terminus-interchange，如 Zaragoza；termCount≥2 亦落入此式）或 端點站被
    // pass 路線穿過（東涌案 2026-07-16：終點站幾何上有線續走＝分歧，絕非藍點）。
    // 與 buildGeojson.mjs 的 isIx 同式（該處為權威，改一處必同步）。同路線共軌
    // 重疊段中間站 degree=2、非端點 不算；濱海沙崙／七張分歧 degree=3 算。
    {
      const bad = pts.filter((f) => {
        const p = f.properties
        const deg = p.station_degree ?? (p.lines?.length ?? 0)
        const hasPass = (p.routes ?? []).some((r) => r?.pass)
        const expect = deg > 2 || (p.is_terminus && (p.lines?.length ?? 0) >= 2)
          || (p.is_terminus && hasPass && deg >= 2)
        return expect !== !!p.is_interchange
      })
      push('interchange_rule', bad.length === 0,
        bad.length
          ? `${bad.length} 站的 interchange 標記與網絡圖度數不符：` +
            bad.slice(0, 4).map((f) => f.properties.station_name).join('、')
          : '所有車站 interchange 標記符合「度數 >2（分歧/交會）或端點站轉乘/被穿過」規則')
    }

    // 全部車站必須有名稱（使用者規則：100%，無名＝資料錯誤）
    const unnamed = pts.filter((f) => /^n\d+$/.test(f.properties.station_name || ''))
    if (pts.length) {
      push('stations_named', unnamed.length === 0,
        unnamed.length
          ? `${unnamed.length}/${pts.length} 站無名稱（${unnamed.slice(0, 3)
              .map((f) => f.properties.station_id).join('、')}…）——需補上游名稱或剔除`
          : `${pts.length}/${pts.length} 站皆有名稱`)
    }
    // invariant: station order must be plausible — computed by the build per
    // route (before segmentization) and carried on route meta `order_suspect`
    const seen = new Set()
    const suspects = []
    for (const f of g.features) {
      if (f.geometry?.type !== 'MultiLineString') continue
      for (const r of f.properties?.routes || []) {
        if (!r.order_suspect || seen.has(r.route_id)) continue
        seen.add(r.route_id)
        suspects.push({ name: r.route_name || r.route_id, ratio: r.order_suspect })
      }
    }
    push('station_order', suspects.length === 0,
      suspects.length
        ? `${suspects.length} 條線站序可疑（路徑長 > ${ORDER_RATIO}× MST）：` +
          suspects.slice(0, 4).map((l) => `${l.name} ${l.ratio}×`).join('、') +
          '，需以 Wikipedia 線路條目與 urbanrail.net 人工確認'
        : '所有線路站序合理',
      'warn')

    // 逐線 wiki 站數對照（使用者規則：不算比值，全以「當地語言」wiki 條目為準，
    // 但「只畫有通車的」不變式優先）——三段式判定（嚴重度由 wikiLineCheck 標定）：
    //   error：infobox 有「營運中/已啟用」數且不等；或 ours > wiki（未通車解釋不了）
    //   warn ：infobox 只有全線總數且 ours < total（可能含未通車段，待人工確認）
    // 判定讀 line_check_report.json（系統條目誤標的護欄在 wikiLineCheck 端）。
    if (ctx.lineReport) {
      const inCity = (x) => normCity(x.city) === normCity(city) && countryOk(x.country, country)
      const cityFlags = (ctx.lineReport.flags ?? []).filter(inCity)
      const hard = cityFlags.filter((x) => x.severity !== 'warn')
        .map((x) => `${x.route_name} ${x.ours}/${x.wiki_stations}`)
      const soft = cityFlags.filter((x) => x.severity === 'warn')
        .map((x) => `${x.route_name} ${x.ours}/${x.wiki_stations}`)
      const noWiki = (ctx.lineReport.uncovered_lines ?? []).filter(inCity)
      push('line_wiki_stations', hard.length === 0,
        hard.length
          ? `${hard.length} 條線站數與 wiki 條目不符（必須相等）：` +
            hard.slice(0, 4).join('、')
          : '各線站數與 wiki 線路條目相符（營運中站數）')
      if (soft.length) {
        push('line_wiki_planned', false,
          `${soft.length} 條線少於 wiki 全線總數（可能含未通車段，待人工確認）：` +
          soft.slice(0, 4).join('、'), 'warn')
      }
      if (noWiki.length) {
        push('line_wiki_coverage', false,
          `${noWiki.length} 條線無 wiki 站數對照：` +
          noWiki.slice(0, 3).map((x) => x.route_name || x.route_id).join('、'), 'warn')
      }
    }
  }

  const errors = checks.filter((c) => !c.ok && c.level === 'error')
  const warns = checks.filter((c) => !c.ok && c.level === 'warn')
  return {
    passed: errors.length === 0,
    checks,
    reasons: errors.map((c) => c.detail),
    warnings: warns.map((c) => c.detail),
    system_file: sys.file,
  }
}

/* ---------------- geocoding helpers (cached, 1 req/s) ---------------- */

async function cityCoords(city, country) {
  const key = `${city}|${country}`
  if (ctx.wikiXY[key]) return ctx.wikiXY[key]
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' +
    encodeURIComponent(`${city}, ${country}`)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    const j = res.ok ? await res.json() : []
    ctx.wikiXY[key] = j[0] ? { lat: +j[0].lat, lon: +j[0].lon } : null
    await writeFile(join(CACHE, 'wiki_city_coords.json'), JSON.stringify(ctx.wikiXY))
    await sleep(1100)
  } catch { /* leave null */ }
  return ctx.wikiXY[key]
}

function continentFor(country) {
  const hit = ctx.index.systems.find((s) => s.continent && countryOk(s.country, country))
  return hit?.continent ?? null
}

/* ---------------- strategies ---------------- */

async function writeOverride(slug, city, country, rids, source) {
  await mkdir(OVERRIDES_DIR, { recursive: true })
  await writeFile(join(OVERRIDES_DIR, `${slug}.json`), JSON.stringify({
    city, country, continent: continentFor(country),
    osm_route_ids: rids, source,
    created: new Date().toISOString(),
  }, null, 2))
}

// S1: relations already in cache whose centroid sits near the city.
// Bound them to this city (override) unless they already belong to a canonical
// nearby city — then the wiki system is covered by that file (record & pass on).
async function s1BindCached(city, country, wikiRow) {
  const xy = await cityCoords(city, country)
  if (!xy) return { changed: false, note: 'no coordinates for city' }
  const near = []
  for (const [rid, c] of ctx.ridCentroid)
    if (ctx.knownRids.has(rid) && kmDist(xy.lat, xy.lon, c.lat, c.lon) < 30) near.push(rid)
  if (!near.length) return { changed: false, note: 'no cached routes within 30 km' }

  // where do those relations currently live?
  const cities = new Map()
  for (const rid of near) {
    const c = ctx.ridCity.get(rid)
    if (c) cities.set(c, (cities.get(c) ?? 0) + 1)
  }
  const canonical = [...cities.keys()].find((c) =>
    ctx.wiki.some((w) => normCity(w.city) === normCity(c)))
  if (canonical && normCity(canonical) !== normCity(city)) {
    return { changed: false, coveredBy: canonical,
      note: `routes near ${city} already belong to ${canonical}` }
  }
  const unbound = near.filter((rid) => {
    const c = ctx.ridCity.get(rid)
    return !c || !ctx.wiki.some((w) => normCity(w.city) === normCity(c))
  })
  if (!unbound.length) return { changed: false, note: 'all nearby routes already canonical' }
  await writeOverride(slugify(`${country}-${city}`), city, country, unbound,
    `auditLoop S1 bind-cached (${wikiRow?.name ?? city})`)
  return { changed: true, note: `bound ${unbound.length} cached relations` }
}

// S2/S3/S4: targeted Overpass fetch around the city.
// modeRegex defaults to the global scope (subway|light_rail); S4 passes
// 'monorail' for Wikipedia-baseline cities whose metro is a monorail in OSM
// (e.g. Wuhu) — the only sanctioned widening, per-city and baseline-only.
async function targetedFetch(city, country, wikiRow, radiusKm, gate, modeRegex = 'subway|light_rail') {
  const xy = await cityCoords(city, country)
  if (!xy) return { changed: false, note: 'no coordinates for city' }
  const slug = slugify(`${country}-${city}`)
  const around = `(around:${radiusKm * 1000},${xy.lat},${xy.lon})`
  const modes = `["route"~"^(${modeRegex})$"]`

  const tagQ = `[out:json][timeout:120];relation${modes}${LIFE}${around};out tags;`
  const tags = await overpass.query(tagQ,
    { cacheName: `gap_probe_${slug}_r${radiusKm}_${modeRegex.replace(/[^a-z]/g, '')}.json`,
      timeout: 120000, maxAttempts: 4 })
    .catch(() => null)
  if (!tags) return { changed: false, note: `overpass probe failed (r=${radiusKm}km)` }

  const nameTok = tokens(`${wikiRow?.name ?? ''} ${city}`)
  const rels = tags.elements.filter((e) => e.type === 'relation').filter((e) => {
    if (gate === 'none') return true
    const t = e.tags || {}
    return shareToken(nameTok,
      tokens(`${t.name ?? ''} ${t['name:en'] ?? ''} ${t.network ?? ''} ${t['network:en'] ?? ''} ${t.operator ?? ''}`))
  })
  const fresh = rels.filter((e) => !ctx.knownRids.has(e.id))
  const unboundCached = rels.filter((e) => {
    if (!ctx.knownRids.has(e.id)) return false
    const c = ctx.ridCity.get(e.id)
    return !c || !ctx.wiki.some((w) => normCity(w.city) === normCity(c))
  })
  if (!rels.length) return { changed: false, note: `no matching relations within ${radiusKm} km` }

  if (fresh.length) {
    await writeFile(join(CACHE, `gap_routes_${slug}.json`),
      JSON.stringify({ elements: fresh }))
    const ids = fresh.map((e) => e.id)
    const geomQ = `[out:json][timeout:180];relation(id:${ids.join(',')})->.r;` +
      '.r out body;node(r.r);out skel qt;'
    const geom = await overpass.query(geomQ,
      { cacheName: `gap_geom_${slug}.json`, timeout: 180000, maxAttempts: 4 })
      .catch(() => null)
    if (!geom) return { changed: false, note: 'geometry fetch failed' }
    // register centroids for future S1 runs
    const nodeXY = new Map()
    for (const e of geom.elements || [])
      if (e.type === 'node' && e.lat != null) nodeXY.set(e.id, [e.lon, e.lat])
    for (const e of geom.elements || []) {
      if (e.type !== 'relation') continue
      let sx = 0, sy = 0, n = 0
      for (const m of e.members || []) {
        if (m.type !== 'node') continue
        const c = m.lat != null ? [m.lon, m.lat] : nodeXY.get(m.ref)
        if (c) { sx += c[0]; sy += c[1]; n++ }
      }
      if (n) ctx.ridCentroid.set(e.id, { lon: sx / n, lat: sy / n })
      ctx.knownRids.add(e.id)
    }

    // stations for the new lines (same mode flavours as the route query)
    const stFlavor = `subway|light_rail${modeRegex.includes('monorail') ? '|monorail' : ''}`
    const stQ = `[out:json][timeout:120];(` +
      `node["station"~"^(${stFlavor})$"]${LIFE}${around};` +
      `node["railway"="station"]["subway"="yes"]${LIFE}${around};` +
      `node["railway"="station"]["light_rail"="yes"]${LIFE}${around};` +
      `way["station"~"^(${stFlavor})$"]${LIFE}${around};` +
      ');out center;'
    const st = await overpass.query(stQ,
      { cacheName: `gap_stations_${slug}.json`, timeout: 120000, maxAttempts: 4 })
      .catch(() => null)
    await sleep(1000)
    void st
  }

  const bindIds = [...new Set([...fresh.map((e) => e.id), ...unboundCached.map((e) => e.id)])]
  if (!bindIds.length) return { changed: false, note: 'relations found but all already canonical' }
  await writeOverride(slug, city, country, bindIds,
    `auditLoop targeted-fetch r=${radiusKm}km (${wikiRow?.name ?? city})`)
  return { changed: true, note: `${fresh.length} new + ${unboundCached.length} rebound relations` }
}

// Z1: fetch stations around an existing system that audits with too few.
async function z1Stations(city, country, sysFile) {
  const g = await readJSON(join(BASE, sysFile), null)
  if (!g) return { changed: false, note: 'system file unreadable' }
  let sx = 0, sy = 0, n = 0, maxKm = 0
  const pts = []
  for (const f of g.features) {
    if (f.geometry.type === 'Point') { pts.push(f.geometry.coordinates) }
    else for (const seg of f.geometry.coordinates) for (const c of seg) pts.push(c)
  }
  for (const [lon, lat] of pts) { sx += lon; sy += lat; n++ }
  if (!n) return { changed: false, note: 'no geometry' }
  const clat = sy / n, clon = sx / n
  for (const [lon, lat] of pts) maxKm = Math.max(maxKm, kmDist(clat, clon, lat, lon))
  const r = Math.min(60, Math.ceil(maxKm + 8))
  const slug = slugify(`${country}-${city}`)
  const around = `(around:${r * 1000},${clat},${clon})`
  const stQ = `[out:json][timeout:120];(` +
    `node["station"~"^(subway|light_rail)$"]${LIFE}${around};` +
    `node["railway"="station"]["subway"="yes"]${LIFE}${around};` +
    `node["railway"="station"]["light_rail"="yes"]${LIFE}${around};` +
    `way["station"~"^(subway|light_rail)$"]${LIFE}${around};` +
    ');out center;'
  const st = await overpass.query(stQ,
    { cacheName: `gap_stations_${slug}.json`, timeout: 120000, maxAttempts: 4 })
    .catch(() => null)
  await sleep(1000)
  if (!st?.elements?.length) return { changed: false, note: `no stations within ${r} km` }
  return { changed: true, note: `${st.elements.length} station candidates fetched (r=${r}km)` }
}

// Z2: derive stations from the system's own named stop_position nodes.
async function z2DeriveStops(city, country, sysFile) {
  const g = await readJSON(join(BASE, sysFile), null)
  if (!g) return { changed: false, note: 'system file unreadable' }
  const rids = new Set()
  for (const f of g.features)
    for (const rid of f.properties.osm_route_ids || []) rids.add(rid)
  // member node ids + coords from geometry cache
  const nodeIds = new Map() // id -> [lon,lat]
  const files = (await readdir(CACHE)).filter((n) =>
    /^(geom_.+|gap_geom_.+)\.json$/.test(n) && !n.endsWith('.partial'))
  for (const f of files) {
    const d = await readJSON(join(CACHE, f), {})
    const nodeXY = new Map()
    for (const e of d.elements || [])
      if (e.type === 'node' && e.lat != null) nodeXY.set(e.id, [e.lon, e.lat])
    for (const e of d.elements || []) {
      if (e.type !== 'relation' || !rids.has(e.id)) continue
      for (const m of e.members || []) {
        if (m.type !== 'node') continue
        const c = m.lat != null ? [m.lon, m.lat] : nodeXY.get(m.ref)
        if (c) nodeIds.set(m.ref, c)
      }
    }
  }
  if (!nodeIds.size) return { changed: false, note: 'no member nodes in cache' }

  const ids = [...nodeIds.keys()]
  const slug = slugify(`${country}-${city}`)
  const derived = []
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400)
    const q = `[out:json][timeout:120];node(id:${chunk.join(',')});out tags;`
    const d = await overpass.query(q,
      { cacheName: `gap_stoptags_${slug}_${i / 400}.json`, timeout: 120000, maxAttempts: 4 })
      .catch(() => null)
    if (!d) continue
    for (const e of d.elements || []) {
      const t = e.tags || {}
      const name = t['name:en'] || t.name
      if (!name) continue
      const c = nodeIds.get(e.id)
      if (!c) continue
      derived.push({
        type: 'node', id: e.id, lon: c[0], lat: c[1],
        tags: { name: t.name, 'name:en': t['name:en'], station: 'light_rail',
          network: t.network, operator: t.operator, derived_from: 'stop_position' },
      })
    }
    await sleep(1000)
  }
  if (!derived.length) return { changed: false, note: 'no named stop nodes' }
  await writeFile(join(CACHE, `gap_stations_${slug}_derived.json`),
    JSON.stringify({ elements: derived }))
  return { changed: true, note: `${derived.length} stations derived from stop nodes` }
}

// Z0: a stray non-baseline 0-station bucket near a canonical city merges into it.
async function z0MergeNeighbor(sys) {
  const g = await readJSON(join(BASE, sys.file), null)
  if (!g) return { changed: false, note: 'system file unreadable' }
  let sx = 0, sy = 0, n = 0
  const rids = new Set()
  for (const f of g.features) {
    for (const rid of f.properties.osm_route_ids || []) rids.add(rid)
    if (f.geometry.type !== 'Point')
      for (const seg of f.geometry.coordinates) for (const [lon, lat] of seg) {
        sx += lon; sy += lat; n++
      }
  }
  if (!n || !rids.size) return { changed: false, note: 'no line geometry' }
  const clat = sy / n, clon = sx / n
  let best = null, bestKm = Infinity
  for (const w of ctx.wiki) {
    if (!countryOk(w.country, sys.country)) continue
    if (normCity(w.city) === normCity(sys.city)) continue
    const xy = ctx.wikiXY[`${w.city}|${w.country}`]
    if (!xy) continue
    const km = kmDist(clat, clon, xy.lat, xy.lon)
    if (km < bestKm) { bestKm = km; best = w }
  }
  if (!best || bestKm > 25) return { changed: false, note: 'no canonical neighbour within 25 km' }
  await writeOverride(slugify(`${best.country}-${best.city}-merge-${sys.city}`),
    best.city, best.country, [...rids],
    `auditLoop Z0 merge ${sys.city} into ${best.city} (${bestKm.toFixed(1)} km)`)
  return { changed: true, note: `merged into ${best.city} (${bestKm.toFixed(1)} km)` }
}

/* ---------------- per-city driver ---------------- */

async function processCity(city, country, wikiRow) {
  const key = `${city}|${country}`
  const st = ctx.state[key] ?? { strategies_tried: [] }
  ctx.state[key] = st

  let verdict = await audit(city, country, wikiRow)
  let guard = 0
  while (!verdict.passed && guard++ < 6) {
    const sys = findSystem(city, country)
    const failedIds = new Set(verdict.checks.filter((c) => !c.ok).map((c) => c.id))
    // choose next untried strategy for this failure shape
    let strategy = null
    if (!sys) {
      // S4 (monorail) only for Wikipedia-baseline cities — see metro-audit skill
      const ladder = wikiRow ? ['S1', 'S2', 'S3', 'S4'] : ['S1', 'S2', 'S3']
      strategy = ladder.find((s) => !st.strategies_tried.includes(s))
    } else if (failedIds.has('has_stations') || failedIds.has('line_wiki_stations')) {
      if (!wikiRow && sys.station_count === 0 && !st.strategies_tried.includes('Z0'))
        strategy = 'Z0'
      else strategy = ['Z1', 'Z2'].find((s) => !st.strategies_tried.includes(s))
    }
    if (!strategy) break

    st.strategies_tried.push(strategy)
    let res
    if (strategy === 'S1') res = await s1BindCached(city, country, wikiRow)
    else if (strategy === 'S2') res = await targetedFetch(city, country, wikiRow, 40, 'token')
    else if (strategy === 'S3') res = await targetedFetch(city, country, wikiRow, 80, 'token')
    else if (strategy === 'S4') res = await targetedFetch(city, country, wikiRow, 40, 'token', 'monorail')
    else if (strategy === 'Z0') res = await z0MergeNeighbor(sys)
    else if (strategy === 'Z1') res = await z1Stations(city, country, verdict.system_file ?? sys.file)
    else if (strategy === 'Z2') res = await z2DeriveStops(city, country, verdict.system_file ?? sys.file)

    console.log(`    ${strategy}: ${res.note}`)
    st.notes = st.notes ?? {}
    st.notes[strategy] = res.note
    if (res.coveredBy) {
      st.covered_by = res.coveredBy
      verdict = { passed: true, checks: verdict.checks,
        reasons: [`由 ${res.coveredBy} 系統檔涵蓋（同都會區，OSM 未區分）`] }
      // also note it on the covering system
      const cover = ctx.index.systems.find((s) => normCity(s.city) === normCity(res.coveredBy))
      if (cover) {
        const ck = `${cover.city}|${cover.country}`
        ctx.state[ck] = ctx.state[ck] ?? { strategies_tried: [] }
        ctx.state[ck].covers = [...new Set([...(ctx.state[ck].covers ?? []),
          wikiRow?.name ?? city])]
      }
      break
    }
    if (res.changed) {
      rebuild()
      await reloadIndex()
      verdict = await audit(city, country, wikiRow)
    }
  }

  st.passed = verdict.passed
  st.checks = verdict.checks
  st.reasons = verdict.passed ? (st.covered_by ? verdict.reasons : []) : verdict.reasons
  st.warnings = verdict.warnings ?? []
  st.audited_at = new Date().toISOString()
  // also record under the system's own index strings (may differ from the wiki
  // wording — "Czechia" vs "Czech Republic") so the build-time embed finds it
  const sysNow = findSystem(city, country)
  if (sysNow) {
    const indexKey = `${sysNow.city}|${sysNow.country}`
    if (indexKey !== key) ctx.state[indexKey] = st
  }
  await saveState()
  return verdict
}

/* ---------------- main ---------------- */

async function main() {
  const t0 = Date.now()
  await loadStatic()
  await reloadIndex()
  if (!ctx.index) { rebuild(); await reloadIndex() }

  // audit queue: every Wikipedia-baseline city first, then extra OSM systems
  const seen = new Set()
  const queue = []
  for (const w of ctx.wiki) {
    const k = `${w.city}|${w.country}`
    if (seen.has(k)) continue
    seen.add(k)
    queue.push({ city: w.city, country: w.country, wikiRow: w })
  }
  for (const s of ctx.index.systems) {
    if (!s.city || !s.country) continue
    const matched = queue.some((q) =>
      normCity(q.city) === normCity(s.city) && countryOk(q.country, s.country))
    if (matched) continue
    const k = `${s.city}|${s.country}`
    if (seen.has(k)) continue
    seen.add(k)
    queue.push({ city: s.city, country: s.country, wikiRow: null })
  }

  console.log(`Auditing ${queue.length} cities (${ctx.wiki.length} baseline + extras)\n`)
  let pass = 0, fail = 0
  for (let i = 0; i < queue.length; i++) {
    const { city, country, wikiRow } = queue[i]
    const prev = ctx.state[`${city}|${country}`]
    // skip cities that already passed and exhausted nothing new
    if (prev?.passed && prev.checks) { pass++; continue }
    console.log(`[${i + 1}/${queue.length}] ${city}, ${country}` +
      (wikiRow ? ` (${wikiRow.name})` : ' (extra system)'))
    const verdict = await processCity(city, country, wikiRow)
    if (verdict.passed) { pass++; console.log('    ✅ PASS') }
    else { fail++; console.log(`    ❌ FAIL: ${verdict.reasons.join('; ')}`) }
  }

  // final rebuild embeds the latest audit verdicts into the outputs
  rebuild()
  await reloadIndex()

  const failed = Object.entries(ctx.state).filter(([, v]) => !v.passed)
  console.log(`\nDONE in ${((Date.now() - t0) / 60000).toFixed(1)} min — ` +
    `${pass} passed, ${fail} failed of ${queue.length} cities`)
  if (failed.length) {
    console.log('\nStill failing:')
    for (const [k, v] of failed)
      console.log(`  ${k}: ${v.reasons?.join('; ') ?? '?'}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
