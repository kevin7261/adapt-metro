// Assemble OSM subway cache into GeoJSON: per-system files + global layers.
//   stations: station_id, station_name (+ network/city/country/lines,
//             station_role = interchange|terminus|normal)
//   lines:    route_id, route_name, route_color, route_ref (+ network/city/country)
// Line geometry connects each route's stops in member order (schematic), not
// the real track ways. Operational elements only (no construction/proposed).
// Run fetchMetro.mjs first. Outputs under data/metro/.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { continentCode, iocCode } from './countryCodes.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '..', 'data', 'metro')
const CACHE = join(BASE, '_cache')
const SYS_DIR = join(BASE, 'systems')
const OVERRIDES_DIR = join(BASE, '_overrides')

// City-binding overrides: data/metro/_overrides/*.json, each
//   { city, country, continent, osm_route_ids: [..], source?, note? }
// A route relation listed here is bucketed into that city, no questions asked.
// Written by scripts/auditLoop.mjs (machine) or by hand (human) — same format.
async function readOverrides() {
  const byRid = new Map()
  let files = []
  try { files = (await readdir(OVERRIDES_DIR)).filter((n) => n.endsWith('.json')) }
  catch { return byRid }
  for (const f of files) {
    try {
      const ov = JSON.parse(await readFile(join(OVERRIDES_DIR, f), 'utf8'))
      if (!ov.city || !Array.isArray(ov.osm_route_ids)) continue
      for (const rid of ov.osm_route_ids) if (!byRid.has(rid)) byRid.set(rid, ov)
    } catch (e) { console.log(`  !! bad override ${f}: ${e.message}`) }
  }
  return byRid
}

// 未通車例外（使用者裁決：只畫有通車的，但台北例外納入 桃捷綠線/萬大線/汐東線）。
// 抓取端 scripts/fetchUcExceptions.mjs 已正規化 lifecycle tags；這裡只需知道哪些
// relation 是例外，好在路線 meta 標 status=under_construction。
async function readUcRids() {
  try {
    const conf = JSON.parse(await readFile(join(OVERRIDES_DIR, 'uc_exceptions.json'), 'utf8'))
    return new Set((conf.exceptions ?? []).filter((x) => x.enabled).map((x) => x.relation))
  } catch { return new Set() }
}

// Per-city audit verdicts (written by scripts/auditLoop.mjs) — embedded into
// each system's metro_system.audit so the UI can show pass/fail + reasons.
async function readAuditState() {
  try { return JSON.parse(await readFile(join(CACHE, 'audit_state.json'), 'utf8')) }
  catch { return {} }
}

// --- station-order sanity (per route, computed BEFORE segmentization; the
// verdict travels on the route meta as `order_suspect`) ---
const ORDER_RATIO = 1.6
const segD = (a, b) => {
  const dx = (a[0] - b[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180)
  return Math.sqrt(dx * dx + (a[1] - b[1]) ** 2)
}
const pathLen = (pts) => {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += segD(pts[i - 1], pts[i])
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
    for (let i = 0; i < pts.length; i++) if (!used[i]) d[i] = Math.min(d[i], segD(pts[u], pts[i]))
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

const CSS_COLORS = {
  red: '#e6194b', blue: '#0000ff', green: '#3cb44b', yellow: '#ffe119',
  orange: '#f58231', purple: '#911eb4', cyan: '#42d4f4', magenta: '#f032e6',
  lime: '#bfef45', pink: '#fabed4', teal: '#469990', lavender: '#dcbeff',
  brown: '#9a6324', beige: '#fffac8', maroon: '#800000', navy: '#000080',
  grey: '#808080', gray: '#808080', black: '#000000', white: '#ffffff',
  silver: '#c0c0c0', gold: '#ffd700', violet: '#ee82ee', indigo: '#4b0082',
  // CSS 具名色的其餘常見值（aqua≡cyan、fuchsia≡magenta）——Pune Aqua Line 標 "aqua"
  aqua: '#42d4f4', fuchsia: '#f032e6', olive: '#808000', turquoise: '#40e0d0',
}

function normColor(c) {
  if (!c) return null
  c = c.trim()
  const low = c.toLowerCase()
  if (CSS_COLORS[low]) return CSS_COLORS[low]
  let m = /^#?([0-9a-fA-F]{6})$/.exec(c)
  if (m) return '#' + m[1].toLowerCase()
  m = /^#?([0-9a-fA-F]{3})$/.exec(c)
  if (m) return '#' + [...m[1].toLowerCase()].map((ch) => ch + ch).join('')
  return c
}

const pick = (tags, ...keys) => { for (const k of keys) if (tags[k]) return tags[k]; return null }

// 顯示名的語言（站名／線名，使用者指定各地用當地語言）：預設英文優先（name:en → name）。
//  · 日本 → 日文（name:ja → name；OSM 日本 name 本就是日文，name:en=Shinjuku）。
//  · 台灣 → 繁體中文（name:zh-Hant → name:zh → name；台灣 name=繁中 竿蓁林）。
//  · 中國（含香港）→ name:zh。**香港 name:zh=繁中（炮台山，避開 name 的「炮台山 Fortress Hill」
//    雙語），中國大陸 name:zh=简体（枣营）**——同一鍵各地自動給正確繁/簡。
const nameFor = (t, country) => {
  const c = (country || '').replace(/[^a-zA-Z]/g, '').toLowerCase()
  if (c === 'japan') return pick(t, 'name:ja', 'name', 'name:en')
  if (c === 'taiwan') return pick(t, 'name:zh-Hant', 'name:zh', 'name', 'name:en')
  if (c === 'china') return pick(t, 'name:zh', 'name', 'name:en')
  return pick(t, 'name:en', 'name')
}

// 路線顯示名清理（全球通用）：路線是**雙向**（去回程已併成一條），名字帶「方向/終點站」
// 尾綴會誤導成兩個方向兩條線（如機捷 name:zh「(西向)/(東向)」）。去掉：「: A → B」「→ B」
// 「to B」「(西向)/(東向)/(上行)/(下行)/(順行)/(逆行)/(內/外環)/(往X)/(inbound)…」等尾綴。
const cleanRouteName = (nm) => {
  if (!nm) return nm
  const s = String(nm)
    .replace(/\s*[:：]\s*[^:：]*?(?:→|->|-->|=>|↔|⇄)\s*.+$/u, '')
    .replace(/\s*(?:→|->|-->|=>|↔|⇄)\s*\S.*$/u, '')
    .replace(/\s+to\s+.+$/i, '')
    .replace(/\s*[（(](?:西向|東向|东向|西行|東行|东行|南行|北行|上行|下行|順行|顺行|順向|逆行|逆向|順|逆|上り|下り|上|下|内|外|內|外環|外环|內環|内环|往[^)）]*|[NSEW]B|inbound|outbound|clockwise|anti[- ]?clockwise|for [^)）]+|to [^)）]+)[)）]\s*$/iu, '')
    // 括號內「分支名＋方向詞」（如「(蘆洲逆向)」）：只去方向詞、留分支名 →「(蘆洲)」
    .replace(/([（(][^)）]*?)(?:西向|東向|东向|西行|東行|东行|南行|北行|上行|下行|順行|顺行|順向|逆行|逆向)+([)）])/gu, '$1$2')
    .replace(/\s*[（(]\s*[)）]\s*$/u, '') // 去空括號
    .trim()
  return s || String(nm)
}
// 快車標記（與普通車區分、非方向）——中日台港用「（快車）」，其餘「 (Express)」。
// 名字本身已含快車字樣（急行/快速/直達/Express…）則不重複加。
const EXPRESS_NAME_RE = /(express|rapid|limited|直達|直达|直通|快速|急行|準急|准急|特急|特快|大站快)/i
const expressMark = (country, name) => {
  if (EXPRESS_NAME_RE.test(name || '')) return ''
  const c = (country || '').replace(/[^a-zA-Z]/g, '').toLowerCase()
  return (c === 'japan' || c === 'taiwan' || c === 'china') ? '（快車）' : ' (Express)'
}

// Operational only: an element carrying a lifecycle tag (under construction,
// proposed, disused…) is not part of the running network. The fetch queries
// already exclude these; this re-filters older caches fetched without the guard.
const NONOP = /^(proposed|construction|planned|disused|abandoned|razed)$/
// stations sometimes mark construction only in the name — "大明北路(建设中)"
const NONOP_NAME = /[（(【[][^）)】\]]*(建設中|建设中|在建|未开通|未開通|規劃|规划|封閉改造|封闭改造|封站|停運|停运|renovation|closed|under construction|planned|u\/c)[^）)】\]]*[）)】\]]/i
const isOperational = (t = {}) =>
  !NONOP.test(t.state || '') && !NONOP.test(t.railway || '') &&
  !('construction' in t) && !('proposed' in t) && !('planned' in t) &&
  !('disused' in t) && !('abandoned' in t) &&
  !NONOP_NAME.test(t.name || '') && !NONOP_NAME.test(t['name:en'] || '')

// Through-service overlay relations (直通運転): metro trains continuing onto
// suburban railways (Tokyo Metro → Tobu/Tokyu …). They duplicate the base
// metro line and extend deep into non-metro rail, so they are not lines of
// the metro network itself — the base lines have their own relations.
const isThroughService = (t = {}) =>
  /直通運転|直通列車|直通電車/.test(`${t.name || ''} ${t['name:ja'] || ''}`) ||
  /through service|bypass line/i.test(`${t['name:en'] || ''} ${t.description || ''}`)

// 機廠/車輛段不是客運設施：出入段線 route（新北捷運淡海機廠）與 depot 停靠點
//（安坑機廠——具名 stop_position 會被當站源）一律排除。
const DEPOT_NAME = /機廠|机厂|機厰|車輛段|车辆段|\bdepot\b/i
const isDepot = (t = {}) => DEPOT_NAME.test(`${t.name || ''} ${t['name:en'] || ''}`)

// 機場航廈間接駁電車（APM／people mover，如桃園機場「旅客自動電車運輸系統」、
// 各國機場 Skytrain／Aerotrain）不是都會地鐵/輕軌——使用者指定排除（台北不抓
// 機場內輕軌）。注意：機場「快線」（Airport Express、機場捷運 A 線）是真地鐵，
// 不在此列——只擋航廈接駁電車，不擋 metro/line/express。
// 全國性鐵路基礎設施/營運公司名不代表城市——rebucket 時比照 Unknown 跳過
// （DB Station&Service AG geocode 到紐倫堡，會把卡爾斯魯厄 Stadtbahn 整桶搬進去）。
const NATIONAL_INFRA = /DB Station|DB InfraGO|\bInfraGO\b|DB Netz|DB Fernverkehr|DB Cargo|Deutsche Bahn|Indian Rail|भारतीय रेल/i

// 機場航廈接駁電車（APM／people mover／VAL）的通用詞 ＋ 各機場的專名。專名精確
// 匹配以免誤傷真地鐵（巴黎 Ligne 14 終點在 Orly 但名含「Aéroport」不含 CDGVAL）。
// 注意：不可加「skyline」——檀香山地鐵正式名就叫 Skyline，會誤剔整個系統。
const AIRPORT_APM = /旅客自動電車|自動電車運輸|航廈電車|航站.*電車|people ?mover|\bapm\b|sky\s?train|aero\s?train|air\s?train|plane ?train|shuttle tram|terminal (?:shuttle|train|tram)|\bCDGVAL\b|\bOrlyval\b/i
const isAirportApm = (t = {}) =>
  AIRPORT_APM.test(`${t.name || ''} ${t['name:en'] || ''} ${t.network || ''} ${t.operator || ''}`)

// 點到線段最近距離（度，經度以緯度餘弦校正）與投影點座標。用於浮空站貼線：
// 把不在線上的站「移動」到所屬線最近投影點——只改站座標，不動線幾何。
function projPointSeg(p, a, b) {
  const cos = Math.cos((p[1] * Math.PI) / 180)
  const dx = (b[0] - a[0]) * cos, dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? (((p[0] - a[0]) * cos * dx + (p[1] - a[1]) * dy) / l2) : 0
  t = Math.max(0, Math.min(1, t))
  const px = a[0] + t * (b[0] - a[0]), py = a[1] + t * (b[1] - a[1])
  const ex = (p[0] - px) * cos, ey = p[1] - py
  return { dist: Math.sqrt(ex * ex + ey * ey), pt: [px, py] }
}

function slugify(s) {
  if (!s) return ''
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
}

const readJSON = async (name) => JSON.parse(await readFile(join(CACHE, name), 'utf8'))

async function readGeocode() {
  try { return JSON.parse(await readFile(join(CACHE, 'geocode.json'), 'utf8')) }
  catch { return {} }
}

const STOP = new Set(['metro', 'subway', 'underground', 'u-bahn', 'the', 'of', 'rapid',
  'transit', 'railway', 'rail', 'mrt', 'system', 'line', 'lines',
  // generic transit words that must never decide a city ("S-Bahn Frankfurt"
  // token-matching "Berlin U-Bahn" via 'bahn' once sent Frankfurt to Berlin)
  'bahn', 'ubahn', 'sbahn', 'stadtbahn', 'lrt', 'light', 'tram', 'verkehrsverbund'])

function tokens(s) {
  s = (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const out = new Set()
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/))
    if (t && t.length > 1 && !STOP.has(t)) out.add(t)
  return out
}
const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n }
const union = (a, b) => new Set([...a, ...b])

function matchWiki(networkStr, cityHint, idx) {
  const nt = union(tokens(networkStr), tokens(cityHint))
  if (nt.size === 0) return null
  let best = null, bestScore = 0
  for (const row of idx) {
    let score = inter(nt, union(row.nameTok, row.cityTok))
    if (inter(nt, row.cityTok) > 0) score += 1
    if (score > bestScore) { bestScore = score; best = row.sys }
  }
  return bestScore >= 1 ? { sys: best, score: bestScore } : null
}

