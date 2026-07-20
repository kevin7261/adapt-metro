// Per-layer documentation shown in <LayerDocViewer>. Two tabs per layer:
//   Tab 1「顯示與資料」= 會顯示成怎樣（手畫示意圖）＋ 顯示方式有哪些（圖例）＋
//                        資料代表什麼意思（欄位語意）＋ JSON 格式怎麼存。
//   Tab 2「演算法」    = 計算的演算法內容。
// Authored content (Traditional Chinese), distilled from the route-* /
// *-osm-fetch skills; `skills` links to the full SKILL.md via the skill viewer.
//
// Diagram convention: every SVG is a self-contained dark mini-canvas (viewBox
// 0 0 240 150) mirroring the real D3 canvas, so it reads the same in light or
// dark theme. Node colours match the skeleton legend (見 route-skeleton-connect).

const C = {
  bg: '#0a1020', gridline: '#3b82f6',
  blue: '#007ec7', orange: '#f58231', red: '#e6194b', green: '#3cb44b', river: '#00E5FF',
  nRed: '#e11d48', nBlue: '#2563eb', nBlack: '#ffffff', nPink: '#ec4899',
  nGray: '#9ca3af', nYellow: '#eab308', nPurple: '#a855f7',
}

// ---- small SVG builders (keep diagrams terse + consistent) ----
const open = () => `<svg viewBox="0 0 240 150" xmlns="http://www.w3.org/2000/svg" role="img">`
const panel = () => `<rect x="0" y="0" width="240" height="150" rx="8" fill="${C.bg}"/>`
const grid = (step = 20) => {
  let s = `<g stroke="${C.gridline}" stroke-width="0.6" opacity="0.28">`
  for (let x = step; x < 240; x += step) s += `<line x1="${x}" y1="8" x2="${x}" y2="142"/>`
  for (let y = step; y < 150; y += step) s += `<line x1="8" y1="${y}" x2="232" y2="${y}"/>`
  return s + '</g>'
}
const dot = (x, y, fill, r = 3.4) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="#0a1020" stroke-width="1"/>`
const poly = (pts, stroke, w = 2.4, dash = '') =>
  `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`
const cap = (t) => `<text x="120" y="140" fill="#93a4c3" font-size="9" text-anchor="middle" font-family="sans-serif">${t}</text>`
const svg = (...inner) => open() + panel() + inner.join('') + '</svg>'

// legend helpers: L(type, color, label) — type ∈ dot|line|dash|area|ring|multi
// (multi: c is an array of colours → interleaved coloured dashes)
const L = (t, c, l) => ({ t, c, l })

// interleaved coloured dashes (共線畫法)：每色一條、dasharray 偏移交錯
const interleave = (x1, x2, y, colors, D = 6, w = 4) => {
  const n = colors.length
  return colors.map((c, i) =>
    `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${c}" stroke-width="${w}" stroke-dasharray="${D} ${(n - 1) * D}" stroke-dashoffset="${-i * D}" stroke-linecap="butt"/>`
  ).join('')
}
const txt = (x, y, t, anchor = 'start', fill = '#cdd8ee', size = 9) =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" text-anchor="${anchor}" font-family="sans-serif">${t}</text>`

// ---- diagrams ----
const dGeo = svg(
  poly([[20, 40], [55, 55], [95, 48], [140, 62], [185, 50], [218, 66]], C.blue),
  poly([[30, 110], [70, 95], [95, 48], [120, 30], [160, 44]], C.orange),
  poly([[40, 128], [95, 48], [150, 100], [205, 120]], C.red),
  [[20, 40], [55, 55], [95, 48], [140, 62], [185, 50], [30, 110], [70, 95], [120, 30], [160, 44], [150, 100], [205, 120], [40, 128]]
    .map((p) => dot(p[0], p[1], '#fff', 2.6)).join(''),
  cap('地理座標的彩色路網＋白色車站'),
)
const dMetroCases =
  `<svg viewBox="0 0 240 208" xmlns="http://www.w3.org/2000/svg" role="img">` +
  `<rect x="0" y="0" width="240" height="208" rx="8" fill="${C.bg}"/>` +
  txt(16, 18, '線的畫法', 'start', '#93a4c3', 9) +
  // 單線 → 實線
  poly([[16, 34], [92, 34]], C.blue, 4) + txt(100, 37, '單一路線 ＝ 原色實線') +
  // 多線同色 → 仍實線
  poly([[16, 56], [92, 56]], C.blue, 4) + txt(100, 59, '多線・同色 ＝ 仍是實線') +
  // 多線異色 → 交錯虛線
  interleave(16, 92, 78, [C.blue, C.orange, C.red]) + txt(100, 81, '多線・異色 ＝ 交錯彩色虛線') +
  // 車站依角色
  txt(16, 110, '車站（依角色上色）', 'start', '#93a4c3', 9) +
  dot(40, 130, '#ffffff', 5) + txt(40, 148, '一般站', 'middle', '#cdd8ee', 8.5) +
  dot(112, 130, C.nRed, 5) + txt(112, 148, '轉乘站', 'middle', '#cdd8ee', 8.5) +
  dot(196, 130, C.nBlue, 5) + txt(196, 148, '端點/終點', 'middle', '#cdd8ee', 8.5) +
  // pass：行經不停
  txt(16, 174, '車站的行經路線（pass）', 'start', '#93a4c3', 9) +
  `<rect x="16" y="182" width="34" height="13" rx="6.5" fill="none" stroke="#9ba3af" stroke-width="1"/>` +
  txt(33, 191, 'pass', 'middle', '#9ba3af', 8) +
  txt(58, 191, '＝ 該線通過但不停靠（hover 分開列）') +
  `</svg>`
