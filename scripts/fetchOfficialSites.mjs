// Fetch each metro system's OFFICIAL WEBSITE (homepage URL, not the route-map
// image — 使用者 2026-07 裁決：路線圖不抓了，改抓官方網站)。
//
// 解析順序（每個候選都要通過驗證才採用）：
//   1. _overrides/site_overrides.json 釘選
//   2. Wikidata 系統條目的 P856 (official website)
//      - 候選 QID：OSM network:wikidata（'Unknown' netKey 不可查表）→ wbsearchentities
//        （每查詢 5 個候選逐一驗證；純代號 A1/M4 不當搜尋詞）
//      - 條目驗證：labels+aliases+descriptions+sitelinks（全語言）必須提及該城市/國家/
//        全索引唯一 network token；描述提到別國沒提到本國 → 拒收（同名城防呆）；
//        單線條目（description "…line…"）改爬 P361 上層系統
//   3. OSM route relation 的 website / contact:website tag（netKey 對應）
//   4. enwiki 條目 infobox 的 website 參數（{{URL|...}} 或裸 URL）
//
// 每個 URL 做存活檢查（GET，跟隨轉址）：404/410/網路錯誤 → 換下一個來源；
// 403/999 等擋爬蟲狀態視為存活。輸出 data/metro/official_sites.json
// （key=洲/國/slug，與 systems/ 檔名對應），前端 資訊 tab 的「官網」列讀它，
// 缺項 fallback 到 metro_system.official_website（OSM build 端舊值，常是深層頁）。
//   node scripts/fetchOfficialSites.mjs [--only substr1,substr2]
import { readFile, writeFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '..', 'data', 'metro')
const CACHE = join(BASE, '_cache')
const OUT = join(BASE, 'official_sites.json')
const OVERRIDES = join(BASE, '_overrides', 'site_overrides.json')
const UA = 'adapt-metro-thesis/1.0 (official site fetch; knowledge.nomads.tw2@gmail.com)'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pick = (t, ...ks) => { for (const k of ks) if (t[k]) return t[k]; return null }
const netKey = (t) => pick(t, 'network:en', 'network', 'operator') || 'Unknown'

const ONLY = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : null
})()

async function exists(p) { try { return (await stat(p)).size > 0 } catch { return false } }

async function getJSON(url) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (e) { if (a === 3) throw e; await sleep(1500 * (a + 1)) }
  }
}

// ---------- validation helpers（與 downloadMaps.mjs 同一套判準） ----------

const norm = (s) => (s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9一-鿿Ѐ-ӿ]/g, '')

const GENERIC = new Set([
  'metro', 'subway', 'underground', 'rail', 'railway', 'railways', 'transit', 'line', 'lines',
  'light', 'urban', 'rapid', 'network', 'system', 'city', 'area', 'municipal', 'municipality',
  'corporation', 'company', 'limited', 'authority', 'transport', 'transportation', 'trains',
  'train', 'tram', 'unknown', 'metropolitan', 'metropolitana', 'metropolitano', 'estacion',
  'sistema', 'linea', 'lineas', 'ligne', 'lignes', 'linie', 'linien', 'linha', 'linhas',
  'metrosu', 'hatti', 'genel', 'colectivo', 'ferroviario', 'chemin', 'ferro',
])

// 只收城市名變體，**不含國名**——國名放行會讓同國別城的條目混過驗證
// （Seville 曾配到 Metro de Granada：描述含 Spain 就過了）。
function cityAliases(sys) {
  const out = new Set()
  const add = (s) => { const n = norm(s); if (n.length >= 3) out.add(n) }
  add(sys.city)
  add(sys.city.replace(/\(.*\)/g, ''))
  const paren = /\(([^)]+)\)/.exec(sys.city)
  if (paren) add(paren[1])
  return [...out]
}

function rawTokens(sys) {
  const out = new Set()
  for (const s of [...(sys.osm_networks || []), sys.operator || '']) {
    for (const w of String(s).split(/[^A-Za-zÀ-ÿ]+/)) {
      const n = norm(w)
      if (n.length >= 4 && !GENERIC.has(n)) out.add(n)
    }
  }
  return [...out]
}

// 全索引唯一 token 才可指認系統（metrosu/sistema 等跨系統泛用詞自動失格）
let TOKEN_OWNERS = null
function buildTokenOwners(systems) {
  TOKEN_OWNERS = new Map()
  for (const sys of systems) {
    for (const t of rawTokens(sys)) TOKEN_OWNERS.set(t, (TOKEN_OWNERS.get(t) || 0) + 1)
  }
}
const distinctTokens = (sys) => rawTokens(sys).filter((t) => (TOKEN_OWNERS?.get(t) || 0) <= 1)

