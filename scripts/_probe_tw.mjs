// 一次性偵查：台灣路線/車站在 OSM 的實況（萬大線狀態、輕軌站 tagging、高雄轉乘）
import * as overpass from './overpass.mjs'

const q1 = '[out:json][timeout:90];relation["route"~"subway|light_rail|tram"]["name"~"萬大|安坑|淡海|三鶯|小碧潭|環狀"](21.5,119.5,25.5,122.2);out tags;'
const d1 = await overpass.query(q1, { timeout: 90000, maxAttempts: 6 })
console.log('=== 台灣相關 route relations ===')
for (const e of d1.elements) {
  const t = e.tags || {}
  console.log(e.id, '|', t.route, '|', (t.name || '').slice(0, 36),
    '| state:', t.state ?? '-', '| network:', t.network ?? '-', '| ref:', t.ref ?? '-')
}

// 淡海輕軌車站 tagging 分佈（紅樹林一帶）＋安坑＋三鶯
const q2 = '[out:json][timeout:90];(node["railway"~"station|tram_stop|halt"](24.9,121.3,25.3,121.6);node["station"](24.9,121.3,25.3,121.6););out tags;'
const d2 = await overpass.query(q2, { timeout: 90000, maxAttempts: 6 })
const tally = {}
for (const e of d2.elements) {
  const t = e.tags || {}
  if (!/輕軌|LRT|light/i.test(`${t.network ?? ''} ${t.operator ?? ''} ${t.name ?? ''}`) &&
      t.station !== 'light_rail' && t.light_rail !== 'yes') continue
  const k = `railway=${t.railway ?? '-'} station=${t.station ?? '-'} light_rail=${t.light_rail ?? '-'}`
  tally[k] = (tally[k] || 0) + 1
}
console.log('=== 北台灣輕軌類車站 tagging ===')
Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(v, k))

// 高雄：美麗島與輕軌轉乘站
const q3 = '[out:json][timeout:60];(node["name"~"美麗島|凱旋|哈瑪星"](22.5,120.2,22.75,120.45););out tags;'
const d3 = await overpass.query(q3, { timeout: 60000, maxAttempts: 6 })
console.log('=== 高雄轉乘站節點 ===')
for (const e of d3.elements) {
  const t = e.tags || {}
  if (!t.railway && !t.station) continue
  console.log(e.id, '|', t.name, '| railway:', t.railway ?? '-', '| station:', t.station ?? '-',
    '| subway:', t.subway ?? '-', '| light_rail:', t.light_rail ?? '-')
}