const dSkeleton = svg(
  poly([[24, 44], [70, 52], [120, 48], [170, 60], [214, 50]], C.blue, 2.2),
  poly([[120, 48], [110, 92], [96, 122]], C.orange, 2.2),
  poly([[120, 48], [160, 96], [200, 118]], C.red, 2.2),
  dot(24, 44, C.nBlue), dot(214, 50, C.nBlue), dot(96, 122, C.nBlue), dot(200, 118, C.nBlue),
  dot(120, 48, C.nRed), dot(70, 52, C.nBlack, 2.8), dot(170, 60, C.nPink),
  dot(110, 92, C.nGray, 2.8), dot(160, 96, C.nYellow),
  cap('分歧紅·端點藍·轉折粉·交叉黃·中段白'),
)
const dGrid = svg(
  grid(24),
  poly([[24, 30], [72, 30], [72, 78], [120, 78], [168, 78], [168, 126]], C.blue),
  poly([[72, 78], [72, 126], [24, 126]], C.orange),
  dot(24, 30, C.nBlue), dot(72, 30, C.nBlack, 2.8), dot(72, 78, C.nRed),
  dot(120, 78, C.nBlack, 2.8), dot(168, 78, C.nPink), dot(168, 126, C.nBlue), dot(24, 126, C.nBlue),
  cap('節點吸到整數格線交叉、彩色點間拉直'),
)
const dHc = svg(
  grid(24),
  poly([[24, 54], [96, 54], [96, 30], [168, 30]], C.blue),
  poly([[96, 54], [96, 102], [48, 102]], C.orange),
  poly([[96, 102], [144, 102], [168, 126]], C.red),
  dot(24, 54, C.nBlue), dot(96, 54, C.nRed), dot(168, 30, C.nBlue),
  dot(48, 102, C.nBlue), dot(96, 102, C.nRed), dot(144, 102, C.nBlack, 2.8), dot(168, 126, C.nBlue),
  cap('多準則爬山 → 大多水平/垂直/45°'),
)
const dStraighten = svg(
  grid(24),
  `<text x="62" y="20" fill="#6b7a99" font-size="8" text-anchor="middle" font-family="sans-serif">前</text>`,
  `<text x="182" y="20" fill="#6b7a99" font-size="8" text-anchor="middle" font-family="sans-serif">後</text>`,
  poly([[24, 40], [56, 52], [92, 46], [110, 70]], C.blue, 2),
  `<line x1="118" y1="28" x2="118" y2="122" stroke="#33415a" stroke-width="1" stroke-dasharray="3 3"/>`,
  poly([[132, 46], [168, 46], [168, 70], [204, 70]], C.blue, 2.4),
  dot(132, 46, C.nBlue, 2.8), dot(168, 46, C.nRed, 2.8), dot(168, 70, C.nBlack, 2.6), dot(204, 70, C.nBlue, 2.8),
  cap('短距離移動 → 正交段數最大化'),
)
const dEndpoint = svg(
  grid(24),
  poly([[36, 96], [108, 60]], '#33415a', 2, '4 3'),
  poly([[36, 96], [108, 96]], C.blue, 2.6),
  dot(108, 60, C.nBlue, 3), dot(108, 96, C.nRed, 3.2), dot(36, 96, C.nBlack, 2.8),
  `<path d="M112 66 q10 12 -2 24" fill="none" stroke="#f59e0b" stroke-width="1.6"/>`,
  `<text x="128" y="80" fill="#f59e0b" font-size="9" font-family="sans-serif">移 1 格</text>`,
  cap('端點移 1 格 → 入射段變水平'),
)
const dLineCompact = svg(
  grid(24),
  poly([[24, 54], [216, 54]], '#33415a', 2, '4 3'),
  poly([[24, 78], [216, 78]], C.blue, 2.6),
  `<path d="M120 60 l0 12" fill="none" stroke="#f59e0b" stroke-width="1.6"/>`,
  `<path d="M116 68 l4 6 l4 -6 z" fill="#f59e0b"/>`,
  cap('整條直線平移 ±1 格 → 網格縮小'),
)
const dGridMerge = svg(
  grid(24),
  poly([[24, 42], [216, 42]], C.blue, 2.4),
  poly([[24, 66], [216, 66]], C.orange, 2.4),
  `<rect x="8" y="34" width="224" height="40" fill="#f59e0b" opacity="0.12" rx="4"/>`,
  `<path d="M120 78 l0 18" fill="none" stroke="#f59e0b" stroke-width="1.6"/>`,
  `<path d="M116 92 l4 6 l4 -6 z" fill="#f59e0b"/>`,
  poly([[24, 118], [216, 118]], C.green, 2.4),
  cap('相鄰列兩兩合併 → 壓掉空列'),
)
const dLoop = svg(
  `<g font-family="sans-serif" font-size="9" fill="#cdd8ee" text-anchor="middle">`,
  `<rect x="26" y="30" width="66" height="24" rx="5" fill="#182338" stroke="#33415a"/><text x="59" y="46">端點移動</text>`,
  `<rect x="150" y="30" width="66" height="24" rx="5" fill="#182338" stroke="#33415a"/><text x="183" y="46">直線縮減</text>`,
  `<rect x="88" y="98" width="66" height="24" rx="5" fill="#182338" stroke="#33415a"/><text x="121" y="114">網格合併</text>`,
  `</g>`,
  `<path d="M94 42 h52" fill="none" stroke="#f59e0b" stroke-width="1.6"/><path d="M146 42 l-7 -3 v6 z" fill="#f59e0b"/>`,
  `<path d="M180 56 l-30 40" fill="none" stroke="#f59e0b" stroke-width="1.6"/><path d="M150 96 l7 -1 -4 -5 z" fill="#f59e0b"/>`,
  `<path d="M90 96 l-28 -40" fill="none" stroke="#f59e0b" stroke-width="1.6"/><path d="M62 56 l1 7 5 -4 z" fill="#f59e0b"/>`,
  cap('三步輪替、每步後縮減 → 收斂'),
)
const dStep = svg(
  grid(24),
  `<circle cx="72" cy="90" r="4" fill="none" stroke="#94a3b8" stroke-width="1.4" stroke-dasharray="3 2"/>`,
  poly([[72, 90], [132, 66]], '#f59e0b', 1.8, '4 3'),
  dot(132, 66, '#f59e0b', 4),
  poly([[24, 66], [132, 66], [200, 66]], C.blue, 2.4),
  cap('舊位置虛圈 → 新位置橘圈，可復原'),
)
const dRwd = svg(
  grid(24),
  poly([[24, 42], [96, 42], [120, 66], [168, 66]], C.blue, 2.6),
  poly([[120, 66], [120, 114], [72, 114]], C.orange, 2.6),
  poly([[168, 66], [204, 102], [204, 126]], C.red, 2.6),
  dot(24, 42, C.nBlue), dot(96, 42, C.nBlack, 2.6), dot(120, 66, C.nRed),
  dot(168, 66, C.nBlack, 2.6), dot(72, 114, C.nBlue), dot(204, 126, C.nBlue),
  cap('嚴格水平/垂直/45° 折線，隨版面變形'),
)
const dHighway = svg(
  poly([[20, 50], [70, 58], [120, 48], [175, 60], [220, 52]], '#e6b800', 3),
  poly([[95, 120], [110, 52], [130, 20]], '#e6b800', 3),
  dot(110, 52, C.nRed, 3), dot(70, 58, '#fff', 2.4), dot(175, 60, '#fff', 2.4),
  cap('封閉式道路＋交流道節點（紅）'),
)
const dRailway = svg(
  poly([[18, 60], [80, 66], [150, 58], [222, 64]], '#7a4fbf', 3),
  poly([[18, 40], [222, 44]], '#d11', 2.6),
  [[18, 60], [80, 66], [150, 58], [222, 64]].map((p) => dot(p[0], p[1], '#fff', 2.4)).join(''),
  `<text x="120" y="30" fill="#e57373" font-size="8" text-anchor="middle" font-family="sans-serif">高鐵</text>`,
  cap('幹線鐵路＋高鐵，逐線排序'),
)
const dMapAdjust = svg(
  `<g font-family="sans-serif" font-size="8.5" fill="#cdd8ee" text-anchor="middle">`,
  `<text x="42" y="24">原始</text><text x="120" y="24">骨架化</text><text x="198" y="24">格網化</text>`,
  `</g>`,
  // 原始：地理彎線
  poly([[18, 60], [40, 50], [58, 66], [70, 54]], C.blue, 2), dot(18, 60, '#fff', 2), dot(70, 54, '#fff', 2),
  // 骨架化：分類節點
  poly([[98, 58], [120, 52], [142, 64]], C.blue, 2), dot(98, 58, C.nBlue), dot(120, 52, C.nRed), dot(142, 64, C.nBlue),
  // 格網化：整數格正交
  `<g stroke="${C.gridline}" stroke-width="0.5" opacity="0.3"><line x1="176" y1="44" x2="176" y2="80"/><line x1="198" y1="44" x2="198" y2="80"/><line x1="220" y1="44" x2="220" y2="80"/><line x1="176" y1="52" x2="220" y2="52"/><line x1="176" y1="74" x2="220" y2="74"/></g>`,
  poly([[176, 52], [198, 52], [198, 74], [220, 74]], C.blue, 2), dot(176, 52, C.nBlue), dot(198, 52, C.nRed), dot(220, 74, C.nBlue),
  `<path d="M76 56 h14" fill="none" stroke="#6b7a99" stroke-width="1.4"/><path d="M90 56 l-6 -2 v4 z" fill="#6b7a99"/>`,
  `<path d="M150 58 h20" fill="none" stroke="#6b7a99" stroke-width="1.4"/><path d="M170 58 l-6 -2 v4 z" fill="#6b7a99"/>`,
  cap('原始 → 骨架化 → 格網化 的示意圖工作區'),
)
const dLandmark = svg(
  `<path d="M20 40 q40 20 70 8 q40 -14 80 10 q30 16 50 6" fill="none" stroke="${C.river}" stroke-width="2.6"/>`,
  `<rect x="150" y="86" width="52" height="40" rx="4" fill="#3cb44b" opacity="0.35" stroke="#3cb44b"/>`,
  cap('河流骨架線（瑩光天藍）＋公園面域（綠）'),
)

