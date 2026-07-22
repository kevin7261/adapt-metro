// Additive combined-variant systems: metro base ＋ 附加鐵路（既有 railway 資料 or OSM），
// 產生全新的 `*-...` 系統檔（不改動任何現有 metro/railway 管線腳本、現有 systems 檔、
// metro_lines / metro_stations 全球層）。與 buildJrCombined / buildLandmarkCombined /
// buildSingaporeVariants 同性質——independent additive builder，stale-cleanup 與 index
// 保留正則對這些 slug 豁免、絕不刪。schema 與 metro 系統檔一致，`combined: true`、
// `audit: null`（未經 metro:audit）。
//
//   as-kor-seoul-incheon  首爾＋仁川：as-kor-seoul ＋ 仁川 1/2 號線（整併）＋ AREX 機場鐵路
//                                     （공항철도 일반열차，OSM rel 7919000；機場輕軌셔틀트레인
//                                      已由 isAirportApm 排除、不含）
//   as-twn-taipei-rail    台北＋台鐵＋高鐵：as-twn-taipei ＋ 大台北都會區內的 TRA/HSR
//                                     （data/railway，bbox 過濾）
//   as-jpn-tokyo-rail     東京＋JR＋私鐵：as-jpn-tokyo ＋ 大東京都心的 JR 與私鐵
//                                     （data/railway，bbox 過濾；私鐵本就混在 JR 各社檔內）
//
// 鐵路站與 metro 站「完整整合」——同站合併成單一轉乘點（共站紅點）、計入 station_count。
//
//   node scripts/buildCombinedSystems.mjs
//
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { query } from './overpass.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const METRO = join(ROOT, 'data', 'metro')
const RAILWAY = join(ROOT, 'data', 'railway')

// 大台北都會區（台北市＋新北市；排除桃園中壢/基隆）——西界 121.33 剛好留鶯歌、切掉桃園端
const TAIPEI_BBOX = [121.33, 24.90, 121.70, 25.22]
// 大東京都心 ＝ Tokyo metro bbox ＋ 0.05° 邊界（私鐵/JR 於此範圍截斷成都心段）
// 東界延到 140.42 納成田空港（JR 成田線/京成往東到成田機場，使用者）
const TOKYO_BBOX = [139.56, 35.54, 140.42, 35.84]
// 東京鐵路噪音：無序大雜燴「一般鐵路」＋貨物/連絡線（重複幹線幾何、非客運）。
// 京成由 fetchTokyoPrivate 從 OSM 完整抓，故 railway 的零星京成在此排除避免重複；東武東上線
// 只在 railway 有（OSM 的 operator=東武 route=train 沒有東上/伊勢崎本線），故 railway 保留東武。
// 山手線改由 OSM 抓乾淨環線（railway 版缺大崎、未閉合）；内房線/総武本線/千葉方面本線不用抓（使用者）
const TOKYO_RAIL_EXCLUDE = /一般鐵路|貨物|Link Line|品鶴線|武蔵野南線|高架段|京成|南武線|山手線|内房線|総武本線/

