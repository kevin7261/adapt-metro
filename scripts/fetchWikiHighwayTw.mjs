// 從 zh.wikipedia 抓台灣各國道/快速公路的「交流道里程表」（使用者：用 wiki 查哩程），
// 解析 wikitext 的結構化模板（確定性，不經 LLM 萃取）：
//   {{台灣公路交流道|KM|NAME|…}}   → NAME交流道
//   {{台灣公路系統連結|KM|NAME|…}} → NAME系統交流道
//   {{台灣公路兩端|KM|NAME|…}}     → NAME端
//   {{台灣公路設施|ser|KM|NAME|…}} → NAME服務區
//   {{台灣公路設施|er|KM|NAME|FULL|…}} → FULL（高架端點/轉接道，如 五股轉接道）
//   其餘設施（tun/bri/wei/brh…）略過。
// 輸出 data/highway/_overrides/wiki_mileage_tw.json：{ ref: { page, list: [{km,name}] } }
// buildHighwayGeojson 讀它覆蓋每路里程（wiki 為權威）；上游條目改版重跑本腳本即可。
//
//   node scripts/fetchWikiHighwayTw.mjs
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'data', 'highway', '_overrides')

// ref → 候選條目（依序嘗試，取第一個解析出 ≥2 列者）
const PAGES = {
  '1': ['中山高速公路交流道列表', '中山高速公路'],
  '2': ['國道二號 (中華民國)'],
  '3': ['福爾摩沙高速公路交流道列表', '福爾摩沙高速公路'],
  '3甲': ['國道三甲 (中華民國)', '國道三甲'],
  '4': ['國道四號 (中華民國)'],
  '5': ['蔣渭水高速公路'],
  '6': ['水沙連高速公路'],
  '8': ['國道八號 (中華民國)'],
  '10': ['國道十號 (中華民國)'],
  '61': ['台61線'], '62': ['台62線'], '62甲': ['台62甲線'],
  '64': ['台64線'], '65': ['台65線'], '66': ['台66線'], '68': ['台68線'],
  '72': ['台72線'], '74': ['台74線'], '76': ['台76線'],
  '86': ['台86線'], '88': ['台88線'],
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rawPage(title, depth = 0) {
  const url = `https://zh.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`
  const res = await fetch(url, { headers: { 'User-Agent': 'adapt-metro-thesis/1.0 (highway wiki mileage; knowledge.nomads.tw2@gmail.com)' } })
  if (!res.ok) return null
  const text = await res.text()
  const m = text.match(/^#(?:REDIRECT|重定向)\s*\[\[([^\]#|]+)/i)
  if (m && depth < 2) return rawPage(m[1].trim(), depth + 1)
  return text
}

// 一列模板 → { km, name }；非收錄列回傳 null
function parseRow(line) {
  const mIc = line.match(/^\{\{台灣公路交流道\|([\d.]+)\|([^|}]+)/)
  if (mIc) return { km: Number(mIc[1]), name: `${mIc[2].trim()}交流道` }
  const mSys = line.match(/^\{\{台灣公路系統連結\|([\d.]+)\|([^|}]+)/)
  if (mSys) return { km: Number(mSys[1]), name: `${mSys[2].trim()}系統交流道` }
  const mEnd = line.match(/^\{\{台灣公路兩端\|([\d.]+)\|([^|}]+)/)
  if (mEnd) return { km: Number(mEnd[1]), name: `${mEnd[2].trim()}端` }
  const mSer = line.match(/^\{\{台灣公路設施\|ser\|([\d.]+)\|([^|}]+)/)
  if (mSer) return { km: Number(mSer[1]), name: `${mSer[2].trim()}服務區` }
  const mRes = line.match(/^\{\{台灣公路設施\|res\|([\d.]+)\|([^|}]+)/)
  if (mRes) return { km: Number(mRes[1]), name: `${mRes[2].trim()}休息站` }
  const mEr = line.match(/^\{\{台灣公路設施\|er\|([\d.]+)\|([^|}]+)(?:\|([^|}]+))?/)
  if (mEr) return { km: Number(mEr[1]), name: (mEr[3] || mEr[2]).trim() }
  return null
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const out = {}
  for (const [ref, titles] of Object.entries(PAGES)) {
    let got = null
    for (const title of titles) {
      const text = await rawPage(title)
      await sleep(300)
      if (!text) continue
      const list = []
      for (const line of text.split('\n')) {
        const row = parseRow(line.trim())
        if (row && Number.isFinite(row.km)) list.push(row)
      }
      // 同名去重（保留第一筆）、依 km 排序
      const seen = new Set()
      const dedup = list.sort((a, b) => a.km - b.km).filter((r) => !seen.has(r.name) && seen.add(r.name))
      if (dedup.length >= 2) { got = { page: title, list: dedup }; break }
    }
    if (got) { out[ref] = got; console.log(`  ref ${ref}: ${got.list.length} 站 ← ${got.page}`) }
    else console.log(`  ref ${ref}: 解析失敗（候選：${titles.join('、')}）`)
  }
  await writeFile(join(OUT, 'wiki_mileage_tw.json'), JSON.stringify({
    note: '台灣各路交流道里程（zh.wikipedia 模板解析；build 以此為每路里程權威）',
    fetched_at: new Date().toISOString(),
    refs: out,
  }, null, 1))
  console.log(`done: ${Object.keys(out).length}/${Object.keys(PAGES).length} 條路`)
}

main().catch((e) => { console.error(e); process.exit(1) })
