// Fetch + parse the Wikipedia 'List of metro systems' main table.
// Output: data/metro/_cache/wiki_metro_systems.json (coverage baseline).
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as overpass from './overpass.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(overpass.CACHE, 'wiki_metro_systems.json')
const URL_ = 'https://en.wikipedia.org/w/api.php?action=parse&page=List_of_metro_systems' +
  '&prop=text&formatversion=2&format=json'
const UA = 'adapt-metro-thesis/1.0 (metro data extraction; knowledge.nomads.tw2@gmail.com)'

const ENT = { '&amp;': '&', '&nbsp;': ' ', '&#160;': ' ', '&quot;': '"', '&#39;': "'",
  '&lt;': '<', '&gt;': '>', '&ndash;': '–', '&mdash;': '—' }

function clean(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\[[^\]]*\]/g, '')            // strip [1] refs
    .replace(/&#?\w+;/g, (m) => ENT[m] ?? (
      /^&#\d+;$/.test(m) ? String.fromCharCode(+m.slice(2, -1)) : m))
    .replace(/\s+/g, ' ').trim()
}

function parseTable(html) {
  const tblMatch = /<table[^>]*wikitable[^>]*>([\s\S]*?)<\/table>/i.exec(html)
  if (!tblMatch) throw new Error('no wikitable found')
  const body = tblMatch[1]
  const trs = body.match(/<tr[\s\S]*?<\/tr>/gi) || []

  // Parse each <tr> into typed cells (capturing rowspan/colspan).
  const parsed = trs.map((tr) => (tr.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map((cm) => {
    const tag = /^<t[hd][^>]*>/i.exec(cm)[0]
    const rs = /rowspan="?(\d+)/i.exec(tag)
    const cs = /colspan="?(\d+)/i.exec(tag)
    return {
      text: clean(cm.replace(/^<t[hd][^>]*>/i, '').replace(/<\/t[hd]>$/i, '')),
      rowspan: rs ? +rs[1] : 1,
      colspan: cs ? +cs[1] : 1,
    }
  })).filter((r) => r.length)

  const numCols = parsed[0].reduce((n, c) => n + c.colspan, 0)  // header defines width
  const carry = []  // per column: { text, left } for active rowspans
  const rows = []
  for (const cells of parsed) {
    const out = new Array(numCols).fill('')
    let ci = 0
    for (let col = 0; col < numCols; col++) {
      if (carry[col] && carry[col].left > 0) {   // inherit a rowspanned cell
        out[col] = carry[col].text
        carry[col].left--
        continue
      }
      const cell = cells[ci++]
      if (!cell) continue
      for (let k = 0; k < cell.colspan && col + k < numCols; k++) {
        out[col + k] = cell.text
        if (cell.rowspan > 1) carry[col + k] = { text: cell.text, left: cell.rowspan - 1 }
      }
      col += cell.colspan - 1
    }
    rows.push(out)
  }
  return rows
}

async function main() {
  const res = await fetch(URL_, { headers: { 'User-Agent': UA } })
  const data = await res.json()
  const rows = parseTable(data.parse.text)
  const header = rows[0]
  console.log('HEADER:', header)
  const col = (...names) => header.findIndex((h) =>
    names.some((n) => h.toLowerCase().includes(n)))
  const ci = {
    city: col('city', 'metro area'), country: col('country'), name: col('name'),
    year: col('year opened', 'opened'), expansion: col('last expand', 'expand'),
    stations: col('station'), length: col('length'), ridership: col('ridership'),
  }
  const get = (r, key) => (ci[key] >= 0 && ci[key] < r.length ? r[ci[key]] : '')
  const systems = rows.slice(1).filter((r) => r.length >= 3).map((r) => ({
    city: get(r, 'city'), country: get(r, 'country'), name: get(r, 'name'),
    year_opened: get(r, 'year'), last_expansion: get(r, 'expansion'),
    stations: get(r, 'stations'), system_length: get(r, 'length'),
    annual_ridership: get(r, 'ridership'),
  }))
  await mkdir(overpass.CACHE, { recursive: true })
  await writeFile(OUT, JSON.stringify(systems, null, 2))
  console.log(`Parsed ${systems.length} metro systems -> ${OUT}`)
  systems.slice(0, 8).forEach((s) => console.log('  ', s.city, '|', s.country, '|', s.name))
}

main().catch((e) => { console.error(e); process.exit(1) })