const TARGETS = [
  {
    slug: 'as-kor-seoul-incheon',
    base: 'systems/asia/south-korea/as-kor-seoul.geojson',
    outDir: 'systems/asia/south-korea',
    cityEn: 'Seoul + Incheon',
    cityZh: '首爾＋仁川',
    countryZh: '南韓',
    mergeMetro: ['systems/asia/south-korea/as-kor-incheon.geojson'],
    osmLines: [{
      rel: 7919000, // AREX 일반열차（all-stop）서울역 → 인천공항2터미널（站序 Seoul→Airport）
      ref: 'A', name: '공항철도', nameLocal: '공항철도', nameEn: 'AREX (Airport Railroad)',
      color: '#0079AC',
      network: 'Airport Railroad', networkLocal: '공항철도',
      operator: '공항철도주식회사', wikidata: 'Q485846', wikipedia: 'ko:인천국제공항철도',
    }],
    // AREX/Incheon 站名 → Seoul metro 站名（羅馬字異拼的知名轉乘站）
    aliases: { "Hongik Univ.": "Hongik Univ.", "Digital Media City": "Digital Media City" },
  },
  {
    slug: 'as-twn-taipei-rail',
    base: 'systems/asia/taiwan/as-twn-taipei.geojson',
    outDir: 'systems/asia/taiwan',
    cityEn: 'Taipei + TRA + HSR',
    cityZh: '台北＋台鐵＋高鐵',
    countryZh: '台灣',
    // 端點精確控制（使用者）：台鐵縱貫線只畫 中壢↔汐止、高鐵只畫 南港↔桃園。
    // osmIds：railway geojson 沒帶 osm_route_ids（track-based 建檔），實際路線／
    // 路線中線管線靠這些 relation 對 OSM way（上下行各一；見 rw_as-twn.json）。
    railway: [
      {
        file: 'systems/asia/taiwan/as-twn-rail.geojson',
        select: { '縱貫線': ['中壢', '汐止'] },
        osmIdsByName: { '縱貫線': [5867233, 5867234] }, // 北上／南下
      },
      {
        file: 'systems/asia/taiwan/as-twn-hsr.geojson',
        select: { '台灣高速鐵路': ['南港', '桃園'] },
        osmIdsByName: { '台灣高速鐵路': [4500369, 4500371] }, // 北向／南向
      },
    ],
    // 高鐵 板橋↔南港 與台鐵共線、中間台鐵站（萬華/松山）標 pass（使用者）
    passThrough: true,
  },
  {
    slug: 'as-jpn-tokyo-rail',
    base: 'systems/asia/japan/as-jpn-tokyo.geojson',
    outDir: 'systems/asia/japan',
    cityEn: 'Tokyo + JR + Private',
    cityZh: '東京＋JR＋私鐵',
    countryZh: '日本',
    // 排除無序大雜燴桶「一般鐵路」與貨物/連絡線（會把遠處不相連的站串成跨市假線）。
    // 不抓新幹線（使用者）——不納 as-jpn-hsr。
    railway: [
      { file: 'systems/asia/japan/as-jpn-east-rail.geojson', bbox: TOKYO_BBOX, exclude: TOKYO_RAIL_EXCLUDE },
      { file: 'systems/asia/japan/as-jpn-central-rail.geojson', bbox: TOKYO_BBOX, exclude: TOKYO_RAIL_EXCLUDE },
    ],
    // 主要私鐵（東急/京急/小田急/京王/西武/相鉄…）不在 railway 資料內，由
    // scripts/fetchTokyoPrivate.mjs（npm run metro:fetchtokyoprivate）另從 OSM 抓、寫此檔；
    // 有就併、沒有就跳過（不擋 metro:combined）。
    extraLinesFile: '_overrides/tokyo-private-lines.json',
    // 從 OSM 抓乾淨的線（railway 版有缺/斷）：山手線環線（含大崎、閉合）＋ JR 成田線到成田空港
    osmLines: [
      {
        rel: 1972960, loop: true, lang: 'ja',
        ref: 'JY', name: '山手線', nameLocal: '山手線', nameEn: 'Yamanote Line', color: '#9acd32',
        network: 'JR East', networkLocal: '東日本旅客鉄道', operator: '東日本旅客鉄道',
        wikidata: 'Q216580', wikipedia: 'ja:山手線',
      },
      {
        rel: 14298300, lang: 'ja', // JR成田線（成田空港 → 千葉）
        ref: 'JO', name: '成田線', nameLocal: '成田線', nameEn: 'Narita Line', color: '#00b2a9',
        network: 'JR East', networkLocal: '東日本旅客鉄道', operator: '東日本旅客鉄道',
        wikidata: 'Q1362617', wikipedia: 'ja:成田線',
      },
      {
        rel: 3340252, lang: 'ja', // 京成成田空港線（成田スカイアクセス，京成上野→成田空港，經北総線）
        ref: 'KS-AE', name: '京成成田空港線', nameLocal: '成田スカイアクセス', nameEn: 'Narita SKY ACCESS', color: '#f7931e',
        network: '京成電鉄', networkLocal: '京成電鉄', operator: '京成電鉄',
        wikidata: 'Q1057299', wikipedia: 'ja:成田空港線',
      },
      {
        rel: 3340250, lang: 'ja', // 北総線各駅（京成高砂→印旛日本医大，與スカイアクセス共軌）
        ref: 'HS', name: '北総線', nameLocal: '北総線', nameEn: 'Hokuso Line', color: '#00bfff',
        network: '北総鉄道', networkLocal: '北総鉄道', operator: '北総鉄道',
        wikidata: 'Q1064544', wikipedia: 'ja:北総鉄道北総線',
      },
      {
        rel: 5326726, lang: 'ja', // JR京葉線各停（東京→蘇我）——railway 版只有「京葉線高架段」片段缺東京
        ref: 'JE', name: '京葉線', nameLocal: '京葉線', nameEn: 'Keiyo Line', color: '#c9242f',
        network: 'JR East', networkLocal: '東日本旅客鉄道', operator: '東日本旅客鉄道',
        wikidata: 'Q812501', wikipedia: 'ja:京葉線',
      },
      {
        rel: 9504526, lang: 'ja', // 東武スカイツリーライン（伊勢崎線，operator 無標故 operator 查詢抓不到）
        ref: 'TS', name: '東武スカイツリーライン', nameLocal: '東武スカイツリーライン', nameEn: 'Tobu Skytree Line', color: '#0f6cc3',
        network: '東武鉄道', networkLocal: '東武鉄道', operator: '東武鉄道',
        wikidata: 'Q1076858', wikipedia: 'ja:東武伊勢崎線',
      },
      {
        rel: 7002081, lang: 'ja', // 埼玉高速鉄道線（赤羽岩淵→浦和美園，route=subway 故 train/AGT 查詢都沒抓）
        ref: 'SR', name: '埼玉高速鉄道線', nameLocal: '埼玉スタジアム線', nameEn: 'Saitama Rapid Railway', color: '#00a99d',
        network: '埼玉高速鉄道', networkLocal: '埼玉高速鉄道', operator: '埼玉高速鉄道',
        wikidata: 'Q1191587', wikipedia: 'ja:埼玉高速鉄道線',
      },
    ],
    // 異名共站（連通轉乘但站名不同）——JR/私鐵靠很近的官方乗換駅要併成一站（使用者稽核）
    aliases: {
      '田町': '三田',            // JR 田町 ↔ 都営 三田
      '山頂駅': '王子',          // JR 王子 節點誤名「山頂駅」（帶京浜東北/東北/湘南新宿）→ 王子
      '京成船橋': '船橋',        // 京成船橋 ↔ JR/東武 船橋
      '代々木八幡': '代々木公園', // 小田急 代々木八幡 ↔ 千代田線 代々木公園
      '馬喰町': '東日本橋',      // JR 馬喰町 ↔ 都営 東日本橋/馬喰横山 複合
      '浜松町': '大門',          // JR 浜松町 ↔ 都営 大門
      '千駄ケ谷': '国立競技場',  // JR 千駄ケ谷 ↔ 大江戸 国立競技場
      '原宿': '明治神宮前',      // JR 原宿 ↔ 千代田/副都心 明治神宮前〈原宿〉
      '京成千葉': '千葉',        // 京成千葉 ↔ JR 千葉
      '京成上野': '上野',        // 京成上野 ↔ JR/metro 上野
      '新日本橋': '三越前',      // JR 新日本橋 ↔ 銀座/半蔵門 三越前
      '秋葉原02': '秋葉原',      // つくば 秋葉原（OSM 節點誤名 02）→ 秋葉原/岩本町 複合
    },
    // JR 各線大量共線（東海道本線 vs 京浜東北/山手…）：共軌重疊只畫一條、跳過的站標 pass
    passThrough: true,
  },
]

