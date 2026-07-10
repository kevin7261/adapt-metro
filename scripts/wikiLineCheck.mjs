// 逐線 Wikipedia 站數驗證（metro-audit skill）：
// 每條 route 用其 OSM `wikipedia` 標籤（如 zh:板南線）抓該線 Wikipedia 條目的
// infobox 站數，對照本資料該線的車站數。結果快取於 _cache/wiki_line_stations.json，
// 報告寫 data/metro/line_check_report.json；auditLoop / verifyMetro 讀取後以
// warn 級（`line_wiki_stations`）呈現——線級站數受支線/計法差異影響，flag 是
// 「請人工以該線 wiki 條目＋urbanrail 確認站單」，不是「一定錯」。
// 執行期零 LLM；wiki API 批次 50 條目/請求、必帶 UA、結果快取可續跑。
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '..', 'data', 'metro')
const CACHE = join(BASE, '_cache')
const OUT_CACHE = join(CACHE, 'wiki_line_stations.json')
const UA = 'adapt-metro-thesis/1.0 (metro line verification; knowledge.nomads.tw2@gmail.com)'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// infobox 站數欄位（多語）
const STATION_FIELD = /\|\s*(?:stations|number_of_stations|車站數量?|车站数量?|駅数|역수)\s*=\s*([0-9]+)/i

async function readJSON(p, fb) { try { return JSON.parse(await readFile(p, 'utf8')) } catch { return fb } }

