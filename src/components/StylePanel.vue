<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { marked } from 'marked'
import { useMapStore } from '../stores/mapStore'
import { layerData } from '../stores/layerData'
import { prettyContinent, continentZh, loadSitesIndex } from '../stores/metroCatalog'
import { URBANRAIL_CITIES, URBANRAIL_CONTINENTS } from '../stores/urbanrail'
import { stationsAlongSeg } from '../stores/popupHtml'
import { dragResize } from '../lib/dragResize'
import { assetUrl } from '../lib/assetUrl'
import { computeOrientation } from '../stores/orientation'
import OrientationRose from './OrientationRose.vue'
import MIcon from './MIcon.vue'

// The layer this tab edits — passed in by LayerTab.
const props = defineProps({
  layer: { type: Object, required: true },
  // LLM 對齊 provenance (the llmview file: model / prompt / per-round
  // transcript / finalOutput) — passed by D3Tab for Hill Climbing views;
  // when present, an extra「LLM對齊」tab appears after Object.
  llmRecord: { type: Object, default: null },
  // Run controls, wired to D3Tab's headless trigger: whether a run is in
  // flight, and whether this view has a city id to run against.
  llmRunning: { type: Boolean, default: false },
  llmCanRun: { type: Boolean, default: false },
  // 目前是否在「LLM 對齊」視圖（hc-llm 及其鏈）——只有這時才顯示自動/指定對齊 tab。
  llmView: { type: Boolean, default: false },
  llmText: { type: String, default: '' },   // 執行中即時串流的 LLM 回傳
  llmMsg: { type: String, default: null },  // 無結果/不符時的提示
  llmError: { type: String, default: '' },  // 執行失敗的尾巴訊息
  // 「執行調整」：對齊結果檔存了移動後座標，按鈕只切換「LLM 對齊」主視圖顯示
  // （套用對齊後座標 ⇄ 恢復對齊前的 Hill Climbing 佈局），不再跑 LLM。
  llmApplied: { type: Boolean, default: false },
  // 「指定對齊」（依一句話）＝與自動對齊完全獨立的一組：另存 .prompt.json、自己的
  // run/串流/結果/toggle。與自動對齊在主視圖互斥（同一個視圖只能顯示一種）。
  promptRecord: { type: Object, default: null },
  promptRunning: { type: Boolean, default: false },
  promptText: { type: String, default: '' },
  promptMsg: { type: String, default: null },
  promptError: { type: String, default: '' },
  promptApplied: { type: Boolean, default: false },
  // LLM 互動（RWD Maps「AI 改網格長寬」，skill route-llm-grid）：結果檔
  // （model / userPrompt / note / colW / rowW）＋run 控制＋即時串流——D3Tab 對
  // RWD 視圖傳入；「LLM互動」tab 對 rwd 常駐（輸入一句話觸發，跑完按「執行調整」
  // 才套用），跟「LLM評價」同一套唯讀＋切換的 UX。
  gridRecord: { type: Object, default: null },
  gridRunning: { type: Boolean, default: false },
  gridCanRun: { type: Boolean, default: false },
  gridText: { type: String, default: '' },   // 執行中即時串流的 LLM 回傳
  gridMsg: { type: String, default: null },  // 無結果/不符時的提示
  gridError: { type: String, default: '' },  // 執行失敗的尾巴訊息
  // 「執行調整」：跑完的區間權重（colW/rowW）存在結果檔，按鈕只切換顯示
  // （套用 intervalAxes ⇄ 恢復均勻/流量網格），不再跑 LLM。
  gridApplied: { type: Boolean, default: false },
  // LLM 評價（RWD Maps「AI 評路網佈局」，skill route-llm-eval）：結果檔
  // （model / summary / scores / lines / suggestions）＋run 控制與即時串流——
  // 只評價、不修改；「LLM評價」tab 對 rwd 常駐，接在「LLM互動」之後。
  evalRecord: { type: Object, default: null },
  evalRunning: { type: Boolean, default: false },
  evalCanRun: { type: Boolean, default: false },
  evalText: { type: String, default: '' },   // 執行中即時串流的 LLM 回傳
  evalMsg: { type: String, default: null },  // 無結果/不符時的提示
  evalError: { type: String, default: '' },  // 執行失敗的尾巴訊息
  // 「執行調整」：評價時已把附帶的 moves 過硬規則、把調整後佈局存進結果檔的
  // exec——按鈕只切換顯示（套用 exec.cells ⇄ 恢復原佈局），不再跑 LLM。
  evalApplied: { type: Boolean, default: false },
  // 'd3' when shown inside a Map Adjust (D3.js) tab — Info then documents the
  // skeleton rules instead of the audit verdict.
  context: { type: String, default: 'map' },
  // Which D3 view this is: 'map-adjust' | 'hillclimb' | 'rwd' (D3Tab sets it),
  // or 'metro' for the MapLibre tab. Orientation shows only for metro maps and
  // Map Adjust; the skeleton rules only for Map Adjust.
  viewKind: { type: String, default: 'metro' },
  // RWD Maps 權重驅動版面（論文 §九）：目前模式（'uniform' | 'weight'），tab 在物件之後。
  weightMode: { type: String, default: 'uniform' },
  weightAuto: { type: Boolean, default: false }, // 每 5 秒自動重抽是否開啟
  showWeights: { type: Boolean, default: true },  // 是否顯示 weight 數字
  hideStops: { type: Boolean, default: false },  // 自動隱藏白點
  minStopPx: { type: Number, default: 5 },       // 最小站距門檻（pt），站距 < 此值才刪
  stopStat: { type: Object, default: null },     // { high, wide, hidden, hiddenNames, hiddenMaxT }
  // 顏色點間最大跨距：目前「已套用」的值（D3Tab 的快取是用它算的）——與滑桿
  // 值不同時「重新計算」按鈕亮起。
  spanApplied: { type: Number, default: null },
  // 三個 LLM 功能（評價/對齊/調整）共用的模型選擇短鍵（'default' | 'opus' |
  // 'fable' | 'sonnet' | 'haiku'）；下拉改動時 emit update:llm-model 回 D3Tab。
  llmModel: { type: String, default: 'fable' },
})
const emit = defineEmits(['run-llm', 'run-prompt', 'run-grid', 'run-eval', 'toggle-eval-exec', 'toggle-grid-exec', 'toggle-llm-exec', 'toggle-prompt-exec', 'weight-mode', 'weight-random', 'weight-auto', 'hide-stops', 'min-stop-px', 'show-weights', 'recalc-span', 'update:llm-model'])
// 模型下拉的選項：短鍵 → 顯示名。'default' 不帶 --model（沿用 Claude Code 預設）。
const LLM_MODEL_OPTIONS = [
  { key: 'default', label: '沿用 CLI 預設' },
  { key: 'opus', label: 'Opus 4.8' },
  { key: 'fable', label: 'Fable 5' },
  { key: 'sonnet', label: 'Sonnet 5' },
  { key: 'haiku', label: 'Haiku 4.5' },
]
const llmUserPrompt = ref('')
// 四個 LLM 功能各自的「做法說明」——哪些是 LLM 判斷、哪些用到程式，顯示在
// 每個 tab 最下面。（llm＝模型判斷、code＝程式負責、sum＝一句結論）
const METHOD_NOTES = {
  autoAlign: {
    llm: '讀整數格佈局，自己決定哪些彩色頂點移到哪一格（純最大化水平／垂直段，不用你下指示）。',
    code: '把提案經 4 條硬規則驗證＋軸對齊退路套用；淨 H/V 段變差就整批退回（applyLlmTargets）。',
    sum: '移動決策全由 LLM，程式只驗證與套用、不做搜尋。',
  },
  promptAlign: {
    llm: '依你的一句話，自己決定哪些彩色頂點移到哪一格。',
    code: '同自動對齊——4 條硬規則＋軸對齊退路＋淨 H/V 變差整批退回（applyLlmTargets）。',
    sum: '移動決策全由 LLM（受你的指示引導），程式只驗證與套用。',
  },
  grid: {
    llm: '依你的一句話，推理每個 X 欄／Y 列區間該佔多大（顯示權重 colW／rowW）。',
    code: '把權重正規化進固定外框、在新像素座標重畫 H/V/45°（intervalAxes）；不搬任何格座標，拓撲由程式保證不變。',
    sum: '權重全由 LLM 判斷，程式只做正規化與畫線。',
  },
  eval: {
    llm: '讀佈局幾何，寫總評／評分／逐線評語／建議，並把建議轉成具體 moves。',
    code: '把 moves 經與對齊相同的硬規則算出調整後佈局存檔（exec）；「執行調整」只切換顯示、不重跑。',
    sum: '評語與建議全由 LLM，程式負責硬規則套用與顯示切換。',
  },
}
const gridUserPrompt = ref('')
const isD3 = computed(() => props.context === 'd3')
const isMapAdjust = computed(() => isD3.value && props.viewKind === 'map-adjust')
// Orientation rose: metro maps (MapLibre) + Map Adjust only, not HC / RWD.
const showOrientation = computed(() => !isD3.value || isMapAdjust.value)

const open = ref(true)
const width = ref(300)

// Panel sections — the LLM對齊 tab is always present for Hill Climbing views
// (hosts run controls + streaming + the 執行調整/恢復 toggle, like LLM評價/互動).
// 「樣式」tab 已移到地圖上方的樣式工具列（StyleBar），這裡不再列出。
// 顏色點間最大跨距（SPAN_CAP）只有 Straighten（hillclimb）與 RWD 視圖用得到——
// 只有這些視圖才顯示「設定」tab（原本在地圖上方樣式工具列的彈窗，改放這裡）。
const hasSpan = computed(() => props.viewKind === 'hillclimb' || props.viewKind === 'rwd')
const TABS = computed(() => [
  { id: 'info', label: '資訊' },
  // 物件 tab：只有選中某個 feature 時才出現；標籤＝目前物件內容類型（站點／路線／地標）。
  ...(objectKind.value ? [{ id: 'object', label: objectKind.value }] : []),
  // LLM 系列 tab：用 auto_awesome（AI 火花）icon 取代「LLM」字首，標籤留短詞、
  // title 存完整名（tooltip/無障礙）。互動/評價常駐 RWD；自動/指定對齊只在左邊
  // 「直線演算法」的 LLM 對齊視圖（hc-llm 及其鏈，llmView）才出現。
  ...(props.viewKind === 'rwd' ? [{ id: 'grid', label: '互動', icon: 'auto_awesome', title: 'LLM互動' }, { id: 'eval', label: '評價', icon: 'auto_awesome', title: 'LLM評價' }] : []),
  ...(props.llmView ? [{ id: 'llm', label: '自動對齊', icon: 'auto_awesome', title: 'LLM自動對齊' }, { id: 'llm-prompt', label: '指定對齊', icon: 'auto_awesome', title: 'LLM指定對齊' }] : []),
])
const activeTab = ref('info')