function entityMentions(sys, entity) {
  const keys = [...cityAliases(sys), ...distinctTokens(sys)]
  const texts = []
  for (const bag of [entity.labels, entity.descriptions]) {
    for (const v of Object.values(bag || {})) texts.push(v.value)
  }
  for (const arr of Object.values(entity.aliases || {})) for (const v of arr) texts.push(v.value)
  for (const sl of Object.values(entity.sitelinks || {})) texts.push(sl.title)
  const blob = norm(texts.join('|'))
  return keys.some((k) => blob.includes(k))
}

function isLineEntity(entity) {
  const desc = entity.descriptions?.en?.value || ''
  const label = entity.labels?.en?.value || ''
  if (/\b(line|linea|línea|linha|ligne|linie)\b/i.test(desc) && !/\bsystem|network\b/i.test(desc)) return true
  return /(line|linea|línea|linha|ligne|linie|hattı)\s*[\dIVXA-Z]{0,4}$/i.test(label.trim())
}

// 民族形容詞 → 正規化國名。舊版 wrongCountry 只比對國名，讓 Abellio 的
// "Dutch public transport company" 混過營運商鏈（Dutch≠Netherlands 字面）誤配紐約。
// 刻意排除 american/english/korean（易與 South American／English 語言／兩韓相撞）。
const DEMONYMS = {
  algerian: 'algeria', argentine: 'argentina', argentinian: 'argentina', armenian: 'armenia',
  australian: 'australia', austrian: 'austria', azerbaijani: 'azerbaijan', azeri: 'azerbaijan',
  bangladeshi: 'bangladesh', belarusian: 'belarus', belgian: 'belgium', brazilian: 'brazil',
  bulgarian: 'bulgaria', canadian: 'canada', chilean: 'chile', chinese: 'china',
  colombian: 'colombia', czech: 'czechia', danish: 'denmark', ecuadorian: 'ecuador',
  ecuadorean: 'ecuador', egyptian: 'egypt', finnish: 'finland', french: 'france',
  georgian: 'georgia', german: 'germany', greek: 'greece', hungarian: 'hungary',
  indian: 'india', indonesian: 'indonesia', iranian: 'iran', italian: 'italy',
  japanese: 'japan', kazakh: 'kazakhstan', kazakhstani: 'kazakhstan', malaysian: 'malaysia',
  mexican: 'mexico', dutch: 'netherlands', nigerian: 'nigeria', norwegian: 'norway',
  pakistani: 'pakistan', panamanian: 'panama', peruvian: 'peru', filipino: 'philippines',
  philippine: 'philippines', polish: 'poland', portuguese: 'portugal', qatari: 'qatar',
  romanian: 'romania', russian: 'russia', saudi: 'saudiarabia', singaporean: 'singapore',
  spanish: 'spain', swedish: 'sweden', swiss: 'switzerland', taiwanese: 'taiwan',
  thai: 'thailand', turkish: 'turkey', ukrainian: 'ukraine', emirati: 'unitedarabemirates',
  british: 'unitedkingdom', uzbek: 'uzbekistan', venezuelan: 'venezuela', vietnamese: 'vietnam',
}

function wrongCountry(sys, entity, allCountries) {
  const descs = ['en', 'es', 'de', 'fr', 'pt'].map((l) => entity.descriptions?.[l]?.value || '').join('|')
  const blob = norm(descs)
  if (!blob) return false
  const mine = norm(sys.country)
  // 本國：國名或其民族形容詞出現 → 判定為對的國家，不拒收
  const myDem = Object.keys(DEMONYMS).filter((d) => DEMONYMS[d] === mine)
  if (blob.includes(mine) || myDem.some((d) => blob.includes(d))) return false
  // 他國：國名出現
  if (allCountries.some((c) => c !== mine && c.length >= 4 && blob.includes(c))) return true
  // 他國：民族形容詞出現（該國不必在 index 內，才能擋 Abellio=Dutch 這類）
  for (const [d, c] of Object.entries(DEMONYMS)) {
    if (c !== mine && d.length >= 4 && blob.includes(d)) return true
  }
  return false
}

// ---------- Wikidata / Wikipedia ----------

