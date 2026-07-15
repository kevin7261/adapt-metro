// Download each metro system's official network map (schematic) from Wikimedia.
//   network -> network:wikidata (system QID) -> Wikidata P15 "route map"
//   -> Wikimedia Commons file -> download to data/metro/maps/{continent}/{country}/
//
// 抓錯防護（2026-07 全量重抓）：每個 Wikidata 候選條目必須「提及該城市/國家/
// network」（labels+aliases+descriptions+sitelinks 全語言比對）才可用——舊版拿
// wbsearchentities 第一筆就用，曾把米蘭 M1/M3 線圖配給 Lima/Monterrey/Seville、
// 比利時高速公路配給 Ankara。單線條目（description 是 "...line..."）不用其 P15，
// 直接爬 P361 上層系統。檔名黑名單擋規劃圖（planning/tentative/proposed/phase/
// 規劃/перспектив…）。描述提到「別的國家、且沒提到本國」→ 拒收（西班牙
// Metrovalencia 冒充委內瑞拉 Valencia）。
//
// 解析順序：_overrides/map_overrides.json 釘選 > network:wikidata QID >
// wbsearchentities 候選（每查詢取 5、逐一驗證）> enwiki infobox map 參數 >
// P361 上層 > Commons 檔案搜尋後備（檔名必須含城市 token＋map 類 token）。
// 索引每次「全量重建」（不吃舊 maps_index 的鍵——舊鍵含已被 rebucket 清掉的
// 垃圾城市），結束時清掉不再被引用的孤兒圖檔。
// Writes maps_index.json with per-map license + attribution. Run after buildGeojson.mjs.
//   node scripts/downloadMaps.mjs [--only substr1,substr2]
import { readFile, writeFile, mkdir, stat, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '..', 'data', 'metro')
const CACHE = join(BASE, '_cache')
const MAPS = join(BASE, 'maps')
const OVERRIDES = join(BASE, '_overrides', 'map_overrides.json')
const UA = 'adapt-metro-thesis/1.0 (metro map download; knowledge.nomads.tw2@gmail.com)'
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

// ---------- validation helpers ----------

// normalize for containment tests: lowercase, strip diacritics + non-alphanumerics
const norm = (s) => (s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9一-鿿Ѐ-ӿ]/g, '')

// 規劃圖/未來圖/工程圖黑名單（檔名層）
const BAD_FILE = /plan(?:ning|ned)?|tentative|proposed|future|expansion|phase|perspektiv|перспектив|規劃|规划|under.?construction|concept/i

// tokens too generic to identify a system
const GENERIC = new Set([
  'metro', 'subway', 'underground', 'rail', 'railway', 'railways', 'transit', 'line', 'lines',
  'light', 'urban', 'rapid', 'network', 'system', 'city', 'area', 'municipal', 'municipality',
  'corporation', 'company', 'limited', 'authority', 'transport', 'transportation', 'trains',
  'train', 'tram', 'unknown', 'metropolitan', 'metropolitana', 'metropolitano', 'estacion',
])

function cityAliases(sys) {
  const out = new Set()
  const add = (s) => { const n = norm(s); if (n.length >= 3) out.add(n) }
  add(sys.city)
  add(sys.city.replace(/\(.*\)/g, ''))            // "San Francisco (Bay Area)" -> san francisco
  const paren = /\(([^)]+)\)/.exec(sys.city)
  if (paren) add(paren[1])                          // -> bay area
  add(sys.country)
  return [...out]
}

// distinctive latin tokens from osm_networks/operator (e.g. "Astram", "SkyTrain", "Bursaray")
function distinctTokens(sys) {
  const out = new Set()
  for (const s of [...(sys.osm_networks || []), sys.operator || '']) {
    for (const w of String(s).split(/[^A-Za-zÀ-ÿ]+/)) {
      const n = norm(w)
      if (n.length >= 4 && !GENERIC.has(n)) out.add(n)
    }
  }
  return [...out]
}

// does this Wikidata entity mention the system's city/country/network anywhere?
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

// entity looks like a single LINE (its P15 would be a line map, not the network map)
function isLineEntity(entity) {
  const desc = entity.descriptions?.en?.value || ''
  const label = entity.labels?.en?.value || ''
  if (/\b(line|linea|línea|linha|ligne|linie)\b/i.test(desc) && !/\bsystem|network\b/i.test(desc)) return true
  return /(line|linea|línea|linha|ligne|linie|hattı)\s*[\dIVXA-Z]{0,4}$/i.test(label.trim())
}

// description names another country but not ours -> different city with same name
function wrongCountry(sys, entity, allCountries) {
  const descs = ['en', 'es', 'de', 'fr', 'pt'].map((l) => entity.descriptions?.[l]?.value || '').join('|')
  const blob = norm(descs)
  if (!blob) return false
  const mine = norm(sys.country)
  if (blob.includes(mine)) return false
  return allCountries.some((c) => c !== mine && c.length >= 4 && blob.includes(c))
}