/* ---- Object: properties of the last-clicked map feature (blank if none) ---- */
const store = useMapStore()
const selectedProps = computed(() => store.selectedFeatures[props.layer.id] ?? null)
const asText = (v) => {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'object') return JSON.stringify(v, null, 2)
  return String(v)
}
// A wikipedia value is a raw OSM tag ("en:Taipei Main Station") or a URL —
// turn it into a clickable link in the Object tab. (wikidata 不顯示——使用者
// 裁決 2026-07「wikidata 都不用了」：資料層保留欄位（audit 的 wikiLineCheck 與
// 車站維基語言 fallback 靠它），僅 UI 不再顯示/成連結。)
const linkFor = (key, v) => {
  if (typeof v !== 'string' || !v) return null
  if (key === 'wikipedia') {
    if (/^https?:\/\//.test(v)) return v
    const m = /^([a-z-]+):(.+)$/.exec(v)
    if (m) return `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, '_'))}`
    return `https://en.wikipedia.org/wiki/${encodeURIComponent(v.replace(/ /g, '_'))}`
  }
  return null
}
// MapLibre serialises nested arrays/objects to JSON strings for GeoJSON source
// features — parse them back. Arrays render as an ordered list (no brackets);
// everything else as text.
const selectedEntries = computed(() => {
  const p = selectedProps.value
  if (!p) return []
  // Skip internal render-only props (e.g. `_c0.._c5` flattened dash colours).
  // merged_names is rendered as its own formatted block (per-name line chips),
  // so keep it out of the raw key/value table.
  // routes/lines/route_refs/route_colors 已在上方結構化顯示（路線列/站序），不進表格——
  // 表格只留 scalar 欄位，且 build 端保證全城鍵集一致 → 各城市表格完全相同。
  const OMIT = new Set(['merged_names', 'wikidata', 'routes', 'lines', 'route_refs', 'route_colors'])
  // X_local / X_en 與 X 同值＝重複列（network / network_local 常一樣），不顯示
  const dupLocal = (k) => {
    const m = /^(.+)_(local|en)$/.exec(k)
    return m && p[m[1]] != null && p[k] === p[m[1]]
  }
  return Object.keys(p).filter((k) => !k.startsWith('_') && !OMIT.has(k) && !dupLocal(k)).sort().map((k) => {
    let v = p[k]
    if (typeof v === 'string' && /^[[{]/.test(v.trim())) {
      try { v = JSON.parse(v) } catch { /* leave as-is */ }
    }
    if (Array.isArray(v)) return { key: k, isList: true, items: v.map(asText) }
    const href = linkFor(k, v)
    return { key: k, isList: false, value: asText(v), href }
  })
})


// 車站物件：路線一律存單一 `routes[]`（{ref,name,pass?}，與路段 feature 同形式、無 OSM id）
// ——pass:true＝行經不停（快車跳站）、無 pass＝停靠。同 ref 的普通/直達由 name 區分；
// 顏色以線名（其次 ref）對 metroLines 查表，找不到退玫瑰紅。
const routeByName = computed(() => {
  const m = new Map()
  for (const r of metroLines.value) {
    if (r.route_name != null && !m.has(String(r.route_name))) m.set(String(r.route_name), r)
    if (r.route_ref != null && !m.has(String(r.route_ref))) m.set(String(r.route_ref), r)
  }
  return m
})
const parseArr = (v) => {
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return [] } }
  return Array.isArray(v) ? v : []
}
const stationRoutes = computed(() => {
  const p = selectedProps.value
  if (!p?.station_id) return []
  return parseArr(p.routes).map((e) => {
    // 車站 routes 自帶個別線 route_color（build 端寫入）——優先用；退回以名/ref 對
    // metroLines 查表。**trunk 合併後 metroLines 的 ref 是幹線值（"1/2/3"），查不到
    // 車站的個別 ref（"2"）→ 全退玫瑰紅**＝使用者「物件tab 都變成紅色」，故直接帶色。
    const r = routeByName.value.get(String(e.name)) ?? routeByName.value.get(String(e.ref))
    return { route_ref: String(e.ref), route_name: e.name ?? String(e.ref),
      route_color: e.route_color ?? r?.route_color ?? '#e11d48', pass: !!e.pass }
  })
})
const stopRoutes = computed(() => stationRoutes.value.filter((r) => !r.pass))
const passRoutes = computed(() => stationRoutes.value.filter((r) => r.pass))
// 共站合併：異名轉乘站（merged_names）——各成員站名＋該名所屬路線。
// 路線色以 ref 對應 metroLines 的 route_color；ref 找不到色時退玫瑰紅。
const mergedNames = computed(() => {
  let v = selectedProps.value?.merged_names
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return [] } }
  if (!Array.isArray(v)) return []
  const colorByRef = new Map()
  for (const r of metroLines.value)
    if (r.route_ref != null) colorByRef.set(String(r.route_ref), r.route_color ?? '#e11d48')
  // 站自帶 routes 的個別線色後蓋——trunk 合併後 metroLines 的 ref 是幹線值（"4/5/6"），
  // 查 merged_names 的個別 ref（"4"）全 miss → 全退玫瑰紅（使用者 2026-07-17
  //「共站（各線）的顏色好多錯」）。共站 lines ⊆ 本站 routes（合併簇聯集），足以覆蓋。
  for (const e of stationRoutes.value)
    if (e.route_ref != null && e.route_color) colorByRef.set(String(e.route_ref), e.route_color)
  return v.map((e) => ({
    station_id: e.station_id,
    name: e.station_name,
    nameLocal: e.station_name_local && e.station_name_local !== e.station_name ? e.station_name_local : null,
    lines: (e.lines ?? []).map((ref) => ({ ref: String(ref), color: colorByRef.get(String(ref)) ?? '#e11d48' })),
  }))
})
// 物件 tab 最上方標題（車站與路段同一版面）：
//  · 車站（有 station_id）：站名（英文 + 在地名）；共站異名轉乘以 " / " 併（"a / b"）。
//  · 路段（有 routes）：行經的路線名以 " / " 併（共線段多條）。
// 標題格式（使用者規則）：第一行＝中文/在地名、第二行＝英文（相同則不顯示）。
// 兩者都回 { name, nameEn }，用同一個 .obj-title 樣式渲染。
const joinTitle = (list) => {
  // 去重相同名（共站同名 玉造[N]/玉造[O] 標題只顯示一個「玉造」；異名 汐留/新橋 才並列）
  const name = [...new Set(list.map((e) => e.name))].join(' / ')
  const en = [...new Set(list.map((e) => e.nameEn || e.name))].join(' / ')
  return { name, nameEn: en !== name ? en : null }
}
const objectTitle = computed(() => {
  const p = selectedProps.value
  if (!p) return null
  if (p.landmark_id) { // 地標（河流/皇居/公園）——名稱（中/在地＋英文）
    const en = p.name_en && p.name_en !== p.name ? p.name_en : null
    return p.name ? { name: p.name, nameEn: en } : null
  }
  if (p.station_id) {
    const mn = mergedNames.value
    const en = p.station_name_en && p.station_name_en !== p.station_name ? p.station_name_en : null
    if (mn.length > 1) return { ...joinTitle(mn), nameEn: en } // 共站：中文各名並列、英文取代表
    const name = p.station_name || p.station_name_local
    if (!name) return null
    return { name, nameEn: en }
  }
  const rl = selectedRouteLists.value
  if (rl.length) return joinTitle(rl)
  return null
})
// 物件 tab 的標籤＝目前選中 feature 的內容類型（三種）；沒選中任何 feature（或無
// 可顯示內容）時回 null → TABS 不列出物件 tab。
//  · 地標（landmark_id）＝地標　· 車站（station_id）＝站點　· 其餘（有路段路線）＝路線
const objectKind = computed(() => {
  const p = selectedProps.value
  if (!p) return null
  if (p.landmark_id) return '地標'
  if (p.station_id) return '站點'
  if (selectedRouteLists.value.length) return '路線'
  return null
})

// 任何目前 tab 消失（例如「權重」「設定」tab 已移除、換視圖後某 tab 不存在）→ 退回資訊。
watch(TABS, (tabs) => { if (!tabs.some((t) => t.id === activeTab.value)) activeTab.value = 'info' })

// The skill that drove the run — fetched once when the LLM對齊 / LLM互動 tab
// first opens (same source + rendering as SkillViewer: /skills/<id>.md).
const llmSkillHtml = ref('')
const gridSkillHtml = ref('')
const evalSkillHtml = ref('')
const fetchSkillHtml = async (id, target) => {
  try {
    const res = await fetch(assetUrl(`skills/${id}.md`))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const md = (await res.text()).replace(/^---\n[\s\S]*?\n---\n/, '')
    target.value = marked.parse(md)
  } catch (err) {
    target.value = `<p>SKILL.md 載入失敗：${err}</p>`
  }
}
watch(activeTab, (t) => {
  if (t === 'llm' && !llmSkillHtml.value) fetchSkillHtml('route-llm-align', llmSkillHtml)
  if (t === 'grid' && !gridSkillHtml.value) fetchSkillHtml('route-llm-grid', gridSkillHtml)
  if (t === 'eval' && !evalSkillHtml.value) fetchSkillHtml('route-llm-eval', evalSkillHtml)
})

// LLM 評價執行中的即時串流（面板內，無畫布 overlay）——新字進來自動捲到底。
const evalStreamEl = ref(null)
watch(() => props.evalText, () => {
  requestAnimationFrame(() => {
    if (evalStreamEl.value) evalStreamEl.value.scrollTop = evalStreamEl.value.scrollHeight
  })
})
const gridStreamEl = ref(null)
watch(() => props.gridText, () => {
  requestAnimationFrame(() => {
    if (gridStreamEl.value) gridStreamEl.value.scrollTop = gridStreamEl.value.scrollHeight
  })
})
const llmStreamEl = ref(null)
watch(() => props.llmText, () => {
  requestAnimationFrame(() => {
    if (llmStreamEl.value) llmStreamEl.value.scrollTop = llmStreamEl.value.scrollHeight
  })
})
const promptStreamEl = ref(null)
watch(() => props.promptText, () => {
  requestAnimationFrame(() => {
    if (promptStreamEl.value) promptStreamEl.value.scrollTop = promptStreamEl.value.scrollHeight
  })
})