async function build() {
  console.log('Loading cache...')
  const cacheFiles = await readdir(CACHE)
  const routesRaw = await readJSON('routes_tags.json')
  const routesTags = new Map()
  for (const e of routesRaw.elements)
    if (e.type === 'relation' && isOperational(e.tags) && !isThroughService(e.tags) &&
        !isDepot(e.tags) && !isAirportApm(e.tags))
      routesTags.set(e.id, e.tags || {})
  // gap supplements: extra route relations fetched per-city by auditLoop.mjs
  // （或 refreshRelations.mjs 的定向刷新）——gap 比主快取新，一律覆蓋（後載者勝）
  for (const f of cacheFiles.filter((n) => /^gap_routes_.+\.json$/.test(n))) {
    const d = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    for (const e of d.elements || [])
      if (e.type === 'relation' && isOperational(e.tags) && !isThroughService(e.tags) &&
          !isDepot(e.tags))
        routesTags.set(e.id, e.tags || {})
  }
  // 個別 relation 缺標籤補丁（_overrides/route_tag_patches.json）：少數 OSM route
  // relation 本身缺 colour／ref（如巴拿馬機場支線 Ramal línea 2 relation 15624911
  // 完全沒有 colour/ref 標籤），既非 route_master 成員也無 ref 可分組，會自成一條
  // 沒有顏色的獨立線、退回預設色，視覺上像是抓錯顏色。這裡補回 wiki/官方來源查得
  // 的正確標籤（通常是 ref，讓既有的「同 network+ref 分組」機制自然把它併成該線的
  // 分支，顏色隨之從代表變體繼承）；上游補齊標籤後應移除對應條目。
  let routePatches = []
  try {
    routePatches = JSON.parse(
      await readFile(join(OVERRIDES_DIR, 'route_tag_patches.json'), 'utf8')).patches ?? []
  } catch { /* no route_tag_patches override */ }
  for (const p of routePatches) {
    const t = routesTags.get(p.relation)
    if (!t) continue // may be a route_master id — patched after masters load
    Object.assign(t, p.set)
    console.log(`  route_tag_patches: r${p.relation} ← ${JSON.stringify(p.set)}`)
  }

  // 整條線剔除（_overrides/route_excludes.json）：OSM 誤標未通車/建設中的線為營運中
  // route=subway（通過 isOperational），違反 operational-only 不變式。把這些 relation id
  // 從 routesTags 移除；連帶車站失去線路歸屬由後面的 orphan-drop 清掉（如 Kocaeli/Gebze
  // M1/Körfezray 皆建設中→整個 Derince 系統消失）。
  try {
    const excl = new Set(JSON.parse(
      await readFile(join(OVERRIDES_DIR, 'route_excludes.json'), 'utf8')).exclude ?? [])
    let n = 0
    for (const rid of excl) if (routesTags.delete(rid)) n++
    if (n) console.log(`  route_excludes: dropped ${n} under-construction/out-of-scope routes`)
  } catch { /* no route_excludes override */ }

  // NYC 服務時段變體收斂：OSM 把每條線拆成 daytime／(late nights)／(am/pm rush)… 多個
  // 變體，(late nights) 常是「各停」全停版（4 號 daytime express 28 站 vs late-night 54 站）。
  // 「最長變體勝＋站聯集」規則會讓快車吃下所有 local 站、畫成各停。對**有 daytime 基本
  // 變體**的 ref，丟掉服務時段限定變體，只留 daytime express 站型——跳過的 local 站由既有
  // pass-through auto 偵測畫成共線（AEL/TCL 式）。<6>/<7>/<F>/Z 等「只有尖峰變體、無 base」
  // 的 ref 保留不動（否則整條線消失）。僅限 network=NYC Subway。
  {
    const QUAL = /\((?:late nights?|am rush|pm rush|rush hours?|evenings?|weekends?|weekday|middays?)\b/i
    const isNyc = (t) => t.network === 'NYC Subway' || t['network:en'] === 'NYC Subway'
    const baseRefs = new Set()
    for (const t of routesTags.values())
      if (isNyc(t) && t.ref && !QUAL.test(t.name || '')) baseRefs.add(t.ref)
    let dropped = 0
    for (const [rid, t] of [...routesTags])
      if (isNyc(t) && t.ref && baseRefs.has(t.ref) && QUAL.test(t.name || '')) {
        routesTags.delete(rid); dropped++
      }
    if (dropped) console.log(`  NYC variant prune: dropped ${dropped} late-night/rush variants (kept daytime express pattern)`)
  }

  const ovByRid = await readOverrides()
  const ucRids = await readUcRids()

  const mastersRaw = await readJSON('route_masters.json')
  const masterOf = new Map(), masterTags = new Map()
  for (const e of mastersRaw.elements) {
    if (e.type !== 'relation') continue
    masterTags.set(e.id, e.tags || {})
    for (const m of e.members || []) if (m.type === 'relation') masterOf.set(m.ref, e.id)
  }
  // route_tag_patches whose target is a route_master (master colour/ref overrides
  // the variant tags, so patching only the route relations wasn't enough——Bursaray
  // B2 master r7869622 carries colour=black). Apply to masterTags now.
  for (const p of routePatches) {
    const mt = masterTags.get(p.relation)
    if (!mt) continue
    Object.assign(mt, p.set)
    console.log(`  route_tag_patches (master): r${p.relation} ← ${JSON.stringify(p.set)}`)
  }

  // geom_* cache: relations with ordered member lists + coordinates for member
  // nodes. New caches ship node coords as separate skel elements; old `out geom`
  // caches carried lat/lon inline on each node member — support both.
  const geom = new Map(), memberXY = new Map()
  // 主快取（geom_*）先載、gap_geom_* 後載——gap 是定向補抓/刷新（較新），
  // 同 id 時「後載者勝」讓刷新資料覆蓋舊快取（如 CCL 環線閉合新增停靠成員）
  const geomFiles = cacheFiles.filter((n) =>
    /^(geom_.+|gap_geom_.+)\.json$/.test(n) && !n.endsWith('.partial'))
    .sort((a, b) => (a.startsWith('gap_') ? 1 : 0) - (b.startsWith('gap_') ? 1 : 0))
  for (const f of geomFiles) {
    const d = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    for (const e of d.elements || []) {
      if (e.type === 'relation') geom.set(e.id, e)
      else if (e.type === 'node' && e.lat != null) memberXY.set(e.id, [e.lon, e.lat])
    }
  }

  // 人工站序補正（_overrides/member_appends.json）：wiki 已裁決通車、但 OSM route
  // relation 上游未更新成員時，宣告式補在成員序尾端（例：新加坡環狀線 CCL6 閉合段）。
  try {
    const ma = JSON.parse(await readFile(join(OVERRIDES_DIR, 'member_appends.json'), 'utf8'))
    for (const fix of ma.appends ?? []) {
      const el = geom.get(fix.relation)
      if (!el) { console.log(`  !! member_appends: r${fix.relation} not in geom cache`); continue }
      el.members ??= []
      // 前置（上游成員只涵蓋路線一段時補前段，如蘇州7號線南段）
      if (fix.prepend_stops?.length)
        el.members.unshift(...fix.prepend_stops.map((nid) => ({ type: 'node', ref: nid, role: 'stop' })))
      for (const nid of fix.append_stops ?? [])
        el.members.push({ type: 'node', ref: nid, role: 'stop' })
      // 中途插站（上游漏掉的營運中間站，如成都 L10 高升桥）
      for (const ins of fix.inserts ?? []) {
        const i = el.members.findIndex((m) => m.type === 'node' && m.ref === ins.after)
        if (i < 0) { console.log(`  !! member_appends: r${fix.relation} anchor ${ins.after} not found`); continue }
        el.members.splice(i + 1, 0,
          ...ins.add.map((nid) => ({ type: 'node', ref: nid, role: 'stop' })))
      }
      if (fix.close_loop) {
        const first = el.members.find((m) => m.type === 'node' && (m.role || '').includes('stop'))
        if (first) el.members.push({ ...first })
      }
      console.log(`  member_appends: r${fix.relation} +${(fix.append_stops ?? []).length} stops` +
        `${(fix.inserts ?? []).length ? ` +${fix.inserts.length} inserts` : ''}` +
        (fix.close_loop ? ' (loop closed)' : ''))
    }
  } catch { /* no member_appends override */ }

  // 快車跨站共線（_overrides/express_passthrough.json）：快車 route 的某段幾何沿慢車的
  // 中間站畫（pass-through 頂點），使共線段被判為共線畫成雙色，但中間站不算快車停靠站。
  let expressPass = []
  const noAutoPassRids = new Set()  // route osm ids excluded from AUTO express pass-through
  try {
    const epFile = JSON.parse(await readFile(join(OVERRIDES_DIR, 'express_passthrough.json'), 'utf8'))
    expressPass = epFile.passthrough ?? []
    for (const e of epFile.no_auto ?? []) for (const r of e.route_osm ?? []) noAutoPassRids.add(r)
  } catch { /* none */ }
  // 容差 ~0.003°（≈300 m）：序列頂點是月台座標、與站座標差 ~100–200 m；快車跨站的
  // from/to 站相距數 km，放寬不會誤配。注入後 snap 會把頂點對齊共站合併點。
  const coordNear = (a, b) => Math.abs(a[0] - b[0]) < 3e-3 && Math.abs(a[1] - b[1]) < 3e-3

  const stRaw = await readJSON('stations.json')
  // 墓碑：上游已刪除的節點（scripts/pruneDeletedStations.mjs 驗證）——快取殭屍
  // 會被頂點吸附撿走變成多出來的站（香港 KTL 舊 stop_position 案例），拒收。
  let tombstones = new Set()
  try {
    tombstones = new Set((JSON.parse(await readFile(join(CACHE, 'deleted_nodes.json'), 'utf8'))
      .deleted ?? []))
  } catch { /* no tombstones */ }
  // wiki 裁決「非營運中」站點（_overrides/station_excludes.json：預留未開通/
  // 封站改造/停運施工——OSM 標營運但 wiki 證實沒有）。單靠 id 剔不乾淨——
  // 同名兄弟節點（雙向 stop_position）會遞補成代表點，故以「名稱＋座標半徑
  // ~3 km」匹配整個同名簇拒收。
  let stationExcludes = []
  try {
    stationExcludes = (JSON.parse(await readFile(
      join(OVERRIDES_DIR, 'station_excludes.json'), 'utf8')).excludes ?? [])
      .filter((e) => e.lon != null && Array.isArray(e.names))
  } catch { /* none */ }
  const isExcluded = (e, lon, lat) => {
    // 精確比對名稱欄位（substring 會誤殺「龙泉驿火车站」之類的同前綴站）
    const nms = [e.tags?.name, e.tags?.['name:en'], e.tags?.['name:zh']]
      .filter(Boolean).map((s) => s.trim())
    if (!nms.length) return false
    for (const x of stationExcludes) {
      if (Math.abs(lon - x.lon) > 0.04 || Math.abs(lat - x.lat) > 0.03) continue
      if (x.names.some((n) => nms.includes(n))) return true
    }
    return false
  }
  // 人工站名補正（_overrides/station_names.json）：上游無名、但 wiki 可查得名稱的
  // 站點——agent/人工逐站核對 wiki 後落地（站名 100% 不變式的裁決出口）。
  let nameOverrides = {}
  try {
    nameOverrides = JSON.parse(
      await readFile(join(OVERRIDES_DIR, 'station_names.json'), 'utf8')).names ?? {}
  } catch { /* none */ }
  const stations = []
  const seenStation = new Set()
  const pushStation = (e) => {
    if (!isOperational(e.tags) || isDepot(e.tags) || isAirportApm(e.tags)) return
    const ov = nameOverrides[`n${e.id}`] ?? nameOverrides[String(e.id)]
    // 墓碑判準是「上游還在且還有名字」——被 station_names 人工補名的站
    // 本來就是「存在但無名」，不得被墓碑誤殺（人工裁決優先）
    if (e.type === 'node' && tombstones.has(e.id) && !ov) return
    // station_names.json 是站名的權威裁決出口——**覆寫**既有名（不只補無名）：
    // 上游把同一站拆成多個異名節點時（雪梨 Central 的 Platform 26/27、Chalmers
    // Street），統一改成同名 → 同名近距合併成一站。
    if (ov) e.tags = { ...(e.tags || {}), name: ov }
    let lon, lat
    if (e.type === 'node') { lon = e.lon; lat = e.lat }
    else { lon = e.center?.lon; lat = e.center?.lat }
    if (lon == null || lat == null) return
    if (isExcluded(e, lon, lat)) return
    const key = `${e.type}/${e.id}`
    if (seenStation.has(key)) return
    seenStation.add(key)
    stations.push({ id: e.id, lon, lat, tags: e.tags || {} })
  }
  // 站點以「先到先贏」去重——gap（定向補抓/刷新，較新）先載，
  // 免得 stations.json 的舊 tags 壓過刷新後的新 tags
  for (const f of cacheFiles.filter((n) => /^gap_stations_.+\.json$/.test(n))) {
    const d = JSON.parse(await readFile(join(CACHE, f), 'utf8'))
    for (const e of d.elements || []) pushStation(e)
  }
  for (const e of stRaw.elements) pushStation(e)

  const wikiSystems = await readJSON('wiki_metro_systems.json')
  const wikiIdx = wikiSystems.map((s) => ({
    sys: s, nameTok: tokens(s.name), cityTok: tokens(s.city),
  }))
  const geocode = await readGeocode()
  // country -> continent, learned from the geocoded systems (used to place
  // coordinate-resolved Unknown-network lines under the right continent dir)
  const countryContinent = new Map()
  for (const g of Object.values(geocode))
    if (g?.country && g?.continent && !countryContinent.has(g.country))
      countryContinent.set(g.country, g.continent)
  let wikiXY = {}
  try { wikiXY = JSON.parse(await readFile(join(CACHE, 'wiki_city_coords.json'), 'utf8')) }
  catch { /* optional; rebucket-by-distance is skipped without it */ }
  // Resolve continent/country/city for a network: prefer reverse-geocode
  // (coordinate-truthful), fall back to the Wikipedia name match.
  // Known country-name variants (reverse-geocode vs Wikipedia wording).
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
  const normCity = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '')
  // word-boundary form: " xiancun subdistrict " must NOT match "Xi'an",
  // while " suzhou industrial park " must match "Suzhou"
  const cityWords = (s) => {
    const w = (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    return w ? ` ${w} ` : ''
  }
  const bestWikiInCountry = (network, netTag, country) => {
    const nt = union(tokens(network), tokens(netTag))
    if (!nt.size) return null
    let best = null, bestScore = 0
    for (const row of wikiIdx) {
      if (!countryOk(country, row.sys.country)) continue
      let score = inter(nt, union(row.nameTok, row.cityTok))
      if (inter(nt, row.cityTok) > 0) score += 1
      if (score > bestScore) { bestScore = score; best = row.sys }
    }
    return bestScore >= 1 ? best : null
  }
  const geoFor = (network, netTag, own) => {
    // Prefer the routes' own network key (most specific), then the display
    // network (may come from a route_master), then the local network name.
    const g = geocode[own] || geocode[network] || geocode[netTag] || {}
    // continent + country come ONLY from coordinate reverse-geocoding (authoritative).
    const continent = g.continent || null
    const country = g.country || null
    let city = g.city || null
    if (country) {
      // Pick the canonical Wikipedia city for this country, trying every
      // geocoded admin level ("Yinzhou District" alone hides "Ningbo"):
      //   1. a candidate that IS a wiki city of this country (exact),
      //   2. a candidate containing / contained by one ("Stockholm Municipality"
      //      ⊃ "Stockholm"; longest wiki name wins so "New Taipei" beats "Taipei"),
      //   3. network-name token match — same-country only, so "Taipei Metro"
      //      can't be pulled to "New Taipei".
      const candList = [...new Set([g.city, ...(g.city_candidates || [])])].filter(Boolean)
      const candsExact = candList.map(normCity)
      const candsWords = candList.map(cityWords).filter(Boolean)
      const inCountry = wikiIdx.filter((r) => countryOk(country, r.sys.country))
      const exact = inCountry.find((r) => candsExact.includes(normCity(r.sys.city)))
      const within = exact || inCountry
        .filter((r) => {
          const b = cityWords(r.sys.city)
          return b && candsWords.some((c) => c.includes(b) || b.includes(c))
        })
        .sort((a, b) => normCity(b.sys.city).length - normCity(a.sys.city).length)[0]
      if (within) city = within.sys.city
      else {
        const b = bestWikiInCountry(network, netTag, country)
        if (b) city = b.city
      }
    }
    return { continent, country, city }
  }
  console.log(`  routes=${routesTags.size} masters=${masterTags.size} ` +
    `geom=${geom.size} stations=${stations.length} geocoded=${Object.keys(geocode).length}`)

  // ---- group route relations into lines ----
  const groupKey = (rid, t) => {
    if (masterOf.has(rid)) return `m|${masterOf.get(rid)}`
    const net = pick(t, 'network:en', 'network'), ref = t.ref
    if (net && ref) return `nr|${net}|${ref}`
    return `r|${rid}`
  }
  // Line geometry = the route's stops connected in relation-member order — we
  // deliberately do NOT use track (way) geometry. Prefer stop members; routes
  // mapped without stop roles fall back to platform nodes, then plain nodes.
  const stopXY = new Map()
  const groups = new Map()
  for (const [rid, t] of routesTags) {
    const key = groupKey(rid, t)
    let g = groups.get(key)
    if (!g) { g = { key, seqs: [], rids: [], stopNodes: new Set() }; groups.set(key, g) }
    g.rids.push(rid)
    const el = geom.get(rid)
    if (!el) continue
    const stops = [], platforms = [], plain = []
    for (const m of el.members || []) {
      if (m.type !== 'node') continue
      const coord = m.lat != null ? [m.lon, m.lat] : memberXY.get(m.ref)
      if (!coord) continue
      const role = m.role || ''
      const bucket = role.includes('stop') ? stops : role.includes('platform') ? platforms : plain
      bucket.push({ ref: m.ref, coord })
    }
    let seq = [stops, platforms, plain].find((b) => b.length >= 2)
    // 混標防護：入選 bucket 之外還有 role=stop 的成員（上游 role 標註不一致——
    // 淡海藍海線 12 個成員只有臺北海洋大學標 stop、其餘空 role），會把該站
    // 從序列裡漏掉 → 依成員「原始順序」把兩桶合併重建序列。
    if (seq && seq !== stops && stops.length) {
      const keep = new Set([...seq, ...stops].map((r) => r.ref))
      seq = (el.members || [])
        .filter((m) => m.type === 'node' && keep.has(m.ref))
        .map((m) => ({ ref: m.ref, coord: m.lat != null ? [m.lon, m.lat] : memberXY.get(m.ref) }))
        .filter((r) => r.coord)
    }
    if (!seq) continue
    g.seqs.push({ rows: seq, rid })
    for (const r of seq) { g.stopNodes.add(r.ref); stopXY.set(r.ref, r.coord) }
  }

  // A line's forward/backward variants share (nearly) all stops: keep the
  // longest sequence, then only variants adding >20% unseen stops (branches).
  // Coverage is keyed by ~100 m coordinate cells, not node ids — the two
  // directions usually use different stop_position nodes at the same station.
  // 入參/回傳皆為 {rows, rid} 包裝——保留「每段變體來自哪個 relation」，
  // 好讓分支變體以自己的 relation 身分獨立成線（使用者規則：以路線自己為準）。
  // 「沒見過」用 ~250 m 鄰域判定（對向月台的 stop_position 可相距 >100 m，
  // 單格 100 m 判定會把反向變體誤判成有新站 → 反向被拆成第二條線）。
  const cellOf = (r) => [Math.round(r.coord[0] / 0.001), Math.round(r.coord[1] / 0.001)]
  const dedupeSeqs = (seqs) => {
    const sorted = [...seqs].sort((a, b) => b.rows.length - a.rows.length)
    const covered = new Set(), kept = []
    const expressCovered = new Set() // 已保留快車的站格（±2 容差用來丟去回程的反向重複）
    const near = (r) => {
      const [cx, cy] = cellOf(r)
      for (let dx = -2; dx <= 2; dx++)
        for (let dy = -2; dy <= 2; dy++)
          if (covered.has(`${cx + dx}:${cy + dy}`)) return true
      return false
    }
    for (const w of sorted) {
      const fresh = w.rows.filter((r) => !near(r)).length
      // Keep any variant bringing ≥1 unseen station (short branches like
      // 小碧潭支線 add just 1-2 stations); pure reverse duplicates (fresh = 0)
      // are dropped. **例外：真正的「快車」（相對主線 kept[0] 中間跳站）不新增 route，
      // 改 fold 成主線的一個子服務**（記 rid＋停靠站座標）——之後在 __stations 把「主線停、
      // 快車不停」的站標成該快車 ref 的 pass。line_count 不變（＝「一線多編號＋每站 stop/pass」）。
      if (kept.length && fresh === 0) {
        // fresh=0（全站已被主線覆蓋）預設丟——**例外：真正的「快車」保留成獨立 route**
        // （與 NYC 快車一致的**全球統一格式**：快車＝獨立 route、其跳過的站由既有 pass-through
        // 偵測算成 pass_stations；不做 services 特例）。判準＝變體名字含快車字樣
        // （Express/Rapid/直達/快速/急行/特急…）＋站數 <0.85×主線＋至少一處中間跳站；
        // 名字條件過濾反向/短交路/資料缺站等非快車變體（板南線、松山新店線…）。
        const ck = (r) => cellOf(r).join(':')
        const hostSeq = kept[0].rows.map(ck)
        const wt = routesTags.get(w.rid) || {}
        const wnm = `${wt['name:en'] ?? ''} ${wt.name ?? ''}`
        const EXPRESS_RE = /(express|rapid|limited|skip.?stop|直達|直达|直通|快速|急行|準急|准急|特急|特快|大站快)/i
        let isExpress = false
        if (EXPRESS_RE.test(wnm) && w.rows.length < 0.85 * kept[0].rows.length) {
          for (let i = 0; i + 1 < w.rows.length && !isExpress; i++) {
            const ia = hostSeq.indexOf(ck(w.rows[i])), ib = hostSeq.indexOf(ck(w.rows[i + 1]))
            if (ia >= 0 && ib >= 0 && Math.abs(ib - ia) >= 2) isExpress = true
          }
        }
        if (!isExpress) continue // 非快車的 fresh=0（反向/短交路）→ 丟；快車 → 落到 kept.push 保留
        // 快車去回程去重（同普通車的 ±2 格容差）：本快車每一站都落在已保留快車 ±2 格內
        // ＝同一條快車的反向（上下行用不同 stop 節點、格差一兩格）→ 丟，只留一條。
        const nearExp = (r) => {
          const [cx, cy] = cellOf(r)
          for (let dx = -2; dx <= 2; dx++)
            for (let dy = -2; dy <= 2; dy++)
              if (expressCovered.has(`${cx + dx}:${cy + dy}`)) return true
          return false
        }
        if (w.rows.length && w.rows.every(nearExp)) continue
        for (const r of w.rows) { const [cx, cy] = cellOf(r); expressCovered.add(`${cx}:${cy}`) }
        w.__isExpress = true // 標記為快車，供路線名加「快車/Express」標記（與普通車區分、非方向）
      }
      kept.push(w)
      for (const r of w.rows) { const [cx, cy] = cellOf(r); covered.add(`${cx}:${cy}`) }
    }
    return kept
  }

  const repTags = (g) => {
    const variants = g.rids.map((r) => routesTags.get(r))
    variants.sort((a, b) =>
      (Number(!!pick(b, 'colour')) - Number(!!pick(a, 'colour'))) ||
      (Number(!!pick(b, 'name:en', 'name')) - Number(!!pick(a, 'name:en', 'name'))))
    const base = { ...(variants[0] || {}) }
    // the routes' own operator/network, before master fill-in — city resolution
    // prefers it so e.g. Incheon's lines (operator 인천교통공사, but network:en
    // "Seoul Metropolitan Subway") aren't pulled into Seoul
    base.__own = pick(base, 'operator') || pick(base, 'network:en', 'network')
    if (g.key.startsWith('m|')) {
      const mt = masterTags.get(Number(g.key.slice(2))) || {}
      for (const [k, v] of Object.entries(mt)) if (v && !base[k]) base[k] = v
      for (const k of ['name', 'name:en', 'ref', 'colour']) if (mt[k]) base[k] = mt[k]
    }
    return base
  }

  // 城市合併規則（使用者指定）：桃園、新北併入台北（台北檔＝台北/新北/桃園捷運
  // 三系統，一城一檔）。key = `${normCity(city)}|${normCountry(country)}` → 目標城市。
  const CITY_MERGE = new Map([
    ['taoyuan|taiwan', { city: 'Taipei', country: 'Taiwan', continent: 'asia' }],
    ['newtaipei|taiwan', { city: 'Taipei', country: 'Taiwan', continent: 'asia' }],
  ])
  // 系統→城市直綁（使用者指定）：跨市系統不靠 geocode 重心（重心會隨站源增減
  // 漂移——臺北捷運重心曾南移到新北把 G/O/Y 整批帶走）。比對 network/operator。
  const NETWORK_CITY = [
    [/臺北捷運|台北捷運|taipei metro|臺北大眾捷運|新北捷運|新北大眾捷運|new taipei metro|淡海輕軌|安坑輕軌|桃園捷運|桃園大眾捷運|桃園機場捷運|taoyuan metro/i,
      { city: 'Taipei', country: 'Taiwan', continent: 'asia' }],
    // 德國 S-Bahn（使用者指定 U-Bahn＋S-Bahn 都要）：系統名/operator 直綁該城
    //（network 是運輸聯盟名 VBB/MVV/RMV…，token 對不到城市名，必須 pin）
    [/s-bahn berlin/i, { city: 'Berlin', country: 'Germany', continent: 'europe' }],
    [/s-bahn hamburg/i, { city: 'Hamburg', country: 'Germany', continent: 'europe' }],
    [/s-bahn münchen|münchner s-bahn/i, { city: 'Munich', country: 'Germany', continent: 'europe' }],
    [/s-bahn rhein-main/i, { city: 'Frankfurt', country: 'Germany', continent: 'europe' }],
    [/s-bahn nürnberg|s-bahn nuremberg/i, { city: 'Nuremberg', country: 'Germany', continent: 'europe' }],
    // 雪梨 Sydney Trains（舊稱 CityRail）市郊 T 線（route=train，由 fetchSydneyTrains.mjs
    // 補抓，使用者指定「雪梨要抓 CityRail」）：network=Sydney Trains 直綁雪梨。
    [/sydney trains|cityrail/i, { city: 'Sydney', country: 'Australia', continent: 'oceania' }],
  ]
  // Resolve each network to a city bucket; networks sharing a city merge into
  // one file. Naming (metro-osm-fetch skill): DIRECTORIES use full names
  // (north+south america merged as "americas"); the FILENAME uses codes —
  // continent 2-letter + country IOC 3-letter, lowercased:
  //   systems/{continent-full}/{country-full}/{cc}-{ioc}-{city}.geojson
  //   e.g. systems/asia/taiwan/as-twn-taipei.geojson
  const CONT_DIR = {
    'north-america': 'americas', 'south-america': 'americas',
    africa: 'africa', asia: 'asia', europe: 'europe', oceania: 'oceania',
  }
  const mkInfo = (geo, fallbackName) => {
    const merged = CITY_MERGE.get(`${normCity(geo.city)}|${normCountry(geo.country)}`)
    if (merged) geo = merged
    const contDir = CONT_DIR[geo.continent] ?? 'unknown'
    const countryDir = slugify(geo.country) || 'unknown'
    const cc = continentCode(geo.continent)
    const ioc = iocCode(geo.country)
    const slug = geo.city
      ? [cc, ioc, slugify(geo.city)].join('-')
      : (slugify(fallbackName) || 'system')
    return { continent: geo.continent, country: geo.country, city: geo.city,
      key: `${contDir}/${countryDir}/${slug}` }
  }
  const cityCache = new Map()
  const cityInfo = (network, netTag, own) => {
    const ck = `${network}|${own || ''}`
    if (cityCache.has(ck)) return cityCache.get(ck)
    const info = mkInfo(geoFor(network, netTag, own), network)
    cityCache.set(ck, info)
    return info
  }
  const cityGroups = new Map()
  const groupFor = (info) => {
    let grp = cityGroups.get(info.key)
    if (!grp) {
      grp = { info, lines: [], stations: [], networks: new Set(),
        operator: null, official_url: null, wikipedia: null, wikidata: null }
      cityGroups.set(info.key, grp)
    }
    return grp
  }

  const kmDist = (aLat, aLon, bLat, bLon) => {
    const dx = (aLon - bLon) * Math.cos(((aLat + bLat) / 2) * Math.PI / 180)
    return Math.sqrt(dx * dx + (aLat - bLat) ** 2) * 111
  }
  const wikiRowXY = (sys) => wikiXY[`${sys.city}|${sys.country}`] || null
  const nearestWiki = (lat, lon, country) => {
    let best = null, bestKm = Infinity
    for (const row of wikiIdx) {
      if (country && !countryOk(country, row.sys.country)) continue
      const xy = wikiRowXY(row.sys)
      if (!xy) continue
      const km = kmDist(lat, lon, xy.lat, xy.lon)
      if (km < bestKm) { bestKm = km; best = row.sys }
    }
    return best ? { sys: best, km: bestKm } : null
  }

  const nodeLineRefs = new Map()
  const lineFeatures = []
  const stationFeatures = []

  // Spatial index: grid cell -> cityKey, built from line vertices. Lets us assign
  // each station to the city of the nearest metro line — OSM stations often lack a
  // network tag (or carry a different one than their lines), so grouping stations
  // by tag alone strands them in a single "unknown" bucket.
  const CELL = 0.02  // ~2 km
  const grid = new Map()
  const cellKey = (lon, lat) => `${Math.round(lon / CELL)}:${Math.round(lat / CELL)}`

  // ---- 同一路線的快/慢車合併為一條線（使用者規則）----
  // 快車/慢車/區間車常是同 network+ref（或同基底名稱）的不同 relation/master。
  // 依「network＋ref」（無 ref 時用去掉快慢字樣的基底名稱）把群組再合併一次；
  // 後續 dedupeSeqs 會把只跳站不加站的快車變體去重（新增 >20% 站的支線仍保留）。
  // network 取 repTags（含 master 補值）——network 無法辨識時**絕不跨組合併**
  //（否則各城市無 network 的「1 號線」會被揉成一個跨國怪物群組）。
  const EXPRESS_WORDS = /(express|local service|local train|rapid|limited|各駅停車|各停|快速|急行|準急|准急|特急|通勤|回送)/gi
  {
    const mergedGroups = new Map()
    for (const g of groups.values()) {
      const t0 = repTags(g)
      const net = pick(t0, 'network:en', 'network') || pick(t0, 'operator')
      let base = g.key
      if (net) {
        if (t0.ref) base = `ref|${net}|${t0.ref}`
        else {
          const nm = (pick(t0, 'name:en', 'name') || '')
            .replace(EXPRESS_WORDS, '').replace(/\s+/g, ' ').trim().toLowerCase()
          if (nm) base = `nm|${net}|${nm}`
        }
      }
      const tgt = mergedGroups.get(base)
      if (!tgt) { mergedGroups.set(base, g); continue }
      tgt.rids.push(...g.rids)
      tgt.seqs.push(...g.seqs)
      for (const s of g.stopNodes) tgt.stopNodes.add(s)
    }
    groups.clear()
    for (const [k, g] of mergedGroups) groups.set(k, g)
  }

  // ---- phase A: resolve every line group to a city (no emission yet) ----
  const pinnedKeys = new Set()
  const resolved = []
  for (const g of groups.values()) {
    const keptAll = dedupeSeqs(g.seqs)
    if (!keptAll.length) continue
    // 支線/分支＝獨立路線（使用者 Option 1：凡有新站的分岔都算支線→獨立 route_id，
    // 只有「0 新站」的純重複/反向/子集短交路才併）。dedupeSeqs 已丟掉 0 新站的重複；
    // keptAll 剩下的每個變體都帶來新站 → 主線＝最長變體、其餘各自獨立成 route_id。
    //   例：香港東鐵綫 EAL 主線 + 羅湖/落馬洲兩端 + 馬場支線各自獨立；台北小碧潭獨立；
    //       雪梨 T1 Richmond/Emu Plains 兩支各自獨立。
    // 同色的多個 route_id（同一條線的兩支、東鐵綫主線 vs 馬場…）在**渲染層**已用「相異
    // 色數」畫成一條連續線（LayerTab `_nc`／skeleton coline），故不在資料層強合併——強合併
    // 會串接站序、幾何來回鋸齒（曾把東鐵綫併成 42 站 Admiralty↔Lo Wu↔Racecourse 來回跳）。
    const branchUnit = (w) => {
      const bt = { ...(routesTags.get(w.rid) || {}) }
      bt.__own = pick(bt, 'operator') || pick(bt, 'network:en', 'network')
      // 快車與主線是**同一條線** → 用主線顏色（OSM 常給快車變體不同色，如機捷直達車淺紫）。
      if (w.__isExpress) { const mc = pick(repTags(g), 'colour'); if (mc) bt.colour = mc }
      // key 不能沿用 m| 前綴（phase B 的 route_id 由 key 推導）——分支用 br|rid
      return { kept: [w.rows], isExpress: !!w.__isExpress, gU: { key: `br|${w.rid}`, rids: [w.rid] }, tU: bt }
    }
    const branchRids = new Set(keptAll.slice(1).map((w) => w.rid))
    const mainRids = g.rids.filter((r) => !branchRids.has(r))
    const units = [{ kept: [keptAll[0].rows],
      gU: { key: g.key, rids: mainRids.length ? mainRids : g.rids }, tU: null }]
    for (const w of keptAll.slice(1)) units.push(branchUnit(w))
    for (const unit of units) {
    const kept = unit.kept
    const gRef = unit.gU
    gRef.stopNodes = new Set()
    for (const rows of kept) for (const r of rows) gRef.stopNodes.add(r.ref)
    // 快車跨站共線：注入 pass-through 頂點（在 stopNodes 建好之後 → 這些中間站不會
    // 變成快車的 stop node，但會進幾何、與慢車共線）。passCoords 供 __stations 排除。
    const passCoords = new Set()
    for (const pt of expressPass) {
      if (!gRef.rids.some((r) => (pt.route_osm ?? []).includes(r))) continue
      for (const seq of kept) {
        for (let i = 0; i < seq.length - 1; i++) {
          const hit = (coordNear(seq[i].coord, pt.from) && coordNear(seq[i + 1].coord, pt.to)) ||
                      (coordNear(seq[i].coord, pt.to) && coordNear(seq[i + 1].coord, pt.from))
          if (!hit) continue
          const rev = coordNear(seq[i].coord, pt.to)
          const via = (rev ? [...pt.via].reverse() : pt.via).map((c) => ({ ref: null, coord: c, pass: true }))
          seq.splice(i + 1, 0, ...via)
          for (const c of pt.via) passCoords.add(c.join(','))
          i += via.length
        }
      }
    }
    const t = unit.tU && (unit.tU.name || unit.tU['name:en']) ? unit.tU : repTags(g)
    const network = pick(t, 'network:en', 'network') || pick(t, 'operator') || 'Unknown'
    // Override wins outright: bind these relations to the specified city and
    // pin the bucket (no sanity-check drift, no rebucketing).
    const ov = gRef.rids.map((r) => ovByRid.get(r)).find(Boolean)
    // 系統→城市直綁（優先於 geocode 解析；視同 override：pin、不做距離裁決）
    const netBind = !ov ? NETWORK_CITY.find(([re]) =>
      re.test(`${network} ${t.network ?? ''} ${t.operator ?? ''} ${t.__own ?? ''}`))?.[1] : null
    let info
    if (ov) {
      info = mkInfo({ continent: ov.continent, country: ov.country, city: ov.city }, ov.city)
      pinnedKeys.add(info.key)
    } else if (netBind) {
      info = mkInfo(netBind, netBind.city)
      pinnedKeys.add(info.key)
    } else {
      info = network === 'Unknown' ? null : cityInfo(network, t.network, t.__own)
      // Unknown network, or a network whose geocode failed (city null):
      // resolve the line by its own coordinates. (A shared null bucket would
      // smear worldwide strays into whichever city its centroid lands near,
      // and the spread guard would then block rebucketing it.)
      if (!info || !info.city) {
        let sx = 0, sy = 0, n = 0
        for (const seq of kept) for (const r of seq) { sx += r.coord[0]; sy += r.coord[1]; n++ }
        const near = n ? nearestWiki(sy / n, sx / n, null) : null
        info = near && near.km < 30
          ? mkInfo({ continent: countryContinent.get(near.sys.country) ?? null,
              country: near.sys.country, city: near.sys.city }, near.sys.city)
          : (info ?? mkInfo({ continent: null, country: null, city: null }, 'unknown'))
      }
    }
    // 座標為準 sanity check: tags can point at the wrong system city — Pune's
    // lines are operated by Nagpur-shared MahaMetro, Incheon's are tagged as
    // the Seoul network. If the resolved city sits far from the line while a
    // same-country wiki city is at least twice as close, the line lives there.
    // (skipped for overrides and coordinate-resolved Unknown-network lines)
    if (!ov && network !== 'Unknown') {
      let sx = 0, sy = 0, n = 0
      for (const seq of kept) for (const r of seq) { sx += r.coord[0]; sy += r.coord[1]; n++ }
      if (n) {
        const clat = sy / n, clon = sx / n
        const own = wikiIdx.find((r) => countryOk(info.country || '', r.sys.country) &&
          normCity(r.sys.city) === normCity(info.city || ''))
        const ownXY = own && wikiRowXY(own.sys)
        const near = nearestWiki(clat, clon, info.country || null)
        if (ownXY && near && near.km < 30) {
          const ownKm = kmDist(clat, clon, ownXY.lat, ownXY.lon)
          if (ownKm > 20 && near.km * 2 < ownKm &&
              normCity(near.sys.city) !== normCity(info.city))
            info = mkInfo({ continent: info.continent, country: info.country,
              city: near.sys.city }, near.sys.city)
        }
      }
    }
    // 同一城市＝同一系統：解析出的 wiki 城市離線路重心 >250 km ⇒ 絕不屬於該城
    // （全國性 network 名稱/token 撞名的誤配，如 Frankfurt→Berlin 424 km），
    // 改用線自身座標或原始反查城市。門檻 250 km：中國直轄市（重慶等）的 wiki
    // 座標是行政區幾何中心，離市中心可達 ~150 km，不能誤殺。
    if (!ov && network !== 'Unknown' && info.city) {
      let sx = 0, sy = 0, n = 0
      for (const seq of kept) for (const r of seq) { sx += r.coord[0]; sy += r.coord[1]; n++ }
      if (n) {
        const clat = sy / n, clon = sx / n
        const row = wikiIdx.find((r) => countryOk(info.country || '', r.sys.country) &&
          normCity(r.sys.city) === normCity(info.city))
        const xy = row && wikiRowXY(row.sys)
        if (xy && kmDist(clat, clon, xy.lat, xy.lon) > 250) {
          const near = nearestWiki(clat, clon, null)
          const raw = geocode[t.__own] || geocode[network] || geocode[t.network] || {}
          info = near && near.km < 30
            ? mkInfo({ continent: countryContinent.get(near.sys.country) ?? info.continent,
                country: near.sys.country, city: near.sys.city }, near.sys.city)
            : mkInfo({ continent: raw.continent ?? info.continent,
                country: raw.country ?? info.country, city: raw.city ?? null }, network)
        }
      }
    }
    // 一組內全部 relation 都是 light_rail 才算 LRT 線（混合視為 subway）
    const lrtOnly = gRef.rids.every((r) => (routesTags.get(r) || {}).route === 'light_rail')
    if (process.env.DEBUG_CITY && new RegExp(process.env.DEBUG_CITY, 'i')
      .test(`${network} ${t.name ?? ''} ${t.__own ?? ''}`))
      console.log('  [resolve]', (t['name:en'] || t.name || '').slice(0, 40),
        '| net:', network, '| own:', t.__own, '→', info.key)
    resolved.push({ g: gRef, kept, passCoords, t, network, ov, info, lrtOnly, isExpress: unit.isExpress })
    }
  }

  // Per-feature flags for the LRT scope rule — the keep/drop decision itself
  // runs AFTER rebucket (the final canonical city decides, not the raw name).
  const lrtFlags = new Map()   // feature -> group is pure light_rail
  const ovFlags = new Map()    // feature -> bound by an override (audit-sanctioned)
  const featTag = new Map()    // feature -> lineTag used in station `lines`

  // ---- phase B: emit features ----
  for (const e of resolved) {
    const { g, kept, passCoords, t, network, ov, info } = e
    const routeRef = t.ref || null
    const routeId = g.key.startsWith('m|') ? `rm${g.key.slice(2)}` : `r${Math.min(...g.rids)}`
    // Stations must always resolve to a line (verify invariant), so fall back
    // to the route name when the relation carries no ref.
    const lineTag = routeRef || nameFor(t, info.country) || routeId
    for (const n of g.stopNodes) {
      if (!nodeLineRefs.has(n)) nodeLineRefs.set(n, new Set())
      nodeLineRefs.get(n).add(lineTag)
    }
    const props = {
      route_id: routeId,
      route_name: ((nm) => nm + (e.isExpress ? expressMark(info.country, nm) : ''))(
        cleanRouteName(nameFor(t, info.country)) || routeRef || routeId),
      route_name_local: cleanRouteName(t.name) || null,
      route_ref: routeRef,
      route_color: normColor(pick(t, 'colour')),
      network,
      network_local: t.network || null,
      operator: pick(t, 'operator'),
      city: info.city, country: info.country,
      wikidata: pick(t, 'wikidata', 'network:wikidata'),
      wikipedia: pick(t, 'wikipedia', 'network:wikipedia'),
      osm_route_ids: g.rids,
      // 未通車例外線（台北限定）——UI 可依此標示「建設中」
      status: g.rids.some((r) => ucRids.has(r)) ? 'under_construction' : null,
    }
    const feat = {
      type: 'Feature', properties: props,
      geometry: { type: 'MultiLineString',
        coordinates: kept.map((seq) => seq.map((r) => r.coord)) },
    }
    if (passCoords.size) feat.__passCoords = passCoords  // pass-through 頂點：不算此線停靠站
    lineFeatures.push(feat)
    lrtFlags.set(feat, e.lrtOnly)
    ovFlags.set(feat, !!ov)
    featTag.set(feat, lineTag)
    for (const seg of feat.geometry.coordinates)
      for (const [lon, lat] of seg) {
        const k = cellKey(lon, lat)
        // 一格可有多城（跨城轉乘站：紹興1號線↔杭州5號線的姑娘桥）——存 Set
        let cks = grid.get(k)
        if (!cks) { cks = new Set(); grid.set(k, cks) }
        cks.add(info.key)
      }
    const grp = groupFor(info)
    grp.lines.push(feat)
    grp.networks.add(network)
    if (!grp.operator) grp.operator = pick(t, 'operator')
    if (!grp.official_url) grp.official_url = pick(t, 'website', 'operator:website')
    if (!grp.wikipedia) grp.wikipedia = pick(t, 'wikipedia', 'network:wikipedia')
    if (!grp.wikidata) grp.wikidata = pick(t, 'wikidata', 'network:wikidata')
  }

  // ---- stations: assign to the city of the nearest metro line (spatial) ----
  const gInfo = new Map([...cityGroups].map(([k, v]) => [k, v.info]))

  // Station→line membership: route stop members are usually stop_position
  // nodes, not the station node itself, so id matching alone strands stations
  // without lines. Fall back to the nearest stop within ~500 m.
  const stopGrid = new Map()
  for (const [nid, refs] of nodeLineRefs) {
    const c = stopXY.get(nid)
    if (!c) continue
    const k = cellKey(c[0], c[1])
    if (!stopGrid.has(k)) stopGrid.set(k, [])
    stopGrid.get(k).push({ lon: c[0], lat: c[1], refs })
  }
  const nearbyLineRefs = (lon, lat) => {
    const gx = Math.round(lon / CELL), gy = Math.round(lat / CELL)
    let best = null, bestD = Infinity
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      for (const p of stopGrid.get(`${gx + dx}:${gy + dy}`) || []) {
        const d = (p.lon - lon) ** 2 + (p.lat - lat) ** 2
        if (d < bestD) { bestD = d; best = p }
      }
    // ~900 m: station nodes can sit well away from the line's stop_position
    // nodes (big interchanges, entrance-tagged stations)
    return best && Math.sqrt(bestD) < 0.008 ? [...best.refs] : []
  }
  const nearestCityKey = (lon, lat) => {
    const gx = Math.round(lon / CELL), gy = Math.round(lat / CELL)
    for (let r = 0; r <= 12; r++) {  // out to ~24 km
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const cks = grid.get(`${gx + dx}:${gy + dy}`)
        if (cks && cks.size) return [...cks][0]
      }
    }
    return null
  }
  // 跨城轉乘站：同一站點 ~2 km 內有「多個城市」的線經過（姑娘桥＝紹興1號線
  // ↔杭州5號線）——站點要複製進每個城市檔，否則另一城的線頂點失主被剪。
  // 誤複製的（該城線實際吸不到）由 orphan-drop 自清。
  const nearbyCityKeys = (lon, lat) => {
    const gx = Math.round(lon / CELL), gy = Math.round(lat / CELL)
    const keys = new Set()
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      for (const ck of grid.get(`${gx + dx}:${gy + dy}`) ?? []) keys.add(ck)
    return keys
  }

  for (const s of stations) {
    const t = s.tags
    const network = pick(t, 'network:en', 'network') || pick(t, 'operator') || 'Unknown'
    const spatialKey = nearestCityKey(s.lon, s.lat)
    const info = (spatialKey && gInfo.get(spatialKey)) || cityInfo(network, t.network)
    let lines = [...(nodeLineRefs.get(s.id) || [])]
    if (!lines.length) lines = nearbyLineRefs(s.lon, s.lat)
    lines = [...new Set(lines)].sort()
    const props = {
      station_id: `n${s.id}`,
      station_name: nameFor(t, info.country) || `n${s.id}`,
      station_name_local: t.name || null,
      network,
      network_local: t.network || null,
      operator: pick(t, 'operator'),
      city: info.city,
      country: info.country,
      lines: lines.length ? lines : null,
      wikidata: pick(t, 'wikidata'),
      wikipedia: pick(t, 'wikipedia'),
    }
    const feat = {
      type: 'Feature', properties: props,
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    }
    // 官方站碼（`ref`，如機捷 A1、環狀 Y20、板南 BL12、港鐵 FOH）——各線的 station 節點自帶
    // 該線的碼；共站合併時聚成 codes，路線再依 ref 字首挑出自己的碼、供官方順序排序。內部欄位。
    if (t.ref && /^[A-Za-z]{1,4}\d|^\d/.test(t.ref)) feat.__codes = new Set(String(t.ref).split(/[;、,\s]+/).filter(Boolean))
    if (process.env.DEBUG_ST && /榴花公园|Embarcadero/.test((t.name || '') + (t['name:en'] || '')))
      console.log('  [st]', t.name, '| id:', s.id, '| bucket:', info.key,
        '| direct-refs:', !!nodeLineRefs.get(s.id), '| lines:', JSON.stringify(props.lines))
    stationFeatures.push(feat)
    groupFor(info).stations.push(feat)
    groupFor(info).networks.add(network)
    // 跨城轉乘站複製（其餘城市各拿一份 clone，city 欄位改該城）
    for (const ck of nearbyCityKeys(s.lon, s.lat)) {
      if (ck === info.key) continue
      const info2 = gInfo.get(ck)
      if (!info2) continue
      const clone = { type: 'Feature',
        properties: { ...props, city: info2.city, country: info2.country },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] } }
      groupFor(info2).stations.push(clone)
    }
  }

  // ---- 手工線（_overrides/manual_lines.json）：未通車特例線（使用者指定，台北專屬）。
  // OSM 無可用車站（無名/佔位/無節點），站名與站序取自 wiki、座標取自 OSM 線形節點
  // 或沿線插值（離線於 scripts/buildManualLines.mjs 補齊）。當作一般線＋站注入對應
  // 城市，後續共站合併／snap／路段化一體適用（萬大線中正紀念堂等自動與既有站共站）；
  // status=under_construction → wikilines 走 planned warn 不擋 audit。ovFlags 豁免
  // LRT 剔除與城市白名單過濾。
  let manualLines = []
  try {
    manualLines = JSON.parse(await readFile(join(OVERRIDES_DIR, 'manual_lines.json'), 'utf8')).lines ?? []
  } catch { /* none */ }
  for (const ml of manualLines) {
    const info = mkInfo({ continent: ml.continent || 'asia', country: ml.country, city: ml.city }, ml.city)
    const grp = groupFor(info)
    const ref = ml.ref
    const net = ml.network || '臺北捷運'
    const coords = ml.stations.map((s) => [s.lon, s.lat])
    if (ml.closed && coords.length > 2) coords.push(coords[0].slice())
    const feat = {
      type: 'Feature',
      properties: {
        route_id: 'manual-' + slugify(`${ml.city}-${ref}-${ml.variant || ml.name}`),
        // 手工線目前皆為台北（台灣顯示繁中，nameFor 慣例）：route_name 用中文，
        // 與 OSM 路線一致（淡水信義線等）；英文名留在 manual_curated 供查考。
        route_name: ml.name,
        route_name_local: ml.name,
        route_ref: ref,
        route_color: normColor(ml.colour),
        network: net, network_local: net, operator: null,
        city: info.city, country: info.country,
        wikidata: null, wikipedia: ml.wikipedia || null,
        osm_route_ids: [], status: 'under_construction',
      },
      geometry: { type: 'MultiLineString', coordinates: [coords] },
    }
    grp.lines.push(feat)
    lineFeatures.push(feat)
    grp.networks.add(net)
    lrtFlags.set(feat, false)
    ovFlags.set(feat, true)
    featTag.set(feat, ref)
    for (const [lon, lat] of coords) {
      const k = cellKey(lon, lat)
      let cks = grid.get(k); if (!cks) { cks = new Set(); grid.set(k, cks) }
      cks.add(info.key)
    }
    for (const s of ml.stations) {
      const sf = {
        type: 'Feature',
        properties: {
          station_id: 'm' + slugify(`${ml.city}-${ref}-${s.code || s.name_en || s.name}`),
          // station_name 用中文（台灣 nameFor＝繁中）——否則與 OSM 站（中正紀念堂／
          // 東湖）異名、同名 ≤800m 合併對不上，轉乘站會分裂成兩點（藍點蓋掉紅點）。
          station_name: s.name,
          station_name_local: s.name,
          network: net, network_local: net, operator: null,
          city: info.city, country: info.country,
          lines: [ref], wikidata: null, wikipedia: null,
        },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      }
      stationFeatures.push(sf)
      grp.stations.push(sf)
    }
    console.log(`  manual line ${ref} ${ml.name}: ${ml.stations.length} stations`)
  }

  // ---- rebucket: groups whose city never resolved to a Wikipedia city ----
  // 1st chance: a member network resolves (station tags often carry the English
  //   name the routes lack — "Ningbo Rail Transit" on 宁波轨道交通 lines).
  // 2nd chance: the group's centroid sits next to a forward-geocoded wiki city
  //   (language-independent — 济南 buckets as "Lixia District" but IS Jinan).
  const isCanon = (info) => !!info.city && wikiIdx.some((r) =>
    countryOk(info.country || '', r.sys.country) && normCity(r.sys.city) === normCity(info.city))
  const groupCentroid = (grp) => {
    let sx = 0, sy = 0, n = 0
    for (const f of grp.lines) for (const seg of f.geometry.coordinates)
      for (const [lon, lat] of seg) { sx += lon; sy += lat; n++ }
    for (const f of grp.stations) {
      sx += f.geometry.coordinates[0]; sy += f.geometry.coordinates[1]; n++
    }
    return n ? { lon: sx / n, lat: sy / n } : null
  }
  const nearestWikiCity = (grp) => {
    const c = groupCentroid(grp)
    if (!c) return null
    const near = nearestWiki(c.lat, c.lon, null)
    if (!near) return null
    // same country within 30 km; cross-country only when unambiguous (<15 km,
    // e.g. Macau is listed under China but reverse-geocodes as Macao)
    const sameCountry = countryOk(grp.info.country || '', near.sys.country)
    return (near.km < 30 && sameCountry) || near.km < 15 ? near.sys : null
  }
  const rebucket = (grp, key, alt) => {
    for (const f of [...grp.lines, ...grp.stations]) {
      f.properties.city = alt.city
      f.properties.country = alt.country
    }
    const tgt = groupFor(alt)
    tgt.lines.push(...grp.lines)
    tgt.stations.push(...grp.stations)
    for (const n of grp.networks) tgt.networks.add(n)
    tgt.operator = tgt.operator || grp.operator
    tgt.official_url = tgt.official_url || grp.official_url
    tgt.wikipedia = tgt.wikipedia || grp.wikipedia
    tgt.wikidata = tgt.wikidata || grp.wikidata
    cityGroups.delete(key)
  }
  // A geographically incoherent pile (strays scattered worldwide) must never
  // be rebucketed as a whole — its centroid is meaningless.
  const groupSpreadKm = (grp) => {
    const c = groupCentroid(grp)
    if (!c) return 0
    let m = 0
    for (const f of grp.lines) for (const seg of f.geometry.coordinates)
      for (const [lon, lat] of seg) m = Math.max(m, kmDist(c.lat, c.lon, lat, lon))
    return m
  }
  for (const [key, grp] of [...cityGroups]) {
    if (pinnedKeys.has(key)) continue  // override-bound buckets never move
    if (isCanon(grp.info)) continue
    if (groupSpreadKm(grp) > 80) continue  // incoherent stray pile — stays unknown
    let alt = null
    let altVia = null
    const gc = groupCentroid(grp)
    for (const net of grp.networks) {
      if (net === 'Unknown') continue
      // 全國性基礎設施/營運公司名不代表城市（DB Station&Service AG geocode 到
      // 紐倫堡，會把整個卡爾斯魯厄 Stadtbahn 桶搬進紐倫堡）——跳過，比照 Unknown。
      if (NATIONAL_INFRA.test(net)) continue
      const c = cityInfo(net, null, null)
      if (!isCanon(c) || c.key === key) continue
      // 同一城市＝同一系統：network 名稱解析出的城市必須離群組重心 ≤250 km
      //（中國直轄市 wiki 座標可偏 ~150 km），否則是誤配（全國性營運商/token
      // 撞名，如 Frankfurt→Berlin 424 km），不得整桶搬家。
      const row = wikiIdx.find((r) => countryOk(c.country || '', r.sys.country) &&
        normCity(r.sys.city) === normCity(c.city))
      const xy = row && wikiRowXY(row.sys)
      if (gc && xy && kmDist(gc.lat, gc.lon, xy.lat, xy.lon) > 250) continue
      alt = c; altVia = `network:${net}`; break
    }
    if (!alt) {
      const w = nearestWikiCity(grp)
      if (w) {
        const cand = mkInfo({ continent: grp.info.continent,
          country: grp.info.country || w.country, city: w.city }, w.city)
        if (cand.key !== key) { alt = cand; altVia = 'nearest-wiki' }
      }
    }
    if (alt && process.env.DEBUG_REBUCKET &&
        new RegExp(process.env.DEBUG_REBUCKET, 'i').test(key + ' ' + alt.key))
      console.log('  [rebucket]', key, '→', alt.key, 'via', altVia,
        '| networks:', [...grp.networks].join(', ').slice(0, 120))
    if (alt) rebucket(grp, key, alt)
  }

  // Re-derive station memberships against the SURVIVING lines only after a
  // line-removal pass. Filtering by removed tag string alone is unsafe: refs
  // collide ("2" = both 東莞地鐵2號線 and the removed 松山湖 tram line 2), and
  // a station whose nearest stop belonged to a removed line (Embarcadero →
  // Muni) needs a second chance against the surviving lines' stops.
  const rederiveStationRefs = (grp, removedTags) => {
    if (!removedTags.size) return
    const surviving = new Set(grp.lines.map((f) => featTag.get(f)))
    const nearestSurvivingRefs = (lon, lat) => {
      const gx = Math.round(lon / CELL), gy = Math.round(lat / CELL)
      let best = null, bestD = Infinity
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
        for (const p of stopGrid.get(`${gx + dx}:${gy + dy}`) || []) {
          const hits = [...p.refs].filter((r) => surviving.has(r))
          if (!hits.length) continue
          const d = (p.lon - lon) ** 2 + (p.lat - lat) ** 2
          if (d < bestD) { bestD = d; best = hits }
        }
      return best && Math.sqrt(bestD) < 0.008 ? best : []  // ~900 m
    }
    for (const s of grp.stations) {
      if (!s.properties.lines) continue
      let left = s.properties.lines.filter((tag) => surviving.has(tag))
      if (!left.length) {
        const [lon, lat] = s.geometry.coordinates
        left = [...new Set(nearestSurvivingRefs(lon, lat))].sort()
      }
      s.properties.lines = left.length ? left : null
    }
  }

  // ---- LRT 範圍規則（使用者指定；用 rebucket 後的最終城市判定）----
  // 只有台北（含新北）/高雄的城市檔「附加」LRT 線；其他城市僅當其 Wikipedia 基準
  // 系統本身就是 LRT（該城完全沒有 subway 線）才保留整個 LRT 系統
  // （SkyTrain、澳門輕軌、Stadtbahn…）。非基準、純 LRT 的額外系統一律剔除。
  // Override 綁定的線（audit 逐城判過的）不在剔除範圍。
  // 附加 LRT 的城市（使用者指定）：該城有 MRT/subway，但也要收其輕軌（台北淡海/安坑/
  // 環狀、高雄輕軌；新加坡 Bukit Panjang/Sengkang/Punggol LRT）。
  const LRT_ADDON_CITIES = new Set(['taipei', 'newtaipei', 'kaohsiung', 'singapore'])
  // 德國例外（使用者指定）：U-Bahn＋S-Bahn 都要。柏林/漢堡的 S-Bahn 在 OSM 標
  // route=light_rail（慕尼黑/法蘭克福等標 route=train，由 fetchSbahnDe.mjs 補抓），
  // 不得被 LRT 範圍規則剔除——以 ref=S 開頭或 operator 含 S-Bahn 辨識。
  // 僅限五個德國 metro 城市：Karlsruhe tram-train 也用 S 開頭 ref，會冒出
  // Walzbachtal 之類的野城市檔。
  const SBAHN_DE_CITIES = new Set(['berlin', 'hamburg', 'munich', 'frankfurt', 'nuremberg'])
  const isSbahnDe = (grp, f) =>
    countryOk(grp.info.country || '', 'germany') &&
    SBAHN_DE_CITIES.has(normCity(grp.info.city)) &&
    (/^S\d/i.test(f.properties.route_ref || '') ||
     /s-bahn/i.test(f.properties.operator || ''))
  const wikiRowOf = (info) => info.city ? (wikiIdx.find((r) =>
    countryOk(info.country || '', r.sys.country) &&
    normCity(r.sys.city) === normCity(info.city))?.sys ?? null) : null
  const parseWikiN = (s) => { const m = /\d[\d,]*/.exec(String(s ?? '')); return m ? parseInt(m[0].replace(/,/g, ''), 10) : null }
  let skippedLrt = 0
  for (const grp of cityGroups.values()) {
    const hasSubway = grp.lines.some((f) => !lrtFlags.get(f))
    const wikiRow = wikiRowOf(grp.info)
    let allowed = LRT_ADDON_CITIES.has(normCity(grp.info.city)) ||
      (!!wikiRow && !hasSubway)
    // Wikipedia 站數當仲裁者：基準城市若剔除 LRT 會跌破 0.6 覆蓋比值，代表
    // wiki 把這些 LRT 線算進該城 metro（仁川2號線、吉隆坡/馬尼拉 LRT）→ 保留。
    if (!allowed && wikiRow && hasSubway) {
      const wikiN = parseWikiN(wikiRow.stations)
      if (wikiN && wikiN >= 3) {
        const subwayTags = new Set(grp.lines.filter((f) => !lrtFlags.get(f))
          .map((f) => featTag.get(f)))
        // 用「唯一站名數」近似合併後站數（此時同名合併尚未發生，節點數會虛胖）
        const keptNames = new Set()
        for (const s of grp.stations) {
          if (!(s.properties.lines || []).some((tag) => subwayTags.has(tag))) continue
          const nm = (s.properties.station_name || '').normalize('NFKD')
            .toLowerCase().replace(/\s+/g, ' ').trim()
          keptNames.add(nm && !/^n\d+$/.test(nm) ? nm : s.properties.station_id)
        }
        const kept = keptNames.size
        if (process.env.DEBUG_LRT) console.log('  [lrt-arbitrate]',
          JSON.stringify(grp.info.city), 'wikiN:', wikiN, 'keptUniqueStations:', kept,
          'ratio:', (kept / wikiN).toFixed(2))
        if (kept / wikiN < 0.6) allowed = true
      }
    }
    if (allowed) continue
    const removedTags = new Set()
    grp.lines = grp.lines.filter((f) => {
      if (!lrtFlags.get(f) || ovFlags.get(f) || isSbahnDe(grp, f)) return true
      removedTags.add(featTag.get(f))
      skippedLrt++
      if (process.env.DEBUG_LRT) console.log('  [lrt-removed]',
        JSON.stringify(grp.info.city), '|', f.properties.route_name)
      return false
    })
    rederiveStationRefs(grp, removedTags)
  }
  if (skippedLrt) console.log(`  LRT scope: removed ${skippedLrt} light-rail lines ` +
    '(kept Taipei/Kaohsiung add-ons and baseline LRT-only systems)')

  // ---- 城市網路白名單（使用者指定）：東京不含私鐵 ----
  // 東京檔只收 Tokyo Metro（東京メトロ）與都營（東京都交通局）的路線——
  // 與 Wikipedia 基準（Tokyo subway = Metro + Toei）一致；私鐵/第三部門
  //（ゆりかもめ、りんかい線、多摩モノレール…）一律不進東京檔。
  const CITY_NETWORK_ALLOW = new Map([
    ['tokyo|japan', {
      allow: /tokyo metro|東京メトロ|東京地下鉄|toei|都営|東京都交通局/i,
      // 私鐵直通車是「聯合營運」——operator 同時含都營與京急/京成等；
      // 只要沾到私鐵就不是 Metro/Toei 本體的線（deny 優先於 allow）。
      deny: /京浜急行|京急|京成|東急|東武|西武|小田急|京王|相鉄|keikyu|keisei|tokyu|tobu|seibu|odakyu|keio|sotetsu|s-train|りんかい|ゆりかもめ|多摩モノレール/i,
    }],
    // 台北（使用者指定）：只收 台北捷運／新北捷運／桃園捷運 三系統
    //（機場航廈電車 Skytrain 等自然不在表列 → 剔除）
    ['taipei|taiwan', {
      allow: /台北捷運|臺北捷運|taipei metro|新北捷運|新北大眾捷運|new taipei metro|淡海輕軌|安坑輕軌|三鶯|桃園捷運|桃園大眾捷運|桃園機場捷運|taoyuan (?:metro|airport)/i,
      deny: /skytrain|航廈電車/i,
    }],
    // 紐約（使用者指定）：只收 MTA 的線——NYC Subway ＋ Staten Island Railway（MTA
    // 子公司運營）。PATH（Port Authority of NY&NJ，跨哈德遜河到新澤西）不是 MTA，剔除。
    ['new york city|united states', {
      allow: /nyc subway|new york city transit|nyct|\bmta\b|metropolitan transportation|staten island rail/i,
      deny: /\bpath\b|port authority/i,
    }],
  ])
  let removedPrivate = 0
  for (const [ckey, rule] of CITY_NETWORK_ALLOW) {
    const [cCity, cCountry] = ckey.split('|')
    for (const grp of cityGroups.values()) {
      // normCity 兩邊都套（ckey 的城市名可能含空格，如 "new york city"→"newyorkcity"）
      if (normCity(grp.info.city) !== normCity(cCity) || !countryOk(grp.info.country, cCountry)) continue
      const removedTags = new Set()
      grp.lines = grp.lines.filter((f) => {
        const p = f.properties
        const hay = `${p.network ?? ''} ${p.network_local ?? ''} ${p.operator ?? ''} ${p.route_name ?? ''}`
        const pass = rule.allow
          ? (rule.allow.test(hay) && !rule.deny.test(hay))
          : !rule.deny.test(hay)
        if (pass || ovFlags.get(f)) return true
        removedTags.add(featTag.get(f))
        removedPrivate++
        if (process.env.DEBUG_LRT) console.log('  [private-removed]',
          JSON.stringify(grp.info.city), '|', p.route_name, '|', p.network, '|', p.operator)
        return false
      })
      rederiveStationRefs(grp, removedTags)
    }
  }
  if (removedPrivate) console.log(`  city network allow-list: removed ${removedPrivate} ` +
    'non-listed lines (Tokyo = Metro + Toei only)')
  // keep the global line layer consistent with the per-city groups
  {
    const keptFeats = new Set()
    for (const grp of cityGroups.values()) for (const f of grp.lines) keptFeats.add(f)
    for (let i = lineFeatures.length - 1; i >= 0; i--)
      if (!keptFeats.has(lineFeatures[i])) lineFeatures.splice(i, 1)
  }

  // ---- 共站合併（可轉乘＝同一車站；stop_area ∪ 同名近距 ∪ overrides）----
  // Interchange stations merge to a single point (mean coords, union of lines).
  // Criteria (union-find): (1) sharing an OSM stop_area relation — the
  // authoritative same-complex signal; (2) same normalized name within ~800 m
  // (same-name-nearby is a transfer in practice; synthetic n123 names exempt);
  // (3) manually adjudicated pairs from _overrides/interchanges.json (cases
  // resolved against Wikipedia / urbanrail.net per the metro-audit skill).
  // 同名正規化，供同名合併/去重用：
  //  · NFKD＋去組合變音符：「Gómez」＝「Gomez」（Monterrey Félix U. Gómez L1/L3）。
  //  · 去消歧義括號註記：「Anand Vihar (Blue Line)」＝「(Pink Line)」＝同站（Delhi/
  //    Hyderabad/Kolkata/Mumbai/Istanbul…同站分屬多線各掛一個節點）。
  //  · 去結尾羅馬數字月台序（Serdika II＝Serdika）——**不去純阿拉伯數字**，那會誤併
  //    Terminal 1/2、Line 1/2 之類真的不同站。
  const normName = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[([（【].*?[)\]）】]/g, ' ')
    .toLowerCase()
    .replace(/\s+(?:i{2,3}|iv)$/, '')
    .replace(/\s+/g, ' ').trim()
  const areaOf = new Map() // station node id -> [stop_area relation ids]
  try {
    const sa = JSON.parse(await readFile(join(CACHE, 'stop_areas.json'), 'utf8'))
    for (const e of sa.elements || []) {
      if (e.type !== 'relation') continue
      for (const m of e.members || [])
        if (m.type === 'node') {
          if (!areaOf.has(m.ref)) areaOf.set(m.ref, [])
          areaOf.get(m.ref).push(e.id)
        }
    }
  } catch { /* optional — same-name fallback still applies */ }
  let ixPairs = []
  try {
    ixPairs = JSON.parse(await readFile(
      join(BASE, '_overrides', 'interchanges.json'), 'utf8')).merge ?? []
  } catch { /* optional */ }

  let mergedAway = 0
  for (const grp of cityGroups.values()) {
    const feats = grp.stations
    if (feats.length < 2) continue
    // union-find
    const parent = feats.map((_, i) => i)
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }
    const nodeId = (f) => parseInt((f.properties.station_id || '').slice(1), 10)

    // (1) shared stop_area
    const byArea = new Map()
    feats.forEach((f, i) => {
      for (const aid of areaOf.get(nodeId(f)) || []) {
        if (byArea.has(aid)) union(byArea.get(aid), i)
        else byArea.set(aid, i)
      }
    })
    // (2) same name within ~800 m (greedy clusters, then union each cluster)
    // 每城政策：紐約的同名站多半「不相通」（23rd St 分屬 6 條線各自獨立、
    // 官方僅以 station complex 定義轉乘）——NYC 改嚴格模式：同名合併只在
    // 「共線（同站的兩個方向節點/同線重複節點）或 <150 m」時成立；跨線
    // 同名遠站不併，官方 complex 以 interchanges.json 回補。stop_area 為
    // 每線每方向粒度，救不了方向節點成對的情況，不能全關。
    const STRICT_SAMENAME = new Set(['newyorkcity'])
    const sameNameStrict = STRICT_SAMENAME.has(normCity(grp.info.city))
    const byName = new Map()
    feats.forEach((f, i) => {
      const key = normName(f.properties.station_name)
      if (!key || /^n\d+$/.test(key)) return
      if (!byName.has(key)) byName.set(key, [])
      byName.get(key).push(i)
    })
    for (const idxs of byName.values()) {
      const clusters = []
      for (const i of idxs) {
        const [lon, lat] = feats[i].geometry.coordinates
        const myLines = feats[i].properties.lines || []
        let c = clusters.find((c) => {
          const dLat = Math.abs(c.lat - lat)
          const dLon = Math.abs((c.lon - lon) * Math.cos((lat * Math.PI) / 180))
          if (dLat >= 0.0072 || dLon >= 0.0072) return false
          if (!sameNameStrict) return true
          if (dLat < 0.0014 && dLon < 0.0014) return true
          return c.members.some((m) => {
            const ml = feats[m].properties.lines || []
            return myLines.some((x) => ml.includes(x))
          })
        })
        if (!c) { c = { members: [], lon, lat }; clusters.push(c) }
        c.members.push(i)
        c.lon = c.members.reduce((s, m) => s + feats[m].geometry.coordinates[0], 0) / c.members.length
        c.lat = c.members.reduce((s, m) => s + feats[m].geometry.coordinates[1], 0) / c.members.length
      }
      for (const c of clusters)
        for (let k = 1; k < c.members.length; k++) union(c.members[0], c.members[k])
    }
    // (3) adjudicated interchange pairs
    if (ixPairs.length) {
      const byId = new Map(feats.map((f, i) => [f.properties.station_id, i]))
      for (const [a, b] of ixPairs) {
        if (byId.has(a) && byId.has(b)) union(byId.get(a), byId.get(b))
      }
    }

    // materialize merged stations
    const groupsByRoot = new Map()
    feats.forEach((_, i) => {
      const r = find(i)
      if (!groupsByRoot.has(r)) groupsByRoot.set(r, [])
      groupsByRoot.get(r).push(i)
    })
    const keep = []
    // 吸附別名：合併後代表點是「質心」，可能離某些成員 >600 m（NYC 125th St
    // 質心位移把 Lexington 節點全甩掉）——記下成員原座標→代表點座標，
    // 吸附階段對成員點找最近、再映射回代表點。
    const aliases = []
    for (const idxs of groupsByRoot.values()) {
      if (idxs.length === 1) { keep.push(feats[idxs[0]]); continue }
      mergedAway += idxs.length - 1
      const members = idxs.map((i) => feats[i])
      // 代表點站名：在有真名的成員裡挑最好的——依序：①拉丁/英文名優先（管線本來就
      // name:en 優先，別被只有 Cyrillic name 的節點搶走：Novosibirsk 取 "Sibirskaya"
      // 而非 "Сибирская"）②無括號註記（"District Court" 勝過 "District Court (Aqua Line)"）
      // ③服務線最多者（主轉乘站，Baku 取 "28 May"[1,2] 而非 "Cəfər Cabbarlı"[2B]）
      // ④最短名。代表 tags 亦取自它。
      const isNamed = (m) => m.properties.station_name && !/^n\d+$/.test(m.properties.station_name)
      const nonLatin = (s) => {
        const letters = [...String(s)].filter((c) => /\p{L}/u.test(c))
        if (!letters.length) return 1
        return letters.filter((c) => !/[A-Za-zÀ-ɏ]/.test(c)).length / letters.length > 0.5 ? 1 : 0
      }
      const first = (members.some(isNamed) ? members.filter(isNamed) : members).slice().sort((a, b) => {
        const na = a.properties.station_name || '', nb = b.properties.station_name || ''
        const lat = nonLatin(na) - nonLatin(nb)
        if (lat) return lat
        const pa = /[(（]/.test(na) ? 1 : 0, pb = /[(（]/.test(nb) ? 1 : 0
        if (pa !== pb) return pa - pb
        const la = (a.properties.lines || []).length, lb = (b.properties.lines || []).length
        if (la !== lb) return lb - la
        return normName(na).length - normName(nb).length
      })[0]
      const lines = [...new Set(members.flatMap((m) => m.properties.lines || []))].sort()
      const lon = members.reduce((s, m) => s + m.geometry.coordinates[0], 0) / members.length
      const lat = members.reduce((s, m) => s + m.geometry.coordinates[1], 0) / members.length
      // 異名轉乘站合併後只留代表點一個 station_name，其餘成員名會消失
      // （Sibirskaya→Krasnyi Prospekt、Chonsung→Chonu）——用 merged_names 保留
      // 每個相異站名的 id/英文名/在地名＋該名所屬路線，依 normName 去重、
      // 代表點排第一；同名多成員（上下行/快慢車月台）的 lines 取聯集。
      // keyMap 同時以英文名與在地名正規化為鍵指向同一 entry——避免只有 Cyrillic
      // name（無 name:en）的成員與有 name:en＋同 name:local 的成員被當成兩個名字
      // （Novosibirsk 的 "Сибирская" vs "Sibirskaya"/local "Сибирская"）。
      const entries = []
      const keyMap = new Map()
      for (const m of [first, ...members.filter((m) => m !== first)]) {
        const nm = m.properties.station_name || ''
        if (/^n\d+$/.test(nm)) continue
        const kName = normName(nm)
        const kLocal = normName(m.properties.station_name_local || '')
        if (!kName) continue
        let entry = keyMap.get(kName) || (kLocal && keyMap.get(kLocal))
        if (!entry) {
          entry = {
            station_id: m.properties.station_id,
            station_name: m.properties.station_name,
            station_name_local: m.properties.station_name_local ?? null,
            lines: new Set(),
          }
          entries.push(entry)
        } else if (nonLatin(m.properties.station_name) < nonLatin(entry.station_name)) {
          // 同站有拉丁與 Cyrillic 兩種名時，顯示名升級成拉丁/英文版
          // （St Petersburg "Владимирская" → "Vladimirskaya"）。
          entry.station_id = m.properties.station_id
          entry.station_name = m.properties.station_name
          entry.station_name_local = m.properties.station_name_local ?? null
        }
        for (const l of m.properties.lines || []) entry.lines.add(l)
        keyMap.set(kName, entry)
        if (kLocal) keyMap.set(kLocal, entry)
      }
      // 折疊同站前綴噪音名：OSM 常給同一站的出入口/代碼變體不同名（Baku
      // "28 May"／"28 May 2nd entrance"／"28 May mst" 其實同站）。某名正規化字串
      // 以另一個較短名為前綴者＝同站，把 lines 併進短名、丟長名。以長度升序找 base
      // 確保短名先定；輸出仍照原本 entries 順序（代表點排第一）。
      const byLen = [...entries].sort(
        (a, b) => normName(a.station_name).length - normName(b.station_name).length)
      const removed = new Set()
      for (const e of byLen) {
        const ke = normName(e.station_name)
        const base = byLen.find((b) => b !== e && !removed.has(b)
          && normName(b.station_name).length < ke.length && ke.startsWith(normName(b.station_name)))
        if (base) { for (const l of e.lines) base.lines.add(l); removed.add(e) }
      }
      const mergedNames = entries.filter((e) => !removed.has(e)).map((e) => ({
        station_id: e.station_id,
        station_name: e.station_name,
        station_name_local: e.station_name_local,
        lines: [...e.lines].sort(),
      }))
      const allCodes = new Set()
      for (const m of members) for (const c of (m.__codes || [])) allCodes.add(c)
      keep.push({
        type: 'Feature',
        properties: {
          ...first.properties,
          lines: lines.length ? lines : null,
          merged_from: members.length,
          merged_names: mergedNames.length > 1 ? mergedNames : null,
        },
        geometry: { type: 'Point', coordinates: [lon, lat] },
        ...(allCodes.size ? { __codes: allCodes } : {}),
      })
      for (const m of members)
        aliases.push({ c: m.geometry.coordinates, rep: [lon, lat] })
    }
    grp.stations = keep
    grp.__snapAliases = aliases
  }
  // ---- drop stations that serve no operational line (invariant 2) ----
  // A station the widened matching still can't tie to any line is either a
  // station of an excluded (under-construction / out-of-scope) route or noise;
  // "operational" means served by an operational route, so it doesn't ship.
  let orphansDropped = 0
  for (const grp of cityGroups.values()) {
    const before = grp.stations.length
    grp.stations = grp.stations.filter((f) => (f.properties.lines || []).length)
    orphansDropped += before - grp.stations.length
  }
  // ---- line geometry = merged station points connected in stop order ----
  // Invariants (see metro-audit skill): every line has stations; every vertex
  // (bend) of a line IS a station; both endpoints ARE stations. So the final
  // polyline keeps ONLY vertices that snap (≤ ~600 m) to a merged station
  // point, in original stop order, consecutive duplicates collapsed
  // (several stop_positions of one interchange → one vertex). Sequences left
  // with <2 stations are dropped; lines left with no sequence are dropped
  // (a line without stations is not shippable — audit flags the city if
  // coverage suffers).
  const SNAP = 0.006 // ~600 m
  let snapped = 0, droppedVerts = 0, droppedLines = 0
  for (const grp of cityGroups.values()) {
    if (!grp.lines.length) continue
    const sGrid = new Map()
    const sKey = (lon, lat) => `${Math.round(lon / SNAP)}:${Math.round(lat / SNAP)}`
    const addSnapPoint = (c, rep) => {
      const k = sKey(c[0], c[1])
      if (!sGrid.has(k)) sGrid.set(k, [])
      sGrid.get(k).push({ c, rep })
    }
    const repAlive = new Set(grp.stations.map((f) => f.geometry.coordinates.join(',')))
    for (const f of grp.stations) addSnapPoint(f.geometry.coordinates, f.geometry.coordinates)
    // 合併成員的原座標也是吸附目標（映射回代表點）——質心位移不甩站；
    // 代表點已被 orphan-drop 移除者不得借屍還魂
    for (const a of grp.__snapAliases ?? [])
      if (repAlive.has(a.rep.join(','))) addSnapPoint(a.c, a.rep)
    const nearestStation = (lon, lat) => {
      const gx = Math.round(lon / SNAP), gy = Math.round(lat / SNAP)
      let best = null, bestD = Infinity
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
        for (const { c, rep } of sGrid.get(`${gx + dx}:${gy + dy}`) || []) {
          const d = (c[0] - lon) ** 2 + (c[1] - lat) ** 2
          if (d < bestD) { bestD = d; best = rep }
        }
      return best && Math.sqrt(bestD) < SNAP ? best : null
    }
    for (const f of grp.lines) {
      f.geometry.coordinates = f.geometry.coordinates.map((seq) => {
        const out = []
        for (const [lon, lat] of seq) {
          const st = nearestStation(lon, lat)
          if (!st) { droppedVerts++; continue }  // bend that is no station → out
          snapped++
          const last = out[out.length - 1]
          if (!last || last[0] !== st[0] || last[1] !== st[1]) out.push(st)
        }
        return out
      }).filter((seq) => seq.length >= 2)
    }
    const before = grp.lines.length
    grp.lines = grp.lines.filter((f) => {
      if (f.geometry.coordinates.length) return true
      if (process.env.DEBUG_SNAP) console.log('  [line-dropped]',
        JSON.stringify(grp.info.city), '| stations-in-bucket:', grp.stations.length,
        '|', f.properties.route_name)
      return false
    })
    droppedLines += before - grp.lines.length

    // ---- 自動快車跨站共線（使用者：像雪梨官方 CityRail 圖，很多路線共線、跳過的站是 pass）----
    // 路線的長跳站邊 A→C（快車直達，>2 km），若另一條線走 A→中間站→C 的近直線路徑（總長
    // ≤1.35× 直線，非繞路），就把中間站插入此線幾何當 pass-through 頂點，使共用走廊被路段化
    // 判為共線、畫在一起（雪梨 T1 跳內西區＝T2 慢車、Seven Hills–Westmead＝T5）。中間站
    // **不算此線停靠**（記入 __passCoords，__stations/__vertexOwners 排除）。此時幾何已 snap
    // 成站座標，同站＝同座標字串。手動 override 已注入者（已是短邊）自然跳過。
    if (grp.lines.length >= 2) {
      // 紐約特例：快車跳站的長邊常 <2 km（曼哈頓 express 跳 1 個 local 站 ~0.6–1.5 km），
      // 通用 2 km 門檻會漏掉（A 跳 Spring St、B 跳 Cortelyou）。NYC 降到 0.35 km，仍靠
      // ≤1.35× 繞路守衛擋偽陽性（跳邊必須另有一線走 A→…→C 的近直線共軌路徑）。
      const passMinKm = /new york city/i.test(grp.info.city || '') ? 0.35 : 2
      const kmd = (a, b) => Math.hypot((a[0] - b[0]) * 111 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 111)
      const coordOf = new Map()
      for (const s of grp.stations) coordOf.set(s.geometry.coordinates.join(','), s.geometry.coordinates)
      const others = grp.lines.map((f) => f.geometry.coordinates.map((seq) => seq.map((c) => c.join(','))))
      for (let fi = 0; fi < grp.lines.length; fi++) {
        const F = grp.lines[fi]
        // 排除名單：獨立路線的跳站長邊剛好與另一條線平行但不共軌（如巴黎 14 號線）
        if ((F.properties.osm_route_ids || []).some((r) => noAutoPassRids.has(r))) continue
        for (const seq of F.geometry.coordinates) {
          for (let i = 0; i < seq.length - 1; i++) {
            const A = seq[i], C = seq[i + 1], ak = A.join(','), ck = C.join(',')
            if (ak === ck || kmd(A, C) < passMinKm) continue
            const d = kmd(A, C)
            let bestVia = null
            for (let gi = 0; gi < others.length; gi++) {
              if (gi === fi) continue
              for (const gs of others[gi]) {
                const ai = gs.indexOf(ak), ci = gs.indexOf(ck)
                if (ai < 0 || ci < 0 || Math.abs(ci - ai) < 2) continue
                const lo = Math.min(ai, ci), hi = Math.max(ai, ci)
                const subKeys = gs.slice(lo, hi + 1)
                const sub = subKeys.map((k) => coordOf.get(k))
                if (sub.some((c) => !c)) continue
                let len = 0; for (let k = 1; k < sub.length; k++) len += kmd(sub[k - 1], sub[k])
                if (len > d * 1.35) continue
                let inner = subKeys.slice(1, -1)
                if (ai > ci) inner = inner.slice().reverse()
                if (!bestVia || inner.length > bestVia.length) bestVia = inner
              }
            }
            if (bestVia && bestVia.length) {
              const viaCoords = bestVia.map((k) => coordOf.get(k))
              F.__passCoords = F.__passCoords || new Set()
              for (const c of viaCoords) F.__passCoords.add(c.join(','))
              seq.splice(i + 1, 0, ...viaCoords)
              i += viaCoords.length
            }
          }
        }
      }
    }

    // which surviving lines own each vertex coordinate (for the consistency pass)
    grp.__vertexOwners = new Map()
    for (const f of grp.lines) {
      const tag = featTag.get(f)
      for (const seq of f.geometry.coordinates)
        for (const c of seq) {
          // 快車 pass-through 頂點：幾何經過但不「擁有」該站（Olympic 等不列 AEL）
          if (f.__passCoords && [...f.__passCoords].some((pk) => {
            const [pl, pt] = pk.split(',').map(Number)
            return Math.abs(c[0] - pl) < 1e-3 && Math.abs(c[1] - pt) < 1e-3
          })) continue
          const k = c.join(',')
          if (!grp.__vertexOwners.has(k)) grp.__vertexOwners.set(k, new Set())
          if (tag) grp.__vertexOwners.get(k).add(tag)
        }
    }
  }

  // final consistency（三者一致的唯一權威）：站的 `lines` **只認它座標實際落在
  // 哪些線頂點上**（`__vertexOwners`＝snap 後每個線頂點座標的 owner tags），
  // **完全不信任 `nearbyLineRefs` 的 900 m 鄰近猜測**。這保證：
  //   站在線上 ⟺ 站屬於該線（lines）⟺ 該線站單（__stations）有此站——三者一致。
  // 不落在任何線頂點的站（浮空點）一律剔除（消除「有站點卻沒路線經過」的點）。
  // 代價：OSM route 漏列 stop 成員的真站（深圳7號線漏文體公園）會被剔除——那是
  // 上游資料缺陷，寧缺勿錯（要補得定向 refetch 修好 route 成員，見 [[metro-audit]]）。
  for (const grp of cityGroups.values()) {
    const alive = new Set(grp.lines.map((f) => featTag.get(f)).filter(Boolean))
    const owners = grp.__vertexOwners ?? new Map()
    grp.stations = grp.stations.filter((s) => {
      const adopted = owners.get(s.geometry.coordinates.join(','))
      const left = adopted?.size ? [...adopted].filter((t) => alive.has(t)).sort() : []
      if (!left.length) return false
      s.properties.lines = left
      return true
    })
    delete grp.__vertexOwners
  }

  // ---- station role: terminus / interchange / normal ----
  // Derived from the FINAL snapped geometry — endpoints are exact station
  // coords, so this matches what's drawn (and what Wikipedia / urbanrail.net
  // show). interchange = **通過次數 ≥2**（使用者規則：同一路線通過同站兩次也算
  // 兩次——支線交會、環線繞經皆計；環線閉合點首尾同座標不重複計）。
  // terminus = an endpoint of some line (circle lines excluded).
  // Single role, interchange > terminus; is_terminus kept as separate flag.
  for (const grp of cityGroups.values()) {
    // grp.lines are still per-route here (segmentization is below) — map each
    // line's tag (as carried in station.lines) to its route id/name/ref/color.
    const tagMeta = new Map()
    for (const f of grp.lines) {
      const tag = featTag.get(f)
      if (tag != null && !tagMeta.has(tag)) tagMeta.set(tag, f.properties)
    }
    const byCoord = new Map()
    for (const s of grp.stations) {
      s.properties.is_terminus = false
      byCoord.set(s.geometry.coordinates.join(','), s)
    }
    // 通過次數：每條 route 的每個幾何頂點各計一次（閉合環的閉合頂點減一次）
    const passCount = new Map()
    for (const f of grp.lines) {
      for (const seq of f.geometry.coordinates) {
        if (seq.length < 2) continue
        for (const c of seq) {
          const k = c.join(',')
          if (byCoord.has(k)) passCount.set(k, (passCount.get(k) ?? 0) + 1)
        }
        const a = seq[0], b = seq[seq.length - 1]
        if (a[0] === b[0] && a[1] === b[1]) {
          const k = a.join(',')
          if (passCount.has(k)) passCount.set(k, passCount.get(k) - 1)
        }
      }
    }
    // 網絡圖「度數」：每站在所有 route 幾何裡的**不同相鄰頂點**數（使用者規則）。
    // interchange ⇔ degree>2（分歧點／交會點——相鄰站不同）；**同路線共軌重疊段
    // 中間站**兩線給相同前後鄰 → degree=2，不算 interchange（如淡海輕軌綠山＋藍海
    // 共軌段）；分歧點 濱海沙崙（往崁頂／往漁人碼頭／往紅樹林 3 鄰）與支線分歧
    // 七張（新店側／公館側／小碧潭 3 鄰）degree=3 → interchange；terminus degree=1。
    const degree = new Map()
    for (const f of grp.lines) {
      // 快車 pass 頂點**計入 degree**（使用者裁決 2026-07：顯徑要紅點）：pass 鏈沿共軌
      // 走廊時給的前後鄰與慢車完全相同 → degree 不變、共軌中間 pass 站仍是黑點（紐約
      // express 沿 local 走廊、AEL 沿 TCL 的中間站不變紅）；但 pass 線在**分岔點**離開
      // 走廊時貢獻新鄰居（EAL 在顯徑往九龍塘、AEL 在欣澳往機場）→ degree>2 ＝ 視覺上
      // 真實的分歧紅點。pass 站仍不進停靠（__stations／lines／terminus 照舊排除）。
      for (const seq of f.geometry.coordinates) {
        if (seq.length < 2) continue
        for (let i = 0; i < seq.length; i++) {
          const k = seq[i].join(',')
          if (!byCoord.has(k)) continue
          if (!degree.has(k)) degree.set(k, new Set())
          if (i > 0) degree.get(k).add(seq[i - 1].join(','))
          if (i < seq.length - 1) degree.get(k).add(seq[i + 1].join(','))
        }
      }
    }
    // 每站有幾條**不同的線在此終止**（端點）。terminus-interchange：兩條線各自從
    // 不同方向到此為終點站（Monterrey General I. Zaragoza：L2、L3 都在此止），
    // degree=2 被 degree>2 漏判——但這是真的轉乘點（使用者：≥2 路段相交＝紅點）。
    // 與「共軌中間站」不同：共軌站沒有線在此終止（termLines=0）→ 仍不算 interchange。
    const termLines = new Map()
    const addTerm = (k, rid) => {
      if (!termLines.has(k)) termLines.set(k, new Set())
      termLines.get(k).add(rid)
    }
    const passByStation = new Map() // station_id -> Set<routeTag>（行經但不停靠此站的服務）
    // station_id → 官方站碼集（共站合併時各成員節點的 ref 聚成，如台北車站 {A1,R10,BL12}）
    const codesById = new Map()
    for (const s of grp.stations) if (s.__codes?.size) codesById.set(s.properties.station_id, s.__codes)
    // 依本線 ref 字首挑出該線的碼（機捷 ref「A」→ A1；板南「BL」→ BL12），供官方順序排序。
    const codeKey = (c) => { const m = String(c).match(/^([A-Za-z]+)(\d+)([a-z]*)/); return m ? [m[1].toUpperCase(), +m[2], m[3]] : null }
    for (const f of grp.lines) {
      // ordered station list for this route：各分段頂點**原序串接、不去重**
      //（使用者規則：列表相鄰＝圖上直連。支線的接續站在支線段開頭重複出現、
      // 環狀線最後回到第一個車站——與 pass_count「通過兩次算兩次」語義一致；
      // 站數統計一律用唯一站數）
      const sts = []
      const passSts = []            // 此線行經但不停靠的站（快車跳站）
      const fTag = featTag.get(f)
      for (const seq of f.geometry.coordinates) {
        if (seq.length < 2) continue
        for (const c of seq) {
          const s = byCoord.get(c.join(','))
          if (!s) continue
          // 快車 pass-through 頂點：幾何經過但不停靠（機場快線跳過的東涌線中間站）。
          // snap 後座標精度變了，用鄰近比對（~110 m；快車真停靠站離 pass 站夠遠）。
          // 舊做法直接丟棄；新做法**保留並標 pass**（供 route.pass_stations／
          // station.pass_lines 表達「X 服務行經卻不停 Y 站」），仍不計入停靠 __stations。
          const isPassC = f.__passCoords && [...f.__passCoords].some((k) => {
            const [pl, pt] = k.split(',').map(Number)
            return Math.abs(c[0] - pl) < 1e-3 && Math.abs(c[1] - pt) < 1e-3
          })
          if (isPassC) {
            passSts.push({ station_id: s.properties.station_id, station_name: s.properties.station_name })
            if (!passByStation.has(s.properties.station_id)) passByStation.set(s.properties.station_id, new Set())
            passByStation.get(s.properties.station_id).add(fTag)
            continue
          }
          sts.push({ station_id: s.properties.station_id,
            station_name: s.properties.station_name })
        }
        const a = seq[0], b = seq[seq.length - 1]
        // closed loop: ends identical, or ~adjacent on a many-stop ring
        if ((a[0] === b[0] && a[1] === b[1]) ||
            (seq.length >= 6 && segD(a, b) < 0.011)) continue
        const fRid = tagMeta.get(featTag.get(f))?.route_id ?? featTag.get(f)
        for (const end of [a, b]) {
          const k = end.join(',')
          const s = byCoord.get(k)
          if (s) { s.properties.is_terminus = true; addTerm(k, fRid) }
        }
      }
      // 官方站碼：依本線 ref 字首挑碼，寫進每站 `code`；並依碼**正規化方向**（官方碼升序、
      // A1 在前）——只反轉整條序列（保留相鄰性/圖上直連不變）。ref 缺或碼不齊則維持成員順序。
      const ref = f.properties.route_ref
      if (ref) {
        // 只挑「字母字首＝本線 ref」的官方碼（機捷 A1↔ref A、東京 T22↔ref T、港鐵 TML…）；
        // 純數字 GTFS/非官方碼（NYC 302N、HK 430）codeKey 無字母字首→不挑、不影響排序。
        const refU = String(ref).toUpperCase()
        const pickCode = (sid) => { const cs = codesById.get(sid); if (cs) for (const c of cs) { const k = codeKey(c); if (k && k[0] === refU) return c } return null }
        for (const st of sts) { const c = pickCode(st.station_id); if (c) st.code = c }
        const coded = sts.filter((s) => s.code && codeKey(s.code))
        if (coded.length >= 2) {
          const a = codeKey(coded[0].code), b = codeKey(coded[coded.length - 1].code)
          if (a[1] > b[1]) sts.reverse() // 首站碼 > 末站碼 → 降序 → 反轉成 A1 在前
        }
      }
      f.__stations = sts
      f.__passStations = passSts
    }
    // 站↔線歸屬一律以 **route_id**（每條線唯一）建立，不用 ref——機捷普通車/直達車都
    // ref「A」會撞（台北車站漏掉直達車、興南 pass 指到普通車）。停靠＝該站在某線的
    // __stations；行經＝在某線的 __passStations。route_id → 該線 ref/名/色。
    const stopRoutesBySt = new Map(), passRoutesBySt = new Map(), routeInfoById = new Map()
    for (const f of grp.lines) {
      const rid = f.properties.route_id
      routeInfoById.set(rid, { id: rid, ref: f.properties.route_ref, name: f.properties.route_name, color: f.properties.route_color })
      for (const st of f.__stations ?? []) {
        if (!stopRoutesBySt.has(st.station_id)) stopRoutesBySt.set(st.station_id, new Set())
        stopRoutesBySt.get(st.station_id).add(rid)
      }
      for (const st of f.__passStations ?? []) {
        if (!passRoutesBySt.has(st.station_id)) passRoutesBySt.set(st.station_id, new Set())
        passRoutesBySt.get(st.station_id).add(rid)
      }
    }
    const routeMeta = (id) => {
      const r = routeInfoById.get(id), t = r ? null : tagMeta.get(id)
      return { route_id: r?.id ?? t?.route_id ?? id, route_name: r?.name ?? t?.route_name ?? id,
        route_ref: r?.ref ?? t?.route_ref ?? null, route_color: r?.color ?? t?.route_color ?? null }
    }
    for (const s of grp.stations) {
      const sid = s.properties.station_id
      // 停靠 route_id：__stations 歸屬 ∪ 既有 lines(tag)（含浮空站 nearbyLineRefs 指派、不漏）
      const stopIds = new Set(stopRoutesBySt.get(sid) ?? [])
      for (const tag of s.properties.lines || []) { const p = tagMeta.get(tag); stopIds.add(p?.route_id ?? tag) }
      const routes = [...stopIds].map(routeMeta)
      routes.sort((a, b) => String(a.route_ref ?? a.route_name ?? '')
        .localeCompare(String(b.route_ref ?? b.route_name ?? ''), undefined, { numeric: true }))
      s.properties.line_ids = routes.map((r) => r.route_id)
      s.properties.line_names = routes.map((r) => r.route_name)
      s.properties.lines = routes.map((r) => r.route_ref ?? r.route_name) // refs（顯示/相容，與 line_ids 同序、可重複）
      // 官方站碼清單（如台北車站 [A1, BL12, R10]）——各線各自的碼；route.stations 每站另帶
      // 依該線 ref 挑出的 `code`。內部 Set 清掉（避免序列化成 {}）。
      if (s.__codes?.size) s.properties.codes = [...s.__codes].sort()
      delete s.__codes
      // 行經但不停靠（快車跳站）：route_id 直接來自 __passStations；排除也停靠者。
      const passIds = [...(passRoutesBySt.get(sid) ?? [])].filter((id) => !stopIds.has(id))
      if (passIds.length) {
        const pr = passIds.map(routeMeta)
        s.properties.pass_line_ids = pr.map((r) => r.route_id)
        s.properties.pass_lines = pr.map((r) => r.route_ref ?? r.route_name)
      }
      // 通過次數（幾何為準）；至少為所屬 route 數（幾何缺漏時的下限）
      const pc = Math.max(
        passCount.get(s.geometry.coordinates.join(',')) ?? 0, routes.length)
      s.properties.pass_count = pc
      // interchange ⇔ 網絡圖度數 >2（使用者規則）：分歧點／交會點（相鄰站不同）算，
      // **同路線共軌重疊段中間站不算**（degree=2，兩線給相同前後鄰，如淡海輕軌綠山
      // ＋藍海共軌段）。濱海沙崙／七張分歧 degree=3 → interchange。pass_count 保留
      // 為參考屬性。
      const coordKey = s.geometry.coordinates.join(',')
      const deg = degree.get(coordKey)?.size ?? 0
      const termCount = termLines.get(coordKey)?.size ?? 0
      s.properties.station_degree = deg
      // interchange ⇔ degree>2（分歧/交會）**或** ≥2 條不同線在此終止（terminus-
      // interchange，如 Zaragoza）**或** 端點站且停靠 ≥2 條線（使用者全域規則：藍色
      // 端點站不可能有超過 1 條路線；若有＝可轉乘＝紅點——涵蓋「A 線在此為終點、B 線
      // 經過並停靠、共用進站方向使 degree=2」的漏判）。三者皆為「≥2 路段相交」；共軌
      // 中間站（非端點、degree=2、termCount=0）仍不算。
      const isIx = deg > 2 || termCount >= 2 || (s.properties.is_terminus && routes.length >= 2)
      s.properties.is_interchange = isIx
      s.properties.station_role = isIx ? 'interchange'
        : s.properties.is_terminus ? 'terminus' : 'normal'
    }
    // 快取殭屍清理：無名（合成名 n123…）且不屬於任何線站序的站點＝上游已刪
    // 或從未真正在線上（僅靠 900 m 鄰近被指派 lines）——剔除（站名 100% 不變式）。
    {
      const used = new Set()
      for (const f of grp.lines) {
        for (const st of f.__stations ?? []) used.add(st.station_id)
        for (const st of f.__passStations ?? []) used.add(st.station_id)
      }
      const before = grp.stations.length
      grp.stations = grp.stations.filter((s) =>
        used.has(s.properties.station_id) ||
        !/^[nwr]\d+$/.test(s.properties.station_name || ''))
      if (grp.stations.length !== before && process.env.DEBUG_LRT)
        console.log('  [zombie]', grp.info.city, before - grp.stations.length, 'unnamed off-line points dropped')
    }
  }

  // ---- 路段化：重疊路段只畫一條（routes list）----
  // Consecutive station pairs (edges) shared by several routes are drawn once.
  // Runs of edges with the identical route set become one segment feature with
  // `routes: [{...}, ...]`. Per-route station order is checked HERE (the last
  // moment the full per-route path exists) and recorded as `order_suspect`.
  let totalSegments = 0, totalRoutes = 0
  for (const grp of cityGroups.values()) {
    const routeFeats = grp.lines
    grp.routeCount = routeFeats.length
    totalRoutes += routeFeats.length
    if (!routeFeats.length) continue
    const metaCache = new Map()
    const metaOf = (f) => {
      if (!metaCache.has(f)) {
        const p = f.properties
        metaCache.set(f, {
          route_id: p.route_id, route_name: p.route_name,
          route_name_local: p.route_name_local, route_ref: p.route_ref,
          route_color: p.route_color, network: p.network,
          network_local: p.network_local, operator: p.operator,
          wikidata: p.wikidata, wikipedia: p.wikipedia,
          osm_route_ids: p.osm_route_ids,
          status: p.status ?? null,
          order_suspect: suspectOrder(f),
          // all stations of this route, in stop order (id + name)
          stations: f.__stations ?? [],
          // 此服務行經但**不停靠**的站（快車跳站）——快車＝獨立 route，其 pass_stations 由
          // pass-through 偵測算出（與 NYC 一致的全球統一格式）。空陣列＝各停。
          pass_stations: f.__passStations ?? [],
        })
      }
      return metaCache.get(f)
    }
    const cs = (c) => c.join(',')
    const ekey = (a, b) => { const x = cs(a), y = cs(b); return x < y ? `${x}|${y}` : `${y}|${x}` }
    // pass 1: which routes traverse each edge
    const edgeRoutes = new Map()
    routeFeats.forEach((f, ri) => {
      for (const seq of f.geometry.coordinates)
        for (let i = 1; i < seq.length; i++) {
          const k = ekey(seq[i - 1], seq[i])
          if (!edgeRoutes.has(k)) edgeRoutes.set(k, new Set())
          edgeRoutes.get(k).add(ri)
        }
    })
    const sigOf = (k) => [...edgeRoutes.get(k)].sort((a, b) => a - b).join('/')
    // pass 2: walk each route, emit every edge once, grouped into runs of equal signature
    const emitted = new Set()
    const segs = new Map() // signature -> array of coordinate sequences
    for (const f of routeFeats) {
      for (const seq of f.geometry.coordinates) {
        let run = null, runSig = null
        const flush = () => {
          if (run && run.length >= 2) {
            if (!segs.has(runSig)) segs.set(runSig, [])
            segs.get(runSig).push(run)
          }
          run = null; runSig = null
        }
        for (let i = 1; i < seq.length; i++) {
          const k = ekey(seq[i - 1], seq[i])
          if (emitted.has(k)) { flush(); continue }
          emitted.add(k)
          const s = sigOf(k)
          if (run && runSig === s) run.push(seq[i])
          else { flush(); runSig = s; run = [seq[i - 1], seq[i]] }
        }
        flush()
      }
    }
    grp.lines = [...segs.entries()].map(([sig, seqs], si) => {
      const routes = sig.split('/').map((i) => metaOf(routeFeats[+i]))
      const colors = routes.map((r) => r.route_color || '#e11d48')
      return {
        type: 'Feature',
        properties: {
          seg_id: `${slugify(grp.info.city) || 'x'}-${si}`,
          routes,
          route_count: routes.length,
          route_refs: routes.map((r) => r.route_ref || r.route_name),
          route_colors: colors,
          route_color: colors[0],
          city: grp.info.city, country: grp.info.country,
        },
        geometry: { type: 'MultiLineString', coordinates: seqs },
      }
    })
    totalSegments += grp.lines.length
  }
  console.log(`  segmented: ${totalRoutes} routes -> ${totalSegments} segment features ` +
    '(overlapping stretches drawn once)')

  // prune buckets left with neither lines nor stations (stray station nodes /
  // out-of-scope fragments end up here after the drops; they are not systems),
  // and buckets that never resolved to a city — 不會有 unknown 輸出：定位不到
  // 城市的雜訊（機場擺渡、遊樂園軌道…）一律不寫檔、不進 index。
  let pruned = 0
  for (const [key, grp] of [...cityGroups]) {
    if (!grp.info.city || (!grp.lines.length && !grp.stations.length)) {
      cityGroups.delete(key); pruned++
    }
  }

  // rebuild the global layers from the per-city groups
  stationFeatures.length = 0
  for (const grp of cityGroups.values()) stationFeatures.push(...grp.stations)
  lineFeatures.length = 0
  for (const grp of cityGroups.values()) lineFeatures.push(...grp.lines)
  console.log(`  merged ${mergedAway} duplicate same-named station points; ` +
    `dropped ${orphansDropped} stations with no operational line; ` +
    `line vertices: ${snapped} = stations, ${droppedVerts} non-station bends removed, ` +
    `${droppedLines} station-less lines dropped; pruned ${pruned} empty buckets`)

  await writeOutputs(lineFeatures, stationFeatures, cityGroups, wikiSystems)
}