async function main() {
  const index = await readJSON(join(BASE, 'index.json'), null)
  if (!index) { console.error('run metro:build first'); process.exit(1) }
  const cache = await readJSON(OUT_CACHE, {})

  // 收集每條 route 的 wiki 對照條目與我們的站數。
  // 以「當地語言」條目為主（使用者規則）：OSM wikipedia 標籤（zh:板南線 等，
  // 本即當地語居多）優先；缺標籤但有 wikidata 者，用 wikidata sitelinks 取
  // 當地語言 wiki（依國家→語言對照，退而求其次 en）。
  const COUNTRY_LANG = {
    taiwan: 'zh', china: 'zh', japan: 'ja', southkorea: 'ko', northkorea: 'ko',
    france: 'fr', germany: 'de', austria: 'de', switzerland: 'de', spain: 'es',
    mexico: 'es', argentina: 'es', chile: 'es', colombia: 'es', peru: 'es',
    venezuela: 'es', ecuador: 'es', panama: 'es', dominicanrepublic: 'es',
    brazil: 'pt', portugal: 'pt', italy: 'it', russia: 'ru', belarus: 'ru',
    ukraine: 'uk', poland: 'pl', czechia: 'cs', hungary: 'hu', romania: 'ro',
    bulgaria: 'bg', greece: 'el', turkey: 'tr', iran: 'fa', india: 'en',
    thailand: 'th', vietnam: 'vi', indonesia: 'id', malaysia: 'ms',
    philippines: 'en', netherlands: 'nl', belgium: 'nl', denmark: 'da',
    norway: 'no', sweden: 'sv', finland: 'fi', egypt: 'ar', algeria: 'ar',
    saudiarabia: 'ar', qatar: 'ar', unitedarabemirates: 'ar', uzbekistan: 'uz',
    kazakhstan: 'ru', azerbaijan: 'az', armenia: 'hy', georgia: 'ka',
    singapore: 'en', bangladesh: 'bn', pakistan: 'ur', nigeria: 'en',
  }
  const langOf = (country) => COUNTRY_LANG[
    (country || '').toLowerCase().replace(/[^a-z]/g, '')] ?? 'en'

  const lines = [] // { city, country, route_id, route_name, ours, wiki|wikidata }
  for (const s of index.systems) {
    const g = await readJSON(join(BASE, s.file), null)
    if (!g) continue
    const seen = new Set()
    for (const f of g.features) {
      if (f.geometry?.type !== 'MultiLineString') continue
      for (const r of f.properties.routes || []) {
        if (seen.has(r.route_id)) continue
        seen.add(r.route_id)
        const rec = { city: s.city, country: s.country, route_id: r.route_id,
          route_name: r.route_name, ours: (r.stations || []).length,
          lang: langOf(s.country) }
        if (r.wikipedia && /^[a-z-]{2,8}:/.test(r.wikipedia)) rec.wiki = r.wikipedia
        else if (r.wikidata && /^Q\d+$/.test(r.wikidata)) rec.wikidata = r.wikidata
        else continue
        lines.push(rec)
      }
    }
  }
  console.log(`${lines.length} routes with wiki/wikidata reference`)

  // wikidata → 當地語 sitelink（批次 50，快取共用 cache 以 'wd:Qxxx:lang' 為鍵）
  const wdPending = [...new Set(lines.filter((l) => !l.wiki && l.wikidata &&
    cache[`wd:${l.wikidata}:${l.lang}`] === undefined).map((l) => l.wikidata))]
  for (let i = 0; i < wdPending.length; i += 50) {
    const batch = wdPending.slice(i, i + 50)
    const url = 'https://www.wikidata.org/w/api.php?action=wbgetentities&props=sitelinks' +
      `&format=json&ids=${batch.join('|')}`
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      const j = await res.json()
      for (const [qid, ent] of Object.entries(j.entities ?? {})) {
        const sl = ent.sitelinks ?? {}
        for (const l of lines.filter((x) => x.wikidata === qid)) {
          const title = sl[`${l.lang}wiki`]?.title ?? sl.enwiki?.title ?? null
          const lang2 = sl[`${l.lang}wiki`] ? l.lang : (sl.enwiki ? 'en' : null)
          cache[`wd:${qid}:${l.lang}`] = title && lang2 ? `${lang2}:${title}` : null
        }
      }
      await writeFile(OUT_CACHE, JSON.stringify(cache))
    } catch (e) { console.log(`  !! wikidata batch failed: ${e.message}`) }
    await sleep(1000)
  }
  for (const l of lines) {
    if (!l.wiki && l.wikidata) l.wiki = cache[`wd:${l.wikidata}:${l.lang}`] ?? undefined
  }
  console.log(`  resolved ${lines.filter((l) => l.wiki).length} to a wiki article`)

  // 批次抓 wikitext（依語言分組，50 titles/請求）
  const byLang = new Map()
  for (const l of lines) {
    if (!l.wiki) continue
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
          const m = STATION_FIELD.exec(text)
          // 回推原 title（可能經 normalize/redirect）
          let orig = page.title
          if (redirect.has(orig)) orig = redirect.get(orig)
          if (norm.has(orig)) orig = norm.get(orig)
          cache[`${lang}:${orig}`] = m ? parseInt(m[1], 10) : null
          if (orig !== page.title) cache[`${lang}:${page.title}`] = m ? parseInt(m[1], 10) : null
        }
        await writeFile(OUT_CACHE, JSON.stringify(cache))
        console.log(`  ${lang}: ${Math.min(i + 50, list.length)}/${list.length}`)
      } catch (e) {
        console.log(`  !! ${lang} batch failed: ${e.message}`)
      }
      await sleep(1000)
    }
  }

  // 比對（使用者規則：不算比值，站數必須與 wiki 條目**完全相等**）。
  // 護欄：OSM 的 wikipedia 標籤常指向「系統」條目而非「線路」條目
  // （北京各線標 zh:北京地铁 → infobox 540 站是系統數）——
  //   (a) 同城多條線共用同一條目 ⇒ 系統條目，不比對、列入 uncovered；
  //   (b) 單線但 wikiN > max(80, 3×ours) ⇒ 疑似系統條目，同上。
  const tagUsers = new Map() // `${city}|${wiki}` -> count
  for (const l of lines) {
    if (!l.wiki) continue
    const k = `${l.city}|${l.wiki}`
    tagUsers.set(k, (tagUsers.get(k) ?? 0) + 1)
  }
  const flags = []
  const uncovered = []
  let checked = 0
  for (const l of lines) {
    if (!l.wiki) {
      uncovered.push({ ...l, reason: 'no wikipedia/wikidata tag resolves' })
      continue
    }
    const wikiN = cache[l.wiki]
    if (!wikiN || wikiN < 2) {
      uncovered.push({ ...l, reason: 'article has no station count infobox' })
      continue
    }
    if (tagUsers.get(`${l.city}|${l.wiki}`) >= 2) {
      uncovered.push({ ...l, reason: `system article shared by several lines (${l.wiki})` })
      continue
    }
    if (wikiN > Math.max(80, l.ours * 3)) {
      uncovered.push({ ...l, reason: `suspect system article (${l.wiki}: ${wikiN})` })
      continue
    }
    checked++
    if (l.ours !== wikiN) {
      flags.push({ ...l, wiki_stations: wikiN, diff: l.ours - wikiN })
    }
  }
  flags.sort((a, b) => a.diff - b.diff)
  await writeFile(join(BASE, 'line_check_report.json'), JSON.stringify({
    generated: 'per-line station counts vs local-language Wikipedia line articles (strict equality)',
    routes_total: lines.length,
    checked_against_infobox: checked,
    flagged: flags.length,
    uncovered: uncovered.length,
    flags,
    uncovered_lines: uncovered,
  }, null, 2))
  console.log(`checked ${checked} lines against wiki infobox; flagged ${flags.length}`)
  for (const f of flags.slice(0, 20))
    console.log(`  ${f.city} | ${f.route_name}: ours ${f.ours} vs wiki ${f.wiki_stations} (${f.diff > 0 ? '+' : ''}${f.diff})`)
  console.log(`report -> ${join(BASE, 'line_check_report.json')}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
