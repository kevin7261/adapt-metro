// Download each metro system's official network map (schematic) from Wikimedia.
//   network -> network:wikidata (system QID) -> Wikidata P15 "route map"
//   -> Wikimedia Commons file -> download to data/metro/maps/{continent}/{country}/
// Writes maps_index.json with per-map license + attribution (Commons files carry
// their own licenses — keep this metadata when redistributing).
// Resumable: existing files are skipped. Rate-limited. Run after buildGeojson.mjs.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '..', 'data', 'metro')
const CACHE = join(BASE, '_cache')
const MAPS = join(BASE, 'maps')
const UA = 'adapt-metro-thesis/1.0 (metro map download; knowledge.nomads.tw2@gmail.com)'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pick = (t, ...ks) => { for (const k of ks) if (t[k]) return t[k]; return null }
const netKey = (t) => pick(t, 'network:en', 'network', 'operator') || 'Unknown'

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

// Extract a route-map image filename from a Wikipedia article's infobox.
async function wikipediaInfoboxMap(enTitle) {
  if (!enTitle) return null
  const u = 'https://en.wikipedia.org/w/api.php?action=query&format=json&prop=revisions' +
    '&rvprop=content&rvslots=main&formatversion=2&titles=' + encodeURIComponent(enTitle)
  const j = await getJSON(u)
  const wikitext = j.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content
  if (!wikitext) return null
  // {{Infobox ...}}  |map = / |system_map = / |route_map = / |map_name =
  const m = /\|\s*(?:system_map|route_map|network_map|map_name|map_image|map)\s*=\s*(?:\[\[)?(?:File:|Image:)?\s*([^|\]\n}{]+?\.(?:svg|png|jpe?g|gif))/i
    .exec(wikitext)
  return m ? m[1].trim() : null
}

// system QID -> Commons route-map filename.
//  1) Wikidata P15 "route map"   2) enwiki infobox map param   3) climb P361 parents
async function routeMapFile(qid, depth = 0) {
  if (!qid || depth > 2) return null
  const j = await getJSON(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`)
  const e = j.entities?.[qid]
  if (!e) return null
  const p15 = e.claims?.P15?.[0]?.mainsnak?.datavalue?.value
  if (p15) return p15
  const enTitle = e.sitelinks?.enwiki?.title
  const fromArticle = await wikipediaInfoboxMap(enTitle)
  if (fromArticle) return fromArticle
  for (const claim of e.claims?.P361 || []) {   // "part of" -> parent system
    const parent = claim.mainsnak?.datavalue?.value?.id
    const f = await routeMapFile(parent, depth + 1)
    if (f) return f
  }
  return null
}

async function searchQid(name) {
  if (!name) return null
  const u = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json' +
    `&language=en&limit=1&search=${encodeURIComponent(name)}`
  const j = await getJSON(u)
  return j.search?.[0]?.id || null
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

async function main() {
  const index = JSON.parse(await readFile(join(BASE, 'index.json'), 'utf8'))
  const rt = JSON.parse(await readFile(join(CACHE, 'routes_tags.json'), 'utf8'))
  const net2qid = new Map()
  for (const e of rt.elements) {
    if (e.type !== 'relation') continue
    const q = e.tags?.['network:wikidata']
    if (q) { const nk = netKey(e.tags); if (!net2qid.has(nk)) net2qid.set(nk, q) }
  }

  const mapsIndex = (await exists(join(MAPS, 'maps_index.json')))
    ? JSON.parse(await readFile(join(MAPS, 'maps_index.json'), 'utf8')) : {}

  // 永不抓的系統（使用者裁決 2026-07）：紐約——官方地鐵圖有版權（Commons 沒有），
  // QID 解析曾誤命中桶內 PATH network（Q1055811）抓到「PATH daytime.svg」冒充全系統
  // 官方圖。map_file 固定 null，前端 官方路線圖 退回 Google 圖片搜尋。
  const NO_MAP = new Set(['americas/united-states/am-usa-new-york-city'])

  let done = 0, got = 0, skipped = 0, none = 0
  for (const sys of index.systems) {
    done++
    const rel = sys.file.replace(/^systems\//, '').replace(/\.geojson$/, '')  // cont/country/slug
    if (NO_MAP.has(rel)) {
      none++
      mapsIndex[rel] = { city: sys.city, country: sys.country, wikidata: null, map_file: null }
      continue
    }
    if (mapsIndex[rel]?.map_file) { skipped++; continue }  // already resolved

    // 1) system QID: prefer network:wikidata, else search by network/city name
    let qid = null
    for (const n of sys.osm_networks || []) if (net2qid.has(n)) { qid = net2qid.get(n); break }
    if (!qid) {
      const guess = (sys.osm_networks || []).find((n) => /[a-z]/i.test(n)) ||
        (sys.city ? `${sys.city} Metro` : null)
      qid = await searchQid(guess); await sleep(400)
    }

    let commonsFile = null
    try { commonsFile = qid ? await routeMapFile(qid) : null } catch { commonsFile = null }
    if (!commonsFile) {
      none++
      mapsIndex[rel] = { city: sys.city, country: sys.country, wikidata: qid, map_file: null }
      continue
    }

    try {
      const info = await commonsInfo(commonsFile); await sleep(300)
      if (!info?.url) { none++; continue }
      const ext = (commonsFile.match(/\.([a-z0-9]+)$/i)?.[1] || 'png').toLowerCase()
      const outRel = `${rel}.${ext}`
      const bytes = await download(info.url, join(MAPS, outRel))
      got++
      mapsIndex[rel] = {
        city: sys.city, country: sys.country, wikidata: qid,
        map_file: `maps/${outRel}`, commons_file: `File:${commonsFile}`,
        source_url: info.url, license: info.license, license_url: info.license_url,
        artist: info.artist,
      }
      console.log(`  [${done}/${index.systems.length}] ${rel} <- ${commonsFile} (${(bytes / 1024).toFixed(0)} KB, ${info.license || '?'})`)
    } catch (e) {
      none++; console.log(`  [${done}] ${rel}: download failed (${e.message})`)
    }
    await writeFile(join(MAPS, 'maps_index.json'), JSON.stringify(mapsIndex, null, 2))
    await sleep(500)
  }
  await mkdir(MAPS, { recursive: true })
  await writeFile(join(MAPS, 'maps_index.json'), JSON.stringify(mapsIndex, null, 2))
  console.log(`\nDONE: ${got} maps downloaded, ${skipped} already present, ${none} without a map. -> ${MAPS}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