// ---------- Wikidata / Wikipedia / Commons ----------

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

// Extract a route-map image filename from a Wikipedia article's infobox.
async function wikipediaInfoboxMap(enTitle) {
  if (!enTitle) return null
  const u = 'https://en.wikipedia.org/w/api.php?action=query&format=json&prop=revisions' +
    '&rvprop=content&rvslots=main&formatversion=2&titles=' + encodeURIComponent(enTitle)
  const j = await getJSON(u)
  const wikitext = j.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content
  if (!wikitext) return null
  const m = /\|\s*(?:system_map|route_map|network_map|map_name|map_image|map)\s*=\s*(?:\[\[)?(?:File:|Image:)?\s*([^|\]\n}{]+?\.(?:svg|png|jpe?g|gif))/i
    .exec(wikitext)
  return m ? m[1].trim() : null
}

const p15Files = (entity) => (entity.claims?.P15 || [])
  .map((c) => c.mainsnak?.datavalue?.value).filter(Boolean)

// one validated entity -> commons filename (P15, else infobox, else P361 parents)
async function fileFromEntity(sys, entity, allCountries, depth = 0) {
  if (!entity || depth > 2) return null
  const lineish = isLineEntity(entity)
  if (!lineish) {
    for (const f of p15Files(entity)) if (!BAD_FILE.test(f)) return { file: f, qid: entity.id }
    const fromArticle = await wikipediaInfoboxMap(entity.sitelinks?.enwiki?.title)
    if (fromArticle && !BAD_FILE.test(fromArticle)) return { file: fromArticle, qid: entity.id }
  }
  for (const claim of entity.claims?.P361 || []) {   // "part of" -> parent system
    const pid = claim.mainsnak?.datavalue?.value?.id
    if (!pid) continue
    const parent = await getEntity(pid)
    if (!parent || !entityMentions(sys, parent) || wrongCountry(sys, parent, allCountries)) continue
    const r = await fileFromEntity(sys, parent, allCountries, depth + 1)
    if (r) return r
  }
  return null
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

// Commons file search fallback: filename must reference the city AND look like a network map.
const MAPPY = /map|network|route|system|linemap|карта|схема|路線|路网|线路|地铁|地鐵|捷運|노선/i
async function commonsSearch(sys) {
  const queries = [
    `${sys.city} metro map`,
    `${sys.city} metro network`,
    `${sys.city} subway map`,
  ]
  const aliases = cityAliases(sys)
  const toks = distinctTokens(sys)
  for (const q of queries) {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search' +
      `&srnamespace=6&srlimit=10&srsearch=${encodeURIComponent(q)}`
    let j = null
    try { j = await getJSON(u) } catch { continue }
    await sleep(250)
    const hits = (j.query?.search || [])
      .map((h) => h.title.replace(/^File:/, ''))
      .filter((t) => /\.(svg|png|jpe?g)$/i.test(t))
      .filter((t) => !BAD_FILE.test(t) && MAPPY.test(t))
      .filter((t) => {
        const n = norm(t)
        return aliases.some((a) => n.includes(a)) || toks.some((k) => n.includes(k))
      })
    if (!hits.length) continue
    hits.sort((a, b) => {
      const ext = (f) => (/\.svg$/i.test(f) ? 0 : /\.png$/i.test(f) ? 1 : 2)
      return ext(a) - ext(b)
    })
    return hits[0]
  }
  return null
}

async function commonsInfo(file) {
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json' +
    '&prop=imageinfo&iiprop=url|extmetadata&titles=' +
    encodeURIComponent('File:' + file)
  const j = await getJSON(u)
  const pages = j.query?.pages || {}
  const info = Object.values(pages)[0]?.imageinfo?.[0]
  if (!info) return null
  const md = info.extmetadata || {}
  const strip = (h) => (h ? h.value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null)
  return {
    url: info.url,
    license: md.LicenseShortName?.value || null,
    license_url: md.LicenseUrl?.value || null,
    artist: strip(md.Artist),
  }
}

async function download(url, outPath) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, buf)
  return buf.length
}

// resolve one system -> { file, qid } | null
async function resolveMap(sys, net2qid, allCountries) {
  const tried = new Set()
  const candidates = []
  for (const n of sys.osm_networks || []) if (net2qid.has(n)) candidates.push(net2qid.get(n))
  const latinNets = (sys.osm_networks || []).filter((n) => /[a-z]/i.test(n) && n !== 'Unknown')
  for (const q of [...latinNets.slice(0, 3), `${sys.city} Metro`, `${sys.city} metro system`]) {
    candidates.push(...(await searchQids(q)))
    if (candidates.length >= 12) break
  }
  for (const qid of candidates) {
    if (!qid || tried.has(qid)) continue
    tried.add(qid)
    const entity = await getEntity(qid)
    if (!entity) continue
    if (!entityMentions(sys, entity)) continue          // 防跨城/跨國誤配（Lima≠Milano）
    if (wrongCountry(sys, entity, allCountries)) continue // 防同名城誤配（Valencia VE≠ES）
    const r = await fileFromEntity(sys, entity, allCountries)
    if (r) return r
  }
  const fromSearch = await commonsSearch(sys)
  return fromSearch ? { file: fromSearch, qid: null } : null
}