// mapping row: M(markType, color, 繪製方式, 實際, 資料內容) — one row of the
// 三欄對照表. `data` may contain inline <code>. `c` is a colour (or array for
// the interleaved 'multi' mark).
const M = (t, c, draw, real, data) => ({ t, c, draw, real, data })

// node/edge rows reused by skeleton-family layers（顏色＝畫法、角色＝實際、依 degree/分類＝資料）
const NODE_MAP = [
  M('dot', C.nRed, '紅點', '分歧／轉乘站', '<code>degree≥3</code>，或 degree=2 的換線點'),
  M('dot', C.nBlue, '藍點', '端點站', '<code>degree≤1</code>'),
  M('dot', C.nBlack, '白點', '直通中段站', 'degree=2 且兩側同 route'),
  M('dot', C.nPink, '粉紅點', '代表性轉折', '彎邊上相對容差 DP 挑的黑點'),
  M('dot', C.nGray, '灰點', '過長黑點段分隔', '連續黑點每 5 個插 1'),
  M('dot', C.nYellow, '黃點', '路線交叉新點', '<code>crossings</code> 合成節點座標'),
  M('dot', C.nPurple, '紫點', '環／頭尾共點切斷', '弧長 1/2 或 1/3·2/3 處的黑點'),
]
const EDGE_MAP = [
  M('area', '#e11d48', '紅底襯', '共線合併邊', '<code>edge.cls=coline</code>（≥2 相異色）'),
  M('area', '#16a34a', '綠底襯', '環線邊', '<code>cls=loop</code>（首尾同節點）'),
  M('area', '#2563eb', '藍底襯', '頭尾共點邊', '<code>cls=parallel</code>（平行多重邊）'),
]