// ---- geo helpers --------------------------------------------------------
const R = 6371000
const rad = (d) => (d * Math.PI) / 180
function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
const inBbox = ([lon, lat], [w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n

// 修正斷序：偵測明顯回跳長邊（max 邊 > 2.5km 且 > 3× 中位邊）→ 從離重心最遠端做最近鄰重排。
// 只用於線性線（呼叫端已排除環線）；正常有序的線 max 邊不會異常，直接原樣返回。
function fixOrder(sts) {
  if (sts.length < 4) return sts
  const eds = []
  for (let i = 0; i + 1 < sts.length; i++) eds.push(haversine(sts[i].coord, sts[i + 1].coord))
  const sorted = [...eds].sort((a, b) => a - b)
  const med = sorted[sorted.length >> 1] || 1
  const maxE = Math.max(...eds)
  if (maxE < 2500 || maxE < 3 * med) return sts
  const cx = sts.reduce((a, s) => a + s.coord[0], 0) / sts.length
  const cy = sts.reduce((a, s) => a + s.coord[1], 0) / sts.length
  let start = 0, fd = -1
  for (let i = 0; i < sts.length; i++) { const d = haversine([cx, cy], sts[i].coord); if (d > fd) { fd = d; start = i } }
  const used = new Array(sts.length).fill(false)
  const out = [sts[start]]; used[start] = true
  for (let k = 1; k < sts.length; k++) {
    const last = out[out.length - 1]
    let bi = -1, bd = Infinity
    for (let i = 0; i < sts.length; i++) { if (used[i]) continue; const d = haversine(last.coord, sts[i].coord); if (d < bd) { bd = d; bi = i } }
    out.push(sts[bi]); used[bi] = true
  }
  return out
}
// 站名正規化：臺→台、小寫、去空白/句點、去尾綴（車站/駅/站/역/station）、去消歧義括號
function normName(s) {
  return (s || '')
    .replace(/臺/g, '台')
    .replace(/[(（〈［].*?[)）〉］]/g, '') // 去消歧義括號（半形()／全形（）／角括號〈〉）
    .replace(/[’'`.]/g, '')
    .replace(/(車站|駅|站|역|station)$/i, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
}

// ---- SourceLine 抽取 -----------------------------------------------------
// 統一表示：{ routeId, ref, name, nameLocal, nameEn, color, network, networkLocal,
//            operator, wikidata, wikipedia, osmIds:[], loop,
//            stations:[{ id, name, nameLocal, nameEn, code, coord }] }

// 從既有 metro/railway geojson 抽出各條線（依 route.stations 完整站序），可 bbox 過濾、
// exclude 正則過濾線名（去掉貨物/連絡線與無序的「一般鐵路」大雜燴桶）。
function extractLinesFromGeojson(gj, { bbox = null, exclude = null, select = null } = {}) {
  const ptById = new Map()
  for (const f of gj.features) {
    if (f.geometry?.type !== 'Point') continue
    ptById.set(f.properties.station_id, {
      coord: f.geometry.coordinates,
      name: f.properties.station_name,
      nameLocal: f.properties.station_name_local ?? f.properties.station_name,
      nameEn: f.properties.station_name_en ?? null,
    })
  }
  const lines = []
  const seen = new Set()
  for (const f of gj.features) {
    if (f.geometry?.type !== 'MultiLineString') continue
    for (const r of f.properties.routes || []) {
      if (seen.has(r.route_id)) continue
      seen.add(r.route_id)
      if (exclude && exclude.test(`${r.route_name || ''} ${r.route_name_local || ''}`)) continue
      // select 模式：只收指定 route_name、且依 [from,to] 兩端站名夾出區間（精確控端點，
      // 不受 bbox 矩形限制——如台鐵縱貫線只畫中壢↔汐止、高鐵只畫南港↔桃園）
      const clip = select && (select[r.route_name] || select[r.route_ref])
      if (select && !clip) continue
      const rawSeq = (r.stations || []).filter((s) => !s.pass)
      let stations = []
      for (const s of rawSeq) {
        const pt = ptById.get(s.station_id)
        if (!pt) continue
        if (bbox && !inBbox(pt.coord, bbox)) continue
        stations.push({
          id: s.station_id, name: pt.name, nameLocal: pt.nameLocal,
          nameEn: pt.nameEn, code: s.code || null, coord: pt.coord,
        })
      }
      if (clip) {
        const idx = (nm) => stations.findIndex((s) => normName(s.name) === normName(nm))
        let a = idx(clip[0]), b = idx(clip[1])
        if (a < 0 || b < 0) { console.warn(`  ⚠ select 端點找不到：${r.route_name} [${clip}] (a=${a},b=${b})`); continue }
        if (a > b) [a, b] = [b, a]
        stations = stations.slice(a, b + 1)
      }
      // 去掉相鄰重複
      const dedup = stations.filter((s, i) => i === 0 || s.id !== stations[i - 1].id)
      if (dedup.length < 2) continue
      const loop = rawSeq.length > 2 && rawSeq[0].station_id === rawSeq[rawSeq.length - 1].station_id
        && dedup.length > 2
      // 修正斷序（railway 上游 route 成員順序有錯，如東海道本線品川被丟到最尾）：非環線且
      // 有明顯回跳長邊時，用最近鄰重排恢復線性站序（否則 pass-through 會插重複、線形打結）
      const seq = loop ? dedup : fixOrder(dedup)
      lines.push({
        routeId: r.route_id, ref: r.route_ref || r.route_name, name: r.route_name,
        nameLocal: r.route_name_local ?? r.route_name, nameEn: r.route_name_en ?? null,
        color: r.route_color || (f.properties.route_colors || [])[0] || '#888888',
        network: r.network, networkLocal: r.network_local, operator: r.operator,
        wikidata: r.wikidata, wikipedia: r.wikipedia,
        osmIds: r.osm_route_ids || [], loop, stations: seq,
      })
    }
  }
  return lines
}

// 從 OSM route relation 抽一條線（依成員 role=stop 順序）。Korea 顯示名用 name:en。
async function extractLineFromOsm(spec) {
  const q = `[out:json][timeout:180];
rel(id:${spec.rel})->.r;
.r out body;
node(r.r);
out body;`
  const res = await query(q, { cacheName: `combined_osm_${spec.rel}.json` })
  const nodes = new Map()
  let rel = null
  for (const e of res.elements) {
    if (e.type === 'node') nodes.set(e.id, e)
    else if (e.type === 'relation' && e.id === spec.rel) rel = e
  }
  if (!rel) throw new Error(`relation ${spec.rel} not found`)
  const stations = []
  for (const m of rel.members) {
    if (m.type !== 'node' || !/stop/.test(m.role)) continue
    const n = nodes.get(m.ref)
    if (!n) continue
    const t = n.tags || {}
    // 顯示名語言：日本用 name:ja、韓國（AREX）用 name:en 為主（比照各地 metro 顯示語言）
    const lang = spec.lang || 'ko'
    const local = t['name:' + lang] || t.name || null
    const nameEn = t['name:en'] || null
    const disp = lang === 'ja' ? (local || nameEn) : (nameEn || local)
    if (!disp) continue
    const prev = stations[stations.length - 1]
    if (prev && prev.id === `n${m.ref}`) continue
    stations.push({
      id: `n${m.ref}`, name: disp, nameLocal: local || disp,
      nameEn, code: t.ref || null, coord: [n.lon, n.lat],
    })
  }
  if (stations.length > 2 && stations[0].id === stations[stations.length - 1].id) stations.pop()
  const seq = spec.loop ? stations : fixOrder(stations)
  return {
    routeId: `osm${spec.rel}`, ref: spec.ref, name: spec.name,
    nameLocal: spec.nameLocal, nameEn: spec.nameEn, color: spec.color,
    network: spec.network, networkLocal: spec.networkLocal, operator: spec.operator,
    wikidata: spec.wikidata, wikipedia: spec.wikipedia,
    osmIds: [spec.rel], loop: spec.loop || false, stations: seq,
  }
}

// ---- graph recompute（degree / interchange / terminus，同 buildJrCombined）--------
function recomputeFlags(features) {
  const stations = features.filter((f) => f.geometry?.type === 'Point')
  const routeSeq = new Map()
  const routeLoop = new Map()
  for (const f of features) {
    if (f.geometry?.type !== 'MultiLineString') continue
    for (const r of f.properties.routes || []) {
      if (routeSeq.has(r.route_id)) continue
      const seq = (r.stations || []).filter((s) => !s.pass).map((s) => s.station_id)
      routeSeq.set(r.route_id, seq)
      routeLoop.set(r.route_id, seq.length > 2 && seq[0] === seq[seq.length - 1])
    }
  }
  const nbrs = new Map(), termCount = new Map()
  const add = (a, b) => {
    if (!a || !b || a === b) return
    if (!nbrs.has(a)) nbrs.set(a, new Set())
    nbrs.get(a).add(b)
  }
  for (const [rid, seq] of routeSeq) {
    for (let i = 0; i + 1 < seq.length; i++) { add(seq[i], seq[i + 1]); add(seq[i + 1], seq[i]) }
    const loop = routeLoop.get(rid)
    if (loop && seq.length > 2) { add(seq[0], seq[seq.length - 2]); add(seq[seq.length - 2], seq[0]) }
    else if (seq.length >= 2) {
      for (const end of [seq[0], seq[seq.length - 1]]) termCount.set(end, (termCount.get(end) || 0) + 1)
    }
  }
  for (const f of stations) {
    const id = f.properties.station_id
    const degree = nbrs.get(id)?.size || 0
    const lineIds = new Set((f.properties.routes || [])
      .filter((r) => !r.pass).map((r) => `${r.ref}|${r.name}`))
    const term = termCount.get(id) || 0
    const isTerm = term > 0
    const isInterchange = degree > 2 || term >= 2 || (isTerm && lineIds.size >= 2)
    f.properties.station_degree = degree
    f.properties.is_terminus = isTerm
    f.properties.is_interchange = isInterchange
    f.properties.station_role = isInterchange ? 'interchange' : isTerm ? 'terminus' : 'normal'
  }
}

// ---- 快車跨站共線 pass-through ------------------------------------------
// 某線相鄰兩停靠站 A→B（>2km）之間，若另一條線提供 A…B 的近直線中間站路徑（總長
// ≤1.35× 直線、非繞路），把那些中間站以 pass 頂點插入此線（行經不停靠）。中間站取最少者
// ＝最直接的共線走廊（高鐵 板橋→南港 沿台鐵經萬華/松山）。同 metro-osm-fetch 的自動偵測精神。
function applyPassThrough(lines, featById) {
  const idIndex = (seq, id) => seq.findIndex((s) => s.id === id)
  for (const L of lines) {
    const present = new Set(L.seq.map((s) => s.id)) // 此線已有的站——pass 不得插重複
    const out = []
    for (let i = 0; i < L.seq.length; i++) {
      out.push(L.seq[i])
      if (i + 1 >= L.seq.length) continue
      const a = L.seq[i], b = L.seq[i + 1]
      const direct = haversine(a.coord, b.coord)
      if (direct < 2000) continue
      let best = null
      for (const M of lines) {
        if (M === L) continue
        const ia = idIndex(M.seq, a.id), ib = idIndex(M.seq, b.id)
        if (ia < 0 || ib < 0 || Math.abs(ia - ib) < 2) continue
        const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia]
        let len = 0
        for (let k = lo; k < hi; k++) len += haversine(M.seq[k].coord, M.seq[k + 1].coord)
        if (len > 1.35 * direct) continue
        const inter = M.seq.slice(lo + 1, hi)
        const ordered = ia < ib ? inter : [...inter].reverse()
        // 只採納「全部都是此線還沒有的站」的中間段——避免把已停靠站重複插成 pass、線形打結
        if (ordered.some((m) => present.has(m.id))) continue
        if (!best || ordered.length < best.length) best = ordered
      }
      if (best) for (const m of best) { out.push({ ...m, pass: true }); present.add(m.id) }
    }
    L.finalSeq = out
  }
  // pass 站：車站 routes[] 加 {ref,name,pass:true}（不進 lines[]、不算停靠）
  for (const L of lines) {
    for (const s of L.finalSeq) {
      if (!s.pass) continue
      const f = featById.get(s.id)
      if (!f) continue
      const p = f.properties
      if (!(p.routes || []).some((r) => r.ref === L.ref && r.name === L.name && r.pass))
        p.routes = [...(p.routes || []), { ref: L.ref, name: L.name, pass: true }]
    }
  }
}

// ---- per-target build ---------------------------------------------------
async function build(t) {
  const gj = JSON.parse(await readFile(join(METRO, t.base), 'utf8'))
  const features = gj.features.map((f) => JSON.parse(JSON.stringify(f)))
  const country = gj.metro_system.country
  const city = gj.metro_system.city
  const baseStationCount = features.filter((f) => f.geometry?.type === 'Point').length

  // 收集所有要附加的 SourceLine
  const addLines = []
  for (const rel of t.mergeMetro || []) {
    const src = JSON.parse(await readFile(join(METRO, rel), 'utf8'))
    addLines.push(...extractLinesFromGeojson(src))
  }
  for (const rw of t.railway || []) {
    const src = JSON.parse(await readFile(join(RAILWAY, rw.file), 'utf8'))
    const lines = extractLinesFromGeojson(src, { bbox: rw.bbox, exclude: rw.exclude, select: rw.select })
    // railway 源檔無 osm_route_ids → 用設定檔的 osmIdsByName 補上（實際路線／中線用）
    if (rw.osmIdsByName) {
      for (const line of lines) {
        const ids = rw.osmIdsByName[line.name] || rw.osmIdsByName[line.ref]
        if (ids?.length && !(line.osmIds || []).length) line.osmIds = ids
      }
    }
    addLines.push(...lines)
  }
  for (const spec of t.osmLines || []) addLines.push(await extractLineFromOsm(spec))
  if (t.extraLinesFile) {
    try {
      const extra = JSON.parse(await readFile(join(METRO, t.extraLinesFile), 'utf8'))
      const lines = extra.lines || []
      addLines.push(...lines)
      console.log(`  + ${lines.length} extra lines from ${t.extraLinesFile}`)
    } catch { console.log(`  (no ${t.extraLinesFile} — run its fetch script to include; skipping)`) }
  }

  console.log(`\n[${t.slug}] base ${gj.metro_system.city} (${baseStationCount} st) + ${addLines.length} lines`)

  // 站名索引（含 merged_names 別名）——含 base 與後續新增的站
  const nameIdx = new Map()
  const addIdx = (name, f) => {
    const k = normName(name)
    if (!k) return
    if (!nameIdx.has(k)) nameIdx.set(k, [])
    if (!nameIdx.get(k).includes(f)) nameIdx.get(k).push(f)
  }
  const indexStation = (f) => {
    addIdx(f.properties.station_name, f)
    addIdx(f.properties.station_name_en, f)
    addIdx(f.properties.station_name_local, f) // 在地名（韓文/日文/中文）——跨資料集有的用
    for (const m of f.properties.merged_names || []) addIdx(m.station_name, f)      // 羅馬字、有的用在地名，兩邊都索引才對得上（首爾仁川 검암 Geomam 共站）
  }
  for (const f of features) if (f.geometry?.type === 'Point') indexStation(f)

  const aliases = t.aliases || {}
  const noMerge = new Set((t.noMerge || []).map(normName))

  // 合併/新增一個 SourceLine 的站，回傳可畫線用的 station feature
  function resolveStation(s, line) {
    const target = aliases[s.name] || s.name
    const keys = [normName(target), normName(s.nameEn), normName(s.nameLocal)].filter(Boolean)
    let hit = null
    if (!noMerge.has(normName(s.name))) {
      const cands = new Set()
      for (const k of keys) for (const c of nameIdx.get(k) || []) cands.add(c)
      for (const cand of cands) {
        const d = haversine(s.coord, cand.geometry.coordinates)
        if (d <= 800 && (!hit || d < hit.d)) hit = { f: cand, d }
      }
      // 名稱對不上（跨資料集羅馬字/讀音異拼）時的純座標近距後備
      if (!hit) {
        for (const f of features) {
          if (f.geometry?.type !== 'Point') continue
          const d = haversine(s.coord, f.geometry.coordinates)
          if (d <= 150 && (!hit || d < hit.d)) hit = { f, d }
        }
      }
    }
    const lineRef = line.ref
    if (hit) {
      const p = hit.f.properties
      const origLines = [...(p.lines || [])]
      if (!(p.routes || []).some((r) => r.ref === lineRef && r.name === line.name))
        p.routes = [...(p.routes || []), { ref: lineRef, name: line.name }]
      if (!(p.lines || []).includes(lineRef)) p.lines = [...(p.lines || []), lineRef]
      if (s.code) p.codes = [...(p.codes || []), s.code].filter((v, i, a) => a.indexOf(v) === i)
      // 共站：附加線一律在 merged_names 標成共站（即使同名），才會顯示轉乘區塊
      if (!Array.isArray(p.merged_names) || p.merged_names.length === 0) {
        p.merged_names = [{
          station_id: p.station_id, station_name: p.station_name,
          station_name_local: p.station_name_local ?? p.station_name, lines: origLines,
        }]
      }
      const rep = p.merged_names[0]
      const ex = p.merged_names.find((m) => m !== rep && normName(m.station_name) === normName(s.name))
      if (ex) { if (!(ex.lines || []).includes(lineRef)) ex.lines = [...(ex.lines || []), lineRef] }
      else p.merged_names.push({
        station_id: s.id, station_name: s.name,
        station_name_local: s.nameLocal ?? s.name, lines: [lineRef],
      })
      return hit.f
    }
    // 新站
    const feat = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: s.coord },
      properties: {
        station_id: s.id, station_name: s.name,
        station_name_local: s.nameLocal ?? s.name, station_name_en: s.nameEn ?? null,
        network: line.network, network_local: line.networkLocal, operator: line.operator,
        city, country, lines: [lineRef], wikidata: null, wikipedia: null,
        merged_from: 1, merged_names: null, is_terminus: false,
        codes: s.code ? [s.code] : null, routes: [{ ref: lineRef, name: line.name }],
        station_degree: 0, is_interchange: false, station_role: 'normal',
      },
    }
    features.push(feat)
    indexStation(feat)
    return feat
  }

  // Phase 1：解析各線停靠站（合併/新增站，附加線 ref 掛進車站 routes/lines）
  const before = features.filter((f) => f.geometry?.type === 'Point').length
  for (const line of addLines) {
    line.seq = line.stations.map((s) => {
      const f = resolveStation(s, line)
      return { id: f.properties.station_id, coord: f.geometry.coordinates, code: s.code || null, name: f.properties.station_name }
    })
  }

  // Phase 2：快車跨站共線 pass-through（如高鐵沿台鐵走廊、中間台鐵站標 pass）
  if (t.passThrough) {
    const featById = new Map(features.filter((f) => f.geometry?.type === 'Point').map((f) => [f.properties.station_id, f]))
    applyPassThrough(addLines, featById)
  }

  // Phase 3：路段化（重疊只畫一條）——把「行經 route 集合」相同的邊分組成一個 MultiLineString
  // feature；共軌重疊段只輸出一次幾何、routes[] 列出全部行經線（渲染層依相異色數畫 n 色）。
  // 每條 route 的完整站序（含 pass）掛在它出現的每個 seg（與 base metro 一致）。
  const routeDesc = new Map()
  for (const line of addLines) {
    const seq = line.finalSeq || line.seq
    const rs = seq.map((x) => ({
      station_id: x.id, station_name: x.name,
      ...(x.code && !x.pass ? { code: x.code } : {}),
      ...(x.pass ? { pass: true } : {}),
    }))
    if (line.loop && rs.length > 2) rs.push({ ...rs[0] })
    routeDesc.set(line, {
      route_id: line.routeId, route_name: line.name, route_name_local: line.nameLocal,
      route_name_en: line.nameEn, route_ref: line.ref, route_color: line.color,
      network: line.network, network_local: line.networkLocal, operator: line.operator,
      wikidata: line.wikidata, wikipedia: line.wikipedia, osm_route_ids: line.osmIds,
      status: null, order_suspect: 0, stations: rs,
    })
  }
  // 無向邊 → 行經 route 集合
  const edgeMap = new Map()
  const addEdge = (u, v, line) => {
    if (!u || !v || u.id === v.id) return
    const key = u.id < v.id ? `${u.id}|${v.id}` : `${v.id}|${u.id}`
    let e = edgeMap.get(key)
    if (!e) { e = { coordA: u.coord, coordB: v.coord, lines: new Set() }; edgeMap.set(key, e) }
    e.lines.add(line)
  }
  for (const line of addLines) {
    const seq = line.finalSeq || line.seq
    for (let i = 0; i + 1 < seq.length; i++) addEdge(seq[i], seq[i + 1], line)
    if (line.loop && seq.length > 2) addEdge(seq[seq.length - 1], seq[0], line)
  }
  // 依 route 集合分組 → 每組一個 feature
  const bySig = new Map()
  for (const e of edgeMap.values()) {
    const lines = [...e.lines]
    const sig = lines.map((l) => l.routeId).sort().join('|')
    let g = bySig.get(sig)
    if (!g) { g = { lines, coords: [] }; bySig.set(sig, g) }
    g.coords.push([e.coordA, e.coordB])
  }
  let segIdx = 0
  for (const g of bySig.values()) {
    features.push({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: g.coords },
      properties: {
        seg_id: `${t.slug}-seg-${segIdx++}`,
        routes: g.lines.map((l) => routeDesc.get(l)),
        route_count: g.lines.length,
        route_refs: g.lines.map((l) => l.ref),
        route_colors: g.lines.map((l) => l.color),
        city, country,
      },
    })
  }
  const afterPts = features.filter((f) => f.geometry?.type === 'Point').length
  console.log(`  new stations +${afterPts - before}, ${edgeMap.size} edges → ${bySig.size} segments`)

  recomputeFlags(features)

  const totalStations = features.filter((f) => f.geometry?.type === 'Point').length
  const totalSegs = features.filter((f) => f.geometry?.type === 'MultiLineString').length
  const nInterchange = features.filter((f) => f.geometry?.type === 'Point' && f.properties.is_interchange).length
  const m = gj.metro_system
  const addNets = [...new Set(addLines.map((l) => l.networkLocal || l.network).filter(Boolean))]
  const out = {
    type: 'FeatureCollection',
    metro_system: {
      ...m, city: t.cityEn,
      osm_networks: [...new Set([...(m.osm_networks || []), ...addNets])],
      line_count: (m.line_count || 0) + addLines.length,
      segment_count: totalSegs, station_count: totalStations,
      combined: true,
      combined_note: `Metro（${m.city}）＋附加鐵路 ${addLines.length} 線（一次性附加，未經 metro:audit）`,
      audit: null,
    },
    features,
  }
  const outPath = join(METRO, t.outDir, `${t.slug}.geojson`)
  await writeFile(outPath, JSON.stringify(out))
  console.log(`  stations ${baseStationCount}→${totalStations}, segs ${totalSegs}, lines ${out.metro_system.line_count}, interchanges ${nInterchange}`)
  console.log(`  wrote ${outPath}`)
  return {
    file: `${t.outDir}/${t.slug}.geojson`,
    continent: m.continent, country: m.country, city: t.cityEn,
    osm_networks: out.metro_system.osm_networks, operator: m.operator,
    official_website: m.official_website, official_map: m.official_map,
    wikidata: m.wikidata, line_count: out.metro_system.line_count,
    segment_count: totalSegs, station_count: totalStations,
    cityZh: t.cityZh, countryZh: t.countryZh, slug: t.slug,
  }
}

// ---- main ---------------------------------------------------------------
const entries = []
for (const t of TARGETS) entries.push(await build(t))

// index.json：附加/覆蓋新系統
const idxPath = join(METRO, 'index.json')
const idx = JSON.parse(await readFile(idxPath, 'utf8'))
for (const e of entries) {
  const { cityZh, countryZh, slug, ...sys } = e
  const rec = { ...sys, audit: null }
  const at = idx.systems.findIndex((s) => s.file === sys.file)
  if (at >= 0) idx.systems[at] = rec
  else idx.systems.push(rec)
}
idx.system_count = idx.systems.length
await writeFile(idxPath, JSON.stringify(idx, null, 2))
console.log(`\nindex.json: ${idx.systems.length} systems`)

// cityNamesZh.json：中文城市名
const zhPath = join(ROOT, 'src', 'stores', 'cityNamesZh.json')
const zh = JSON.parse(await readFile(zhPath, 'utf8'))
for (const e of entries) zh[e.slug] = { country: e.countryZh, city: e.cityZh }
await writeFile(zhPath, JSON.stringify(zh, null, 2) + '\n')
console.log(`cityNamesZh.json: added ${entries.map((e) => e.slug).join(', ')}`)