async function main() {
  const index = JSON.parse(await readFile(join(BASE, 'index.json'), 'utf8'))
  const rt = JSON.parse(await readFile(join(CACHE, 'routes_tags.json'), 'utf8'))
  const net2qid = new Map()
  for (const e of rt.elements) {
    if (e.type !== 'relation') continue
    const q = e.tags?.['network:wikidata']
    if (q) { const nk = netKey(e.tags); if (!net2qid.has(nk)) net2qid.set(nk, q) }
  }
  const overrides = (await exists(OVERRIDES))
    ? JSON.parse(await readFile(OVERRIDES, 'utf8')).overrides || {} : {}
  const allCountries = [...new Set(index.systems.map((s) => norm(s.country)))]

  // 全量重建：不讀舊 maps_index（舊鍵含已淘汰城市）；--only 模式保留舊索引只改命中者
  const mapsIndex = ONLY && (await exists(join(MAPS, 'maps_index.json')))
    ? JSON.parse(await readFile(join(MAPS, 'maps_index.json'), 'utf8')) : {}

  let done = 0, got = 0, none = 0
  for (const sys of index.systems) {
    const rel = sys.file.replace(/^systems\//, '').replace(/\.geojson$/, '')
    if (ONLY && !ONLY.some((s) => rel.includes(s))) continue
    done++
    const tag = `[${done}/${ONLY ? ONLY.length : index.systems.length}] ${rel}`

    let resolved = null
    const ov = overrides[rel]
    if (ov !== undefined) {
      if (!ov || !ov.commons_file) {   // 釘選為「無圖」（如 NYC 官方圖版權）
        none++
        mapsIndex[rel] = { city: sys.city, country: sys.country, wikidata: sys.wikidata || null, map_file: null }
        console.log(`  ${tag}: pinned no-map (${ov?.note || 'override'})`)
        continue
      }
      resolved = { file: ov.commons_file.replace(/^File:/, ''), qid: ov.wikidata || null }
      console.log(`  ${tag}: pinned <- ${resolved.file}`)
    } else {
      try { resolved = await resolveMap(sys, net2qid, allCountries) } catch { resolved = null }
    }

    if (!resolved) {
      none++
      mapsIndex[rel] = { city: sys.city, country: sys.country, wikidata: sys.wikidata || null, map_file: null }
      console.log(`  ${tag}: no map found`)
      await writeFile(join(MAPS, 'maps_index.json'), JSON.stringify(mapsIndex, null, 2))
      continue
    }

    try {
      const info = await commonsInfo(resolved.file); await sleep(250)
      if (!info?.url) throw new Error('no imageinfo')
      const ext = (resolved.file.match(/\.([a-z0-9]+)$/i)?.[1] || 'png').toLowerCase()
      const outRel = `${rel}.${ext}`
      const bytes = await download(info.url, join(MAPS, outRel))
      got++
      mapsIndex[rel] = {
        city: sys.city, country: sys.country, wikidata: resolved.qid || sys.wikidata || null,
        map_file: `maps/${outRel}`, commons_file: `File:${resolved.file}`,
        source_url: info.url, license: info.license, license_url: info.license_url,
        artist: info.artist,
      }
      console.log(`  ${tag} <- ${resolved.file} (${(bytes / 1024).toFixed(0)} KB, ${info.license || '?'})`)
    } catch (e) {
      none++
      mapsIndex[rel] = { city: sys.city, country: sys.country, wikidata: resolved.qid || sys.wikidata || null, map_file: null }
      console.log(`  ${tag}: download failed (${e.message})`)
    }
    await writeFile(join(MAPS, 'maps_index.json'), JSON.stringify(mapsIndex, null, 2))
    await sleep(300)
  }

  await mkdir(MAPS, { recursive: true })
  await writeFile(join(MAPS, 'maps_index.json'), JSON.stringify(mapsIndex, null, 2))

  // 清孤兒：不被任何 map_file 引用的圖檔一律刪除（舊垃圾城市、改副檔名者）
  if (!ONLY) {
    const referenced = new Set(Object.values(mapsIndex).map((v) => v.map_file).filter(Boolean))
    const walk = async (dir) => {
      let out = []
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name)
        if (ent.isDirectory()) out = out.concat(await walk(p))
        else out.push(p)
      }
      return out
    }
    for (const p of await walk(MAPS)) {
      const rel = 'maps/' + relative(MAPS, p).split('\\').join('/')
      if (rel === 'maps/maps_index.json') continue
      if (!referenced.has(rel)) { await rm(p); console.log(`  orphan removed: ${rel}`) }
    }
  }
  console.log(`\nDONE: ${got} maps downloaded, ${none} without a map. -> ${MAPS}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