// ---- doc entries ----
export const LAYER_DOCS = {
  metro: {
    title: '地鐵／輕軌路網（資料圖層）', tag: '資料', skills: ['metro-osm-fetch', 'metro-audit', 'metro-cities'],
    svg: dMetroCases, caption: '線：單線實色／共線交錯彩色虛線；站：一般白·轉乘紅·端點藍。',
    mapping: [
      M('line', C.blue, '原色實線', '單一路線獨走這段', '<code>route_count=1</code>'),
      M('line', C.blue, '仍是原色實線', '多條 route 共用一段、且同一顏色', '<code>route_count≥2</code>、route_colors 皆同色 → 相異色數=1（如 Boston Green Line B/C/D/E 共幹、Vancouver Canada Line 雙向）'),
      M('multi', [C.blue, C.orange, C.red], '交錯彩色虛線', '多條線共用、且顏色相異', '<code>route_count≥2</code> 且相異色數≥2（最多 6 色，超過夾住）'),
      M('dot', '#ffffff', '白點', '一般車站', '非轉乘、非端點'),
      M('dot', C.nRed, '紅點', '轉乘站', '<code>is_interchange</code>＝≥2 條相異線<b>停靠</b>（同線支線不算）'),
      M('dot', C.nBlue, '藍點', '端點／終點站', '<code>is_terminus</code>（線的頭或尾）'),
      M('pill', C.nGray, 'hover 標灰「pass」', '該線通過但不停靠此站', '<code>stations[].pass=true</code>（與停靠路線分開列）'),
      M('line', C.river, '瑩光天藍線', '河流中心線（地標，<code>-lm</code> 檔）', '<code>route_id="river:…"</code>、每折點是 <code>river:true</code> 的站'),
      M('area', '#3cb44b', '綠色半透明面', '皇居／公園面域（地標 overlay）', '<code>Polygon</code>（<code>landmark_id</code>）'),
    ],
    json: {
      code: `{ "type":"FeatureCollection",
  "metro_system": { "city":"Taipei", "line_count":17, "station_count":197,
                    "combined_landmark":true, "landmark_kinds":["river-centerline"] },
  "features": [

    // ① 路線（一段路網）——線色/共線都在這裡
    { "properties": { "route_count":1, "route_colors":["#007ec7"],
        "routes":[{ "route_id":"rm94…", "route_name":"板南線", "route_color":"#007ec7",
          "stations":[{ "station_id":"n363…", "station_name":"頂埔", "pass":false }, …] }] },
      "geometry": { "type":"MultiLineString", "coordinates":[[[121.41,24.95],…]] } },

    // ② 車站（獨立 Point）——is_interchange / is_terminus 決定紅/藍/白
    { "properties": { "station_id":"n363…", "station_name":"頂埔",
        "is_interchange":false, "is_terminus":true },
      "geometry": { "type":"Point", "coordinates":[121.41,24.95] } },

    // ③ 地標·河流（-lm 檔：河流＝一般路線，折點＝站）
    { "properties": { "route_id":"river:keelung", "route_color":"#00E5FF",
        "routes":[{ "route_id":"river:keelung", … }] },
      "geometry": { "type":"MultiLineString", "coordinates":[[…]] } },
    { "properties": { "river":true, "station_id":"riv…" },
      "geometry": { "type":"Point", "coordinates":[121.5,25.06] } },

    // ④ 地標·面域（皇居/公園）——Polygon overlay，不進網路
    { "properties": { "landmark_id":"palace-…", "kind":"park" },
      "geometry": { "type":"Polygon", "coordinates":[[…]] } }
  ] }`,
      note: '一個 FeatureCollection 同時含：①路線 LineString（帶 routes[]／有序 stations[]）、②車站 Point、③河流地標（route_id=river:… 的線＋river:true 的站）、④面域地標 Polygon。',
    },
    algorithm: `<p>從 OpenStreetMap 抓 <code>subway</code>／<code>light_rail</code> 的 route relation：</p>
<ul><li>同一站的成員合併、依 route 站序連線。</li><li>反向地理編碼分到各城市，一城一個 GeoJSON。</li><li>共線（重疊路段）在資料端去重成 <code>route_count≥2</code> 的一筆 feature。</li><li>正確性由 metro-audit 逐城對照 Wikipedia／urbanrail 驗證、收斂覆蓋率。</li></ul>`,
  },
  highway: {
    title: '高速公路網（資料圖層）', tag: '資料', skills: ['highway-osm-fetch', 'highway-audit', 'highway-cities'],
    svg: dHighway, caption: '分層封閉式道路＋交流道節點。',
    mapping: [
      M('line', '#e6b800', '黃色道路線', '一段封閉式道路', '<code>LineString</code>＋<code>routes[]</code>（同 metro）'),
      M('dot', C.nRed, '紅點', '交流道', '當「車站」的節點 <code>Point</code>'),
      M('dot', '#ffffff', '白點', '沿線里程／端點', '<code>Point</code>'),
    ],
    json: { code: `{ "type":"FeatureCollection",
  "highway_system": { "audit": {…} },
  "features": [ /* 同 metro：LineString+routes[]、交流道 Point */ ] }`,
      note: '鏡射 metro schema，一個都會區一個檔。' },
    algorithm: `<p>抓封閉式道路（國道 <code>motorway</code>＋封閉式 <code>trunk</code>/<code>expressway</code>）：把交流道當節點、串成網絡，一都會區一檔。各國封閉式判準／配色例外見 highway-cities。</p>`,
  },
  railway: {
    title: '國家鐵路網（資料圖層）', tag: '資料', skills: ['railway-osm-fetch', 'railway-audit'],
    svg: dRailway, caption: '幹線鐵路（紫）＋高鐵（紅）。',
    mapping: [
      M('line', '#7a4fbf', '紫線', '一般國鐵幹線', '<code>-rail</code> 檔的 route'),
      M('line', '#d11', '紅線', '高鐵／新幹線', '<code>-hsr</code> 檔的 route（有序停站建）'),
      M('dot', '#ffffff', '白點', '車站', '<code>Point</code>（有序 <code>stations[]</code>）'),
    ],
    json: { code: `{ "type":"FeatureCollection",
  "railway_system": {…},
  "features": [ /* 同 metro schema */ ] }`,
      note: '高鐵由 OSM route=railway 有序停站建、保證串接。' },
    algorithm: `<p>抓 <code>railway=rail</code> 幹線＋高鐵（不含地鐵/輕軌/路面電車）；track-based 逐線排序。正確性由 railway-audit 逐線對照當地語 Wikipedia 站數。</p>`,
  },
  landmark: {
    title: '地標圖層（河流／皇居／公園）', tag: '資料', skills: ['landmark-osm-fetch'],
    svg: dLandmark, caption: '河流骨架線（瑩光天藍）＋面域地標（綠）。',
    mapping: [
      M('line', C.river, '瑩光天藍線', '河流中心線', '<code>route_id="river:…"</code>、每折點是 <code>river:true</code> 的站'),
      M('area', '#3cb44b', '綠色半透明面', '皇居／公園面域', '<code>Polygon</code>（<code>landmark_id</code>，overlay）'),
    ],
    json: { code: `// 河流（併進城市檔，變成一般網路路線）
{ "properties": { "route_id":"river:keelung", "route_color":"#00E5FF" } }  // 線
{ "properties": { "river":true, "station_id":"…" },
  "geometry": { "type":"Point", … } }                                     // 折點=站
// 面域：Polygon feature（properties.landmark_id）`,
      note: '河流一律當一般線（骨架/格網化零特例）；僅河流不放灰點、不畫白點。' },
    algorithm: `<p>河流中心線＝graph diameter 主線骨架，全點保留後轉成真的 route＋車站 Point。皇居／中央公園抓面域 Polygon 當 overlay。</p>`,
  },

  mapadjust: {
    title: 'Map Adjust（示意圖工作區）', tag: '視圖', skills: ['route-skeleton-connect', 'route-skeleton-grid'],
    svg: dMapAdjust, caption: '把 Metro Maps 一步步轉成示意圖的地方。',
    mapping: [
      M('line', C.blue, '地理彎線', '原始 Metro Maps', '讀城市 GeoJSON、不改幾何'),
      M('dot', C.nRed, '分類節點', '骨架化後的角色', '<code>stationClass</code>（紅/藍/白/…）'),
      M('line', C.gridline, '整數格正交線', '格網化後', '節點吸到整數格 <code>(c, r)</code>'),
    ],
    json: { code: `// 即時計算，讀城市 GeoJSON；各視圖細節看樹狀各自的 ?`, note: '骨架/格網化都是純函式即時算，可即時切換。' },
    algorithm: `<p>三步管線：<b>原始</b>（地理座標）→ <b>骨架化</b>（拓撲收縮＋節點分類）→ <b>格網化</b>（吸到整數格、拉直）。每一步的演算法看該視圖標題旁的 <b>?</b>。</p>`,
  },
  original: {
    title: '原始（Map Adjust）', tag: '視圖', skills: ['metro-osm-fetch'],
    svg: dGeo, caption: '與地圖底圖一模一樣。',
    mapping: [
      M('line', C.blue, '原色實線', '單線', '<code>route_count=1</code>'),
      M('multi', [C.blue, C.orange, C.red], '交錯彩色虛線', '共線（多線共用）', '<code>route_count≥2</code>、≥2 相異色'),
      M('dot', '#ffffff', '白點', '車站', '<code>Point</code>（座標＝真實經緯度）'),
    ],
    json: { code: `// 不另存——即時讀城市 GeoJSON 畫`, note: '純顯示層，無獨立結果檔。' },
    algorithm: `<p>把城市 GeoJSON 照<b>地理座標</b>畫成 Metro Maps，不動任何幾何（單線實色、共線交錯彩色虛線）。可依建議角度旋轉到接近正南北。</p>`,
  },
  skeleton: {
    title: '骨架化（connect 骨架）', tag: '視圖', skills: ['route-skeleton-connect'],
    svg: dSkeleton, caption: '地理網路上疊節點分類色＋邊分類襯底。',
    mapping: [...NODE_MAP, ...EDGE_MAP],
    json: { code: `// 即時計算、可開關；不另存
buildConnectSkeleton(geojson) → {
  stationClass: Map<id, 'red'|'blue'|'black'|'pink'|
                        'gray'|'purple'|'yellow'>,
  edges: [{ path, geom, cls, routeColors }],
  crossings: [{ id, coord }] }`,
      note: '純函式；線照原始 feature 畫，只疊分類色與襯底。' },
    algorithm: `<p>Metro Maps 網路的<b>純拓撲收縮</b>（不拉直、保留地理形狀）：</p>
<ul><li>共線併成一條邊、真交叉補黃點。</li><li>依 degree 分紅（分歧/轉乘）/藍（端點）/白（直通）。</li><li>曲折邊用相對容差 DP 標粉紅轉折、過長段插灰、環/頭尾共點切紫。</li></ul>`,
  },
  grid: {
    title: '格網化（示意格網化）', tag: '視圖', skills: ['route-skeleton-grid', 'route-skeleton-connect'],
    svg: dGrid, caption: '節點落在整數格線交叉、線在彩色點間拉直。',
    mapping: [
      M('line', C.gridline, '藍色分隔網格', '欄=x 排名、列=y 排名', '<code>cutsX</code>／<code>cutsY</code>（排名，非公尺）'),
      M('dot', C.nRed, '彩色點落在格線交叉', '各角色（同骨架）', '每點一組整數 <code>(c, r)</code>'),
      M('line', C.blue, '彩色點間拉直的線', '示意化路線', '端點吸整數格、黑點沿新邊平均放回'),
    ],
    json: { code: `// 全球畫廊縮圖存 hcviews/<city>.json
{ "W":200, "H":150,
  "views": { "grid-post-orig": {
    "lines": [{ "d":"M 41 125 L 44 121 …", "color":"#007ec7" }] } } }`,
      note: '主視圖即時算；縮圖把每視圖的線幾何存成 lines[{d,color}]。' },
    algorithm: `<p>彩色點做「排名吸附」：欄＝x 排名、列＝y 排名，每點一格（撞格外移到最近空格）。每條線在彩色點切開、端點吸到整數欄列並拉直，黑點沿新邊平均放回。</p>`,
  },
  hillclimb: {
    title: 'Hill Climbing（多準則爬山）', tag: '視圖', skills: ['route-hillclimb'],
    svg: dHc, caption: '最佳化後大多是水平/垂直/45° 的示意佈局。',
    mapping: [
      M('line', C.gridline, '整數格', '格空間', '<code>cols × rows</code>'),
      M('line', C.blue, 'H/V/45° 線', '最佳化後的路線', '節點移動後的線'),
      M('dot', C.nRed, '彩色節點', '各角色（同骨架）', '<code>cellAfter=[id,c,r]</code>（<code>stats.hvAfter</code>=正交段數）'),
    ],
    json: { code: `// hcviews/<city>.json ＋ localStorage 快取
{ "id":"…", "views": { … "lines":[{d,color}] },
  "hc": { "cellAfter": [[id,c,r], …], "stats": { "hvAfter": 49 } } }`,
      note: 'cellAfter＝每節點整數格；改演算法要 bump 快取版本。' },
    algorithm: `<p>以「格網化後」為輸入，並排比較 <b>8 個主佈局</b>（①筆畫法／②Hill Climbing／③MILP／④力導向／⑤最小平方／⑥八向格網／⑦路徑簡化／⑧SAT）。②＝真正的多準則爬山（適應度＋硬規則＋群集移動）；其餘 7 個＝論文鏈 build 直接餵格網（短距離、同硬規則），<b>只供觀看、不進下游</b>——直線演算法／端點移動／RWD 仍只吃爬山結果。</p>`,
  },
  straighten: {
    title: '直線演算法（H/V 最大化後處理）', tag: '視圖',
    skills: ['route-paper-align', 'route-stroke-align', 'route-rect-polish',
      'route-milp-align', 'route-force-align', 'route-lsq-align',
      'route-octi-align', 'route-path-align', 'route-sat-align', 'route-llm-align'],
    svg: dStraighten, caption: '比 HC 更多正交段（前 → 後對照）。',
    mapping: [
      M('line', C.blue, '拉直後的路線', '更多正交段', '新的 <code>cellAfter</code>'),
      M('dash', '#94a3b8', '灰虛線', '前（HC 結果）對照', '<code>fingerprint.hvStart</code>'),
      M('dot', C.nRed, '彩色點', '被移動的節點', '短距離移動、過相同硬規則'),
    ],
    json: { code: `// ①〜⑧論文鏈：即時算（迭代到不動點）
// LLM 對齊：llmviews/<city>.<variant>.json
{ "fingerprint": { "verts":67, "segs":82, "cols":67, "hvStart":27 },
  "model":"Opus 4.8", "rounds":9, "cellAfter":[[id,c,r],…] }`,
      note: '論文鏈不寫檔；LLM 對齊由 Claude Code 離線產生、含指紋驗證。' },
    algorithm: `<p>在 Hill Climbing 結果上再最大化正交段，短距離移動彩色點。9 條鏈＝
論文①〜⑧（名稱與 <code>data/thesis/&lt;n&gt;_*_演算法說明.md</code> 一一對應）＋ LLM 對齊：</p>
<ul><li><b>①筆畫法</b>（Li &amp; Dong 2010）：段串成筆畫、按方向失真遞迴切割、吸 4 主方向再垂直投影。</li><li><b>②直角爬山</b>（Stott et al. 2011）：爬山法的方向準則換 |sin 2θ|（45° 變最貴）短半徑再爬。</li><li><b>③MILP規劃</b>（Nöllenburg &amp; Wolff 2011）：邊方向指派的生成樹 DP＋feedback 枚舉，再重建座標。</li><li><b>④力導向</b>（Hong et al. 2006）：磁性彈簧力（吸引/排斥/八方向磁力）迭代。</li><li><b>⑤最小平方</b>（Wang &amp; Chi 2011）：Gauss-Seidel 逼近八方向吸附後的邊向量。</li><li><b>⑥八向格網</b>（Bast et al. 2020）：依 ldeg 逐邊安置、位移＋轉折成本取最小。</li><li><b>⑦路徑簡化</b>（Merrick &amp; Gudmundsson 2007）：C-directed 最少折線簡化。</li><li><b>⑧SAT規劃</b>（Fuchs 2022）：方向指派的 DPLL 分支定界。</li><li><b>LLM 對齊</b>：模型讀圖提出移動，過相同硬規則套用。</li></ul>`,
  },
  'endpoint-move': {
    title: '端點移動', tag: '視圖', skills: ['route-endpoint-move', 'route-movewise-loop'],
    svg: dEndpoint, caption: '端點移 1 格，把斜的入射段拉成正交。',
    mapping: [
      M('dash', '#94a3b8', '灰虛線', '移動前位置', '前一格座標'),
      M('line', C.orange, '橘箭頭', '移動方向（1 格）', '單一非白點移 1 格'),
      M('dot', C.nRed, '彩色點', '被移動的節點', '受跨距上限 <code>SPAN_CAP</code>（預設 3）約束'),
    ],
    json: { code: `// 即時算（movewise，不另存）`, note: 'movewise 三步鏈第 1 步；移動後立即縮減網格。' },
    algorithm: `<p>每個非白點一次移 <b>1 格</b>，讓入射段 H/V 淨增、或直線變長且斜線變短、或藍點收線；bendsPaid 護欄＋跨距上限擋不良移動。</p>`,
  },
  'line-compact': {
    title: '直線縮減', tag: '視圖', skills: ['route-line-compact', 'route-movewise-loop'],
    svg: dLineCompact, caption: '整條線平移一格 → 網格變小、線更集中。',
    mapping: [
      M('dash', '#94a3b8', '灰虛線', '移動前', '前一列座標'),
      M('line', C.blue, '整條藍線', '跨相交點串接的整條直線', '當一個單位平移'),
      M('line', C.orange, '橘箭頭', '平移 ±1 格', 'validShift 通過才採納、全網 H/V 不減'),
    ],
    json: { code: `// 即時算（movewise，不另存）`, note: 'movewise 三步鏈第 2 步。' },
    algorithm: `<p>跨相交點串接的整條直線垂直平移 ±1 格，<b>嚴格縮小網格</b>、全網 H/V 不減；validShift 硬規則（不壓點/不新增交叉/拓撲不變）＋跨距上限。</p>`,
  },
  'grid-merge': {
    title: '網格合併', tag: '視圖', skills: ['route-grid-merge', 'route-movewise-loop'],
    svg: dGridMerge, caption: '相鄰列/欄合併，壓掉空白 → 網格更緊。',
    mapping: [
      M('area', '#f59e0b', '橘色框選兩列/欄', '被合併的相鄰列/欄', '相鄰 row 兩兩、col 兩兩'),
      M('line', C.orange, '橘箭頭', '半平面整體移 1 格', '自帶壓縮、只縮不增'),
    ],
    json: { code: `// 即時算（movewise，不另存）`, note: 'movewise 三步鏈第 3 步。' },
    algorithm: `<p>相鄰 row／col 兩兩合併：半平面整體移 1 格、自帶壓縮；validShift 判準＝不壓點／不新增交叉／拓撲不變。</p>`,
  },
  'movewise-loop': {
    title: '循環（端點移動＋直線縮減＋網格合併）', tag: '視圖', skills: ['route-movewise-loop'],
    svg: dLoop, caption: '三步輪替直到沒有點可以動 → 最緊示意佈局。',
    mapping: [
      M('line', C.orange, '橘箭頭', '三步輪替順序', '端點移動→直線縮減→網格合併'),
      M('dot', C.nRed, '彩色點', '被收斂的節點', '一輪全靜止才停；結果＝RWD 底圖'),
    ],
    json: { code: `// 即時算；RWD 底圖用其收斂結果`, note: '一輪全靜止才停。' },
    algorithm: `<p>端點移動 → 直線縮減 → 網格合併輪替：每輪各掃整個 network 一遍，每個單一移動後立即縮減網格；一輪全靜止才停。</p>`,
  },
  'step-verify': {
    title: '逐步驗證', tag: '視圖', skills: ['route-step-verify', 'route-movewise-loop'],
    svg: dStep, caption: '舊位置虛線圈 → 新位置橘色實圈。',
    mapping: [
      M('ring', '#94a3b8', '灰色虛線空心圈', '移動前位置', '復原堆疊記錄'),
      M('dot', '#f59e0b', '橘色實圈', '移動後位置', '「下一步」掃一遍／「下一小步」單一移動'),
    ],
    json: { code: `// 即時算（步進狀態在記憶體）`, note: '用來觀察四步鏈怎麼一步步收斂。' },
    algorithm: `<p>把 movewise 循環拆成可觀察的單步：每步後亮起執行到的階段 chip，前後橘圈比對，含復原堆疊。演算法本體同端點移動／直線縮減／網格合併。</p>`,
  },
  rwd: {
    title: 'RWD 路網（版面路網畫線）', tag: '視圖', skills: ['route-rwd-draw', 'route-llm-eval', 'route-llm-grid'],
    svg: dRwd, caption: '全線只有水平/垂直/45°，跟著版面形狀縮放。',
    mapping: [
      M('line', C.blue, '水平／垂直段', '正交走向的路線', '折線 <code>pts</code>（H/V）'),
      M('line', C.red, '45° 斜段', '斜向的路線', '折線 <code>pts</code>（45°）＋<code>bends</code> 轉折數'),
      M('dot', C.nRed, '紅點', '分歧／轉乘', '節點（版面 pixel 座標）'),
      M('dot', C.nBlack, '白點', '直通站', '沿選定折線弧長放回'),
    ],
    json: { code: `// rwdviews/<city>.json
{ "lines": [{ "pts": [[x,y],…], "color":"#007ec7", "bends":1 }],
  "stats": {…} }`,
      note: '存每段折線 pixel 頂點＋顏色；黑點沿折線弧長放回。' },
    algorithm: `<p>把「縮減網格」佈局重繪成嚴格 <b>H/V/45°</b>：每段依轉折數排序候選（直線→單折→雙折），衝突就換下一個；合法直線衝突有平行偏移與三角/L 繞行；黑點沿選定折線弧長放回。</p>`,
  },
}