const entityCache = new Map()
async function getEntity(qid) {
  if (entityCache.has(qid)) return entityCache.get(qid)
  let e = null
  try {
    const j = await getJSON(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`)
    e = j.entities?.[qid] || null
  } catch { e = null }
  entityCache.set(qid, e)
  await sleep(200)
  return e
}

const p856 = (entity) => (entity.claims?.P856 || [])
  .filter((c) => c.rank !== 'deprecated')
  .map((c) => c.mainsnak?.datavalue?.value).filter(Boolean)

// validated entity -> 候選官網清單（P856 全收；再追 P137 operator／P127 owner 的
// P856——Wikidata 系統條目的 P856 常是死域名或缺項（Paris ratp.info、高雄 krtco、
// 首爾沒有 P856），營運商條目的官網才是活的；line 條目改爬 P361 上層）
const claimIds = (entity, prop) => (entity.claims?.[prop] || [])
  .map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean)

async function sitesFromEntity(sys, entity, allCountries, depth = 0) {
  if (!entity || depth > 2) return []
  const out = []
  const lineish = isLineEntity(entity) && (sys.line_count || 2) > 1
  if (!lineish) {
    for (const u of p856(entity)) out.push({ url: u, qid: entity.id, source: 'wikidata' })
    // 營運商/持有者條目的 P856（provenance 來自已驗證的系統條目，僅擋錯國）
    for (const pid of [...claimIds(entity, 'P137'), ...claimIds(entity, 'P127')].slice(0, 3)) {
      const op = await getEntity(pid)
      if (!op || wrongCountry(sys, op, allCountries)) continue
      for (const u of p856(op)) out.push({ url: u, qid: op.id, source: 'wikidata-operator' })
    }
    const fromArticle = await wikipediaInfoboxSite(entity.sitelinks?.enwiki?.title)
    if (fromArticle) out.push({ url: fromArticle, qid: entity.id, source: 'wikipedia' })
  }
  if (!out.length) {
    for (const pid of claimIds(entity, 'P361')) {
      const parent = await getEntity(pid)
      if (!parent || !entityMentions(sys, parent) || wrongCountry(sys, parent, allCountries)) continue
      out.push(...(await sitesFromEntity(sys, parent, allCountries, depth + 1)))
      if (out.length) break
    }
  }
  return out
}

// enwiki infobox：| website = {{URL|www.x.com}} / [https://x.com ...] / 裸 URL
async function wikipediaInfoboxSite(enTitle) {
  if (!enTitle) return null
  const u = 'https://en.wikipedia.org/w/api.php?action=query&format=json&prop=revisions' +
    '&rvprop=content&rvslots=main&formatversion=2&titles=' + encodeURIComponent(enTitle)
  let j = null
  try { j = await getJSON(u) } catch { return null }
  const wikitext = j.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content
  if (!wikitext) return null
  const m = /\|\s*(?:website|web)\s*=\s*(?:\{\{\s*URL\s*\|\s*(?:1=)?([^|}]+)|\[?(https?:\/\/[^\s\]|}]+))/i
    .exec(wikitext)
  if (!m) return null
  let url = (m[1] || m[2] || '').trim()
  if (!url) return null
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  return url
}

async function searchQids(query, limit = 5) {
  if (!query) return []
  const u = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json' +
    `&language=en&limit=${limit}&search=${encodeURIComponent(query)}`
  try {
    const j = await getJSON(u)
    await sleep(200)
    return (j.search || []).map((s) => s.id)
  } catch { return [] }
}

// 存活檢查：**確定死**（DNS 不存在、404/410）才拒收；403/999 擋爬蟲視為活；
// **連線逾時/重設視為「無法驗證但接受」**——中國官網從境外常連不上（shmetro.com
// connect timeout），URL 本身仍是正確官網，不得因本機網路可達性誤殺。
async function checkAlive(url) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 12000)
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctrl.signal })
    clearTimeout(t)
    if (r.status === 404 || r.status === 410) return { alive: false, status: r.status }
    return { alive: true, status: r.status, finalUrl: r.url }
  } catch (e) {
    const code = e?.cause?.code || e?.name || ''
    if (/ENOTFOUND|EAI_AGAIN/.test(code)) return { alive: false, status: null }   // 域名不存在＝死
    return { alive: true, status: null }   // timeout/reset/TLS＝無法驗證，接受
  }
}

async function resolveSite(sys, net2qid, net2site, allCountries) {
  // 2) Wikidata P856（候選 QID 逐一驗證）
  const tried = new Set()
  const candidates = []
  for (const n of sys.osm_networks || []) {
    if (n !== 'Unknown' && net2qid.has(n)) candidates.push(net2qid.get(n))
  }
  const latinNets = (sys.osm_networks || [])
    .filter((n) => /[a-z]/i.test(n) && n !== 'Unknown' && norm(n).length >= 5 && !/^[A-Za-z]?\d+$/.test(n.trim()))
  for (const q of [...latinNets.slice(0, 3), `${sys.city} Metro`, `${sys.city} metro system`]) {
    candidates.push(...(await searchQids(q)))
    if (candidates.length >= 12) break
  }
  // 收集多個驗證過的條目（≤3）的所有候選 URL，偏好**路徑最淺**者——第一個命中
  // 可能是子系統/線的深層頁（香港曾拿到 MTR 輕鐵子頁而非 mtr.com.hk 首頁）
  let found = []
  let hits = 0
  for (const qid of candidates) {
    if (hits >= 3) break
    if (!qid || tried.has(qid)) continue
    tried.add(qid)
    const entity = await getEntity(qid)
    if (!entity) continue
    if (!entityMentions(sys, entity)) continue
    if (wrongCountry(sys, entity, allCountries)) continue
    const rs = await sitesFromEntity(sys, entity, allCountries)
    if (rs.length) { found.push(...rs); hits++ }
  }
  const seenUrl = new Set()
  found = found.filter((f) => { const k = f.url.replace(/\/$/, ''); if (seenUrl.has(k)) return false; seenUrl.add(k); return true })
  const depth = (u) => { try { return new URL(u).pathname.split('/').filter(Boolean).length } catch { return 9 } }
  found.sort((a, b) => depth(a.url) - depth(b.url))
  // 3) OSM website tag（netKey 對應本系統的 networks）
  for (const n of sys.osm_networks || []) {
    if (n !== 'Unknown' && net2site.has(n)) { found.push({ url: net2site.get(n), qid: null, source: 'osm' }); break }
  }
  // 4) build 端舊值（OSM operator/route 的 website，常是深層頁——墊底）
  if (sys.official_website) found.push({ url: sys.official_website, qid: null, source: 'build' })

  if (process.env.DEBUG_SITES) console.log(`    [debug] ${sys.city}: candidates=${JSON.stringify(found)}`)
  for (const cand of found) {
    const chk = await checkAlive(cand.url); await sleep(200)
    if (process.env.DEBUG_SITES) console.log(`    [debug]   ${cand.url} alive=${chk.alive} status=${chk.status}`)
    if (chk.alive) return { ...cand, status: chk.status, final_url: chk.finalUrl || cand.url }
  }
  return null
}

async function main() {
  const index = JSON.parse(await readFile(join(BASE, 'index.json'), 'utf8'))
  const rt = JSON.parse(await readFile(join(CACHE, 'routes_tags.json'), 'utf8'))
  const net2qid = new Map()
  const net2site = new Map()
  for (const e of rt.elements) {
    if (e.type !== 'relation') continue
    const nk = netKey(e.tags || {})
    if (nk === 'Unknown') continue
    const q = e.tags?.['network:wikidata']
    if (q && !net2qid.has(nk)) net2qid.set(nk, q)
    const w = e.tags?.website || e.tags?.['contact:website']
    if (w && !net2site.has(nk)) net2site.set(nk, w)
  }
  buildTokenOwners(index.systems)
  const overrides = (await exists(OVERRIDES))
    ? JSON.parse(await readFile(OVERRIDES, 'utf8')).overrides || {} : {}
  const allCountries = [...new Set(index.systems.map((s) => norm(s.country)))]

  const sites = ONLY && (await exists(OUT)) ? JSON.parse(await readFile(OUT, 'utf8')) : {}

  let done = 0, got = 0, none = 0
  for (const sys of index.systems) {
    const rel = sys.file.replace(/^systems\//, '').replace(/\.geojson$/, '')
    if (ONLY && !ONLY.some((s) => rel.includes(s))) continue
    done++
    const tag = `[${done}/${ONLY ? ONLY.length : index.systems.length}] ${rel}`

    let entry = null
    const ov = overrides[rel]
    if (ov !== undefined) {
      entry = ov?.website
        ? { website: ov.website, source: 'override', wikidata: ov.wikidata || null }
        : null
      console.log(`  ${tag}: pinned ${entry ? entry.website : 'no-site'} (${ov?.note || 'override'})`)
    } else {
      let r = null
      try { r = await resolveSite(sys, net2qid, net2site, allCountries) } catch { r = null }
      if (r) entry = { website: r.url, source: r.source, wikidata: r.qid || null, http_status: r.status }
      if (r) console.log(`  ${tag} <- ${r.url} (${r.source}, HTTP ${r.status})`)
      else console.log(`  ${tag}: no official site found`)
    }

    if (entry) { got++ } else { none++ }
    sites[rel] = { city: sys.city, country: sys.country, ...(entry || { website: null }) }
    await writeFile(OUT, JSON.stringify(sites, null, 2))
    await sleep(200)
  }
  await writeFile(OUT, JSON.stringify(sites, null, 2))
  console.log(`\nDONE: ${got} sites resolved, ${none} without. -> ${OUT}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