const fc = (features, extra = {}) => ({ type: 'FeatureCollection', ...extra, features })

async function writeOutputs(lines, stations, cityGroups, wikiSystems) {
  await mkdir(SYS_DIR, { recursive: true })
  const auditState = await readAuditState()
  console.log(`\nWriting global layers: ${lines.length} lines, ${stations.length} stations`)
  await writeFile(join(BASE, 'metro_lines.geojson'), JSON.stringify(fc(lines)))
  await writeFile(join(BASE, 'metro_stations.geojson'), JSON.stringify(fc(stations)))

  const index = []
  const groups = [...cityGroups.values()].sort((a, b) => b.lines.length - a.lines.length)
  for (const grp of groups) {
    const { info } = grp
    const relPath = `${info.key}.geojson`
    const feats = [...grp.lines, ...grp.stations]
    const wp = grp.wikipedia
    let wikiUrl = null
    if (wp) {
      if (wp.startsWith('http')) wikiUrl = wp
      else if (wp.includes(':')) {
        const [lang, ...rest] = wp.split(':')
        wikiUrl = `https://${lang}.wikipedia.org/wiki/${rest.join(':').replace(/ /g, '_')}`
      }
    }
    const audit = auditState[`${info.city}|${info.country}`] ?? null
    const systemMeta = {
      continent: info.continent, country: info.country, city: info.city,
      osm_networks: [...grp.networks].sort(),
      operator: grp.operator,
      official_website: grp.official_url,
      official_map: wikiUrl,
      wikidata: grp.wikidata,
      // line_count = number of ROUTES; the geometry is stored as overlap-deduped
      // segment features (segment_count) whose `routes` lists the routes on them
      line_count: grp.routeCount ?? grp.lines.length,
      segment_count: grp.lines.length,
      station_count: grp.stations.length,
      // per-city audit verdict (scripts/auditLoop.mjs): passed / reasons / checks
      audit,
    }
    const outPath = join(SYS_DIR, relPath)
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, JSON.stringify(fc(feats, { metro_system: systemMeta })))
    index.push({ file: `systems/${relPath}`, ...systemMeta })
  }

  // stale-file cleanup：桶的命名/歸屬改變時，上一輪寫出的舊檔要刪掉
  // （index 不引用的 systems/*.geojson 一律不留，避免殘留誤導）
  {
    const wanted = new Set(index.map((i) => join(BASE, i.file)))
    const walk = async (d) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else if (p.endsWith('.geojson') && !wanted.has(p)) {
          await rm(p, { force: true })
          console.log(`  stale removed: ${p.slice(BASE.length + 1)}`)
        }
      }
    }
    try { await walk(SYS_DIR) } catch { /* first run */ }
  }

  const matchedCities = new Set(index.map((i) => i.city).filter(Boolean))
  const missing = wikiSystems
    .filter((s) => !matchedCities.has(s.city))
    .map((s) => ({ city: s.city, country: s.country, name: s.name }))

  await writeFile(join(BASE, 'index.json'), JSON.stringify({
    generated_from: 'OpenStreetMap via Overpass API (route=subway|light_rail, operational only; ' +
      'line geometry = stops connected in member order; same-named stations merged)',
    baseline: 'Wikipedia: List of metro systems',
    system_count: index.length,
    wikipedia_system_count: wikiSystems.length,
    line_total: lines.length,
    station_total: stations.length,
    systems: index,
    wikipedia_cities_without_match: missing,
  }, null, 2))

  console.log(`  ${index.length} systems written to ${SYS_DIR}`)
  console.log(`  matched ${matchedCities.size} cities; ${missing.length} wikipedia systems unmatched by city name`)
  console.log(`  index -> ${join(BASE, 'index.json')}`)
}

build().catch((e) => { console.error(e); process.exit(1) })