// ---- Tab「程式執行」：這個圖層的程式實際怎麼跑（用到什麼程式／call 什麼 skill／抓什麼）----
// 前端即時視圖共用格式：純函式、零網路、零 token。file/fn/skills/flow/cache 客製。
const execPure = (file, fn, skills, flow, cache = '') => `<ul class="exec-list">
<li><b>怎麼觸發</b>：在 Map Adjust 左側樹狀點這個視圖 → <b>瀏覽器即時計算</b>，不跑任何 npm 指令、不連伺服器。</li>
<li><b>用到什麼程式</b>：<code>${file}</code> 的 <code>${fn}</code>（純函式、不改輸入），由 <code>src/components/D3Tab.vue</code> 在 render 時呼叫${cache ? `；${cache}` : ''}。</li>
<li><b>會抓什麼</b>：只讀「已載入的城市 GeoJSON」（先前 <code>fetch(assetUrl('data/metro/systems/…'))</code> 載進來的），<b>零 Overpass、零網路 API、零 token</b>。</li>
<li><b>會 call 什麼 skill</b>：${skills} — 這些是<b>演算法的文件依據</b>（給要改程式的人看的 SKILL.md），執行時<b>不會真的去呼叫</b>。</li>
<li><b>執行流程</b>：${flow}</li>
</ul>`