// 點到路段時：只列「**這一段上**」的車站（使用者 2026-07：物件 tab 顯示該段車站、
// 不是整條路線；整線完整站表移到 資訊 tab 的路線清單展開）。順序＝原始路段幾何的
// 頂點序（線壓在站上；快車 pass 頂點也是站座標 → 停靠與通過(不停)站都會列出，
// pass 站灰字＋pass 標記）。event feature 的幾何被 tile 裁切，不可用——以 seg_id
// 回原始資料找完整幾何。
const selectedRouteLists = computed(() => {
  const p = selectedProps.value
  if (!p || p.station_id) return []
  let routes = p.routes
  if (typeof routes === 'string') { try { routes = JSON.parse(routes) } catch { return [] } }
  if (!Array.isArray(routes)) return []
  const d = layerData[layer.value?.id] ??
    (layer.value?.sourceLayerId ? layerData[layer.value.sourceLayerId] : null)
  const seg = d?.features.find((f) =>
    f.geometry?.type !== 'Point' && f.properties?.seg_id === p.seg_id)
  let ordered = []
  if (seg) {
    const byCoord = new Map()
    for (const f of d.features)
      if (f.geometry.type === 'Point') byCoord.set(f.geometry.coordinates.join(','), f.properties)
    ordered = stationsAlongSeg(seg, byCoord) // 共用 popupHtml——與地圖/D3 hover 同邏輯
      .map((s) => ({ station_id: s.station_id, station_name: s.station_name, code: s.code }))
  }
  const rows = routes.map((r) => {
    // pass 已內嵌 r.stations（完整行經序、pass 項標 pass:true——依幾何真實順序交錯）
    const passIds = new Set((r.stations ?? []).filter((s) => s.pass).map((s) => s.station_id))
    const codeOf = new Map((r.stations ?? []).map((s) => [s.station_id, s.code])) // 該線官方碼（站點無 code 欄）
    // 找不到原始段（理論上不會）退回整線行經序（本身已含 pass 標記與正確順序）
    const base = ordered.length ? ordered : (r.stations ?? [])
    const stations = base.map((s) => ({ ...s, code: s.code ?? codeOf.get(s.station_id),
      pass: !!s.pass || passIds.has(s.station_id) }))
    return {
      route_id: r.route_id,
      name: r.route_name ?? r.route_id,
      nameLocal: r.route_name_local && r.route_name_local !== r.route_name ? r.route_name_local : null,
      nameEn: r.route_name_en && r.route_name_en !== r.route_name ? r.route_name_en : null,
      ref: r.route_ref,
      color: r.route_color ?? '#e11d48',
      stations,
      uniqueCount: new Set(stations.filter((s) => !s.pass).map((s) => s.station_id)).size,
    }
  })
  // 同官方名分支（中和新蘆線 迴龍/蘆洲）在共用段的列一模一樣——顯示層去重（留第一筆）
  const seen = new Set()
  return rows.filter((r) => {
    const k = `${r.ref ?? ''}|${r.name}|${r.uniqueCount}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
})

// Set ref 的 toggle（換新 Set 觸發 reactivity）——物件 tab 與資訊 tab 的展開集合共用。
const toggleIn = (setRef, id) => {
  const next = new Set(setRef.value)
  next.has(id) ? next.delete(id) : next.add(id)
  setRef.value = next
}
// 路線車站 list 預設收合（高速公路一條可有數十個交流道，展開會拉太長）——
// 點路線標題切換展開。切換選取物件時重置回收合。
const expandedRoutes = ref(new Set())
const toggleRoute = (routeId) => toggleIn(expandedRoutes, routeId)
// 切換選取物件：有選取就自動開物件 tab；展開集合重置回收合。
watch(selectedProps, (v) => {
  if (v) activeTab.value = 'object'
  expandedRoutes.value = new Set()
})

const layer = computed(() => props.layer)
// metroLike: a D3 view created from an imported metro GeoJSON — same panels.
const isMetro = computed(() => layer.value?.type === 'metro' || layer.value?.metroLike === true)
// Highway layers reuse the metro layer type/renderer but are NOT subways —
// don't show subway-only Info (Wikipedia 地鐵 / urbanrail / 官方路線圖) and
// relabel the counts (交流道 not 車站).
const isHighway = computed(() => layer.value?.highway === true)
const editable = computed(() => layer.value && !layer.value.isBasemap && !isMetro.value)

/* ---- Info: metro system metadata (from the loaded GeoJSON) ---- */
const meta = computed(() => layerData[layer.value.id]?.metro_system ?? null)
const metroLines = computed(() => {
  const d = layerData[layer.value.id]
  if (!d) return []
  // line features are overlap-deduped SEGMENTS carrying `routes: [...]` —
  // the city's line list is the unique routes across all segments
  const byId = new Map()
  for (const f of d.features) {
    if (f.geometry.type === 'Point') continue
    for (const r of f.properties.routes ?? [f.properties]) {
      if (r.route_id && !byId.has(r.route_id)) byId.set(r.route_id, r)
    }
  }
  return [...byId.values()].sort((a, b) =>
    String(a.route_ref ?? a.route_name ?? '').localeCompare(
      String(b.route_ref ?? b.route_name ?? ''), undefined, { numeric: true },
    ),
  )
})
// 資訊 tab 路線清單可展開**每條路線的完整站表**（使用者 2026-07：整線車站移到
// 資訊 tab 顯示；快車 pass 的站也要顯示——停靠站依官方站序編號，通過(不停)站
// 灰字附註在後）。點路線列切換展開。
const expandedInfoRoutes = ref(new Set())
const toggleInfoRoute = (id) => toggleIn(expandedInfoRoutes, id)
function routeStationList(ln) {
  // pass 站已就地標在 stations[]（{...,pass:true}，schema 瘦身後版本）——
  // 依站序單一清單、pass 灰標；站數只算停靠。
  const stops = (ln.stations ?? []).map((s) => ({ ...s, pass: !!s.pass }))
  return { stops, uniqueCount: new Set(stops.filter((s) => !s.pass).map((s) => s.station_id)).size }
}

/* ---- Info: network orientation rose (Boeing 2019) ---- */
// Length-weighted distribution of line bearings + orientation-order φ.
const orientation = computed(() => {
  const d = layerData[layer.value.id]
  if (!isMetro.value || !d) return null
  return computeOrientation(d)
})
// Suggested rotation to square the network up (rotate by −tilt): a clockwise tilt
// is cancelled by a counter-clockwise turn, and vice versa.
function rotationHint(o) {
  const t = o?.tilt ?? 0
  if (Math.abs(t) < 0.5) return '0°（已對齊正南北）'
  return `${Math.abs(t).toFixed(0)}° ${t > 0 ? '逆時針' : '順時針'}`
}

/* ---- Info: per-city audit verdict (metro_system.audit, from metro:audit) ---- */
const auditInfo = computed(() => meta.value?.audit ?? null)
const auditChecks = computed(() => auditInfo.value?.checks ?? [])

/* ---- Info: external links (wiki / official website / urbanrail) ---- */
// 官方網站索引（official_sites.json，metro:sites 產出）——官方路線圖圖檔不再抓
// （使用者 2026-07 裁決改抓官方網站）；缺項 fallback 到 meta.official_website。
const sitesIndex = ref(null)
onMounted(() => {
  if (isMetro.value) loadSitesIndex().then((v) => { sitesIndex.value = v }).catch(() => {})
})
// '/data/metro/systems/asia/taiwan/asia-taiwan-taipei.geojson' → 'asia/taiwan/asia-taiwan-taipei'
const systemKey = computed(() => layer.value.file?.match(/systems\/(.+)\.geojson$/)?.[1] ?? null)
const officialSite = computed(() =>
  (systemKey.value && sitesIndex.value?.[systemKey.value]?.website) ||
  meta.value?.official_website || null)

// The zh-Wikipedia search term for this system. Default "{城市}地鐵" lands
// directly on the system article (台北地鐵 → 臺北捷運, 紐約地鐵 → 紐約地鐵), but
// a few systems in the catalog aren't subways — e.g. Sydney is the Sydney Trains
// / CityRail suburban network, so "雪梨地鐵" is wrong; "雪梨城市鐵路" → 悉尼火車.
const WIKI_TERM = {
  'oc-aus-sydney': '雪梨城市鐵路',
}
const wikiTerm = computed(() =>
  WIKI_TERM[layer.value?.id] ?? `${layer.value?.cityZh ?? layer.value?.city}地鐵`)
// Wikipedia article of this metro SYSTEM. Neither the metadata's `wikidata` nor
// `official_map` can be trusted — both often point to a single LINE (checked:
// NYC's Q126093 = 紐約地鐵1號線, London's Q207699 = 滑鐵盧及城市線). Instead we
// hit zh.wikipedia's Go-or-search with the term above, landing on the system.
const wikipediaUrl = computed(() =>
  layer.value ? `https://zh.wikipedia.org/w/index.php?search=${encodeURIComponent(wikiTerm.value)}` : null)
// 系統維基連結維持 zh 搜尋（Go-or-search，可靠落在系統條目）：系統的 meta.wikidata
// 常指向「單一路線」而非系統（實測 Tbilisi Q340562 → 阿赫梅特利-瓦爾克蒂利線），
// 用 sitelinks 反而會連到某條線，比 zh 搜尋更糟，故不套語言 fallback。

// （物件 tab 標題下原有車站維基連結——使用者 2026-07 移除：下方屬性表的
//  wikipedia 列已是可點連結，不重複顯示。）
// （官方路線圖列——使用者 2026-07 移除：改抓官方網站，見上 officialSite。）
// urbanrail.net 城市/洲 → URL 映射搬到 ../stores/urbanrail.js（純資料表）。
const urbanrailUrl = computed(() => {
  const city = URBANRAIL_CITIES[layer.value.city]
  if (city) return `https://www.urbanrail.net/${city}`
  const path = URBANRAIL_CONTINENTS[layer.value.continent]
  return path ? `https://www.urbanrail.net/${path}` : 'https://www.urbanrail.net/'
})
// 有城市頁映射 → 顯示城市名；否則顯示洲（連到洲索引頁）
const urbanrailLabel = computed(() =>
  URBANRAIL_CITIES[layer.value.city] ? layer.value.city : prettyContinent(layer.value.continent))

/* ---- resize ---- */
const dragging = ref(false)
function startResize(e) {
  const startW = width.value
  // 拖到極限但**不越過左邊面板**：上限＝容器寬 − 左側視圖導覽條寬 − 畫布一小條。
  const host = e.currentTarget?.parentElement
  const leftNav = host?.querySelector('.view-nav')
  dragResize(e, {
    dragging,
    onMove: (dx) => {
      const navW = leftNav ? leftNav.offsetWidth : 0
      const maxW = host ? Math.max(120, host.clientWidth - navW - 60) : 2000
      width.value = Math.min(maxW, Math.max(60, startW - dx))
    },
  })
}
</script>

<template>
  <!-- Collapsed rail -->
  <aside v-if="!open" class="rail" aria-label="Panel (collapsed)">
    <button class="btn-icon" title="Expand panel" @click="open = true">
      <MIcon name="right_panel_open" :size="15" />
    </button>
    <MIcon name="tune" :size="14" class="rail-icon" />
    <span class="rail-label">資訊 / 物件</span>
  </aside>

  <template v-else>
    <div
      class="resize-x"
      :class="{ dragging }"
      role="separator"
      aria-orientation="vertical"
      @pointerdown="startResize"
    />

    <aside class="style-panel" aria-label="Layer panel" :style="{ width: width + 'px' }">
      <div class="panel-header tabs-header">
        <div class="panel-tabs" role="tablist">
          <button
            v-for="t in TABS"
            :key="t.id"
            class="panel-tab"
            :class="{ active: activeTab === t.id }"
            role="tab"
            :aria-selected="activeTab === t.id"
            :title="t.title ?? t.label"
            @click="activeTab = t.id"
          >
            <MIcon v-if="t.icon" :name="t.icon" :size="14" />
            {{ t.label }}
          </button>
        </div>
        <button class="btn-icon" title="Collapse panel" @click="open = false">
          <MIcon name="right_panel_close" :size="14" />
        </button>
      </div>

      <div class="style-body">
        <div v-if="!(activeTab === 'info' && isMetro)" class="layer-heading">
          <span class="layer-name">{{ layer.name }}</span>
        </div>

        <!-- ============ Info ============ -->
        <template v-if="activeTab === 'info'">
          <template v-if="isMetro">
            <!-- 城市標題：中文城市。中文國名 / 英文城市。英文國名 -->
            <div class="info-title">
              <div class="info-title-zh">{{ layer.cityZh ?? layer.city }}・{{ layer.countryZh ?? layer.country }}</div>
              <div class="info-title-en">{{ layer.city }}・{{ layer.country }}</div>
            </div>
            <div class="info-rows">
              <div class="info-row">
                <span class="info-key">洲別</span><span>{{ continentZh(layer.continent) }}</span>
              </div>
              <div class="info-row"><span class="info-key">{{ isHighway ? '道路數' : '路線數' }}</span><span>{{ layer.lineCount }}</span></div>
              <div class="info-row"><span class="info-key">{{ isHighway ? '交流道數' : '車站數' }}</span><span>{{ layer.stationCount }}</span></div>
              <div v-if="meta?.operator" class="info-row">
                <span class="info-key">營運單位</span><span>{{ meta.operator }}</span>
              </div>
              <div v-if="officialSite" class="info-row">
                <span class="info-key">官網</span>
                <a :href="officialSite" target="_blank" rel="noopener" class="info-link">
                  {{ officialSite.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') }}
                  <MIcon name="open_in_new" :size="11" />
                </a>
              </div>
              <div v-if="!isHighway && wikipediaUrl" class="info-row">
                <span class="info-key">Wikipedia</span>
                <a :href="wikipediaUrl" target="_blank" rel="noopener" class="info-link">
                  {{ wikiTerm }} <MIcon name="open_in_new" :size="11" />
                </a>
              </div>
              <div v-if="!isHighway" class="info-row">
                <span class="info-key">urbanrail</span>
                <a :href="urbanrailUrl" target="_blank" rel="noopener" class="info-link">
                  UrbanRail.Net：{{ urbanrailLabel }} <MIcon name="open_in_new" :size="11" />
                </a>
              </div>
              <div v-if="meta?.osm_networks?.length" class="info-row">
                <span class="info-key">路網</span>
                <span>{{ meta.osm_networks.join(', ') }}</span>
              </div>
            </div>

            <template v-if="showOrientation">
            <div class="section-title">方位</div>
            <div v-if="!orientation || !orientation.segments" class="info-empty">
              載入中…
            </div>
            <template v-else>
              <OrientationRose
                :bins="orientation.bins"
                :size="220"
                :tilt="orientation.tilt"
                :strength="orientation.strength"
              />
              <div class="info-rows rose-stats">
                <div class="info-row">
                  <span class="info-key">φ 秩序度</span><span>{{ orientation.phi.toFixed(3) }}</span>
                </div>
                <div class="info-row">
                  <span class="info-key">路線總長</span>
                  <span>{{ orientation.totalKm.toFixed(1) }} km</span>
                </div>
                <div class="info-row">
                  <span class="info-key">建議旋轉</span>
                  <span>{{ rotationHint(orientation) }}</span>
                </div>
              </div>
              <div class="rose-note">
                <strong>玫瑰圖的算法</strong>：把每條線段的羅盤方位角（0°=北、順時針）連同反向
                （+180°），依<strong>線段長度</strong>加權，分進 36 個 10° 方向格；每根 wedge 的半徑
                ∝ 該方向的長度佔比（面積等比、雙向對稱）。共用主幹只算一條、不乘路線數。
                <br />
                <strong>φ 秩序度</strong>（Boeing 2019 方向熵）：φ = 0 方向均勻（無序），
                φ = 1 完美方格網——越高代表越接近單一方格、旋轉建議越可靠。
                <br />
                <strong>建議旋轉的算法</strong>：<strong>只取玫瑰圖<span class="rose-red">紅色（最長）</span>那格內的線</strong>，
                以各自長度為權重、平均它們的角度（精確值，非取格子中心），再轉到<strong>最近</strong>的水平／垂直
                （摺 90°，轉幅 ≤ 45°，即最小旋轉）。其他方向不參與。此角度不改地圖。
              </div>
            </template>
            </template>

            <!-- Skeleton computation rules — Map Adjust view only -->
            <template v-if="isMapAdjust">
              <div class="section-title">骨架化規則</div>
              <div class="skeleton-rules">
                <p>不拉直、保留地理形狀，只做拓撲收縮與標記（connect 骨架）。</p>
                <p class="sk-sub">節點（依圖 degree）</p>
                <ul>
                  <li><span class="sk-dot" style="background:#e11d48" /> 紅：分歧／轉乘（degree≥3，或兩側路線不同的 degree-2）</li>
                  <li><span class="sk-dot" style="background:#2563eb" /> 藍：真端點（degree≤1）</li>
                  <li><span class="sk-dot sk-ring" /> 白：直通中段站（degree=2、兩側同路線；不變）</li>
                  <li><span class="sk-dot" style="background:#a855f7" /> 紫：頭尾共點／環線切斷點</li>
                  <li><span class="sk-dot" style="background:#ec4899" /> 粉紅：代表性轉折點（邊曲折度&gt;1.25 才挑，DP 垂距/弦長&gt;0.25 的黑點）</li>
                  <li><span class="sk-dot" style="background:#9ca3af" /> 灰：過長黑點段的分隔（每段 ≤4，G=⌊N/5⌋）</li>
                </ul>
                <p class="sk-sub">線畫法（照原本）</p>
                <ul>
                  <li><span class="sk-line sk-plain" /> 單線＝route 原色；重疊＝各 route 交錯彩色虛線</li>
                </ul>
                <p class="sk-sub">邊分類（線底下的 highlight 襯底）</p>
                <ul>
                  <li><span class="sk-line" style="background:#e11d48" /> 紅：共線合併（≥2 路線；不切紫點）</li>
                  <li><span class="sk-line" style="background:#16a34a" /> 綠：環線（自環；1/3、2/3 切 2 紫）</li>
                  <li><span class="sk-line" style="background:#2563eb" /> 藍：頭尾共點（平行多重邊；1/2 切 1 紫）</li>
                  <li><span class="sk-line" style="background:#7c3aed" /> 紫：<b>非分類</b>——紅、藍襯底半透明重疊處的疊色（同走廊既是共線又有平行邊）</li>
                </ul>
                <p class="rose-note">
                  依 skill <code>route-skeleton-connect</code>。座標一律照原地理、不移動；
                  黃色幾何交叉為 v2（metro 交叉多為轉乘站，罕見）。
                </p>
              </div>
            </template>

            <template v-if="!isD3">
            <div class="section-title">資料驗證</div>
            <div v-if="!auditInfo" class="info-empty">
              尚未執行資料驗證（npm run metro:audit）
            </div>
            <template v-else>
              <div class="audit-banner" :class="auditInfo.passed ? 'pass' : 'fail'">
                <MIcon name="check_circle" v-if="auditInfo.passed" :size="14" />
                <MIcon name="cancel" v-else :size="14" />
                <span>{{ auditInfo.passed ? '資料驗證通過' : '資料驗證未通過' }}</span>
                <span v-if="auditInfo.audited_at" class="audit-date">
                  {{ auditInfo.audited_at.slice(0, 10) }}
                </span>
              </div>

              <div v-if="!auditInfo.passed && auditInfo.reasons?.length" class="audit-list fail">
                <div v-for="(r, i) in auditInfo.reasons" :key="i" class="audit-item">
                  <MIcon name="cancel" :size="12" class="audit-ic" /> {{ r }}
                </div>
              </div>
              <div v-if="auditInfo.covered_by" class="audit-list">
                <div class="audit-item">
                  <MIcon name="warning" :size="12" class="audit-ic warn" />
                  由 {{ auditInfo.covered_by }} 系統檔涵蓋（同都會區）
                </div>
              </div>
              <div v-if="auditInfo.warnings?.length" class="audit-list warn">
                <div v-for="(w, i) in auditInfo.warnings" :key="i" class="audit-item">
                  <MIcon name="warning" :size="12" class="audit-ic warn" /> {{ w }}
                </div>
              </div>
              <div v-if="auditChecks.length" class="audit-list">
                <div v-for="c in auditChecks.filter((c) => c.ok)" :key="c.id" class="audit-item ok">
                  <MIcon name="check_circle" :size="12" class="audit-ic ok" /> {{ c.detail }}
                </div>
              </div>
            </template>
            </template>

            <!-- 路線 list: only on the Metro Maps (MapLibre) view -->
            <template v-if="!isD3">
              <div class="section-title">路線</div>
              <div v-if="!metroLines.length" class="info-empty">載入中…</div>
              <div v-else class="line-list">
                <template v-for="ln in metroLines" :key="ln.route_id">
                  <button type="button" class="line-row line-row-toggle"
                    :aria-expanded="expandedInfoRoutes.has(ln.route_id)"
                    @click="toggleInfoRoute(ln.route_id)">
                    <MIcon :name="expandedInfoRoutes.has(ln.route_id) ? 'expand_more' : 'chevron_right'" class="obj-route-caret" />
                    <span class="line-swatch" :style="{ background: ln.route_color ?? '#e11d48' }" />
                    <span v-if="ln.route_ref" class="line-ref">{{ ln.route_ref }}</span>
                    <span class="line-name">
                      {{ ln.route_name ?? ln.route_name_local ?? '—' }}
                    </span>
                    <span v-if="ln.status === 'under_construction'" class="line-uc">建設中</span>
                    <span class="obj-route-count">{{ routeStationList(ln).uniqueCount }} 站</span>
                  </button>
                  <ol v-if="expandedInfoRoutes.has(ln.route_id)" class="obj-station-list">
                    <li v-for="(st, i) in routeStationList(ln).stops" :key="`${st.station_id}-${i}`"
                      :class="{ 'st-pass': st.pass }">
                      <span v-if="st.code" class="obj-st-code">{{ st.code }}</span>{{ st.station_name
                      }}<span v-if="st.pass" class="obj-pass-tag">pass</span>
                    </li>
                  </ol>
                </template>
              </div>
            </template>

            <!-- 顏色點間最大跨距（SPAN_CAP）：Straighten（hillclimb）與 RWD 都有——
                 控制（最大跨距＋重新計算）已移到地圖上方工具列第 2 排，這裡只留說明。 -->
            <template v-if="hasSpan">
              <div class="section-title">顏色點間最大跨距</div>
              <p class="weight-hint">
                水平／垂直最大化的每一次移動，都不得讓一條線段的兩個顏色點在網格上橫跨
                超過這個格數（Chebyshev＝max(|Δx|,|Δy|)）——避免某條線被拉成過長的斜段。
                本來就超標的舊長段只准縮短、不准再拉長。
              </p>
              <p class="weight-hint">
                目前套用值 <b>{{ spanApplied ?? 3 }}</b> 格。上方工具列可改「最大跨距」，
                改完不會自動重算——按「重新計算」才會用新值重跑水平垂直最大化。
              </p>
            </template>

            <!-- 版面（權重驅動）：RWD 視圖——控制與即時診斷（最小站距／畫布／已隱藏）
                 已移到地圖上方工具列第 2 排，這裡只留說明與被隱藏的站清單。 -->
            <template v-if="viewKind === 'rwd'">
              <div class="section-title">版面（權重驅動）</div>
              <p class="weight-hint">
                版面簡化不改拓撲：用各欄／列最忙路段的流量（weight）決定該欄多寬、該列多高
                ——主走廊變寬、次要區壓窄，外框固定，路線在新像素座標重畫成 H/V/45°。
                模式切換、顯示權重數字、隨機權重、自動隱藏白點與最小站距等控制，都在地圖
                上方工具列的第 2 排。
              </p>
              <p class="weight-hint">
                「隨機權重」每按一次整表重抽：每個沿路相鄰站對抽 1–9，反等比（機率 ∝ 1/2ᵏ）
                ——數字越小越常見，少數主走廊、多數次要邊。「每5秒隨機權重」開啟後每 5 秒
                整表重抽一次，network 點跟著新版面變形（自動切到權重模式）。
              </p>
              <p class="weight-hint">
                自動隱藏白點：由最擠的路段決定一個全域 weight 差 cutoff T（升高 T 直到最擠段
                均分後站距 ≥「最小站距」），然後全圖任何白點（直通站）只要左右兩段 weight 差
                ≤ T 就一律隱藏（相鄰標籤合併取 max）。彩色錨點（紅／藍／黃）不會被藏。
              </p>
              <div v-if="hideStops && stopStat && stopStat.hidden > 0" class="hidden-list">
                <div class="hidden-list-title">被隱藏的站（{{ stopStat.hidden }}）</div>
                <ol class="hidden-list-items">
                  <li v-for="(n, i) in stopStat.hiddenNames" :key="i">{{ n }}</li>
                </ol>
              </div>
            </template>
          </template>
          <div v-else class="info-empty">此圖層沒有 metro 資訊。</div>
        </template>


        <template v-else-if="activeTab === 'object'">
          <div v-if="!selectedEntries.length" class="obj-empty">
            點地圖上的物件以檢視其屬性
          </div>
          <!-- 車站/路段：最上方顯示名稱（英文 + 在地名），共站/共線以 " / " 併 -->
          <div v-if="objectTitle" class="obj-title">
            {{ objectTitle.name }}
            <span v-if="objectTitle.nameEn" class="obj-title-local">{{ objectTitle.nameEn }}</span>
          </div>
          <!-- 標題下不放維基連結（使用者 2026-07：下方屬性表的 wikipedia 列已有連結） -->
          <!-- 路段：站序中同時列停靠與通過(不停)站，pass 站標記、灰字並排在正確位置 -->
          <template v-for="rt in selectedRouteLists" :key="rt.route_id">
            <button type="button" class="obj-route-head obj-route-toggle"
              :aria-expanded="expandedRoutes.has(rt.route_id)" @click="toggleRoute(rt.route_id)">
              <MIcon :name="expandedRoutes.has(rt.route_id) ? 'expand_more' : 'chevron_right'" class="obj-route-caret" />
              <span class="line-swatch" :style="{ background: rt.color }" />
              <span v-if="rt.ref" class="line-ref">{{ rt.ref }}</span>
              <span class="obj-route-name">{{ rt.name }}</span>
              <span class="obj-route-count">停靠 {{ rt.uniqueCount }} 站</span>
            </button>
            <ol v-if="expandedRoutes.has(rt.route_id)" class="obj-station-list">
              <li v-for="(st, i) in rt.stations" :key="`${st.station_id}-${i}`" :class="{ 'st-pass': st.pass }">
                <span v-if="st.code" class="obj-st-code">{{ st.code }}</span><span v-else-if="st.mileage != null" class="obj-st-code" title="里程">{{ st.mileage }}K</span>{{ st.station_name }}<span v-if="st.pass" class="obj-pass-tag">pass</span>
              </li>
            </ol>
          </template>
          <!-- 共站合併：異名轉乘站——每條線在此站的不同站名 -->
          <div v-if="mergedNames.length" class="obj-merged">
            <div class="obj-pass-sub">共站（各線）</div>
            <div v-for="mn in mergedNames" :key="mn.station_id" class="obj-merged-row">
              <span class="obj-merged-name">{{ mn.name
                }}<span v-if="mn.nameLocal" class="obj-merged-local">{{ mn.nameLocal }}</span></span>
              <span v-for="ln in mn.lines" :key="ln.ref" class="line-ref obj-merged-line"
                :style="{ background: ln.color }">{{ ln.ref }}</span>
            </div>
          </div>
          <!-- 車站：停靠此站的路線 + 行經(不停靠)的路線 -->
          <div v-if="stopRoutes.length || passRoutes.length" class="obj-pass">
            <div v-if="stopRoutes.length" class="obj-pass-sub">停靠路線</div>
            <div v-for="r in stopRoutes" :key="`s-${r.route_name}`" class="obj-pass-row">
              <span class="line-swatch" :style="{ background: r.route_color ?? '#e11d48' }" />
              <span v-if="r.route_ref" class="line-ref">{{ r.route_ref }}</span>
              <span class="obj-route-name">{{ r.route_name ?? '—' }}</span>
            </div>
            <div v-if="passRoutes.length" class="obj-pass-sub">行經（不停靠）</div>
            <div v-for="r in passRoutes" :key="`p-${r.route_name}`" class="obj-pass-row">
              <span class="line-swatch" :style="{ background: r.route_color ?? '#e11d48' }" />
              <span v-if="r.route_ref" class="line-ref">{{ r.route_ref }}</span>
              <span class="obj-route-name">{{ r.route_name ?? '—' }}</span>
              <span class="obj-pass-tag">pass</span>
            </div>
          </div>
          <table v-if="selectedEntries.length" class="obj-table">
            <tbody>
              <tr v-for="row in selectedEntries" :key="row.key">
                <th class="obj-key">{{ row.key }}</th>
                <td class="obj-val">
                  <template v-if="row.isList">
                    <span v-if="!row.items.length">—</span>
                    <div v-for="(it, i) in row.items" :key="i" class="obj-li">{{ it }}</div>
                  </template>
                  <a v-else-if="row.href" :href="row.href" target="_blank" rel="noopener" class="info-link">
                    {{ row.value }} <MIcon name="open_in_new" :size="11" />
                  </a>
                  <template v-else>{{ row.value }}</template>
                </td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- ============ LLM互動（RWD Maps）: AI 改網格長寬（skill route-llm-grid）============ -->
        <template v-else-if="activeTab === 'grid'">
          <div class="weight-panel">
            <p class="weight-hint">
              用一句話改網格大小：模型推理**每個 X 欄／Y 列區間**在畫面上該佔多大（顯示權重，
              1=原尺寸、&gt;1 放大、&lt;1 壓縮），不搬任何站的格座標。跑完先回傳要怎麼改、
              **不自動套用**——按「執行調整」才把權重正規化進固定外框、在新像素座標重畫
              H/V/45°，「恢復原佈局」切回。與「權重」tab 的流量比例是同一種變形、不同的權重來源。
            </p>
            <template v-if="gridCanRun">
              <textarea
                v-model="gridUserPrompt"
                class="llm-prompt-box"
                rows="3"
                :disabled="gridRunning"
                placeholder="例：把市中心那幾欄拉開；中間幾列拉高；東側壓縮一點、把空間讓給核心…"
              />
              <label class="llm-model-pick">
                模型
                <select :value="llmModel" :disabled="gridRunning"
                  @change="emit('update:llm-model', $event.target.value)">
                  <option v-for="m in LLM_MODEL_OPTIONS" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
              </label>
              <button
                class="llm-run-btn"
                :disabled="gridRunning || !gridUserPrompt.trim()"
                @click="emit('run-grid', gridUserPrompt.trim())"
              >{{ gridRunning ? '互動中…' : (gridRecord ? '重新 LLM 互動' : '開始 LLM 互動') }}</button>
              <p class="llm-run-hint">按下會啟動本機 headless Claude Code 依 route-llm-grid skill 推理權重並存檔——跑完不自動套用，用下面的「執行調整」才會改 RWD 路網。放大會明顯（核心 3–5 倍）且由核心向外漸近。</p>
            </template>
            <p v-else class="llm-run-hint">匯入資料沒有城市 id，無法對應結果檔——請用目錄裡的城市。</p>
            <template v-if="gridRunning">
              <h4 class="llm-h">LLM 回傳（即時串流）</h4>
              <pre ref="gridStreamEl" class="llm-pre eval-stream">{{ gridText || '等待模型回應…' }}</pre>
            </template>
            <p v-if="gridError" class="llm-run-hint eval-err">執行失敗：{{ gridError }}</p>

            <template v-if="gridRecord">
              <div class="info-rows">
                <div class="info-row"><span class="info-key">模型</span><span>{{ gridRecord.model ?? '—' }}</span></div>
                <div class="info-row"><span class="info-key">網格</span><span>{{ gridRecord.cols }} 欄 × {{ gridRecord.rows }} 列</span></div>
                <div class="info-row">
                  <span class="info-key">最大倍率</span>
                  <span>{{ Math.max(...gridRecord.colW, ...gridRecord.rowW).toFixed(1) }}</span>
                </div>
              </div>
              <p v-if="gridRecord.userPrompt" class="llm-run-hint">上次指示：{{ gridRecord.userPrompt }}</p>
              <h4 class="llm-h">模型的思路</h4>
              <div class="llm-note">{{ gridRecord.note ?? '（無說明）' }}</div>
              <h4 class="llm-h">欄權重（西 → 東）</h4>
              <pre class="llm-pre">{{ gridRecord.colW.map((w) => (+w).toFixed(1)).join(' ') }}</pre>
              <h4 class="llm-h">列權重（北 → 南）</h4>
              <pre class="llm-pre">{{ gridRecord.rowW.map((w) => (+w).toFixed(1)).join(' ') }}</pre>
              <template v-if="gridRecord.finalOutput">
                <h4 class="llm-h">最終輸出</h4>
                <pre class="llm-pre">{{ gridRecord.finalOutput }}</pre>
              </template>

              <!-- 執行調整：跑完的區間權重存在結果檔，這顆按鈕只切換顯示
                   （套用 intervalAxes ⇄ 恢復），不再跑 LLM，可來回比較前後 -->
              <h4 class="llm-h">套用到 RWD 路網</h4>
              <button
                class="llm-run-btn"
                @click="emit('toggle-grid-exec')"
              >{{ gridApplied ? '恢復原佈局' : '執行調整' }}</button>
              <p class="llm-run-hint">這顆按鈕只是切換顯示（不跑 LLM、即時）——「執行調整」用模型推理的欄寬列高重畫 RWD 路網，「恢復原佈局」切回原本的均勻/流量網格，可來回比較。</p>
            </template>
            <p v-else-if="!gridRunning" class="llm-note">{{ gridMsg ?? '尚未產生結果——在上面輸入一句話執行。' }}</p>

            <h4 class="llm-h">使用的 skill：route-llm-grid</h4>
            <details class="llm-skill">
              <summary>展開 SKILL.md 全文（模型執行時遵循的協定）</summary>
              <div class="skill-md llm-skill-md" v-html="gridSkillHtml || '<p>載入中…</p>'" />
            </details>

            <h4 class="llm-h">做法說明</h4>
            <ul class="llm-method">
              <li><b>LLM 判斷：</b>{{ METHOD_NOTES.grid.llm }}</li>
              <li><b>程式負責：</b>{{ METHOD_NOTES.grid.code }}</li>
            </ul>
            <p class="llm-method-sum">{{ METHOD_NOTES.grid.sum }}</p>
          </div>
        </template>

        <!-- ============ LLM評價（RWD Maps）: AI 評路網佈局（skill route-llm-eval）============ -->
        <template v-else-if="activeTab === 'eval'">
          <div class="weight-panel">
            <p class="weight-hint">
              讓模型評這個路網的佈局：哪些線可以調整讓直線與水平線更多、整體更方正、
              哪條線彎折太多可以更直……只評價、不修改——不會動任何座標，回傳的只是結果文字。
            </p>
            <template v-if="evalCanRun">
              <label class="llm-model-pick">
                模型
                <select :value="llmModel" :disabled="evalRunning"
                  @change="emit('update:llm-model', $event.target.value)">
                  <option v-for="m in LLM_MODEL_OPTIONS" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
              </label>
              <button
                class="llm-run-btn"
                :disabled="evalRunning"
                @click="emit('run-eval', '')"
              >{{ evalRunning ? '評價中…' : (evalRecord ? '重新 LLM 評價' : 'LLM 評價') }}</button>
              <p class="llm-run-hint">按下會啟動本機 headless Claude Code 依 route-llm-eval skill 讀佈局幾何（逐線段方向、彎折數）寫評價並存檔，完成後顯示在下面。</p>
            </template>
            <p v-else class="llm-run-hint">匯入資料沒有城市 id，無法對應結果檔——請用目錄裡的城市。</p>
            <template v-if="evalRunning">
              <h4 class="llm-h">LLM 回傳（即時串流）</h4>
              <pre ref="evalStreamEl" class="llm-pre eval-stream">{{ evalText || '等待模型回應…' }}</pre>
            </template>
            <p v-if="evalError" class="llm-run-hint eval-err">執行失敗：{{ evalError }}</p>

            <template v-if="evalRecord">
              <div class="info-rows">
                <div class="info-row"><span class="info-key">模型</span><span>{{ evalRecord.model ?? '—' }}</span></div>
                <div class="info-row"><span class="info-key">網格</span><span>{{ evalRecord.stats.cols }} 欄 × {{ evalRecord.stats.rows }} 列</span></div>
                <div class="info-row">
                  <span class="info-key">直段</span>
                  <span>H/V {{ evalRecord.stats.hv }}＋45° {{ evalRecord.stats.d45 }}／{{ evalRecord.stats.segs }} 段</span>
                </div>
              </div>
              <p v-if="evalRecord.userPrompt" class="llm-run-hint">關注點：{{ evalRecord.userPrompt }}</p>
              <h4 class="llm-h">總評</h4>
              <div class="llm-note">{{ evalRecord.summary }}</div>
              <template v-if="(evalRecord.scores ?? []).length">
                <h4 class="llm-h">面向評分</h4>
                <div v-for="(s, i) in evalRecord.scores" :key="i" class="eval-score">
                  <div class="eval-score-head"><span>{{ s.aspect }}</span><b>{{ s.score }}/10</b></div>
                  <div v-if="s.comment" class="llm-note">{{ s.comment }}</div>
                </div>
              </template>
              <template v-if="(evalRecord.lines ?? []).length">
                <h4 class="llm-h">逐線評語</h4>
                <div v-for="(l, i) in evalRecord.lines" :key="i" class="eval-line">
                  <div class="eval-line-name">{{ l.name }}</div>
                  <div class="llm-note">{{ l.comment }}</div>
                </div>
              </template>
              <template v-if="(evalRecord.suggestions ?? []).length">
                <h4 class="llm-h">調整建議（僅建議、不執行）</h4>
                <ol class="eval-suggestions">
                  <li v-for="(s, i) in evalRecord.suggestions" :key="i">{{ s }}</li>
                </ol>
              </template>
              <template v-if="evalRecord.finalOutput">
                <h4 class="llm-h">最終輸出</h4>
                <pre class="llm-pre">{{ evalRecord.finalOutput }}</pre>
              </template>

              <!-- 執行調整：評價時已把 moves 過硬規則、算好調整後佈局存進 exec——
                   這裡只切換顯示（套用 ⇄ 恢復），不再跑 LLM，可來回比較前後差別 -->
              <template v-if="evalRecord.exec">
                <h4 class="llm-h">記錄的調整（評價時已算好）</h4>
                <div class="info-rows">
                  <div class="info-row">
                    <span class="info-key">水平垂直</span>
                    <span>{{ evalRecord.exec.hvBefore }} → {{ evalRecord.exec.hvAfter }}／{{ evalRecord.stats.segs }} 段</span>
                  </div>
                  <div class="info-row">
                    <span class="info-key">移動</span>
                    <span>{{ evalRecord.exec.moved }} 點／提案 {{ evalRecord.exec.proposed }}<template v-if="(evalRecord.exec.rejected ?? []).length">（{{ evalRecord.exec.rejected.length }} 被硬規則拒絕）</template></span>
                  </div>
                </div>
                <button
                  class="llm-run-btn"
                  @click="emit('toggle-eval-exec')"
                >{{ evalApplied ? '恢復原佈局' : '執行調整' }}</button>
                <p class="llm-run-hint">評價時已把建議轉成具體移動、經硬規則驗證並存檔——這顆按鈕只是切換顯示（不跑 LLM、即時），可來回切換比較調整前後的差別。</p>
                <div v-if="(evalRecord.exec.rejected ?? []).length" class="llm-note">被拒絕的提案：{{ evalRecord.exec.rejected.map((x) => `${x.name}→(${x.want[0]},${x.want[1]})`).join('、') }}</div>
              </template>
              <p v-else class="llm-run-hint">此評價沒有記錄具體移動——按「重新 LLM 評價」重新產生即可（新版評價會一併記錄怎麼移動、供一鍵執行）。</p>
            </template>
            <p v-else-if="!evalRunning" class="llm-note">{{ evalMsg ?? '尚未產生評價——按上面的按鈕執行。' }}</p>

            <h4 class="llm-h">使用的 skill：route-llm-eval</h4>
            <details class="llm-skill">
              <summary>展開 SKILL.md 全文（模型執行時遵循的協定）</summary>
              <div class="skill-md llm-skill-md" v-html="evalSkillHtml || '<p>載入中…</p>'" />
            </details>

            <h4 class="llm-h">做法說明</h4>
            <ul class="llm-method">
              <li><b>LLM 判斷：</b>{{ METHOD_NOTES.eval.llm }}</li>
              <li><b>程式負責：</b>{{ METHOD_NOTES.eval.code }}</li>
            </ul>
            <p class="llm-method-sum">{{ METHOD_NOTES.eval.sum }}</p>
          </div>
        </template>

        <!-- ============ LLM自動對齊（skill route-llm-align，寫 .json，餵下游）======
             跟 LLM評價/互動 同一套唯讀＋切換 UX：跑完不自動套用，按「執行調整」才
             套用到 LLM 對齊主視圖。與「指定對齊」完全獨立、互不影響。 -->
        <template v-else-if="activeTab === 'llm'">
          <div class="weight-panel">
            <p class="weight-hint">
              讓模型**自動對齊**這個路網：短距離移動彩色點、把線盡量拉成水平／垂直
              （最大化 H/V），不需要你下指示。**以主視圖目前顯示的佈局為起點**——按
              「執行調整」把結果套到主視圖，「恢復原佈局」切回。下游的「LLM對齊端點
              移動…」等鏈會**跟著目前顯示的佈局重算**。
            </p>
            <template v-if="llmCanRun">
              <label class="llm-model-pick">
                模型
                <select :value="llmModel" :disabled="llmRunning"
                  @change="emit('update:llm-model', $event.target.value)">
                  <option v-for="m in LLM_MODEL_OPTIONS" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
              </label>
              <button
                class="llm-run-btn"
                :disabled="llmRunning"
                @click="emit('run-llm', '')"
              >{{ llmRunning ? '對齊中…' : (llmRecord ? '重新 LLM 自動對齊' : '開始 LLM 自動對齊') }}</button>
              <p class="llm-run-hint">按下會啟動本機 headless Claude Code 依 route-llm-align skill 逐輪最佳化並存檔（跑完不自動套用）。</p>
            </template>
            <p v-else class="llm-run-hint">匯入資料沒有城市 id，無法對應結果檔——請用目錄裡的城市。</p>

            <template v-if="llmRunning">
              <h4 class="llm-h">LLM 回傳（即時串流）</h4>
              <pre ref="llmStreamEl" class="llm-pre eval-stream">{{ llmText || '等待模型回應…' }}</pre>
            </template>
            <p v-if="llmError" class="llm-run-hint eval-err">執行失敗：{{ llmError }}</p>

            <template v-if="llmRecord">
              <div class="info-rows">
                <div class="info-row"><span class="info-key">模型</span><span>{{ llmRecord.model ?? '—' }}</span></div>
                <div class="info-row"><span class="info-key">輪數</span><span>{{ llmRecord.rounds }}</span></div>
                <div class="info-row">
                  <span class="info-key">水平垂直</span>
                  <span>{{ llmRecord.hvBefore }} → {{ llmRecord.hvAfter }}／{{ llmRecord.segs }} 段</span>
                </div>
                <div class="info-row"><span class="info-key">移動</span><span>{{ llmRecord.moved }} 站</span></div>
              </div>
              <template v-if="(llmRecord.transcript ?? []).length">
                <h4 class="llm-h">LLM 回傳（逐輪）</h4>
                <div v-for="(t, i) in llmRecord.transcript" :key="i" class="llm-round">
                  <div class="llm-round-head">
                    {{ t.round ? `第 ${t.round} 輪` : '附註' }} · 提案 {{ t.proposed }} 點
                    · HV {{ t.hv }}<template v-if="t.rejected"> · 硬規則拒絕 {{ t.rejected }}</template>
                  </div>
                  <div class="llm-note">{{ t.note ?? '（無說明）' }}</div>
                </div>
              </template>
              <template v-if="llmRecord.finalOutput">
                <h4 class="llm-h">最終輸出</h4>
                <pre class="llm-pre">{{ llmRecord.finalOutput }}</pre>
              </template>

              <h4 class="llm-h">套用到 LLM 對齊主視圖</h4>
              <button class="llm-run-btn" @click="emit('toggle-llm-exec')">{{ llmApplied ? '恢復原佈局' : '執行調整' }}</button>
              <p class="llm-run-hint">切換顯示（不跑 LLM、即時）——「執行調整」用自動對齊的座標重畫主視圖並讓下游各鏈以它重算，「恢復原佈局」切回。與「指定對齊」在主視圖互斥。RWD 'llm' 版面固定以自動對齊為基準。</p>
            </template>
            <p v-else-if="!llmRunning" class="llm-note">{{ llmMsg ?? '尚未產生自動對齊——按上面的按鈕執行。' }}</p>

            <h4 class="llm-h">使用的 skill：route-llm-align</h4>
            <details class="llm-skill">
              <summary>展開 SKILL.md 全文（模型執行時遵循的協定）</summary>
              <div class="skill-md llm-skill-md" v-html="llmSkillHtml || '<p>載入中…</p>'" />
            </details>

            <h4 class="llm-h">做法說明</h4>
            <ul class="llm-method">
              <li><b>LLM 判斷：</b>{{ METHOD_NOTES.autoAlign.llm }}</li>
              <li><b>程式負責：</b>{{ METHOD_NOTES.autoAlign.code }}</li>
            </ul>
            <p class="llm-method-sum">{{ METHOD_NOTES.autoAlign.sum }}</p>
          </div>
        </template>

        <!-- ============ LLM指定對齊（skill route-llm-align，寫 .prompt.json）=========
             自己的結果檔、run/串流/結果/toggle（與自動對齊獨立、UI 互不影響）。以主
             視圖目前顯示的佈局為起點；與自動對齊在主視圖互斥（套一個會取消另一個）。 -->
        <template v-else-if="activeTab === 'llm-prompt'">
          <div class="weight-panel">
            <p class="weight-hint">
              用**一句話指定**要怎麼對齊：例「優先把紅線拉成水平」「讓東側幾條線對齊
              同一欄」。**以主視圖目前顯示的佈局為起點**（若正顯示自動對齊，就從自動
              對齊結果往下做）。跑完先回傳、**不自動套用**——按「執行調整」才套到主視圖
              （與自動對齊互斥），下游各鏈跟著顯示重算。結果另存、與自動對齊 UI 互不影響。
            </p>
            <template v-if="llmCanRun">
              <label class="llm-model-pick">
                模型
                <select :value="llmModel" :disabled="promptRunning"
                  @change="emit('update:llm-model', $event.target.value)">
                  <option v-for="m in LLM_MODEL_OPTIONS" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
              </label>
              <p v-if="promptRecord?.userPrompt" class="llm-run-hint">上次指示：{{ promptRecord.userPrompt }}</p>
              <textarea
                v-model="llmUserPrompt"
                class="llm-prompt-box"
                rows="3"
                :disabled="promptRunning"
                placeholder="例：優先把紅線拉成水平；讓東側幾條線對齊同一欄；把環狀線盡量收成矩形…"
              />
              <button
                class="llm-run-btn"
                :disabled="promptRunning || !llmUserPrompt.trim()"
                @click="emit('run-prompt', llmUserPrompt.trim())"
              >{{ promptRunning ? '對齊中…' : (promptRecord ? '重新指定對齊' : '開始指定對齊') }}</button>
              <p class="llm-run-hint">你的指示會併入 route-llm-align、引導模型「移動哪些點、往哪對齊」，存到獨立的結果檔（跑完不自動套用）。</p>
            </template>
            <p v-else class="llm-run-hint">匯入資料沒有城市 id，無法對應結果檔——請用目錄裡的城市。</p>

            <template v-if="promptRunning">
              <h4 class="llm-h">LLM 回傳（即時串流）</h4>
              <pre ref="promptStreamEl" class="llm-pre eval-stream">{{ promptText || '等待模型回應…' }}</pre>
            </template>
            <p v-if="promptError" class="llm-run-hint eval-err">執行失敗：{{ promptError }}</p>

            <template v-if="promptRecord">
              <div class="info-rows">
                <div class="info-row"><span class="info-key">模型</span><span>{{ promptRecord.model ?? '—' }}</span></div>
                <div class="info-row"><span class="info-key">輪數</span><span>{{ promptRecord.rounds }}</span></div>
                <div class="info-row">
                  <span class="info-key">水平垂直</span>
                  <span>{{ promptRecord.hvBefore }} → {{ promptRecord.hvAfter }}／{{ promptRecord.segs }} 段</span>
                </div>
                <div class="info-row"><span class="info-key">移動</span><span>{{ promptRecord.moved }} 站</span></div>
              </div>
              <template v-if="(promptRecord.transcript ?? []).length">
                <h4 class="llm-h">LLM 回傳（逐輪）</h4>
                <div v-for="(t, i) in promptRecord.transcript" :key="i" class="llm-round">
                  <div class="llm-round-head">
                    {{ t.round ? `第 ${t.round} 輪` : '附註' }} · 提案 {{ t.proposed }} 點
                    · HV {{ t.hv }}<template v-if="t.rejected"> · 硬規則拒絕 {{ t.rejected }}</template>
                  </div>
                  <div class="llm-note">{{ t.note ?? '（無說明）' }}</div>
                </div>
              </template>
              <template v-if="promptRecord.finalOutput">
                <h4 class="llm-h">最終輸出</h4>
                <pre class="llm-pre">{{ promptRecord.finalOutput }}</pre>
              </template>

              <h4 class="llm-h">套用到 LLM 對齊主視圖</h4>
              <button class="llm-run-btn" @click="emit('toggle-prompt-exec')">{{ promptApplied ? '恢復原佈局' : '執行調整' }}</button>
              <p class="llm-run-hint">切換顯示（不跑 LLM、即時）——「執行調整」用指定對齊的座標重畫主視圖並讓下游各鏈以它重算（會取消自動對齊的套用），「恢復原佈局」切回。RWD 'llm' 版面固定以自動對齊為基準、不受此切換影響。</p>
            </template>
            <p v-else-if="!promptRunning" class="llm-note">{{ promptMsg ?? '尚未產生指定對齊——在上面輸入一句話執行。' }}</p>

            <h4 class="llm-h">使用的 skill：route-llm-align</h4>
            <details class="llm-skill">
              <summary>展開 SKILL.md 全文（模型執行時遵循的協定）</summary>
              <div class="skill-md llm-skill-md" v-html="llmSkillHtml || '<p>載入中…</p>'" />
            </details>

            <h4 class="llm-h">做法說明</h4>
            <ul class="llm-method">
              <li><b>LLM 判斷：</b>{{ METHOD_NOTES.promptAlign.llm }}</li>
              <li><b>程式負責：</b>{{ METHOD_NOTES.promptAlign.code }}</li>
            </ul>
            <p class="llm-method-sum">{{ METHOD_NOTES.promptAlign.sum }}</p>
          </div>
        </template>
      </div>
    </aside>
  </template>
</template>

<style scoped>
/* ---- 面板字級系統（使用者 2026-07：右側 tab 標題/內文字級與顏色要一致）----
   標題 15/700 前景、副標 12 灰、小節標題 11.5/600 灰、內文 12.5 前景、
   註記 11.5 灰、徽章 10.5、等寬 11。六個 tab 一律取用這組變數，不得自訂字級。 */
.style-panel {
  --sp-title: 15px;   /* 主標題（城市名/站名/路線名） */
  --sp-sub: 12px;     /* 副標（標題下第二行英文） */
  --sp-head: 11.5px;  /* 小節標題（section-title/llm-h/obj-pass-sub…） */
  --sp-body: 12.5px;  /* 內文（rows/表格/站表/按鈕/輸入） */
  --sp-note: 11.5px;  /* 註記/提示（hint/note） */
  --sp-badge: 10.5px; /* 小徽章（建設中/pass/站碼/日期） */
  --sp-mono: 11px;    /* 等寬（ref 碼/pre 區塊） */
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-height: 0;
  background: hsl(var(--card));
  border-left: 1px solid hsl(var(--border));
}
.rail {
  width: 44px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  background: hsl(var(--card));
  border-left: 1px solid hsl(var(--border));
}
.rail-icon { color: hsl(var(--muted-foreground)); }
.rail-label {
  writing-mode: vertical-rl;
  font-size: var(--sp-mono);
  color: hsl(var(--muted-foreground));
}

/* header tabs */
.tabs-header { padding: 4px 8px 0 8px; align-items: flex-end; }
.panel-tabs { display: flex; gap: 2px; }
.panel-tab {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 7px 10px 8px;
  font-size: var(--sp-body);
  color: hsl(var(--muted-foreground));
  border-bottom: 2px solid transparent;
  border-radius: calc(var(--radius) - 4px) calc(var(--radius) - 4px) 0 0;
  white-space: nowrap;
}
.panel-tab:hover { background: hsl(var(--accent) / 0.6); color: hsl(var(--foreground)); }
.panel-tab.active {
  color: hsl(var(--primary));
  font-weight: 600;
  border-bottom-color: hsl(var(--primary));
}

.style-body { flex: 1; overflow-y: auto; padding: 12px; }

/* Object tab: all properties of the clicked feature */
.obj-empty { color: hsl(var(--muted-foreground)); font-size: var(--sp-body); padding: 8px 2px; }
.obj-route-head {
  display: flex; align-items: center; gap: 6px;
  margin: 10px 0 4px; font-size: var(--sp-body); font-weight: 600; min-width: 0;
}
.obj-route-head:first-of-type { margin-top: 0; }
/* 收合切換：整條路線標題可點，caret 指示展開狀態 */
.obj-route-toggle {
  width: 100%; border: 0; background: none; cursor: pointer; text-align: left;
  padding: 2px 0; color: inherit; font: inherit; font-weight: 600;
  border-radius: 4px;
}
/* 資訊 tab 路線列（可展開整線站表）：沿用 line-row 版面、加按鈕重置 */
.line-row-toggle {
  width: 100%; border: 0; background: none; cursor: pointer; text-align: left;
  color: inherit; font: inherit; border-radius: 4px;
}
.line-row-toggle:hover { background: hsl(var(--muted) / 0.45); }
.line-row-toggle .obj-route-count { margin-left: auto; }
.obj-route-toggle:hover { background: hsl(var(--muted) / 0.45); }
.obj-route-caret { flex-shrink: 0; color: hsl(var(--muted-foreground)); font-size: 16px; /* 圖示字元（非文字階層） */ }
.obj-route-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.obj-route-count {
  margin-left: auto; flex-shrink: 0;
  font-weight: 400; font-size: var(--sp-badge); color: hsl(var(--muted-foreground));
}
/* 站序中的通過(不停)站：灰字 + pass 標記 */
.obj-station-list .st-pass { color: hsl(var(--muted-foreground)); }
/* 官方站碼（A1、BL12…）小徽章 */
.obj-st-code {
  display: inline-block; min-width: 22px; margin-right: 6px; padding: 0 4px;
  font-size: var(--sp-badge); font-weight: 600; text-align: center; border-radius: 3px;
  background: hsl(var(--muted) / 0.6); color: hsl(var(--muted-foreground));
}
.obj-pass-sub { margin: 8px 0 2px; font-size: var(--sp-head); font-weight: 600; color: hsl(var(--muted-foreground)); }
/* 行經（不停靠）路線 */
.obj-pass { margin: 6px 0 10px; }
.obj-pass-row {
  display: flex; align-items: center; gap: 6px;
  font-size: var(--sp-body); padding: 2px 0; min-width: 0;
}
.obj-pass-tag {
  margin-left: auto; flex-shrink: 0;
  font-size: var(--sp-badge); font-weight: 600; color: hsl(var(--muted-foreground));
  border: 1px solid hsl(var(--border)); border-radius: 999px; padding: 0 7px;
}
/* 物件標題（車站名 / 路線名，物件 tab 最上方） */
.obj-title {
  margin: 0 0 8px; font-size: var(--sp-title); font-weight: 700; line-height: 1.3;
  color: hsl(var(--foreground));
}
.obj-title-local {
  display: block; margin-top: 1px;
  font-size: var(--sp-sub); font-weight: 400; color: hsl(var(--muted-foreground));
}
/* 共站合併：異名轉乘站的各線站名 */
.obj-merged { margin: 6px 0 10px; }
.obj-merged-row {
  display: flex; align-items: center; gap: 6px;
  font-size: var(--sp-body); padding: 2px 0; min-width: 0;
}
.obj-merged-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.obj-merged-local { margin-left: 5px; font-size: var(--sp-note); color: hsl(var(--muted-foreground)); }
.obj-merged-line { margin-left: auto; color: #fff; flex-shrink: 0; }
.obj-merged-row .obj-merged-line + .obj-merged-line { margin-left: 4px; }
.obj-station-list {
  margin: 0 0 10px; padding-left: 26px; font-size: var(--sp-body); line-height: 1.7;
  color: hsl(var(--foreground));
}
.obj-station-list li::marker { color: hsl(var(--muted-foreground)); font-size: var(--sp-badge); }
/* LLM對齊 tab: run provenance */
.llm-h {
  margin: 14px 0 6px;
  font-size: var(--sp-head);
  font-weight: 600;
  color: hsl(var(--muted-foreground));
}
.llm-pre {
  font-size: var(--sp-mono);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  background: hsl(var(--muted) / 0.5);
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  padding: 8px 10px;
  max-height: 220px;
  overflow: auto;
}
.llm-round {
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  padding: 8px 10px;
  margin-bottom: 8px;
}
.llm-round-head {
  font-size: var(--sp-head);
  font-weight: 600;
  color: hsl(var(--muted-foreground));
  margin-bottom: 4px;
  font-variant-numeric: tabular-nums;
}
.llm-note { font-size: var(--sp-note); line-height: 1.6; color: hsl(var(--muted-foreground)); white-space: pre-wrap; }
/* LLM評價 tab：執行中串流／失敗訊息／評分列／逐線評語／建議清單 */
.eval-stream { max-height: 200px; }
.eval-err { color: hsl(var(--destructive)); }
.eval-score { margin-bottom: 6px; }
.eval-score-head {
  display: flex;
  justify-content: space-between;
  font-size: var(--sp-body);
  font-variant-numeric: tabular-nums;
}
.eval-line { margin-bottom: 6px; }
.eval-line-name { font-size: var(--sp-body); font-weight: 600; }
.eval-suggestions {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: var(--sp-note);
  line-height: 1.6;
  color: hsl(var(--muted-foreground));
}
.eval-suggestions li { margin-bottom: 4px; }
.llm-skill summary {
  cursor: pointer;
  font-size: var(--sp-note);
  color: hsl(var(--primary));
  user-select: none;
  margin-bottom: 6px;
}
.llm-skill summary:hover { text-decoration: underline; }
.llm-skill-md {
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  padding: 8px 12px;
  max-height: 320px;
  overflow: auto;
  font-size: var(--sp-body);
}
.llm-run-btn {
  width: 100%;
  height: 30px;
  margin-top: 16px;
  font-size: var(--sp-body);
  font-weight: 600;
  border: 1px solid hsl(var(--primary) / 0.55);
  border-radius: calc(var(--radius) - 2px);
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.12);
}
.llm-run-btn:hover:not(:disabled) { background: hsl(var(--primary) / 0.22); }
.llm-run-btn:disabled { opacity: 0.55; cursor: default; }
.llm-model-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: var(--sp-note);
  color: hsl(var(--muted-foreground));
}
.llm-model-pick select {
  flex: 1;
  height: 28px;
  padding: 0 6px;
  font-size: var(--sp-body);
  color: hsl(var(--foreground));
  background: hsl(var(--background));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
}
.llm-model-pick select:disabled { opacity: 0.55; }
.llm-run-hint { margin: 6px 0 0; font-size: var(--sp-note); color: hsl(var(--muted-foreground)); }
/* 做法說明：每個 LLM tab 最下面——哪些是 LLM 判斷、哪些用到程式 */
.llm-method {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: var(--sp-note);
  color: hsl(var(--muted-foreground));
  line-height: 1.55;
}
.llm-method li { margin: 2px 0; }
.llm-method b { color: hsl(var(--foreground)); font-weight: 600; }
.llm-method-sum {
  margin: 5px 0 0;
  font-size: var(--sp-note);
  color: hsl(var(--foreground));
  font-weight: 600;
}
.llm-prompt-box {
  width: 100%;
  margin-top: 4px;
  padding: 8px 10px;
  font-size: var(--sp-body);
  font-family: inherit;
  line-height: 1.5;
  color: hsl(var(--foreground));
  background: hsl(var(--background));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  resize: vertical;
  box-sizing: border-box;
}
.llm-prompt-box:focus { outline: none; border-color: hsl(var(--primary) / 0.6); }
.llm-prompt-box:disabled { opacity: 0.6; }

.obj-table { width: 100%; border-collapse: collapse; font-size: var(--sp-body); }
.obj-table tr { border-bottom: 1px solid hsl(var(--border)); }
.obj-key {
  text-align: left;
  vertical-align: top;
  padding: 5px 8px 5px 2px;
  font-weight: 600;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
.obj-val {
  padding: 5px 2px;
  word-break: break-word;
  white-space: pre-wrap;
  font-variant-numeric: tabular-nums;
}
.obj-li { padding: 1px 0; }
.obj-li + .obj-li { border-top: 1px dotted hsl(var(--border)); }
.layer-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
  min-width: 0;
}
.layer-name {
  font-size: var(--sp-body);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Info */
/* 權重 tab（RWD Maps 版面簡化控制）*/
.weight-panel { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
.weight-hint { font-size: var(--sp-note); color: hsl(var(--muted-foreground)); line-height: 1.6; }
.weight-modes { display: flex; flex-direction: column; gap: 4px; }
.weight-mode {
  text-align: left;
  padding: 7px 12px;
  font-size: var(--sp-body);
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  color: hsl(var(--foreground));
}
.weight-mode:hover { background: hsl(var(--accent)); }
.weight-mode.active { background: hsl(var(--primary) / 0.12); color: hsl(var(--primary)); border-color: hsl(var(--primary)); font-weight: 600; }
.weight-random {
  padding: 8px 12px;
  font-size: var(--sp-body);
  border: 1px solid hsl(var(--primary) / 0.5);
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--primary) / 0.1);
  color: hsl(var(--primary));
  font-weight: 500;
}
.weight-random:hover { background: hsl(var(--primary) / 0.2); }
.weight-auto.active {
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  border-color: hsl(var(--primary)); font-weight: 600;
}
.weight-auto.active:hover { background: hsl(var(--primary) / 0.9); }
.weight-hide-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px; }
.weight-hide-toggle { display: flex; align-items: center; gap: 6px; font-size: var(--sp-body); cursor: pointer; }
.weight-hide-px { display: flex; align-items: center; gap: 4px; font-size: var(--sp-body); color: hsl(var(--muted-foreground)); }
.weight-hide-px input {
  width: 46px; padding: 3px 5px; font-size: var(--sp-body); text-align: right;
  border: 1px solid hsl(var(--border)); border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--background)); color: hsl(var(--foreground));
}
.weight-stat { font-size: var(--sp-body); color: hsl(var(--muted-foreground)); padding: 0 2px; }
.weight-stat b { color: hsl(var(--foreground)); font-variant-numeric: tabular-nums; }
.hidden-list { padding: 2px; }
.hidden-list-title { font-size: var(--sp-head); font-weight: 600; color: hsl(var(--muted-foreground)); margin-bottom: 4px; }
.hidden-list-items {
  margin: 0; padding: 6px 8px 6px 26px; max-height: 160px; overflow-y: auto;
  border: 1px solid hsl(var(--border)); border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--muted) / 0.4); font-size: var(--sp-body); line-height: 1.6;
}
.hidden-list-items li { color: hsl(var(--foreground)); }
/* Info tab 城市標題（中英雙行）——與物件 tab 的 .obj-title 同級 */
.info-title { margin: 0 0 10px; }
.info-title-zh { font-size: var(--sp-title); font-weight: 700; line-height: 1.3; color: hsl(var(--foreground)); }
.info-title-en { margin-top: 1px; font-size: var(--sp-sub); font-weight: 400; color: hsl(var(--muted-foreground)); }
.info-rows { display: flex; flex-direction: column; gap: 2px; }
.info-row {
  display: flex;
  gap: 10px;
  padding: 4px 0;
  font-size: var(--sp-body);
  border-bottom: 1px solid hsl(var(--border) / 0.5);
}
.info-row:last-child { border-bottom: none; }
.info-key {
  width: 84px;
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
}
.info-row > span:not(.info-key), .info-row > a { min-width: 0; overflow-wrap: anywhere; }
.info-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: hsl(var(--primary));
  text-decoration: none;
}
.info-link:hover { text-decoration: underline; }
.info-empty { font-size: var(--sp-body); color: hsl(var(--muted-foreground)); padding: 8px 0; }

