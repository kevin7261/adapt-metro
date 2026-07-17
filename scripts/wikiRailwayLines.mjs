// 逐線 Wikipedia 站數驗證（railway-audit skill）——metro 的 [[wikiLineCheck]] 對應版。
// 差異只在「對照單位」：railway 的 route 沒有 wikipedia 標籤，但**線名本身就是當地語
// wiki 條目標題**（高崎線 → ja:高崎線、山陰本線 → ja:山陰本線、Ligne Paris–Lyon → fr:…）。
// 又因日本一般國鐵一線拆多社（東海道本線 分在 JR東/海/西 三檔），wiki 條目涵蓋「全線」，
// 故**跨同一國家所有系統檔、依線名聚合車站（去重）後**再比對 wiki infobox 站數。
//
// 結果快取於 data/railway/_cache/wiki_line_stations.json，報告寫
// data/railway/line_check_report.json；verifyRailways 讀取後以 warn/error 呈現
// （`line_wiki_stations`）。人工裁決寫 _overrides/wiki_adjudications.json（綁
// country+line+ours，任一變動即失效重 flag）。執行期零 LLM；wiki API 批次 50/請求、
// 必帶 UA、結果快取可續跑。使用者規則：站數與 wiki 條目**嚴格相等**（不算比值）。
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '..', 'data', 'railway')
const CACHE = join(BASE, '_cache')
const OUT_CACHE = join(CACHE, 'wiki_line_stations.json')
const UA = 'adapt-metro-thesis/1.0 (railway line verification; knowledge.nomads.tw2@gmail.com)'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// infobox 站數欄位（多語，含日文 駅数 / 中文 車站數量 / 韓文 역수 / 英法德西…）。
const STATION_FIELD = /\|\s*(?:stations|number_of_stations|車站數量?|车站数量?|車站總數|车站总数|駅数|역수|stations_count|nombre de gares|anzahl bahnhöfe|estaciones)\s*=([^\n|]*)/i
function parseStations(text) {
  const m = STATION_FIELD.exec(text)
  if (!m) return null
  const val = m[1]
  const op = /([0-9]+)\s*(?:座|站|个|個|駅)?\s*(?:營運中|营运中|運營中|运营中|啟用|启用|已通車|已通车|in (?:operation|service)|operational|open)/i.exec(val)
    ?? /(?:營運中|营运中|運營中|运营中|啟用|启用|opened?)[^0-9]{0,6}([0-9]+)/i.exec(val)
  const first = /([0-9]+)/.exec(val)
  return { total: first ? parseInt(first[1], 10) : null, operational: op ? parseInt(op[1], 10) : null }
}

async function readJSON(p, fb) { try { return JSON.parse(await readFile(p, 'utf8')) } catch { return fb } }

// country → local-language wiki (使用者規則：以當地語條目為主). 鏡射 [[wikiLineCheck]].
const COUNTRY_LANG = {
  taiwan: 'zh', china: 'zh', japan: 'ja', southkorea: 'ko', northkorea: 'ko',
  france: 'fr', germany: 'de', austria: 'de', switzerland: 'de', spain: 'es',
  italy: 'it', portugal: 'pt', netherlands: 'nl', belgium: 'nl', denmark: 'da',
  norway: 'no', sweden: 'sv', finland: 'fi', poland: 'pl', czechia: 'cs',
  hungary: 'hu', romania: 'ro', greece: 'el', ireland: 'en', unitedkingdom: 'en',
  unitedstates: 'en', canada: 'en',
}
const langOf = (country) => COUNTRY_LANG[(country || '').toLowerCase().replace(/[^a-z]/g, '')] ?? 'en'

