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

  // 收集每條 route 的 wiki tag 與我們的站數
  const lines = [] // { city, country, route_id, route_name, ours, wiki: 'zh:板南線' }
  for (const s of index.systems) {
    const g = await readJSON(join(BASE, s.file), null)
    if (!g) continue
    const seen = new Set()
    for (const f of g.features) {
      if (f.geometry?.type !== 'MultiLineString') continue
      for (const r of f.properties.routes || []) {
        if (seen.has(r.route_id)) continue
        seen.add(r.route_id)
        const wp = r.wikipedia
        if (!wp || !/^[a-z-]{2,8}:/.test(wp)) continue
        lines.push({ city: s.city, country: s.country, route_id: r.route_id,
          route_name: r.route_name, ours: (r.stations || []).length, wiki: wp })
      }
    }
  }
  console.log(`${lines.length} routes with a wikipedia tag`)

  // 批次抓 wikitext（依語言分組，50 titles/請求）
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

  // 比對：|diff| >= 2 且 比值超出 [0.7, 1.3] → flag（支線/環線計法差容忍）
  const flags = []
  let checked = 0
  for (const l of lines) {
    const wikiN = cache[l.wiki]
    if (!wikiN || wikiN < 2) continue
    checked++
    const ratio = l.ours / wikiN
    if (Math.abs(l.ours - wikiN) >= 2 && (ratio < 0.7 || ratio > 1.3)) {
      flags.push({ ...l, wiki_stations: wikiN, ratio: +ratio.toFixed(2) })
    }
  }
  flags.sort((a, b) => a.ratio - b.ratio)
  await writeFile(join(BASE, 'line_check_report.json'), JSON.stringify({
    generated: 'per-line station counts vs Wikipedia line articles',
    routes_with_wiki_tag: lines.length,
    checked_against_infobox: checked,
    flagged: flags.length,
    flags,
  }, null, 2))
  console.log(`checked ${checked} lines against wiki infobox; flagged ${flags.length}`)
  for (const f of flags.slice(0, 20))
    console.log(`  ${f.city} | ${f.route_name}: ours ${f.ours} vs wiki ${f.wiki_stations} (${f.ratio})`)
  console.log(`report -> ${join(BASE, 'line_check_report.json')}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