/* Audit */
.audit-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: calc(var(--radius) - 2px);
  font-size: var(--sp-body);
  font-weight: 600;
  margin-bottom: 8px;
}
.audit-banner.pass {
  background: hsl(142 71% 45% / 0.12);
  color: hsl(142 60% 40%);
}
.dark .audit-banner.pass { color: hsl(142 65% 55%); }
.audit-banner.fail {
  background: hsl(var(--destructive) / 0.12);
  color: hsl(var(--destructive));
}
.audit-date {
  margin-left: auto;
  font-weight: 400;
  font-size: var(--sp-badge);
  opacity: 0.75;
}
.audit-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.audit-item {
  display: flex;
  gap: 6px;
  font-size: var(--sp-note);
  line-height: 1.45;
  color: hsl(var(--foreground));
}
.audit-item.ok { color: hsl(var(--muted-foreground)); }
.audit-ic { flex-shrink: 0; margin-top: 2px; }
.audit-ic.ok { color: hsl(142 60% 42%); }
.audit-ic.warn { color: hsl(38 92% 50%); }
.audit-list.fail .audit-ic { color: hsl(var(--destructive)); }

.line-list { display: flex; flex-direction: column; gap: 2px; }
.line-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 2px;
  font-size: var(--sp-body);
  min-width: 0;
}
.line-swatch {
  width: 14px;
  height: 6px;
  border-radius: 3px;
  flex-shrink: 0;
}
.line-uc {
  font-size: var(--sp-badge);
  color: hsl(38 92% 40%);
  background: hsl(38 92% 50% / 0.15);
  border-radius: 4px;
  padding: 1px 5px;
  /* 緊跟線名（使用者 2026-07：「建設中要寫在路線名後面」）——原本 margin-left:auto
     會和站數的 auto margin 平分空隙、章浮在列中間；改小固定間距貼著名字。 */
  margin-left: 6px;
  flex: none;
}
.line-ref {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--sp-mono);
  color: hsl(var(--muted-foreground));
  background: hsl(var(--muted));
  border-radius: 4px;
  padding: 1px 5px;
  flex-shrink: 0;
  /* 固定最小寬＋置中：單字（G/R）與雙三字（LB/TML）ref 同寬，路線名才會對齊
     （使用者 2026-07：建設中章與線名沒對齊——根因是 ref 徽章寬度不一）。 */
  min-width: 34px;
  text-align: center;
  box-sizing: border-box;
}
.line-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Style */
.field { margin-bottom: 12px; flex: 1; min-width: 0; }
.check-field { display: flex; align-items: center; gap: 8px; font-size: var(--sp-body); cursor: pointer; }
.check-field input { accent-color: hsl(var(--primary)); }
.field-row { display: flex; gap: 10px; }
.bg-row { display: flex; align-items: center; gap: 8px; }
.color-input {
  width: 100%;
  height: 30px;
  padding: 2px;
  border: 1px solid hsl(var(--input));
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  cursor: pointer;
}
.skeleton-rules { font-size: var(--sp-body); line-height: 1.55; color: hsl(var(--foreground)); }
.skeleton-rules p { margin: 4px 0; }
.skeleton-rules .sk-sub { font-weight: 600; margin-top: 10px; color: hsl(var(--muted-foreground)); }
.skeleton-rules ul { list-style: none; margin: 4px 0; padding: 0; }
.skeleton-rules li { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
.sk-dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  border: 1.5px solid #3f3f46;
}
.sk-dot.sk-ring { background: #fff; }
.sk-line { width: 16px; height: 4px; border-radius: 2px; flex-shrink: 0; }
.sk-line.sk-plain { background: linear-gradient(90deg, #e11d48, #2563eb, #16a34a); }
.skeleton-rules .rose-note { margin-top: 10px; font-size: var(--sp-note); color: hsl(var(--muted-foreground)); }
.section-title {
  font-size: var(--sp-head);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: hsl(var(--muted-foreground));
  border-top: 1px solid hsl(var(--border));
  padding-top: 12px;
  margin: 12px 0 10px;
}
.rose-stats { margin-top: 10px; }
.rose-note {
  margin-top: 8px;
  font-size: var(--sp-note);
  line-height: 1.5;
  color: hsl(var(--muted-foreground));
}
.rose-note .rose-red { color: #e11d48; font-weight: 600; }

/* 設定 tab：顏色點間最大跨距 */
.settings-panel { display: flex; flex-direction: column; gap: 10px; }
.settings-panel .section-title { border-top: none; padding-top: 0; margin-top: 4px; }
.settings-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.settings-label { font-size: var(--sp-note); color: hsl(var(--muted-foreground)); }
.settings-num {
  width: 64px;
  padding: 5px 8px;
  font-size: 13px;
  /* 靠左：數字在左、原生上下箭頭在右，兩者不互相擋住 */
  text-align: left;
  color: hsl(var(--foreground));
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 4px);
}
.settings-num:focus { outline: 2px solid hsl(var(--ring)); outline-offset: -1px; }
.settings-unit { font-size: var(--sp-note); color: hsl(var(--muted-foreground)); }
.settings-recalc {
  margin-left: auto;
  padding: 5px 12px;
  font-size: 12px;
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.12);
  border: 1px solid hsl(var(--primary) / 0.5);
  border-radius: calc(var(--radius) - 4px);
  white-space: nowrap;
}
.settings-recalc:hover:not(:disabled) { background: hsl(var(--primary) / 0.22); }
.settings-recalc:disabled { opacity: 0.45; cursor: default; }
.settings-note { margin-top: 2px; }
</style>