async function main() {
  const index = await readJSON(join(BASE, 'index.json'), null)
  if (!index) { console.error('run railway:build first'); process.exit(1) }
  const cache = await readJSON(OUT_CACHE, {})

  // 跨同一國家所有系統檔、依線名聚合車站（去重）——一線拆多社時 wiki 比全線。
  // key = `${country}|${route_name}`；記錄該線落在哪些檔（除錯用）與 rail_class。
  const agg = new Map()
  for (const s of index.systems) {
    const g = await readJSON(join(BASE, s.file), null)
    if (!g) continue
    for (const f of g.features) {
      if (f.geometry?.type !== 'MultiLineString') continue
      for (const r of f.properties.routes || []) {
        // 跳過類別標籤線（一般鐵路/高速鐵路＝無名 connector 群，非真線名）
        if (!r.route_name || r.rail_class == null) continue
        if (r.route_name === '一般鐵路' || r.route_name === '高速鐵路'
          || /^(Conventional|High-speed) Rail$/.test(r.route_name)) continue
        const key = `${s.country}|${r.route_name}`
        if (!agg.has(key)) {
          agg.set(key, {
            country: s.country, route_name: r.route_name, rail_class: r.rail_class,
            lang: langOf(s.country), stations: new Set(), files: new Set(),
          })
        }
        const a = agg.get(key)
        for (const st of r.stations || []) a.stations.add(st.station_id)
        a.files.add(s.file.split('/').pop())
      }
    }
  }
  const lines = [...agg.values()].map((a) => ({
    country: a.country, route_name: a.route_name, rail_class: a.rail_class, lang: a.lang,
    ours: a.stations.size, files: [...a.files], wiki: `${a.lang}:${a.route_name}`,
  }))
  console.log(`${lines.length} distinct lines aggregated across railway systems`)

  // 批次抓 wikitext（依語言分組，50 titles/請求；線名即條目標題）
  const byLang = new Map()
  for (const l of lines) {
    if (cache[l.wiki] !== undefined) continue
    const [lang, ...rest] = l.wiki.split(':')
    const title = rest.join(':')
    if (!byLang.has(lang)) byLang.set(lang, new Set())
    byLang.get(lang).add(title)
  }
  for (const [lang, titles] of byLang) {
    const list = [...titles]
    for (let i = 0; i < list.length; i += 50) {
      const batch = list.slice(i, i + 50)
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=revisions` +
        '&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1&titles=' +
        encodeURIComponent(batch.join('|'))
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA } })
        const j = await res.json()
        const redirect = new Map((j.query?.redirects ?? []).map((r) => [r.to, r.from]))
        const norm = new Map((j.query?.normalized ?? []).map((n) => [n.to, n.from]))
        for (const page of j.query?.pages ?? []) {
          const text = page.revisions?.[0]?.slots?.main?.content ?? ''
          const parsed = page.missing ? null : parseStations(text)
          let orig = page.title
          if (redirect.has(orig)) orig = redirect.get(orig)
          if (norm.has(orig)) orig = norm.get(orig)
          cache[`${lang}:${orig}`] = parsed
          if (orig !== page.title) cache[`${lang}:${page.title}`] = parsed
        }
        await writeFile(OUT_CACHE, JSON.stringify(cache))
        console.log(`  ${lang}: ${Math.min(i + 50, list.length)}/${list.length}`)
      } catch (e) { console.log(`  !! ${lang} batch failed: ${e.message}`) }
      await sleep(1000)
    }
  }

  // 比對（嚴格相等）。護欄：條目可能是「系統/幹線總表」而非單線 → wikiN 過大時列 uncovered。
  const flags = [], uncovered = [], adjudicated = []
  let adjudications = []
  try { adjudications = JSON.parse(await readFile(join(BASE, '_overrides', 'wiki_adjudications.json'), 'utf8')).adjudications ?? [] } catch { /* none */ }
  let checked = 0
  for (const l of lines) {
    const entry = cache[l.wiki]
    if (entry === null || entry === undefined) { uncovered.push({ ...l, reason: 'no wiki article / no station infobox' }); continue }
    const hasOp = typeof entry === 'object' && entry.operational != null
    const wikiN = typeof entry === 'object' ? (entry.operational ?? entry.total) : entry
    if (!wikiN || wikiN < 2) { uncovered.push({ ...l, reason: 'article has no station count infobox' }); continue }
    if (wikiN > Math.max(120, l.ours * 3)) { uncovered.push({ ...l, reason: `suspect system/trunk article (${l.wiki}: ${wikiN})` }); continue }
    checked++
    const adj = adjudications.find((a) => a.country === l.country && a.line === l.route_name && a.ours === l.ours)
    if (adj) { adjudicated.push({ ...l, wiki_stations: wikiN, note: adj.note }); continue }
    if (l.ours !== wikiN) {
      // ours > wiki 無法用「未通車/OSM 關聯不全」解釋（誤併/多抓）→ error；
      // ours < wiki 多為 OSM route relation 停站不全 → warn（待人工以 wiki 站單確認）。
      const severity = hasOp || l.ours > wikiN ? 'error' : 'warn'
      flags.push({ ...l, wiki_stations: wikiN, wiki_basis: hasOp ? 'operational' : 'total', diff: l.ours - wikiN, severity })
    }
  }
  flags.sort((a, b) => a.diff - b.diff)
  await writeFile(join(BASE, 'line_check_report.json'), JSON.stringify({
    generated: 'per-line station counts vs local-language Wikipedia line articles (strict equality); stations aggregated across a country\'s system files by line name (一線拆多社時比全線)',
    lines_total: lines.length, checked_against_infobox: checked,
    flagged: flags.length, uncovered: uncovered.length, adjudicated: adjudicated.length,
    flags, uncovered_lines: uncovered, adjudicated_lines: adjudicated,
  }, null, 2))
  console.log(`checked ${checked} lines against wiki infobox; flagged ${flags.length}`)
  for (const f of flags.slice(0, 25)) console.log(`  ${f.country} | ${f.route_name}: ours ${f.ours} vs wiki ${f.wiki_stations} (${f.diff > 0 ? '+' : ''}${f.diff}) [${f.severity}]`)
  console.log(`report -> ${join(BASE, 'line_check_report.json')}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
