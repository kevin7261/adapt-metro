// 抓取東京主要私鐵（東急/京急/小田急/京王/西武/相鉄/つくば/りんかい…）——這些
// route=train 私鐵不在 data/railway 的 JR 六社檔內（該資料只有 JR＋零星私鐵），故
// 「東京＋JR＋私鐵」combined 系統缺主要私鐵。此腳本從 OSM 另抓，寫成
// data/metro/_overrides/tokyo-private-lines.json，供 buildCombinedSystems.mjs 併入
// as-jpn-tokyo-rail（有此檔就併、沒有就跳過）。
//
//   npm run metro:fetchtokyoprivate   →  data/metro/_overrides/tokyo-private-lines.json
//   npm run metro:combined            →  重建 as-jpn-tokyo-rail（含私鐵）
//   npm run metro:views               →  重算縮圖（拉直/RWD 畫廊）
//
// 做法：①operator 過濾（不加 bbox，避免 Overpass 逾時）抓候選 route=train 的 tags；
//       ②同 operator＋ref（無 ref 用基底線名）分組，取「停靠站最多」的變體當代表（去上下行）；
//       ③抓代表的成員＋節點、依 role=stop 取序；④bbox 截成大東京都心段；⑤寫檔。
//
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { query } from './overpass.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'data', 'metro', '_overrides', 'tokyo-private-lines.json')

// 與 buildCombinedSystems.mjs 的 TOKYO_BBOX 一致（大東京都心）
// 東界延到 140.42 納成田空港（京成本線/成田スカイアクセス往東到成田機場，使用者）
const TOKYO_BBOX = [139.56, 35.54, 140.42, 35.84]
const inBbox = ([lon, lat]) =>
  lon >= TOKYO_BBOX[0] && lon <= TOKYO_BBOX[2] && lat >= TOKYO_BBOX[1] && lat <= TOKYO_BBOX[3]