const EXECUTION = {
  metro: `<ul class="exec-list">
<li><b>怎麼觸發</b>：<b>離線資料管線</b>（不是網頁跑）——終端機跑 <code>npm run metro:fetch</code> → <code>npm run metro:build</code>（或一次 <code>metro:all</code>）。網頁只是把產出的 GeoJSON <code>fetch</code> 進來畫。</li>
<li><b>用到什麼程式</b>：<code>scripts/fetchMetro.mjs</code>（抓 OSM）→ <code>scripts/geocodeSystems.mjs</code>（反向地理編碼分城）→ <code>scripts/buildGeojson.mjs</code>（組檔、共站合併、共線去重）→ <code>scripts/buildViews.mjs</code>（畫廊縮圖）。抓取共用 <code>scripts/overpass.mjs</code>。</li>
<li><b>會抓什麼</b>：<b>OpenStreetMap Overpass API</b>——主站 <code>overpass-api.de</code> ＋ <code>overpass.kumi.systems</code>／<code>maps.mail.ru</code>／<code>overpass.private.coffee</code> 三個鏡像輪替、失敗重試——抓 route relation／node／way。回應快取在 <code>data/metro/_cache/</code>（<code>geom_*.json</code> 等）避免重抓。</li>
<li><b>會 call 什麼 skill</b>：<code>metro-osm-fetch</code>（取得管線）、<code>metro-audit</code>（逐城對照 Wikipedia／urbanrail 驗證，<code>npm run metro:audit</code>＝<code>auditLoop.mjs</code>）、<code>metro-cities</code>＋城市專屬 skill（台北/東京/紐約…的裁決）。這些是 Claude Code 模型抓取／修補時遵循的指示。</li>
<li><b>執行流程</b>：Overpass 抓原始關係 → 依 route 站序連線、共站合併、共線去重（<code>route_count</code>）→ 反向地理編碼分城 → 輸出 <code>data/metro/systems/&lt;洲&gt;/&lt;國&gt;/&lt;城&gt;.geojson</code>；再由 <code>buildJrCombined</code>／<code>buildLandmarkCombined</code> 併入 JR 與地標（<code>-lm</code> 檔）。</li>
</ul>`,
  highway: `<ul class="exec-list">
<li><b>怎麼觸發</b>：離線——<code>npm run highway:fetch as-twn</code> → <code>highway:build as-twn</code>（或 <code>highway:all</code>）。</li>
<li><b>用到什麼程式</b>：<code>scripts/fetchHighways.mjs</code> → <code>scripts/buildHighwayGeojson.mjs</code> → <code>scripts/verifyHighways.mjs</code>；抓取共用 <code>scripts/overpass.mjs</code>。</li>
<li><b>會抓什麼</b>：Overpass API 抓 <code>highway=motorway/trunk</code> 的 way 與交流道 node；快取 <code>data/highway/_cache/</code>。</li>
<li><b>會 call 什麼 skill</b>：<code>highway-osm-fetch</code>、<code>highway-audit</code>、<code>highway-cities</code>（各國封閉式判準／配色例外）。</li>
<li><b>執行流程</b>：抓封閉式道路 → 交流道當節點串成網絡 → 一都會區輸出 <code>data/highway/systems/…geojson</code>（schema 同 metro）→ verify 把結果寫回 <code>highway_system.audit</code>。</li>
</ul>`,
  railway: `<ul class="exec-list">
<li><b>怎麼觸發</b>：離線——<code>npm run railway:fetch</code> → <code>railway:build</code>（或 <code>railway:all</code>）。</li>
<li><b>用到什麼程式</b>：<code>scripts/fetchRailways.mjs</code> → <code>scripts/buildRailwayGeojson.mjs</code>（＋日本 <code>buildJrCombined.mjs</code>）→ <code>scripts/wikiRailwayLines.mjs</code>／<code>verifyRailways.mjs</code>；抓取共用 <code>scripts/overpass.mjs</code>。</li>
<li><b>會抓什麼</b>：Overpass API 抓 <code>railway=rail</code> 幹線與高鐵的 way／route relation；快取 <code>data/railway/_cache/</code>。</li>
<li><b>會 call 什麼 skill</b>：<code>railway-osm-fetch</code>、<code>railway-audit</code>（逐線對照當地語 Wikipedia infobox 站數）。</li>
<li><b>執行流程</b>：track-based 逐線排序 → 一國拆 <code>-hsr</code>／<code>-rail</code> 兩檔（日本一般國鐵再拆 JR 六社）→ 輸出 <code>data/railway/systems/…geojson</code>。</li>
</ul>`,
  landmark: `<ul class="exec-list">
<li><b>怎麼觸發</b>：離線——<code>npm run metro:landmarks</code>（抓）→ <code>metro:landmarkscombined</code>（併入城市檔成 <code>-lm</code>）。</li>
<li><b>用到什麼程式</b>：<code>scripts/fetchLandmarks.mjs</code> → <code>scripts/buildLandmarkCombined.mjs</code>。</li>
<li><b>會抓什麼</b>：Overpass 抓河流 <code>waterway=river</code> 中心線 way、皇居／公園面域（<code>leisure=park</code> 等）；快取 <code>data/metro/_cache/landmarks_*.json</code>。</li>
<li><b>會 call 什麼 skill</b>：<code>landmark-osm-fetch</code>。</li>
<li><b>執行流程</b>：河流中心線 → graph diameter 主線 → 全點保留轉成 route＋每折點車站 Point（<code>river:true</code>），併進城市檔；面域另存 <code>Polygon</code> overlay。</li>
</ul>`,
  mapadjust: `<ul class="exec-list">
<li><b>怎麼觸發</b>：在 dock 打開某城市的「Map Adjust」分頁——<b>前端即時</b>，不跑 npm、不連伺服器。</li>
<li><b>用到什麼程式</b>：<code>src/components/D3Tab.vue</code> 用 <code>d3</code> 畫；點骨架化＝<code>src/stores/skeleton.js</code>、點格網化＝<code>src/stores/schematicGrid.js</code>（皆純函式）。</li>
<li><b>會抓什麼</b>：只 <code>fetch(assetUrl('data/metro/systems/…'))</code> 讀城市 GeoJSON，<b>零網路 API、零 token</b>。</li>
<li><b>會 call 什麼 skill</b>：<code>route-skeleton-connect</code>、<code>route-skeleton-grid</code>（演算法文件依據）。</li>
<li><b>執行流程</b>：讀城市檔 → d3 <code>geoPath</code> 畫線與站（原始）；切到骨架化/格網化才呼叫對應純函式重算、即時切換。</li>
</ul>`,
  original: execPure('src/components/D3Tab.vue', 'path(f)（d3 geoPath）', '<code>metro-osm-fetch</code>',
    '把每個 feature 的原始幾何直接畫（單線實色、共線交錯彩色虛線）；「依建議旋轉」只套一個 tilt 角度，不改資料。'),
  skeleton: execPure('src/stores/skeleton.js', 'buildConnectSkeleton(geojson)', '<code>route-skeleton-connect</code>',
    '建圖 → 依 degree 分節點 → 找幾何交叉補黃點 → 收縮 degree-2 黑點鏈成邊 → 邊分類 → 標粉紅/灰/紫。',
    '結果存在記憶體 <code>cachedSkeleton</code>'),
  grid: execPure('src/stores/schematicGrid.js', 'buildSchematicGrid + placeBlacks', '<code>route-skeleton-grid</code>',
    '彩色點排名吸附 → <code>cellOf</code> → <code>repairOcclusions</code> 消壓點/交叉 → <code>placeBlacks</code> 把黑點沿新邊拉直。'),
  hillclimb: execPure('src/stores/hillClimb.js', 'buildHillClimb(skeleton, cellOf, cols, rows)', '<code>route-hillclimb</code>',
    '以格網化後為輸入，多準則適應度＋4 條硬規則爬山、短半徑移動格子、含冷卻與超長邊群集移動。',
    '結果快取在 <code>localStorage</code>（鍵 <code>d3tab-hc-cache-v7</code>）＋記憶體 <code>cachedHC</code>，資料指紋/界內驗證不符就作廢重算'),
  straighten: `<ul class="exec-list">
<li><b>怎麼觸發</b>：論文①〜⑧的八條鏈（①筆畫法／②直角爬山／③MILP規劃／④力導向／⑤最小平方／⑥八向格網／⑦路徑簡化／⑧SAT規劃）＝點視圖即時算；<b>LLM 對齊</b>＝按「開始 LLM 對齊」，由 <code>vite.config.js</code> 的外掛 spawn 一個 <b>headless <code>claude -p</code></b> session。</li>
<li><b>用到什麼程式</b>：八條論文鏈＝<code>src/stores/paperAlign.js</code> 的 <code>PAPER_BUILD</code>（②直角爬山的本體 <code>buildRectPolish</code> 在 <code>hillClimb.js</code>；都是純函式、走 <code>iteratePost</code> 迭代到不動點）；LLM＝<code>vite.config.js</code> 收 <code>/llm-align/run</code> → 跑 <code>claude -p</code> 依 skill 提移動、寫 <code>data/metro/llmviews/&lt;city&gt;.&lt;variant&gt;.json</code>，網頁輪詢 <code>/llm-align/status</code>。</li>
<li><b>會抓什麼</b>：即時算的鏈<b>零網路</b>；LLM 對齊會<b>啟動 Claude Code 模型</b>（headless、不用 API key），讀目前佈局的幾何脈絡、回傳短距離移動。</li>
<li><b>會 call 什麼 skill</b>：<code>route-rect-polish</code>（②）＋其餘論文鏈各自的 <code>route-*-align</code>（即時鏈的文件依據）；<code>route-llm-align</code>（LLM 對齊，<b>真的被 headless session 讀取執行</b>）。</li>
<li><b>執行流程</b>：都以「主視圖目前顯示的佈局」為起點 → 產生新 <code>cellAfter</code> → 過與其他相同的硬規則套用；LLM 版跑完不自動套用、按「執行調整」才套。</li>
</ul>`,
  'endpoint-move': execPure('src/stores/hillClimb.js', "movewiseStage('endp', skeleton, cells, cols, rows)", '<code>route-endpoint-move</code>、<code>route-span-cap</code>',
    '掃每個非白點、一次移 1 格試採納（H/V 淨增等條件），受跨距上限 SPAN_CAP 擋；移動後立即縮減網格。'),
  'line-compact': execPure('src/stores/hillClimb.js', "movewiseStage('line', …)", '<code>route-line-compact</code>',
    '把跨相交點串接的整條直線當一個單位平移 ±1 格，validShift 通過才採納、嚴格縮小網格。'),
  'grid-merge': execPure('src/stores/hillClimb.js', "movewiseStage('gather', …)", '<code>route-grid-merge</code>',
    '相鄰 row／col 兩兩合併：半平面整體移 1 格自帶壓縮，不壓點/不新增交叉/拓撲不變才採納。'),
  'movewise-loop': execPure('src/stores/hillClimb.js', 'straightenCompactLoop(skeleton, cells, cols, rows)', '<code>route-movewise-loop</code>',
    '端點移動→直線縮減→網格合併三個純函式輪替，每輪各掃整個 network 一遍，一輪全靜止才停；結果供 RWD 底圖。'),
  'step-verify': execPure('src/stores/hillClimb.js', 'stepChainInit / stepChainNext', '<code>route-step-verify</code>',
    '把 movewise 循環拆成單步：<code>stepChainNext</code> 推進一掃描或一移動，前後橘圈比對，含復原堆疊（狀態只在記憶體）。'),
  rwd: `<ul class="exec-list">
<li><b>怎麼觸發</b>：點「RWD 路網」＝前端即時畫；「LLM 評價／互動」＝按鈕由 <code>vite.config.js</code> spawn <b>headless <code>claude -p</code></b>。</li>
<li><b>用到什麼程式</b>：<code>src/stores/rwdMap.js</code> 的 <code>mergeParallelSegs</code>＋<code>buildRwdMap(segs, pxPos, {unit, lattice…})</code>（純函式），底圖段來自 <code>src/stores/hillClimb.js</code> 的 <code>buildHcGraph</code>；由 <code>D3Tab.vue</code> 呼叫、快取 <code>cachedRWD</code>（隨版面大小重算）。</li>
<li><b>會抓什麼</b>：畫線<b>零網路</b>；LLM 評價（<code>/llm-eval</code>）／互動（<code>/llm-grid</code>）會啟動 Claude Code 模型（headless），寫 <code>data/metro/llmevals</code>／<code>llmgrids</code>。</li>
<li><b>會 call 什麼 skill</b>：<code>route-rwd-draw</code>（畫線文件依據）；<code>route-llm-eval</code>／<code>route-llm-grid</code>（<b>真的被 headless session 讀取執行</b>）。</li>
<li><b>執行流程</b>：每段依轉折數排序候選折線（直線→單折→雙折）→ 衝突換候選、必要時 A* 繞行 → 黑點沿選定折線弧長放回；八方向約束以<b>版面 pixel</b> 為準。</li>
</ul>`,
}
for (const k in LAYER_DOCS) LAYER_DOCS[k].execution = EXECUTION[k] ?? '<p>（尚無說明）</p>'

// Map a data-layer to a doc key (LayerPanel). Map Adjust view sections pass
// their doc key directly. All data layers load as type 'metro'; highway/railway
// networks mirror the schema and are told apart only by a flag (見 mapStore
// _importSystem). Derived layers carry type 'hillclimb' / 'rwd'.
export function docKeyForLayer(layer) {
  if (!layer) return null
  if (layer.type === 'd3') return 'mapadjust'
  if (layer.type === 'hillclimb') return 'hillclimb'
  if (layer.type === 'rwd') return 'rwd'
  if (layer.highway) return 'highway'
  if (layer.railway) return 'railway'
  return 'metro' // 一般地鐵，含 metro＋地標合併（-lm）檔
}
