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
const SYS_DIR = join(BASE, 'metro-maps')
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
  // OSM 偶用 CSS Level 3 具名色（未進上表會原樣落到 route_color，前端當無效色）
  // Moscow Line 2 = darkgreen；Baku 2B = lightgreen；Sendai = DeepSkyBlue / SeaGreen
  darkgreen: '#006400', lightgreen: '#90ee90',
  deepskyblue: '#00bfff', seagreen: '#2e8b57',
  darkblue: '#00008b', lightblue: '#add8e6', skyblue: '#87ceeb',
  darkred: '#8b0000', lightcoral: '#f08080', coral: '#ff7f50',
  darkorange: '#ff8c00', darkviolet: '#9400d3', mediumpurple: '#9370db',
  forestgreen: '#228b22', mediumseagreen: '#3cb371', springgreen: '#00ff7f',
  steelblue: '#4682b4', royalblue: '#4169e1', dodgerblue: '#1e90ff',
  crimson: '#dc143c', tomato: '#ff6347', orangered: '#ff4500',
  chocolate: '#d2691e', saddlebrown: '#8b4513', sandybrown: '#f4a460',
  hotpink: '#ff69b4', deeppink: '#ff1493', mediumvioletred: '#c71585',
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
    // 去尾端**未閉合**的「(終點/方向」殘骸——OSM name 常見「(A=>B)」「(A → B)」被上面的
    // 箭頭尾綴規則截掉「=>B)」後留下不成對的「(A」（大阪 長堀鶴見緑地線「(大正=>門真南)」→「(大正」、
    // 星國/德里/孟買各線同病）。只吃「(」後接非括號字元直到結尾者，成對的「(分支)」不受影響。
    .replace(/\s*[（(][^（()）]*$/u, '')
    .replace(/\s*[（(]\s*[)）]\s*$/u, '') // 去空括號
    .trim()
  return s || String(nm)
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
// 機廠/車輛段中文設施名一律排除；英文 "depot" 需小心——**乘客路線/車站常以其
// 機廠端點命名**（清奈 Blue Line 終點站「Wimco Nagar Depot」、諾伊達 Aqua Line
// 終點「Depot Station」都是真乘客站），那不是出入段線。故英文 depot 只在「無乘客
// 線碼 ref、且不是正式車站（無 station 標、railway≠station、名稱不含 station）」時
// 才視為機廠出入段——真正的浮空 depot stop_position 才會中。中文設施名不受此限。
const DEPOT_ZH = /機廠|机厂|機厰|車輛段|车辆段/
const isDepot = (t = {}) => {
  const s = `${t.name || ''} ${t['name:en'] || ''}`
  if (DEPOT_ZH.test(s)) return true
  if (!/\bdepot\b/i.test(s)) return false
  if (t.ref) return false                                    // 有乘客線碼＝正式路線/車站
  if (t.railway === 'station' || t.station || /\bstation\b/i.test(s)) return false
  return true
}

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
const AIRPORT_APM = /旅客自動電車|自動電車運輸|航廈電車|航站.*電車|셔틀트레인|people ?mover|\bapm\b|sky\s?train|aero\s?train|air\s?train|plane ?train|shuttle ?(?:tram|train)|terminal (?:shuttle|train|tram)|\bCDGVAL\b|\bOrlyval\b/i
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
  // pass-through auto 偵測畫成共線（AEL/TCL 式）。
  // 使用者裁決 2026-07：**AM/PM rush 一律不抓**——含「(am/pm rush)」寫法（舊 regex 漏抓）
  // 與 <6>/<7>/<F> 菱形尖峰車 ref（整個 ref 剔除；6/7/F 本體仍在）。Z 是官方常設服務
  // （J/Z skip-stop，見官方幹線表）→ 保留。僅限 network=NYC Subway。
  {
    const QUAL = /\((?:late nights?|am\/?pm rush|am rush|pm rush|rush hours?|evenings?|weekends?|weekday|middays?)\b/i
    const isNyc = (t) => t.network === 'NYC Subway' || t['network:en'] === 'NYC Subway'
    const baseRefs = new Set()
    for (const t of routesTags.values())
      if (isNyc(t) && t.ref && !QUAL.test(t.name || '')) baseRefs.add(t.ref)
    let dropped = 0
    for (const [rid, t] of [...routesTags])
      if (isNyc(t) && t.ref &&
          (/^<.+>$/.test(t.ref) || (baseRefs.has(t.ref) && QUAL.test(t.name || '')))) {
        routesTags.delete(rid); dropped++
      }
    if (dropped) console.log(`  NYC variant prune: dropped ${dropped} late-night/rush/<diamond> variants (kept daytime pattern)`)
  }

  // NYC 官方幹線色（使用者裁決 2026-07：路線色以官方幹線表為準——mta.info／
  // zh.wikipedia「紐約地鐵路線列表」，OSM 自帶的色全是近似色）。route 與 master
  // 的 colour 一律覆寫（master colour 會蓋代表 tags，兩層都要改）。
  const NYC_TRUNK_COLOR = {
    A: '#0039a6', C: '#0039a6', E: '#0039a6',            // IND 第八大道線
    B: '#ff6319', D: '#ff6319', F: '#ff6319', M: '#ff6319', // IND 第六大道線
    G: '#6cbe45',                                          // IND 跨城線
    L: '#a7a9ac',                                          // BMT 卡納西線
    J: '#996633', Z: '#996633',                            // BMT 納蘇街線
    N: '#fccc0a', Q: '#fccc0a', R: '#fccc0a', W: '#fccc0a', // BMT 百老匯線
    1: '#ee352e', 2: '#ee352e', 3: '#ee352e',              // IRT 百老匯-第七大道線
    4: '#00933c', 5: '#00933c', 6: '#00933c',              // IRT 萊辛頓大道線
    7: '#b933ad',                                          // IRT 法拉盛線
    T: '#00add0',                                          // IND 第二大道線
    S: '#808183',                                          // 接駁線
  }
  {
    const isNyc = (t) => t?.network === 'NYC Subway' || t?.['network:en'] === 'NYC Subway'
    const trunkOf = (ref) => NYC_TRUNK_COLOR[String(ref ?? '').replace(/[<>]/g, '')]
    for (const t of routesTags.values()) {
      const c = isNyc(t) && trunkOf(t.ref)
      if (c) t.colour = c
    }
  }

  const ovByRid = await readOverrides()
  const ucRids = await readUcRids()

  const mastersRaw = await readJSON('route_masters.json')
  const masterOf = new Map(), masterTags = new Map()
  const addMasters = (elements) => {
    for (const e of elements || []) {
      if (e.type !== 'relation') continue
      masterTags.set(e.id, e.tags || {})
      for (const m of e.members || []) if (m.type === 'relation') masterOf.set(m.ref, e.id)
    }
  }
  addMasters(mastersRaw.elements)
  // gap masters（scripts/fetchGapMasters.mjs）：基準查詢只抓 subway|light_rail 的
  // route_master，route=train／tram 的定向補抓要靠這批才分得出線——南非 Metrorail 的
  // route relation 沒有 ref（無 master 就一個方向一條線）、墨爾本 Metro Tunnel 貫通
  // 運營的 relation 用「EPH => SUY」箭頭 ref（靠 master 收回 Pakenham／Cranbourne 線）。
  for (const f of cacheFiles.filter((n) => /^gap_masters_.+\.json$/.test(n)))
    addMasters(JSON.parse(await readFile(join(CACHE, f), 'utf8')).elements)
  // route_tag_patches whose target is a route_master (master colour/ref overrides
  // the variant tags, so patching only the route relations wasn't enough——Bursaray
  // B2 master r7869622 carries colour=black). Apply to masterTags now.
  for (const p of routePatches) {
    const mt = masterTags.get(p.relation)
    if (!mt) continue
    Object.assign(mt, p.set)
    console.log(`  route_tag_patches (master): r${p.relation} ← ${JSON.stringify(p.set)}`)
  }
  // NYC 官方幹線色也要覆寫 master（master colour 蓋代表 tags）。
  for (const mt of masterTags.values()) {
    const nyc = mt?.network === 'NYC Subway' || mt?.['network:en'] === 'NYC Subway' || /NYCS/.test(mt?.name || '')
    const c = nyc && NYC_TRUNK_COLOR[String(mt.ref ?? '').replace(/[<>]/g, '')]
    if (c) mt.colour = c
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
  let codeOverrides = {}
  try {
    codeOverrides = JSON.parse(await readFile(join(OVERRIDES_DIR, 'station_codes.json'), 'utf8')).codes ?? {}
  } catch { /* none */ }
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
    // **覆寫也蓋在地語顯示鍵**（name:ja/zh/zh-Hant）——否則 nameFor 對日/台/中優先取
    // 在地語鍵，覆寫的 name 壓不過（東京 新線新宿：node name:ja=新線新宿 舊稱，改名 新宿
    // 才生效）。保留 name:en 不動（英文＝標題第二行）。
    if (ov) e.tags = { ...(e.tags || {}), name: ov, 'name:ja': ov, 'name:zh': ov, 'name:zh-Hant': ov }
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
  // nearRadius：freshness 的鄰域格數（±n 格 ≈ ±111n m）。預設 ±2（~222m）；
  // NYC 用 ±4（~444m）——曼哈頓長月台的上下行 stop 節點可距 >250m，±2 會把
  // 純反向變體誤判成「有新站」→ 同名同站的第二條線（使用者 2026-07 回報的
  // 重複路線）。NYC 的真分支（Lefferts/Rockaway…）都隔數公里，±4 安全。
  // 快車一律不抓（使用者裁決 2026-07，全球）：fresh=0 的快車變體（純子集、只跳站）
  // 一律丟棄——各停已涵蓋全部車站。像紐約 J/Z「不同車交錯停站」（彼此有對方沒有的站
  // → fresh>0）或獨立編號的快線（香港 AEL 自有 ref）自然保留，不需例外機制。
  const dedupeSeqs = (seqs, nearRadius = 2) => {
    const sorted = [...seqs].sort((a, b) => b.rows.length - a.rows.length)
    const covered = new Set(), kept = []
    const near = (r) => {
      const [cx, cy] = cellOf(r)
      for (let dx = -nearRadius; dx <= nearRadius; dx++)
        for (let dy = -nearRadius; dy <= nearRadius; dy++)
          if (covered.has(`${cx + dx}:${cy + dy}`)) return true
      return false
    }
    for (const w of sorted) {
      const fresh = w.rows.filter((r) => !near(r)).length
      // Keep any variant bringing ≥1 unseen station (short branches like
      // 小碧潭支線 add just 1-2 stations); pure reverse/express duplicates
      // (fresh = 0) are dropped. Overlap segmentization dedupes the shared
      // stretch afterwards, so keeping a mostly-overlapping branch is free.
      if (kept.length && fresh === 0) continue
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
      // master 的名稱鍵（含在地語 name:zh/name:ja…）一律覆蓋變體：master 名是
      // 「線名」等級、變體常是目的地/分支名——只覆蓋 name/name:en 會讓變體的
      // name:zh 蓋過 master（台北新北投支線變體毒到紅線主線名，2026-07 修正）。
      for (const k of Object.keys(mt))
        if (mt[k] && (k === 'ref' || k === 'colour' || k === 'name' || k.startsWith('name:'))) base[k] = mt[k]
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
    // 広島電鉄（廣電）路面電車（route=tram，由 fetchHiroden.mjs 補抓；使用者 2026-07-21
    // 裁決「只有廣島特例」收 tram）：pin 廣島，不靠 geocode 重心——廣電含宮島線一路向
    // 西南，重心會把同城的 Astram Line 拖出廣島桶。
    [/広島電鉄|廣島電鉄|hiroden|hiroshima electric railway/i,
      { city: 'Hiroshima', country: 'Japan', continent: 'asia' }],
    // ── 大洋洲：澳洲／紐西蘭（使用者 2026-07-23，依 urbanrail.net/au/oceania.htm
    // 「澳洲紐西蘭是 suburban rail 和 tram，除了 Sydney 外要重抓」＋「市郊鐵路＋電車都收」）。
    // 這些城市不在 wiki List of metro systems，geocode 只會給行政區名（North Canberra、
    // Newcastle-Maitland、District of Gungahlin…），且 route=train/tram 由 fetchOceania.mjs
    // 寫進 gap_* 快取——gap 的 network 從不進 geocodeSystems（只讀 stations/geom_*），
    // 故一律 pin。route=light_rail 的坎培拉/紐卡索本來就在基準查詢內，同樣 pin 城市名。
    // 墨爾本分成兩個系統檔（使用者裁決 2026-07-23「墨爾本分 Metro Trains 和 tram」）：
    //   Melbourne      ＝ Metro Trains 16 線（route=train）
    //   Melbourne Tram ＝ Yarra Trams 24 路線（route=tram）→ oc-aus-melbourne-tram
    // 兩網在同一座城市重疊，但車站會被複製進附近每個城市桶、再由 orphan-drop 清掉
    // 沒有該桶線路的那一份（見下方「跨城轉乘站複製」），故分桶安全；分桶還能避免
    // 電車停留場（名如「Stop 13: Flinders Street Station」）與火車站共站合併後
    // 把火車站改名。
    [/PTV - Metropolitan Train|Metro Trains Melbourne/i,
      { city: 'Melbourne', country: 'Australia', continent: 'oceania' }],
    [/PTV - Metropolitan Tram|Yarra Trams/i,
      { city: 'Melbourne Tram', country: 'Australia', continent: 'oceania' }],
    // 布里斯本 Translink 市郊線的 operator＝Queensland Rail（network "Translink" 與
    // 加拿大溫哥華 TransLink 撞名，不能用 network 當 key）。黃金海岸 G:link 的
    // network 也是 Translink、operator 是 Keolis Downer（跨城通用），改用
    // _overrides/australia-gold-coast.json 以 relation id 綁定。
    [/Queensland Rail/i, { city: 'Brisbane', country: 'Australia', continent: 'oceania' }],
    [/Transperth/i, { city: 'Perth', country: 'Australia', continent: 'oceania' }],
    [/Adelaide Metro/i, { city: 'Adelaide', country: 'Australia', continent: 'oceania' }],
    [/Canberra Metro/i, { city: 'Canberra', country: 'Australia', continent: 'oceania' }],
    [/Newcastle Transport/i, { city: 'Newcastle', country: 'Australia', continent: 'oceania' }],
    // 奧克蘭：network=AT（Auckland Transport），operator 有 Auckland One Rail 與
    // Transdev 兩種（Transdev 是跨國營運商、不可當 key），故以獨立 token "AT" 比對——
    // 全球快取內沒有其他 network/operator 以 AT 單獨成詞。
    [/(^|[\s;])AT([\s;]|$)/, { city: 'Auckland', country: 'New Zealand', continent: 'oceania' }],
    [/Metlink/i, { city: 'Wellington', country: 'New Zealand', continent: 'oceania' }],
    // ── 非洲（使用者 2026-07-23「模里西斯和一些非洲國家好像也有輕軌」，依
    // urbanrail.net/af/africa.htm）：輕軌／電車城市。tram 由 fetchAfrica.mjs 補抓，
    // light_rail（阿迪斯阿貝巴／阿布加／突尼斯）本來就在基準查詢內但 geocode 只給
    // 行政區名（Kirkos、Gwarinpa…），一律 pin。SETRAM（阿爾及利亞七城共用 operator）
    // 與模里西斯（完全無 network/operator 標籤）無法用 network 分辨，走 _overrides。
    [/Addis Ababa Light Rail/i, { city: 'Addis Ababa', country: 'Ethiopia', continent: 'africa' }],
    [/Abuja Rail Mass Transit/i, { city: 'Abuja', country: 'Nigeria', continent: 'africa' }],
    [/المترو الخفيف لمدينة تونس|نقل تونس|شركة النقل بتونس|(^|[\s;])TGM([\s;]|$)/,
      { city: 'Tunis', country: 'Tunisia', continent: 'africa' }],
    [/Casa Tram/i, { city: 'Casablanca', country: 'Morocco', continent: 'africa' }],
    [/(^|[\s;])STRS([\s;]|$)|Rabat-Salé Tram/i,
      { city: 'Rabat', country: 'Morocco', continent: 'africa' }],
    [/Alexandria Passenger Transport/i, { city: 'Alexandria', country: 'Egypt', continent: 'africa' }],
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
    const gNet0 = pick(repTags(g), 'network:en', 'network') || ''
    // 電車（route=tram）：同號路線的變體一律併成**一條線**畫共線（使用者裁決 2026-07-23
    // 「同路線就要畫共線；沒停站才用 pass」）。墨爾本 12d／57a／57d／75d… 是同號區間／
    // 車廠交路，若各自成線會把 24 條畫成 35 條同色重疊。規則：
    //   - 同 ref → 一個 route_id；幾何＝dedupe 後各變體（含有新站的車廠支）全部進同一線
    //   - 停靠＝各變體 stop 成員聯集（真的有停才算站）
    //   - pass 只用在「幾何行經但不停靠」（快車跳站／express_passthrough）；區間車沒跑到
    //     的外段不是 pass、也不另畫線
    const isTram = g.rids.every((r) => (routesTags.get(r) || {}).route === 'tram')
    const keptAll = dedupeSeqs(g.seqs, /nyc subway|new york city subway/i.test(gNet0) ? 4 : 2)
    if (!keptAll.length) continue
    // 支線/分支＝獨立路線（使用者 Option 1：凡有新站的分岔都算支線→獨立 route_id，
    // 只有「0 新站」的純重複/反向/子集短交路才併）。dedupeSeqs 已丟掉 0 新站的重複；
    // keptAll 剩下的每個變體都帶來新站 → 主線＝最長變體、其餘各自獨立成 route_id。
    //   例：香港東鐵綫 EAL 主線 + 羅湖/落馬洲兩端 + 馬場支線各自獨立；台北小碧潭獨立；
    //       雪梨 T1 Richmond/Emu Plains 兩支各自獨立。
    // 同色的多個 route_id（同一條線的兩支、東鐵綫主線 vs 馬場…）在**渲染層**已用「相異
    // 色數」畫成一條連續線（LayerTab `_nc`／skeleton coline），故不在資料層強合併——強合併
    // 會串接站序、幾何來回鋸齒（曾把東鐵綫併成 42 站 Admiralty↔Lo Wu↔Racecourse 來回跳）。
    // 電車例外：不拆 branchUnit，見下方 isTram 分支。
    const branchUnit = (w) => {
      const bt = { ...(routesTags.get(w.rid) || {}) }
      bt.__own = pick(bt, 'operator') || pick(bt, 'network:en', 'network')
      // key 不能沿用 m| 前綴（phase B 的 route_id 由 key 推導）——分支用 br|rid
      return { kept: [w.rows], gU: { key: `br|${w.rid}`, rids: [w.rid] }, tU: bt }
    }
    // 端點延伸併入主線（使用者：千代田線不可拆兩段）——分支變體只與主線共用**一個站**、
    // 且該站是主線的**端點**（＝純線性延伸，官方碼連續：綾瀬 C19→北綾瀬 C20 同一條線）
    // → 新站直接接進主線序列、不另成 route。**中途分岔**（小碧潭在七張、東鐵羅湖/落馬洲
    // 在上水、NYC A 線分支）共用點非端點或共用多站 → 維持獨立 route 不變。
    // 電車跳過此步：車廠／區間支整段併進同一 line unit（多段 MultiLineString）。
    if (!isTram) {
      const near2 = (a, b) => { const A = cellOf(a), B = cellOf(b)
        return Math.abs(A[0] - B[0]) <= 2 && Math.abs(A[1] - B[1]) <= 2 }
      const mainW = keptAll[0]
      const rest = []
      for (const w of keptAll.slice(1)) {
        const mainCells = new Set(mainW.rows.map((r) => cellOf(r).join(':')))
        const nearMain = (r) => { const [cx, cy] = cellOf(r)
          for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++)
            if (mainCells.has(`${cx + dx}:${cy + dy}`)) return true
          return false }
        const shared = w.rows.filter(nearMain)
        const mFirst = mainW.rows[0], mLast = mainW.rows[mainW.rows.length - 1]
        if (shared.length === 1 && (near2(shared[0], mFirst) || near2(shared[0], mLast))) {
          let seq = [...w.rows]
          if (!near2(seq[0], shared[0])) seq.reverse() // 共用端排最前
          const newRows = seq.slice(1)
          if (near2(shared[0], mLast)) mainW.rows.push(...newRows)
          else mainW.rows.unshift(...newRows.reverse())
          continue // rid 不進 branch → 自然歸入 mainRids
        }
        rest.push(w)
      }
      keptAll.length = 0
      keptAll.push(mainW, ...rest)
    }
    const units = isTram
      ? (() => {
          // 同路線一條：主線＝最長變體；其餘只保留「分岔 spur」（含接軌站＋新站），
          // 避免把反向／區間整段再走一遍把站序脹成 2×。停靠＝聯集；不標假 pass。
          const mainW = keptAll[0]
          const kept = [mainW.rows]
          const mainCells = new Set(mainW.rows.map((r) => cellOf(r).join(':')))
          const nearMain = (r) => {
            const [cx, cy] = cellOf(r)
            for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++)
              if (mainCells.has(`${cx + dx}:${cy + dy}`)) return true
            return false
          }
          // 接軌站必須是主線「真的停靠的同一個節點」（ref 相同），不能只是幾何鄰近
          // ——否則車廠／區間支的接點是另一個近旁站，畫出來的支段與主鏈不共用頂點、
          // 路段聯集斷成兩塊（verify broken_routes：墨爾本 Tram 64/72/5）。找不到共用
          // 節點的支（純車廠短枝）整段丟棄，維持「一條連續電車線」。
          const mainRefs = new Set(mainW.rows.map((r) => r.ref))
          for (const w of keptAll.slice(1)) {
            const onMain = w.rows.map(nearMain)
            if (!onMain.some(Boolean) || onMain.every(Boolean)) continue // 全離／全重疊
            // 找連續 fresh 段，向前收到第一個「主線同一節點」的接軌站
            let i = 0
            while (i < w.rows.length) {
              while (i < w.rows.length && onMain[i]) i++
              if (i >= w.rows.length) break
              let start = i
              while (start > 0 && !mainRefs.has(w.rows[start].ref)) start--
              while (i < w.rows.length && !onMain[i]) i++
              const spur = w.rows.slice(start, i)
              // 需含 ≥2 站且首站是主線共用節點，才接得回主鏈
              if (spur.length >= 2 && mainRefs.has(spur[0].ref)) kept.push(spur)
            }
          }
          return [{ kept, gU: { key: g.key, rids: g.rids }, tU: null }]
        })()
      : (() => {
          const branchRids = new Set(keptAll.slice(1).map((w) => w.rid))
          const mainRids = g.rids.filter((r) => !branchRids.has(r))
          const u = [{ kept: [keptAll[0].rows],
            gU: { key: g.key, rids: mainRids.length ? mainRids : g.rids }, tU: null }]
          for (const w of keptAll.slice(1)) u.push(branchUnit(w))
          return u
        })()
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
    // 一組內全部 relation 都是 light_rail（或 tram）才算 LRT 線（混合視為 subway）。
    // tram 只可能來自廣島特例的定向補抓（fetchHiroden.mjs，見 metro-city-hiroshima）——
    // 全球基準查詢不收 tram，故此條對其他城市天然無作用。tram 必須歸在 LRT 這側：
    // 否則路面電車會被當成 subway，讓 hasSubway 誤判為真、污染下面的 LRT 範圍仲裁
    //（廣島的真 subway 是 Astram Line，route=subway）。
    const lrtOnly = gRef.rids.every((r) =>
      /^(light_rail|tram)$/.test((routesTags.get(r) || {}).route || ''))
    if (process.env.DEBUG_CITY && new RegExp(process.env.DEBUG_CITY, 'i')
      .test(`${network} ${t.name ?? ''} ${t.__own ?? ''}`))
      console.log('  [resolve]', (t['name:en'] || t.name || '').slice(0, 40),
        '| net:', network, '| own:', t.__own, '→', info.key)
    resolved.push({ g: gRef, kept, passCoords, t, network, ov, info, lrtOnly })
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
      route_name: cleanRouteName(nameFor(t, info.country)) || routeRef || routeId,
      route_name_local: cleanRouteName(t.name) || null,
      route_name_en: cleanRouteName(pick(t, 'name:en')) || null, // 英文線名（標題/hover 第二行）
      route_ref: routeRef,
      route_color: normColor(pick(t, 'colour')),
      network,
      network_local: t.network || null,
      operator: pick(t, 'operator') ?? null,
      city: info.city, country: info.country,
      wikidata: pick(t, 'wikidata', 'network:wikidata') ?? null,
      wikipedia: pick(t, 'wikipedia', 'network:wikipedia') ?? null,
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
    // 系統 metadata 候選記在 feature（__meta，不序列化——路段化會重建 features），最終於
    // 路段化前由**存活線多數決**重算——舊「先到先贏」會被之後才剔除的線搶走（東京被
    // allow-list 剔除的 Yurikamome 曾把 official_website 搶成 yurikamome.tokyo）。
    feat.__meta = {
      operator: pick(t, 'operator'),
      website: pick(t, 'website', 'operator:website'),
      wikipedia: pick(t, 'network:wikipedia', 'wikipedia'),
      wikidata: pick(t, 'network:wikidata', 'wikidata'),
    }
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

  // 城市桶 → 該桶所有線的 lineTag（站點分桶用）。同一座城市有兩個重疊路網各自成檔時
  // （墨爾本 Metro Trains ↔ Yarra Trams），格網 cell 會同時登記兩個桶、`nearestCityKey`
  // 取 Set 的第一個 → 電車停留場可能被判進鐵路桶，接著被鐵路 route 的 stop 成員 snap
  // 吸走（Flinders Street 出現三次、Caulfield 變成「Stop 57: Caulfield Station」）。
  // 故：站點的主桶優先取「含有該站所屬路線」的那個桶。
  const groupTags = new Map()
  for (const [ck, grp] of cityGroups) {
    const tags = new Set()
    for (const f of grp.lines) { const tg = featTag.get(f); if (tg) tags.add(tg) }
    groupTags.set(ck, tags)
  }

  for (const s of stations) {
    const t = s.tags
    const network = pick(t, 'network:en', 'network') || pick(t, 'operator') || 'Unknown'
    let lines = [...(nodeLineRefs.get(s.id) || [])]
    if (!lines.length) lines = nearbyLineRefs(s.lon, s.lat)
    lines = [...new Set(lines)].sort()
    const ownKey = lines.length
      ? [...nearbyCityKeys(s.lon, s.lat)].find((ck) =>
          lines.some((tag) => groupTags.get(ck)?.has(tag)))
      : null
    const spatialKey = ownKey ?? nearestCityKey(s.lon, s.lat)
    const info = (spatialKey && gInfo.get(spatialKey)) || cityInfo(network, t.network)
    const props = {
      station_id: `n${s.id}`,
      station_name: nameFor(t, info.country) || `n${s.id}`,
      station_name_local: t.name || null,
      station_name_en: pick(t, 'name:en') || null, // 英文名（標題/hover 第二行；與在地名相同則前端不顯示）
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
    // 這個站「真正掛在哪些 route 成員上」（不含 nearbyLineRefs 的 900 m 猜測）——
    // 供 snap 階段排除外來路網的站當吸附目標，見該處。
    const memberLines = nodeLineRefs.get(s.id)
    if (memberLines?.size) feat.__memberLines = new Set(memberLines)
    // 官方站碼（`ref`，如機捷 A1、環狀 Y20、板南 BL12、港鐵 FOH）——各線的 station 節點自帶
    // 該線的碼；共站合併時聚成 codes，路線再依 ref 字首挑出自己的碼、供官方順序排序。內部欄位。
    // `_overrides/station_codes.json`：上游節點缺 ref、官方確有碼者由此補（東京 N13/N19/S11/E27）。
    if (t.ref && /^[A-Za-z]{1,4}\d|^\d/.test(t.ref)) feat.__codes = new Set(String(t.ref).split(/[;、,\s]+/).filter(Boolean))
    for (const c of codeOverrides[`n${s.id}`] ?? []) (feat.__codes = feat.__codes || new Set()).add(c)
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
      if (feat.__codes) clone.__codes = new Set(feat.__codes) // 官方站碼隨複製帶走（赤羽岩淵：主 bucket 在埼玉側、東京拿 clone）
      if (feat.__memberLines) clone.__memberLines = new Set(feat.__memberLines) // 路線歸屬也帶走（桶內清理要用）
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
  // 環狀、高雄輕軌；新加坡 Bukit Panjang/Sengkang/Punggol LRT；大阪ニュートラム
  // 南港ポートタウン線 P——Osaka Metro 自家路線、OSM 標 route=light_rail，2026-07 使用者指定）。
  // boston：MBTA Green Line（B/C/D/E 支線，OSM 標 route=light_rail）＋ Mattapan Trolley
  // 是波士頓地鐵系統核心（官方 rapid transit 圖含綠線）——有 Red/Orange/Blue subway 原被
  // 「附掛純 LRT 剔除」丟掉，加入白名單保留（使用者 2026-07 指定「要抓綠線」）。
  // losangeles：LA Metro Rail 的 A/C/E/K 為 route=light_rail、B/D 為 route=subway，
  //   同屬「Metro Rail」系統；wiki List of metro systems 只計 B/D(19 站) → 覆蓋率不跌破
  //   0.6 使輕軌被剔。使用者 2026-07 指定要含輕軌（同波士頓綠線待遇）。
  // guadalajara：Mi Tren（SITEUR）L1/L2/L4 為 route=light_rail、L3 為 route=subway，
  //   同一系統；覆蓋率 18/28=0.64 剛好卡在門檻上使輕軌被剔。使用者 2026-07 指定收全系統。
  // hiroshima：Astram Line（route=subway，wiki 22 站）之外，使用者 2026-07-21 裁決
  //   「廣島要收路面電車，且只有廣島特例」——広島電鉄（route=tram，由 fetchHiroden.mjs
  //   補抓）算 LRT，會被範圍規則剔掉（Astram 已獨力達成 wiki 覆蓋率，仲裁不會放行）。
  //   故與波士頓綠線／LA 輕軌同待遇，白名單放行。見 metro-city-hiroshima。
  const LRT_ADDON_CITIES = new Set(['taipei', 'newtaipei', 'kaohsiung', 'singapore', 'osaka', 'boston', 'losangeles', 'guadalajara', 'hiroshima'])
  // 大洋洲／非洲的「輕軌・電車城市」（使用者 2026-07-23，依 urbanrail.net 的
  // oceania.htm／africa.htm 兩頁）：這些城市的都市軌道全部或部分是 tram/light_rail，
  // 且**不在** wiki List of metro systems（沒有 wikiRow）——會被「非基準、純 LRT 一律
  // 剔除」整城丟掉；墨爾本/阿德萊德則是有市郊鐵路（route=train，不算 LRT）而電車被剔。
  // 使用者裁決「市郊鐵路＋電車都收」，故整城放行。
  //（阿爾及利亞 SETRAM 七城與模里西斯的 relation 走 _overrides 綁城，override 本身
  //  即豁免此規則，這裡列出只是文件性的；黃金海岸 G:link 同理。）
  const TRAM_RAIL_CITIES = new Set([
    // 大洋洲（melbournetram＝墨爾本電車獨立系統檔，見 NETWORK_CITY）
    'melbournetram', 'adelaide', 'canberra', 'newcastle', 'goldcoast',
    // 非洲
    'addisababa', 'abuja', 'tunis', 'casablanca', 'rabat', 'alexandria',
    'portlouis', 'algiers', 'oran', 'constantine', 'setif', 'sidibelabbes',
    'ouargla', 'mostaganem',
  ])
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
      TRAM_RAIL_CITIES.has(normCity(grp.info.city)) ||
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

  // ---- 同城重疊路網分檔：把跑錯桶的站複本剔掉 --------------------------------
  // 站點會被複製進附近每個城市桶（跨城轉乘站需要）。**同一座城市**有兩個重疊路網
  // 各自成檔時（目前只有墨爾本：Metro Trains ↔ Yarra Trams），電車停留場的複本會
  // 留在鐵路桶裡，接著被共站合併／snap 吸進鐵路線——Flinders Street 會出現三次、
  // Caulfield 變成「Stop 57: Caulfield Station」。這裡在合併前剔掉走錯桶的複本。
  // **只作用於下面明列的同城姊妹桶**，不影響其它城市既有行為（跨城轉乘站的複本
  // 仍照舊保留，見上方 nearbyCityKeys）。
  const SPLIT_SIBLINGS = new Map([
    ['oceania/australia/oc-aus-melbourne', 'oceania/australia/oc-aus-melbourne-tram'],
    ['oceania/australia/oc-aus-melbourne-tram', 'oceania/australia/oc-aus-melbourne'],
  ])
  {
    let dropped = 0
    for (const [ckey, grp] of cityGroups) {
      const sib = SPLIT_SIBLINGS.get(ckey)
      if (!sib) continue
      const alive = new Set(grp.lines.map((f) => featTag.get(f)).filter(Boolean))
      const sibTags = groupTags.get(sib) ?? new Set()
      if (!alive.size || !sibTags.size) continue
      const before = grp.stations.length
      grp.stations = grp.stations.filter((f) => {
        const ml = f.__memberLines
        // 有 route 成員歸屬：屬於本桶就留、只屬於姊妹桶就剔
        if (ml?.size) return [...ml].some((tag) => alive.has(tag)) ||
          ![...ml].some((tag) => sibTags.has(tag))
        // 沒有成員歸屬（lines 是 nearbyLineRefs 的 900 m 鄰近猜測，同城重疊路網會
        // 互相猜錯）：改看站自帶的 network／operator 被 NETWORK_CITY 釘到哪個城市
        const p = f.properties
        const bind = NETWORK_CITY.find(([re]) =>
          re.test(`${p.network ?? ''} ${p.network_local ?? ''} ${p.operator ?? ''}`))?.[1]
        return !bind || normCity(bind.city) === normCity(grp.info.city)
      })
      dropped += before - grp.stations.length
    }
    if (dropped) console.log(`  同城分檔清理：剔除 ${dropped} 個跑錯桶的站複本`)
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
  let splitSpecs = []
  try {
    const ix = JSON.parse(await readFile(join(BASE, '_overrides', 'interchanges.json'), 'utf8'))
    ixPairs = ix.merge ?? []
    // `split`: 同名站「拆站」裁決——某些同名站分屬不相通的不同線（NYC 下曼哈頓 7 Av
    // 線的 1 與平行的 A/C/E、N/Q/R/W 同名卻不轉乘）。每筆 {city,name,groups:[[refs]…]}：
    // 每個 line-group 各自成一站、彼此不併；未列出的成員（真 complex）照常距離聚合。
    splitSpecs = ix.split ?? []
  } catch { /* optional */ }

  let mergedAway = 0
  // 墨爾本電車路口異名合併（pre-snap + post-snap 共用此集合）
  const TRAM_JUNCTION_MERGE = new Set(['melbournetram'])
  for (const grp of cityGroups.values()) {
    const feats = grp.stations
    if (feats.length < 2) continue
    // 拆站 override（interchanges.json 的 `split`，本城適用者）：name → [[refs]…]。
    // 合併後再依 line-group 拆（見 materialize），故用「合併簇的代表名」判定——能處理
    // 跨名合併（WTC 一帶 Cortlandt Street 併進 WTC Cortlandt/Park Place… 異名節點）。
    const splitByName = new Map()
    for (const sp of splitSpecs) if (normCity(sp.city) === normCity(grp.info.city)) splitByName.set(normName(sp.name), sp)
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
    // 墨爾本電車：**不以同名為共站**（官方路網圖為準）。同名「Stop 15: Smith
    // Street」可分屬 Victoria Parade(12/109) 與 Smith St(86)、相距 ~300 m——800 m
    // 同名規則會誤併；改走下方 (2b) 近距／成員線拓撲。
    const STRICT_SAMENAME = new Set(['newyorkcity'])
    const SKIP_SAMENAME = TRAM_JUNCTION_MERGE // 與路口近距合併共用城市集
    const sameNameStrict = STRICT_SAMENAME.has(normCity(grp.info.city))
    const skipSameName = SKIP_SAMENAME.has(normCity(grp.info.city))
    if (!skipSameName) {
      const byName = new Map()
      feats.forEach((f, i) => {
        const key = normName(f.properties.station_name)
        if (!key || /^n\d+$/.test(key)) return
        if (!byName.has(key)) byName.set(key, [])
        byName.get(key).push(i)
      })
      // greedy same-name distance/line clustering → union each cluster
      const clusterAndUnion = (idxs) => {
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
      for (const idxs of byName.values()) clusterAndUnion(idxs)
    }
    // (2b) 墨爾本電車：以官方示意圖「同位置＝共站」為準，不用同名／異名。
    // 同名可分屬不同走廊（Stop 15 Smith＝Victoria Pde 12/109 vs Smith St 86）；
    // 異名可為同站（Gertrude↔Brunswick、Chapel↔Dandenong／Windsor）；
    // Swanston 對向月台同號約 60 m。只用 __memberLines。
    //   同 Stop 號（含 D1/D14）+ <110 m → 併（對向月台；不可放大——CBD 同號會串
    //     Bourke Mall 5→Elizabeth 5→Flinders 5 整條吸進 Flinders）
    //   <12 m → 強制併
    //   <30 m + 異線 → 併
    //   30–90 m + 異線 + 街名不同 → 併（路口；擋 Bourke Mall 3↔5 同街異號）
    //   具名樞紐（…Station／Melbourne Central）一般 <200 m；Melbourne Central 兩側
    //     街道 OSM ~280 m → 該樞紐單獨 <300 m
    // 吸附後靠 post-snap。
    if (TRAM_JUNCTION_MERGE.has(normCity(grp.info.city))) {
      const stopNum = (name) => {
        const m = String(name || '').match(/\bstop\s+(d?\d+[a-z]?)\b/i)
        return m ? m[1].toUpperCase() : null
      }
      // 「Stop N: Street」→ street 正規化；同街異號近距＝CBD 平行站，不是路口共站
      const streetKey = (name) => {
        const s = String(name || '').replace(/^stop\s+\S+:\s*/i, '').trim().toLowerCase()
        return s.replace(/[^a-z0-9]+/g, ' ').trim()
      }
      // 官方圖上的具名樞紐（火車站名／Melbourne Central）——異 Stop 號仍是同一共站
      const isHubStation = (name) => {
        const s = streetKey(name)
        if (/mall|shopping/.test(s)) return false // Bourke Street Mall 等不是樞紐
        return /\bstations?\b/.test(s) || /melbourne central|southern cross/.test(s)
      }
      // 樞紐核心名必須相同（flinders≠southern≠flagstaff），避免 200 m 內異樞紐誤併
      const hubCore = (name) => {
        const s = streetKey(name)
          .replace(/\band\b.*$/, '')
          .replace(/\bstations?\b/g, 'station')
          .replace(/\s+/g, ' ').trim()
        const toks = s.split(' ').filter((t) => t.length > 3 && t !== 'station' && t !== 'street')
        return toks[0] || s
      }
      const hubMatch = (a, b) => {
        if (!isHubStation(a) || !isHubStation(b)) return false
        const ca = hubCore(a), cb = hubCore(b)
        return !!(ca && cb && ca === cb)
      }
      const lineKeys = (f) => {
        const out = new Set()
        if (f.__memberLines) for (const t of f.__memberLines) out.add(String(t).toLowerCase())
        return out
      }
      const deg2m = (lon1, lat1, lon2, lat2) => {
        const dy = (lat1 - lat2) * 111000
        const dx = (lon1 - lon2) * Math.cos((lat1 * Math.PI) / 180) * 111000
        return Math.hypot(dx, dy)
      }
      const clusterLines = feats.map(() => new Set())
      for (let i = 0; i < feats.length; i++) {
        const r = find(i)
        for (const x of lineKeys(feats[i])) clusterLines[r].add(x)
      }
      const unionJn = (a, b) => {
        const ra = find(a), rb = find(b)
        if (ra === rb) return false
        parent[rb] = ra
        for (const x of clusterLines[rb]) clusterLines[ra].add(x)
        clusterLines[rb] = clusterLines[ra]
        return true
      }
      const shares = (A, B) => {
        for (const x of A) if (B.has(x)) return true
        return false
      }
      let jn = 0
      const cand = []
      for (let i = 0; i < feats.length; i++) {
        const [lon1, lat1] = feats[i].geometry.coordinates
        const ni = stopNum(feats[i].properties.station_name)
        for (let j = i + 1; j < feats.length; j++) {
          const [lon2, lat2] = feats[j].geometry.coordinates
          const d = deg2m(lon1, lat1, lon2, lat2)
          if (d >= 310) continue // 候選上限＝Melbourne Central 樞紐窗
          const nj = stopNum(feats[j].properties.station_name)
          cand.push({ i, j, d, sameNum: !!(ni && nj && ni === nj) })
        }
      }
      cand.sort((a, b) => a.d - b.d)
      for (const { i, j, d, sameNum } of cand) {
        const ra = find(i), rb = find(j)
        if (ra === rb) continue
        // 同號只認對向月台（≤110 m）；放大會串 CBD 同號進 Flinders
        if ((sameNum && d < 110) || d < 12) {
          if (unionJn(i, j)) jn++
          continue
        }
        const Li = clusterLines[ra], Lj = clusterLines[rb]
        const ni = feats[i].properties.station_name
        const nj = feats[j].properties.station_name
        // 具名樞紐先判（可已有共用線——City Circle 30/35 常掛兩側出入口）
        // 一般 ≤200 m；Melbourne Central 兩側街道 OSM ~280 m，單獨放寬
        const hubR = hubCore(ni) === 'melbourne' && hubCore(nj) === 'melbourne' ? 300 : 200
        if (d < hubR && hubMatch(ni, nj)) {
          if (unionJn(i, j)) jn++
          continue
        }
        if (!Li.size || !Lj.size || shares(Li, Lj)) continue
        if (d < 30) {
          if (unionJn(i, j)) jn++
          continue
        }
        if (d < 90) {
          const si = streetKey(ni), sj = streetKey(nj)
          // 同街異號（Bourke Mall 3↔5）不併；異街＝路口（Chapel↔Dandenong、
          // Swanston↔Bourke Mall Stop 10——官方圖轉乘共站）
          if (si && sj && si !== sj) {
            if (unionJn(i, j)) jn++
          }
        }
      }
      if (jn) console.log(`  ${grp.info.city}: tram map-costop merge ${jn} pairs`)
    }
    // (3) adjudicated interchange pairs
    if (ixPairs.length) {
      const byId = new Map(feats.map((f, i) => [f.properties.station_id, i]))
      for (const [a, b] of ixPairs) {
        if (byId.has(a) && byId.has(b)) union(byId.get(a), byId.get(b))
      }
    }

    // materialize merged stations. 拆站 override：若一個合併簇內**任一成員名 == split 站名**，
    // 就把整簇依 line-group 重新拆成多站（每組一站、未列出 refs＝rest 那一站）。用「簇代表名」
    // 判定→能處理跨名合併（WTC 一帶 Cortlandt Street 併了 WTC Cortlandt/Park Place 等異名節點）。
    const groupsByRoot = new Map()
    const forcedName = new Map() // groupsByRoot key → optional station name (split spec `names`)
    {
      const rootMembers = new Map()
      feats.forEach((_, i) => { const r = find(i); if (!rootMembers.has(r)) rootMembers.set(r, []); rootMembers.get(r).push(i) })
      const nref = (r) => String(r).toLowerCase().replace(/\s+/g, '')
      for (const [root, idxs] of rootMembers) {
        let spec = null
        if (splitByName.size) for (const i of idxs) { const s = splitByName.get(normName(feats[i].properties.station_name)); if (s) { spec = s; break } }
        // optional `near:[lon,lat]` (+ `radius` m, default 600) scopes a split to ONE
        // cluster when the station name is non-unique (Brooklyn Fulton St vs Manhattan
        // Fulton Center) — skip clusters whose centroid is far from the anchor.
        if (spec && spec.near) {
          const clon = idxs.reduce((s, i) => s + feats[i].geometry.coordinates[0], 0) / idxs.length
          const clat = idxs.reduce((s, i) => s + feats[i].geometry.coordinates[1], 0) / idxs.length
          const dM = Math.hypot((clon - spec.near[0]) * Math.cos(clat * Math.PI / 180), clat - spec.near[1]) * 111000
          if (dM > (spec.radius ?? 600)) spec = null
        }
        if (spec && idxs.length > 1) {
          const gsets = spec.groups.map((g) => new Set(g.map(nref)))
          for (const i of idxs) {
            const ml = (feats[i].properties.lines || []).map(nref)
            let gi = 'rest'
            for (let g = 0; g < gsets.length; g++) if (ml.some((x) => gsets[g].has(x))) { gi = String(g); break }
            const k = `${root}#${gi}`
            if (!groupsByRoot.has(k)) groupsByRoot.set(k, [])
            groupsByRoot.get(k).push(i)
            if (spec.names && gi !== 'rest' && spec.names[+gi]) forcedName.set(k, spec.names[+gi])
          }
        } else groupsByRoot.set(root, idxs)
      }
    }
    const keep = []
    // 吸附別名：合併後代表點是「質心」，可能離某些成員 >600 m（NYC 125th St
    // 質心位移把 Lexington 節點全甩掉）——記下成員原座標→代表點座標，
    // 吸附階段對成員點找最近、再映射回代表點。
    const aliases = []
    for (const [gkey, idxs] of groupsByRoot) {
      const forced = forcedName.get(gkey) // split-spec `names` override for this sub-station
      if (idxs.length === 1) {
        const f = feats[idxs[0]]
        // 拆站 override 給了明確 `names`＝這是使用者裁定的獨立站，不可再掛
        // 其他成員名（Fulton St ↔ Lafayette Av 非共站，卻因合併殘留 merged_names
        // 兩名、前端顯示成 "Fulton Street / Lafayette Avenue" 誤讀為共站）。
        if (forced) { f.properties.station_name = forced; f.properties.station_name_local = forced; f.properties.merged_names = null }
        keep.push(f); continue
      }
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
      const allMemberLines = new Set()
      for (const m of members) {
        for (const c of (m.__codes || [])) allCodes.add(c)
        if (m.__memberLines) for (const t of m.__memberLines) allMemberLines.add(t)
      }
      keep.push({
        type: 'Feature',
        properties: {
          ...first.properties,
          ...(forced ? { station_name: forced, station_name_local: forced } : {}),
          lines: lines.length ? lines : null,
          merged_from: members.length,
          // 拆站 override 給了明確 `names`＝獨立站，抑制 merged_names（見上）
          merged_names: forced ? null : (mergedNames.length > 1 ? mergedNames : null),
        },
        geometry: { type: 'Point', coordinates: [lon, lat] },
        ...(allCodes.size ? { __codes: allCodes } : {}),
        // 保留 route 成員歸屬聯集——墨爾本電車 post-snap 路口合併靠它判不相交
        ...(allMemberLines.size ? { __memberLines: allMemberLines } : {}),
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
    // 吸附目標只認「本桶的站」：同一座城市有兩個重疊路網各自成檔時（墨爾本
    // Metro Trains ↔ Yarra Trams），跨桶複製會把電車停留場放進鐵路桶，鐵路 route 的
    // stop 成員就會 snap 到隔壁路網的點（Flinders Street 出現三次、Caulfield 變成
    // 「Stop 57: Caulfield Station」）。有明確 route 成員歸屬、且沒有一條在本桶的站
    // 不當吸附目標；無歸屬的站（純鄰近推得）維持原行為。
    const aliveTags = new Set(grp.lines.map((f) => featTag.get(f)).filter(Boolean))
    // repKey → 該站 __memberLines（小寫 tag）；別名吸附也帶同一份
    const memByRep = new Map()
    for (const f of grp.stations) {
      const ml = f.__memberLines
      if (ml?.size && ![...ml].some((tag) => aliveTags.has(tag))) continue
      const rep = f.geometry.coordinates
      const mem = new Set()
      if (ml) for (const t of ml) mem.add(String(t).toLowerCase())
      memByRep.set(rep.join(','), mem)
      addSnapPoint(rep, rep)
    }
    // 合併成員的原座標也是吸附目標（映射回代表點）——質心位移不甩站；
    // 代表點已被 orphan-drop 移除者不得借屍還魂
    for (const a of grp.__snapAliases ?? [])
      if (repAlive.has(a.rep.join(','))) addSnapPoint(a.c, a.rep)
    // preferTag：墨爾本電車 CBD 站距常 <100 m，純距離會把 Swanston 吸到隔壁
    // Bourke Mall。優先吸附「本線 stop 成員」的站，再 fallback 最近站。
    const nearestStation = (lon, lat, preferTag = null) => {
      const gx = Math.round(lon / SNAP), gy = Math.round(lat / SNAP)
      let best = null, bestD = Infinity
      let bestMem = null, bestMemD = Infinity
      const want = preferTag ? String(preferTag).toLowerCase() : null
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
        for (const { c, rep } of sGrid.get(`${gx + dx}:${gy + dy}`) || []) {
          const d = (c[0] - lon) ** 2 + (c[1] - lat) ** 2
          if (d < bestD) { bestD = d; best = rep }
          if (want) {
            const mem = memByRep.get(rep.join(','))
            if (mem?.has(want) && d < bestMemD) { bestMemD = d; bestMem = rep }
          }
        }
      const lim = SNAP * SNAP
      if (bestMem != null && bestMemD < lim) return bestMem
      return best != null && bestD < lim ? best : null
    }
    for (const f of grp.lines) {
      const tag = featTag.get(f)
      f.geometry.coordinates = f.geometry.coordinates.map((seq) => {
        const out = []
        for (const [lon, lat] of seq) {
          const st = nearestStation(lon, lat, tag)
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

    // ---- 墨爾本電車：吸附後幾乎重疊的異名站補合併 ----
    // 路口兩站 OSM 相距 ~25–30 m（未過 pre-snap 門檻），snap 到同一軌道頂點後變 <15 m
    // 卻仍是兩點 → 畫面上「該共站卻沒共站」。吸附後再併一次並改寫線頂點座標。
    if (TRAM_JUNCTION_MERGE.has(normCity(grp.info.city)) && grp.stations.length >= 2) {
      const deg2m = (a, b) => {
        const dy = (a[1] - b[1]) * 111000
        const dx = (a[0] - b[0]) * Math.cos((a[1] * Math.PI) / 180) * 111000
        return Math.hypot(dx, dy)
      }
      const sts = grp.stations
      // <5 m：強制併（snap 把路口撕成兩點）。5–30 m：僅 __memberLines 不相交才併
      // （Camberwell 等異號路口；不用 properties.lines——900 m 猜測會誤判）。
      const memLines = (f) => {
        const out = new Set()
        if (f.__memberLines) for (const t of f.__memberLines) out.add(String(t).toLowerCase())
        return out
      }
      const clusterMem = sts.map((s) => memLines(s))
      const parent = sts.map((_, i) => i)
      const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
      const union = (a, b) => {
        const ra = find(a), rb = find(b)
        if (ra === rb) return false
        parent[rb] = ra
        for (const x of clusterMem[rb]) clusterMem[ra].add(x)
        clusterMem[rb] = clusterMem[ra]
        return true
      }
      let n = 0
      const cand = []
      for (let i = 0; i < sts.length; i++) {
        for (let j = i + 1; j < sts.length; j++) {
          const d = deg2m(sts[i].geometry.coordinates, sts[j].geometry.coordinates)
          if (d < 30) cand.push({ i, j, d })
        }
      }
      cand.sort((a, b) => a.d - b.d)
      for (const { i, j, d } of cand) {
        if (find(i) === find(j)) continue
        if (d >= 5) {
          const Li = clusterMem[find(i)], Lj = clusterMem[find(j)]
          if (!Li.size || !Lj.size) continue
          let share = false
          for (const x of Li) if (Lj.has(x)) { share = true; break }
          if (share) continue
        }
        if (union(i, j)) n++
      }
      if (n) {
        const groups = new Map()
        sts.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i) })
        const keep = []
        const remap = new Map() // oldCoordKey → newCoord
        for (const idxs of groups.values()) {
          if (idxs.length === 1) { keep.push(sts[idxs[0]]); continue }
          const members = idxs.map((i) => sts[i])
          const lon = members.reduce((s, m) => s + m.geometry.coordinates[0], 0) / members.length
          const lat = members.reduce((s, m) => s + m.geometry.coordinates[1], 0) / members.length
          const lines = [...new Set(members.flatMap((m) => m.properties.lines || []))].sort()
          const first = members.slice().sort((a, b) =>
            (b.properties.lines || []).length - (a.properties.lines || []).length)[0]
          const mergedNames = []
          const seen = new Set()
          for (const m of [first, ...members.filter((m) => m !== first)]) {
            const nm = m.properties.station_name
            const k = (nm || '').toLowerCase()
            if (!k || seen.has(k)) continue
            seen.add(k)
            mergedNames.push({
              station_id: m.properties.station_id,
              station_name: m.properties.station_name,
              station_name_local: m.properties.station_name_local ?? null,
              lines: m.properties.lines || [],
            })
          }
          const rep = [lon, lat]
          for (const m of members) remap.set(m.geometry.coordinates.join(','), rep)
          keep.push({
            type: 'Feature',
            properties: {
              ...first.properties,
              lines: lines.length ? lines : first.properties.lines,
              merged_from: (first.properties.merged_from || 1) + members.length - 1,
              merged_names: mergedNames.length > 1 ? mergedNames : first.properties.merged_names,
            },
            geometry: { type: 'Point', coordinates: rep },
          })
        }
        for (const f of grp.lines) {
          f.geometry.coordinates = f.geometry.coordinates.map((seq) =>
            seq.map((c) => remap.get(c.join(',')) || c))
        }
        grp.stations = keep
        console.log(`  ${grp.info.city}: post-snap tram merge ${n} pairs → ${keep.length} stations`)
      }
    }

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
      // 墨爾本電車站距常 200–400 m，區間變體常跳過 1 站畫成捷徑弦→共線變兩條；
      // 門檻降到 0.2 km（仍靠 ≤1.35× 繞路守衛）。
      const passMinKm = /new york city/i.test(grp.info.city || '') ? 0.35
        : /melbourne tram/i.test(grp.info.city || '') ? 0.2
        : 2
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
            let bestVia = null, bestSameColor = null
            const fColor = (F.properties.route_color || '').toLowerCase()
            for (let gi = 0; gi < others.length; gi++) {
              if (gi === fi) continue
              // 快車與它的慢車是**同一條幹線＝同色**（NYC 黃線 N/Q 快車跳站，走廊是黃線
              // R/W 慢車、絕非旁邊平行的綠線 Lexington 6）。同色候選優先——否則會抓到
              // 恰好也連 A→C、≤1.35× 的**異色鄰線**，把兩條不同色線誤畫成共線（seg-52：
              // N/Q 被接到綠線 Spring/Bleecker/Astor）。異色 fallback 保留給雪梨式
              // 「不同色線官方共線」（T1 快車＝T2 慢車、色不同、無同色候選）。
              const giColor = (grp.lines[gi].properties.route_color || '').toLowerCase()
              const sameColor = fColor && giColor && fColor === giColor
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
                if (sameColor && (!bestSameColor || inner.length > bestSameColor.length)) bestSameColor = inner
              }
            }
            const chosen = bestSameColor || bestVia
            if (chosen && chosen.length) { bestVia = chosen }
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
      const sts = []                // 停靠站（機器/計數用）
      const passSts = []            // 此線行經但不停靠的站（站↔線 pass 歸屬用）
      const ordered = []            // **完整行經序**：stop＋pass 依幾何真實順序交錯（輸出用）
      const fTag = featTag.get(f)
      for (const seq of f.geometry.coordinates) {
        if (seq.length < 2) continue
        for (const c of seq) {
          const s = byCoord.get(c.join(','))
          if (!s) continue
          // 快車 pass-through 頂點：幾何經過但不停靠（機場快線跳過的東涌線中間站）。
          // snap 後座標精度變了，用鄰近比對（~110 m；快車真停靠站離 pass 站夠遠）。
          // pass 站**就地插入行經序**（entry 標 pass:true），不計入停靠 __stations。
          const isPassC = f.__passCoords && [...f.__passCoords].some((k) => {
            const [pl, pt] = k.split(',').map(Number)
            return Math.abs(c[0] - pl) < 1e-3 && Math.abs(c[1] - pt) < 1e-3
          })
          if (isPassC) {
            const entry = { station_id: s.properties.station_id, station_name: s.properties.station_name, pass: true }
            passSts.push(entry)
            ordered.push(entry)
            if (!passByStation.has(s.properties.station_id)) passByStation.set(s.properties.station_id, new Set())
            passByStation.get(s.properties.station_id).add(fTag)
            continue
          }
          const entry = { station_id: s.properties.station_id, station_name: s.properties.station_name }
          sts.push(entry)
          ordered.push(entry) // 同一物件——之後補 code 兩邊同步
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
        const pickCode = (sid) => { const cs = codesById.get(sid); if (!cs) return null
          for (const c of cs) { const k = codeKey(c); if (k && k[0] === refU) return c } // 字首完全相同優先
          for (const c of cs) { const k = codeKey(c); if (k && k[0].startsWith(refU)) return c } // 後備：Mb03↔ref M（支線碼）
          return null }
        for (const st of ordered) { const c = pickCode(st.station_id); if (c) st.code = c } // 含 pass 站（三重 A2）
        const coded = sts.filter((s) => s.code && codeKey(s.code))
        if (coded.length >= 2) {
          const a = codeKey(coded[0].code), b = codeKey(coded[coded.length - 1].code)
          if (a[1] > b[1]) { sts.reverse(); ordered.reverse() } // 首站碼 > 末站碼 → 反轉成 A1 在前（行經序同步）
        }
      }
      f.__stations = sts
      f.__passStations = passSts
      f.__stationsOrdered = ordered
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
      // 車站的路線一律存單一 `routes[]`（使用者規則：與路段 feature 同形式、不拆平行
      // array、不輸出 OSM 內部 id）：每項 { ref, name, pass? }——pass:true＝行經不停
      // （快車跳站），無 pass 鍵＝停靠。同 ref 的普通/直達由 name 區分。route_id 只在
      // build 內部做站↔線歸屬（唯一鍵），不寫進車站欄位。`lines`（停靠 refs）保留給
      // no_line 不變式與地圖 hover。
      // 顯示身分（ref＋name）去重：同官方名的分支（中和新蘆線 迴龍/蘆洲、將軍澳綫
      // 寶琳/康城）在共用站會出現兩筆一模一樣的列（使用者 2026-07 蘆洲截圖）——
      // 站層只留一筆；異名分支（松山新店線 vs 小碧潭支線）不受影響。
      const seenDisp = new Set()
      const dispRoutes = routes.filter((r) => {
        const k = `${r.route_ref ?? ''}|${r.route_name ?? ''}`
        if (seenDisp.has(k)) return false
        seenDisp.add(k)
        return true
      })
      s.properties.lines = dispRoutes.map((r) => r.route_ref ?? r.route_name)
      // 官方站碼清單（如台北車站 [A1, BL12, R10]）——各線各自的碼；route.stations 每站另帶
      // 依該線 ref 挑出的 `code`。內部 Set 清掉（避免序列化成 {}）。
      if (s.__codes?.size) s.properties.codes = [...s.__codes].sort()
      delete s.__codes
      // 行經但不停靠（快車跳站）：route_id 直接來自 __passStations；排除也停靠者。
      const passIds = [...(passRoutesBySt.get(sid) ?? [])].filter((id) => !stopIds.has(id))
      const pr = passIds.map(routeMeta)
      const seenDisp2 = new Set(dispRoutes.map((r) => `${r.route_ref ?? ''}|${r.route_name ?? ''}`))
      const dispPass = pr.filter((r) => {
        const k = `${r.route_ref ?? ''}|${r.route_name ?? ''}`
        if (seenDisp2.has(k)) return false
        seenDisp2.add(k)
        return true
      })
      // 每筆停靠/行經路線自帶 route_color——**車站 routes 用的是個別線 ref（"2"/"N"），
      // 路段 routes 經 trunk 合併後是幹線 ref（"1/2/3"/"N/Q/R/W"）**，故前端由路段建的
      // refColor map 查不到車站的個別 ref/name（色swatch 全空＝使用者「停靠路線顏色都錯」）。
      // 直接把個別線色寫進車站 routes，前端不必再查表。
      s.properties.routes = [
        ...dispRoutes.map((r) => ({ ref: r.route_ref ?? r.route_name, name: r.route_name, route_color: r.route_color ?? null })),
        ...dispPass.map((r) => ({ ref: r.route_ref ?? r.route_name, name: r.route_name, route_color: r.route_color ?? null, pass: true })),
      ]
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
      // 經過並停靠、共用進站方向使 degree=2」的漏判）**或** 端點站被 pass 路線穿過
      // （使用者裁決 2026-07-16 東涌案：TCL 終點、AEL pass 續往機場——幾何上線
      // 穿過此站再分岔，degree=2 但絕不可能是藍色端點＝分歧紅點；顯徑/欣澳的
      // 分岔在走廊中段 degree=3 已被第一條件涵蓋，這條補「分岔恰在終點站」的洞）。
      // 四者皆為「≥2 路段相交」；共軌中間站（非端點、degree=2、termCount=0）仍不算，
      // NYC express 沿 local 走廊的中間 pass 站照舊黑點。
      // 端點站規則用**顯示線數**（dispRoutes＝官方線身分去重後）：同名分支（中和新蘆線
      // 迴龍/蘆洲）在端點只算 1 條線——蘆洲是單線端點＝藍點，不因兩個 branch route_id
      // 誤判成紅點；七張（松山新店線＋小碧潭支線異名）仍 2 線。
      // 轉乘（紅點）必須是「≥2 條**相異色**的線」在此相交，不是「≥2 個服務」——NYC 同幹線
      // 的多個服務（N/W 同黃、B/D/F/M 同橘、1/2/3 同紅）雖 degree>2 或端點多服務，卻是**同
      // 一條線**、非轉乘（使用者：好多車站顏色和路線對不上）。故 degree/端點條件成立後，再
      // 要求「相異 route_color ≥2」才算紅點；同色幹線的分歧/端點回歸藍/白點。
      const stColors = new Set([...dispRoutes, ...dispPass].map((r) => r.route_color).filter(Boolean))
      const isNYC = /new york city/i.test(grp.info?.city || '')
      let isIx, role
      if (isNYC) {
        // 使用者裁決 2026-07-17（NYC，視覺為主）：紅/藍/白**純看「畫出的線」拓撲度數**
        // ——共線（多服務/多色共用同一段畫線）＝**一條線**，色數與服務數皆不計：
        //   · deg≥3（畫線在此分岔/交會 junction）→ 紅點：Rockaway Blvd（A 分岔
        //     Lefferts/Rockaway）、Rockefeller（4 向）、135 St、Brooklyn 59 St。
        //   · deg≤1（單一畫線盡頭）→ 藍點（terminus）——**即使該段是多色共線**：
        //     Jamaica Center（E+J/Z 共線盡頭、2 色仍 1 條畫線）、Astoria（N/W）、
        //     Broad St（J/Z）皆藍。
        //   · deg==2（畫線直線通過）→ 白點——即使多服務同走廊：5th Av-59（N/R/W）、
        //     72 St（1/2/3）、Euclid Av（A 貫通、C 在此終點但畫線續行 deg=2）。
        // degree ＝相異相鄰站數（共線給相同前後鄰→collapse 成一條），正是「畫出幾條線」。
        isIx = deg >= 3
        role = isIx ? 'interchange' : (deg <= 1 ? 'terminus' : 'normal')
        // 前端（LayerTab/D3Tab/GalleryTile/viewGeometry）著色只看 is_interchange/
        // is_terminus 旗標，不看 station_role——NYC 必須把舊語義（任一服務在此終點
        // ＝true，如 Euclid 的 C、Church Av 的 G、Utica 的 4）覆寫成 role 同步值，
        // 否則 role=normal 的站仍被畫成藍點（使用者 2026-07-17 回報四站全中）。
        s.properties.is_terminus = role === 'terminus'
      } else {
        // 其他城市：維持既有「相異色 ≥2 ＋（junction/端點）」規則——他城同色分支
        // （台北大橋頭 orange 分岔）官方不算轉乘，未經 NYC 視覺裁決，不動 226 城既有行為。
        isIx = stColors.size >= 2 && (deg > 2 || termCount >= 2
          || (s.properties.is_terminus && dispRoutes.length >= 2)
          || (s.properties.is_terminus && dispPass.length >= 1 && deg >= 2))
        role = isIx ? 'interchange' : (s.properties.is_terminus ? 'terminus' : 'normal')
      }
      s.properties.is_interchange = isIx
      s.properties.station_role = role
      // 全城一致鍵集（使用者：物件顯示不可因城市而異、不要客製）——缺值一律 null/false，
      // 每站輸出的欄位集完全相同，前端表格列數/順序全球一致。
      for (const [k, v] of Object.entries({ station_name_local: null, station_name_en: null,
        network: null, network_local: null, operator: null, wikidata: null, wikipedia: null,
        codes: null, merged_from: null, merged_names: null, is_terminus: false })) {
        if (s.properties[k] === undefined) s.properties[k] = v
      }
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
    // 系統 metadata＝**存活線多數決**（此時 allow-list/LRT 剔除已完成）：operator/官網/
    // wikipedia/wikidata 各取存活線 __meta 的最高票非空值（初期先到先贏值當 fallback）。
    {
      const vote = (k) => {
        const cnt = new Map()
        for (const f of routeFeats) { const v = f.__meta?.[k]; if (v) cnt.set(v, (cnt.get(v) || 0) + 1) }
        let best = null, bn = 0
        for (const [v, n] of cnt) if (n > bn) { best = v; bn = n }
        return best
      }
      // 只信存活線：沒有任何存活線帶該 tag → null（fallback 會被已剔除線毒到，
      // 東京 yurikamome 案）。
      grp.operator = vote('operator')
      grp.official_url = vote('website')
      grp.wikipedia = vote('wikipedia')
      grp.wikidata = vote('wikidata')
    }
    const metaCache = new Map()
    const metaOf = (f) => {
      if (!metaCache.has(f)) {
        const p = f.properties
        metaCache.set(f, {
          route_id: p.route_id, route_name: p.route_name,
          route_name_local: p.route_name_local, route_name_en: p.route_name_en ?? null, route_ref: p.route_ref,
          route_color: p.route_color, network: p.network,
          network_local: p.network_local, operator: p.operator,
          wikidata: p.wikidata, wikipedia: p.wikipedia,
          osm_route_ids: p.osm_route_ids,
          status: p.status ?? null,
          order_suspect: suspectOrder(f),
          // 此 route 的**完整行經序**（stop＋pass 依幾何真實順序交錯；pass 項標 pass:true
          // ＝行經但不停靠，快車跳站——使用者規則：資訊面板站序含 pass 照真實順序）。
          // 站數/圖論一律取**非 pass** 項（消費端自行 filter）。
          stations: f.__stationsOrdered ?? f.__stations ?? [],
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
    // 路段必須**連續**（使用者不變式：路段只含該段車站、不中間斷掉，hover 不得斷開）：
    // 同簽名（相同 route 集合）的 runs 可能是**不相連的多段走廊**（NYC M 線在 Queens Blvd
    // 與 Ridgewood 各有一段 M-only），塞進同一個 feature 會讓 hover 高亮出現缺口。
    // 依共用頂點做 union-find，把每個簽名的 seqs 拆成連通組——一組＝一個 seg feature。
    grp.lines = []
    let si = 0
    for (const [sig, seqs] of segs.entries()) {
      const parent = new Map()
      const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r)
        let c = x; while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n } return r }
      const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra) }
      seqs.forEach((seq, qi) => {
        const tag = `q${qi}`
        parent.set(tag, tag)
        for (const c of seq) { const k = cs(c); if (!parent.has(k)) parent.set(k, k); uni(tag, k) }
      })
      const comps = new Map() // root -> seqs
      seqs.forEach((seq, qi) => {
        const r = find(`q${qi}`)
        if (!comps.has(r)) comps.set(r, [])
        comps.get(r).push(seq)
      })
      const routes = sig.split('/').map((i) => metaOf(routeFeats[+i]))
      const colors = routes.map((r) => r.route_color || '#e11d48')
      for (const compSeqs of comps.values()) {
        grp.lines.push({
          type: 'Feature',
          properties: {
            seg_id: `${slugify(grp.info.city) || 'x'}-${si++}`,
            routes,
            route_count: routes.length,
            route_refs: routes.map((r) => r.route_ref || r.route_name),
            route_colors: colors,
            city: grp.info.city, country: grp.info.country,
          },
          geometry: { type: 'MultiLineString', coordinates: compSeqs },
        })
      }
    }
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
  // NYC only (使用者 2026-07): 同色不同 ref 的營運服務＝共線的同一條幹線，合成 1 條
  // 線——1/2/3（同紅）→ 一條「1/2/3」紅線，快車跳站以 pass 標示；不同色共軌仍各自
  // 一條（渲染層 _nc≥2 交錯虛線不變）。只作用於紐約，其他城市維持逐服務一線。
  // 後處理最終 feature list：把 routes[] 依 route_color 收成 trunk 身分並去重。
  const mergeSameColourTrunks = (feats) => {
    const refsByColor = new Map(), colorOfRef = new Map()
    for (const f of feats) {
      if (f.geometry.type === 'Point') continue
      for (const r of f.properties.routes || []) {
        const col = r.route_color, ref = r.route_ref ?? r.route_name
        if (!col || ref == null) continue
        if (!refsByColor.has(col)) refsByColor.set(col, new Set())
        refsByColor.get(col).add(String(ref)); colorOfRef.set(String(ref), col)
      }
    }
    const trunkOfColor = new Map()
    for (const [col, set] of refsByColor) {
      const label = [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('/')
      trunkOfColor.set(col, { route_id: `nyc-trunk-${col}`, route_ref: label, route_name: label, route_color: col })
    }
    // 路段：只 relabel 顯示身分（route_ref/name→trunk），**保留每個服務自己的 route_id
    // 與 stations**——示意圖骨架（skeleton.js）以 route_id 為鍵、逐路線 stations 建拓撲，
    // 若把 1/2/3 併成同一 route_id 只會留一條的站、其餘站變孤兒白點（使用者截圖的散點）。
    // 同色共軌畫實線靠渲染層 `_nc`（相異色數＝1），不需在資料層合併 route_id。
    for (const f of feats) {
      if (f.geometry.type === 'Point') continue
      const routes = f.properties.routes || []
      for (const r of routes) {
        const tk = trunkOfColor.get(r.route_color)
        if (tk) { r.route_ref = tk.route_ref; r.route_name = tk.route_name }
      }
      // route_colors 必須**去重成相異色**並讓 route_count＝相異色數——LayerTab 交錯虛線
      // 以 route_count 決定槽位數、以 route_colors[i] 取色；若 route_colors 留重複
      // （[red,red,green,green]）而 route_count＝2，兩槽都取到 red → 共線只畫紅（使用者：
      // 很多共線沒畫交錯色）。去重後 route_count=2、route_colors=[red,green] → 紅綠交錯。
      const cols = [...new Set(routes.map((r) => r.route_color))]
      f.properties.route_count = cols.length
      f.properties.route_refs = [...new Set(routes.map((r) => r.route_ref || r.route_name))]
      f.properties.route_colors = cols
    }
    // 車站 routes[]/lines **不** relabel 成 trunk——車站顯示**實際停靠的服務**（Atlantic
    // Av–Barclays 停 2/3/4/5/B/D/N/Q/R，不是 trunk 標籤 1/2/3/4/5/6/…；使用者 2026-07）。
    // trunk 合併只作用於「線」（map 同色一條），車站保留原本每個服務的 ref＋pass。
    return trunkOfColor.size
  }

  const groups = [...cityGroups.values()].sort((a, b) => b.lines.length - a.lines.length)
  for (const grp of groups) {
    const { info } = grp
    const relPath = `${info.key}.geojson`
    const feats = [...grp.lines, ...grp.stations]
    const nycTrunkCount = /new york/i.test(info.city || '') ? mergeSameColourTrunks(feats) : null
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
      // segment features (segment_count) whose `routes` lists the routes on them.
      // NYC: same-colour services merged into trunk lines (1/2/3 → one) → trunk count.
      line_count: nycTrunkCount ?? grp.routeCount ?? grp.lines.length,
      segment_count: grp.lines.length,
      station_count: grp.stations.length,
      // per-city audit verdict (scripts/auditLoop.mjs): passed / reasons / checks
      audit,
    }
    const outPath = join(SYS_DIR, relPath)
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, JSON.stringify(fc(feats, { metro_system: systemMeta })))
    index.push({ file: `metro-maps/${relPath}`, ...systemMeta })
  }

  // stale-file cleanup：桶的命名/歸屬改變時，上一輪寫出的舊檔要刪掉
  // （index 不引用的 systems/*.geojson 一律不留，避免殘留誤導）。
  // **例外：additive 合併系統 `*-jr`／`*-lm`／`*-lrt`／`*-incheon`／`*-rail`.geojson**（東京＋山手／
  // 城市＋地標／新加坡＋LRT／首爾＋仁川／台北＋台鐵＋高鐵／東京＋JR＋私鐵，由 buildJrCombined／
  // buildLandmarkCombined／buildSingaporeVariants／buildCombinedSystems 維護）不是 buildGeojson
  // 的產出，**絕不刪**——否則每次 base 重建都會把它們掃掉、下游圖層變英文/找不到（使用者多次回報）。
  {
    const wanted = new Set(index.map((i) => join(BASE, i.file)))
    const walk = async (d) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else if (p.endsWith('.geojson') && !wanted.has(p) && !/-(?:jr|lm|lrt|incheon|rail)\.geojson$/.test(e.name)) {
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

  // 保留 additive 合併系統的 index 條目（`*-jr`／`*-lm`／`*-lrt`）——buildGeojson 不產生
  // 它們，但也**不得**把它們從 index 移除（否則每次 base 重建，前端就找不到 東京＋山手／
  // 城市＋地標／新加坡＋LRT，圖層名變英文）。它們的檔案也在上面的 stale-cleanup 被豁免，
  // 故 index＋檔案一起存活。
  // 資料可能因 base 更新而過時 → metro:build/metro:all 會接著重跑兩個 combined builder 刷新。
  let combined = []
  try {
    const prev = JSON.parse(await readFile(join(BASE, 'index.json'), 'utf8'))
    const have = new Set(index.map((i) => i.file))
    combined = (prev.systems || []).filter((s) => /-(?:jr|lm|lrt|incheon|rail)\.geojson$/.test(s.file || '') && !have.has(s.file))
  } catch { /* first run */ }
  const indexAll = [...index, ...combined]

  await writeFile(join(BASE, 'index.json'), JSON.stringify({
    generated_from: 'OpenStreetMap via Overpass API (route=subway|light_rail, operational only; ' +
      'line geometry = stops connected in member order; same-named stations merged)',
    baseline: 'Wikipedia: List of metro systems',
    system_count: indexAll.length,
    wikipedia_system_count: wikiSystems.length,
    line_total: lines.length,
    station_total: stations.length,
    systems: indexAll,
    wikipedia_cities_without_match: missing,
  }, null, 2))

  console.log(`  ${index.length} base + ${combined.length} combined systems written to ${SYS_DIR}`)
  console.log(`  matched ${matchedCities.size} cities; ${missing.length} wikipedia systems unmatched by city name`)
  console.log(`  index -> ${join(BASE, 'index.json')}`)
}

build().catch((e) => { console.error(e); process.exit(1) })