const R = 6371000, rad = (d) => (d * Math.PI) / 180
function hav([x1, y1], [x2, y2]) {
  const a = Math.sin(rad(y2 - y1) / 2) ** 2 + Math.cos(rad(y1)) * Math.cos(rad(y2)) * Math.sin(rad(x2 - x1) / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
// 站序重建：最近鄰鏈（各變體 union 後順序會亂）。從最西端起，貪婪接最近未用站。
function chainOrder(sts) {
  if (sts.length < 3) return sts
  let start = 0
  for (let i = 1; i < sts.length; i++) if (sts[i].coord[0] < sts[start].coord[0]) start = i
  const used = new Array(sts.length).fill(false), out = [sts[start]]; used[start] = true
  for (let k = 1; k < sts.length; k++) {
    const last = out[out.length - 1]; let bi = -1, bd = Infinity
    for (let i = 0; i < sts.length; i++) { if (used[i]) continue; const d = hav(last.coord, sts[i].coord); if (d < bd) { bd = d; bi = i } }
    out.push(sts[bi]); used[bi] = true
  }
  return out
}

// 主要私鐵營運商（OSM operator 標法）。世田谷線/都電=tram、ゆりかもめ/舎人/モノレール=
// monorail/light_rail，皆不在 route=train 內自然排除。京成/東武由此完整抓（railway 資料只有
// 零星幾條、已在 buildCombinedSystems 的 TOKYO_RAIL_EXCLUDE 排除避免重複）。
const OPERATORS = '東急|東京急行|京浜急行|京王|小田急|西武鉄道|西武|相模鉄道|相鉄|首都圏新都市鉄道'
  + '|東京臨海高速鉄道|Tokyo Waterfront|京成|東武|新京成|北総|東葉高速鉄道|埼玉高速鉄道'
// 台場/臨海副都心一帶的新交通/單軌（route=light_rail|monorail，非 route=train，需另查）：
// ゆりかもめ（台場主力）、東京モノレール、日暮里・舎人ライナー、多摩都市モノレール。
const AGT_NAMES = 'ゆりかもめ|東京モノレール|舎人ライナー|多摩都市モノレール|多摩モノレール'

// 排除：直通運転覆蓋線（跨社直通班次，非路線本身，見 metro-osm-fetch）＋具名優等列車
// （スカイライナー/ロマンスカー/きぬがわ/シティライナー…是「列車」不是「線」）。
// **不可放 bare「急行/快速」**——會誤傷京浜急`行`；各停/急行/快速同名變體改由 baseLineName
// 分組時「取最長（各停）」自然收斂，無須在此排除。
const SERVICE_EXCLUDE = /直通運転|バイパス|ライナー|きぬがわ|けごん|スペーシア|リバティ|ロマンスカー|Cityliner|シテイ|シティ|アクセス|小江戸|Ｓトレイン|S-?TRAIN|ウィング|Wing/i

// 線名去「列車」前綴、方向/區間括號尾綴、A=>B/A->B/A→B 尾段
function cleanName(s) {
  return (s || '')
    .replace(/^列車\s*/, '')
    .split(/[:：]/)[0]
    .replace(/\s*[（(][^（()）]*[）)]\s*$/g, '') // 去尾端整段括號（浦賀=>泉岳寺 / 西に / 方面…）
    .replace(/\s*(?:=>|->|→|–|—).*$/, '')        // 去 A=>B / A→B 尾段
    .replace(/(?:上り|下り|上リ|下リ)$/, '')      // 去方向尾綴（つくばエクスプレス線上り）
    .trim()
}
function normHex(c) {
  if (!c) return null
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(c)) return ('#' + c.slice(1).split('').map((h) => h + h).join('')).toLowerCase()
  return null
}

// 分組鍵：同社同「基底線名」＝同一條線（京成本線/押上線/千葉線 都 ref=KS，不能用 ref 分組）。
// 去社名前綴＋種別（普通/各停/快速/急行/特急/準急…）尾綴，讓上下行與各種別收斂成一條。
const opKey = (t) => (t.operator || '').split(/[ (（]/)[0].replace(/(電鉄|鉄道|株式会社|旅客鉄道)$/g, '')
function baseLineName(t) {
  return cleanName(t['name:ja'] || t.name)
    .replace(/[（(].*$/, '')
    .replace(/^(京成電鉄|京浜急行電鉄|京王電鉄|小田急電鉄|東急電鉄|西武鉄道|東武鉄道|相模鉄道|首都圏新都市鉄道|東京臨海高速鉄道)\s*/, '')
    .replace(/\s*(普通|各停|各駅停車|快速特急|快速急行|快特|通勤特急|通勤準急|通勤急行|快速|準急|急行|特急|区間.*)$/, '')
    .trim()
}

// ---- ① 候選 tags ---------------------------------------------------------
const tagQ = `[out:json][timeout:180];
relation["type"="route"]["route"="train"]["operator"~"${OPERATORS}"];
out tags;`
const agtQ = `[out:json][timeout:180];
relation["type"="route"]["route"~"^(light_rail|monorail)$"]["name"~"${AGT_NAMES}"];
out tags;`
const tagRes = await query(tagQ, { cacheName: 'tokyo_private_tags.json' })
const agtRes = await query(agtQ, { cacheName: 'tokyo_agt_tags.json' })
const cands = [...tagRes.elements, ...agtRes.elements].filter((e) => e.type === 'relation')
console.log(`候選 relation：${cands.length}（route=train 私鐵 ${tagRes.elements.length}、新交通/單軌 ${agtRes.elements.length}）`)

// ---- ② 抓成員（分批）並計站數，同組取最長 --------------------------------
const ids = cands.map((e) => e.id)
const memberNodes = new Map() // nodeId -> node
const relMembers = new Map()  // relId -> members[]
const BATCH = 60
for (let i = 0; i < ids.length; i += BATCH) {
  const batch = ids.slice(i, i + BATCH)
  const q = `[out:json][timeout:180];
relation(id:${batch.join(',')})->.r;
.r out body;
node(r.r);
out body;`
  const res = await query(q, { cacheName: `tokyo_private_members_${i}.json` })
  for (const e of res.elements) {
    if (e.type === 'node') memberNodes.set(e.id, e)
    else if (e.type === 'relation') relMembers.set(e.id, e.members || [])
  }
  console.log(`  成員批 ${i / BATCH + 1}/${Math.ceil(ids.length / BATCH)}`)
}

function orderedStops(members) {
  const out = []
  for (const m of members) {
    if (m.type !== 'node' || !/stop/.test(m.role || '')) continue
    const n = memberNodes.get(m.ref)
    if (!n) continue
    const t = n.tags || {}
    // 去 stop 編號尾綴（つくば節點名如「南流山02」「八潮03」＝OSM 月台序號，非站名）——
    // 日文站名不會以阿拉伯數字結尾，可安全剝除。
    const strip = (s) => (s || '').replace(/\s*\d+$/, '')
    const name = strip(t['name:ja'] || t.name || t['name:en'])
    if (!name) continue
    if (out.length && out[out.length - 1].id === `n${m.ref}`) continue
    out.push({
      id: `n${m.ref}`, name, nameLocal: strip(t['name:ja'] || t.name) || name,
      nameEn: strip(t['name:en']) || null, code: t.ref || null, coord: [n.lon, n.lat],
    })
  }
  return out
}

// 分組：operator|ref（無 ref 用 operator|cleanName）。先剔除直通/優等服務。
const groups = new Map()
let skipped = 0
// 新交通/單軌是「線」不是服務——名含ライナー/普通/快速也不套服務過濾（日暮里・舎人ライナー等）
const AGT_ALLOW = /ゆりかもめ|舎人|東京モノレール|多摩都市モノレール/
for (const e of cands) {
  const t = e.tags || {}
  const isAgt = AGT_ALLOW.test(t.name || '')
  if (!isAgt && SERVICE_EXCLUDE.test(`${t.name || ''} ${t.ref || ''}`)) { skipped++; continue }
  // 相鉄（相模鉄道）＝橫濱系統，東京只有零星片段（使用者：不用抓）
  if (/相鉄|相模鉄道/.test(`${t.operator || ''} ${t.name || ''}`)) { skipped++; continue }
  // 東武大師線＝西新井↔大師前 2 站支線（使用者：不用抓）
  if (/大師線/.test(t.name || '') && /東武/.test(`${t.operator || ''} ${t.name || ''}`)) { skipped++; continue }
  // 京成千原線／芝山鉄道線（千葉，使用者：不用抓）
  if (/千原線|芝山/.test(`${t.operator || ''} ${t.name || ''}`)) { skipped++; continue }
  const base = baseLineName(t)
  if (!base) { skipped++; continue }
  const key = `${opKey(t)}|${base}`
  const stops = orderedStops(relMembers.get(e.id) || [])
  let g = groups.get(key)
  if (!g) { g = { tags: t, id: e.id, stops, color: null, union: new Map() }; groups.set(key, g) }
  else if (stops.length > g.stops.length) { g.tags = t; g.id = e.id; g.stops = stops }
  // 顏色跨變體borrow：任一方向變體有 colour 就記下（代表可能缺）
  g.color = g.color || normHex(t.colour) || normHex(t.color)
  // 各變體（各停/急行/上下行）站集 union——各停常有急行沒有的站，union 才不漏站（小田急千歳船橋等）
  for (const s of stops) if (!g.union.has(s.name)) g.union.set(s.name, s)
}
console.log(`剔除直通/優等服務 ${skipped} 筆；分組 ${groups.size} 條`)

// ---- ③④ 代表線 → bbox 截斷 → SourceLine ---------------------------------
const lines = []
for (const [key, g] of groups) {
  const t = g.tags
  // 用最長變體（各停）的原始成員順序——OSM 私鐵 route 成員序多半正確，不亂重排（最近鄰在
  // 長線會打結，如京成本線）。只補進其他變體有、但此變體漏的站（union），插到幾何最近的相鄰位。
  let stops = g.stops.filter((s) => inBbox(s.coord)).filter((s, i, a) => i === 0 || s.id !== a[i - 1].id)
  const have = new Set(stops.map((s) => s.name))
  for (const s of g.union.values()) {
    if (have.has(s.name) || !inBbox(s.coord)) continue
    // 插到與前後站距離總和最小的位置
    let bi = stops.length, bd = Infinity
    for (let i = 0; i <= stops.length; i++) {
      const a = stops[i - 1], b = stops[i]
      const cost = (a ? hav(a.coord, s.coord) : 0) + (b ? hav(b.coord, s.coord) : 0) - (a && b ? hav(a.coord, b.coord) : 0)
      if (cost < bd) { bd = cost; bi = i }
    }
    stops.splice(bi, 0, s); have.add(s.name)
  }
  if (stops.length < 2) continue
  const rawLoop = g.stops.length > 2 && g.stops[0].id === g.stops[g.stops.length - 1].id
  const rawName = cleanName(t['name:ja'] || t.name)
  // 同線異名歸一（使用者）：京王線/京王新線 同屬京王線（KO，快慢車/線路別；新線＝新宿↔笹塚
  // 支線含初台/幡ヶ谷），統一顯示成「京王線」→ 同名同色渲染成一條。
  const LINE_CANON = { '京王新線': '京王線', '京王電鉄京王線': '京王線' }
  // 去線名尾的種別（東京モノレール羽田空港線 普通 → …羽田空港線）
  const name = (LINE_CANON[rawName] || rawName).replace(/\s*(普通|各停|各駅停車|快速|急行|特急|区間快速|空港快速)$/, '').trim()
  // 名稱仍含種別（急行/快速/特急/普通…）＝殘留的服務變體片段（各停已另成一條）→ 丟。
  // 真實線名不含這些；(?<!京浜) 讓「京浜急行」社名不被 急行 誤傷、「エクスプレス」不在此列、
  // AGT/單軌（舎人ライナー/モノレール普通…）名帶種別但是線本身、不丟。
  if (!AGT_ALLOW.test(name) && /(?<!京浜)急行|快速|特急|準急|通勤|普通|各停|各駅/.test(name)) continue
  lines.push({
    routeId: `tokyopriv-r${g.id}`,
    opk: key.split('|')[0],
    ref: t.ref || name,
    name, nameLocal: name, nameEn: t['name:en'] ? cleanName(t['name:en']) : null,
    color: g.color || normHex(t.colour) || normHex(t.color) || '#888888',
    network: t.network || t.operator || 'Private Railway',
    networkLocal: t['network:ja'] || t.operator || null,
    operator: t.operator || null,
    wikidata: t.wikidata || null,
    wikipedia: t.wikipedia || null,
    osmIds: [g.id], loop: rawLoop && stops.length > 2,
    stations: stops,
  })
}

// 站集重疊去重：OSM 名稱太亂（京成本線 vs 京成本線・千葉線 普通、京急本線 vs 逗子•本線•空港線
// 急行、東武大師線 vs 東武鉄道大師線…），改用「同社且站集高度重疊（≥60%）」判為同一條線，
// 保留站最多者。
const overlap = (A, B) => {
  let n = 0; for (const x of A) if (B.has(x)) n++
  return n / Math.min(A.size, B.size)
}
// 用站「名」集（比 node id 穩定：同站在不同 relation 常用不同 stop node）
const nameSet = (L) => new Set(L.stations.map((s) => s.name))
lines.sort((a, b) => b.stations.length - a.stations.length)
const kept = []
for (const L of lines) {
  const Ls = nameSet(L)
  if (kept.some((K) => K.opk === L.opk && overlap(nameSet(K), Ls) >= 0.6)) continue
  kept.push(L)
}
kept.sort((a, b) => (a.operator || '').localeCompare(b.operator || '') || (a.ref || '').localeCompare(b.ref || ''))
lines.length = 0; lines.push(...kept)

await writeFile(OUT, JSON.stringify({
  generated_at: new Date().toISOString(),
  bbox: TOKYO_BBOX,
  note: '東京主要私鐵（route=train，operator 過濾）→ buildCombinedSystems 併入 as-jpn-tokyo-rail',
  lines,
}, null, 2))
console.log(`\n寫出 ${lines.length} 條私鐵線 → ${OUT}`)
for (const l of lines) console.log(`  [${l.ref}] ${l.name} (${l.stations.length} 站) ${l.color}  ${l.operator || ''}`)
