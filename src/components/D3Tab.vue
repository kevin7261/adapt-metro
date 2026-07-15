<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { geoMercator, geoPath } from 'd3-geo'
import { select, pointer } from 'd3-selection'
import { zoom, zoomIdentity } from 'd3-zoom'
import { useMapStore } from '../stores/mapStore'
import { assetUrl } from '../lib/assetUrl'
import { layerData, localizeStationNames } from '../stores/layerData'
import { computeOrientation } from '../stores/orientation'
import { buildConnectSkeleton } from '../stores/skeleton'
import { buildSchematicGrid, placeBlacks } from '../stores/schematicGrid'
import {
  buildHillClimb, compactGrid, buildHcGraph, buildEndpointStraighten,
  buildRectPolish, buildAxisAlign, buildAxisIlp, iteratePost, POST_ITER_CAP,
} from '../stores/hillClimb'
import { buildRwdMap, mergeParallelSegs } from '../stores/rwdMap'
import { randomWeights, weightedAxes, intervalAxes, linkWeight, uniformAxes, lerpAxes } from '../stores/rwdWeight'
import StylePanel from './StylePanel.vue'
import AttributeTable from './AttributeTable.vue'

// Dockview panel props: { params: { layerId }, api, containerApi }
const props = defineProps({ params: { type: Object, required: true } })

const store = useMapStore()
const layerId = props.params.params.layerId
const panelApi = props.params.api
const layer = computed(() => store.layers.find((l) => l.id === layerId) ?? null)

// A Hill Climbing view (layer group Hill Climbing) reuses this tab: its source
// is a Map Adjust (d3) layer whose 格網化後 layout it optimizes — the variant
// ('orig' | 'rot') picks which of the city's two grid-post layouts is the input.
// An RWD Maps view chains one step further: its source is a Hill Climbing layer
// whose 縮減網格 layout it redraws with strict H/V/45° polylines.
const isHC = computed(() => layer.value?.type === 'hillclimb')
const isRWD = computed(() => layer.value?.type === 'rwd')
const needsHC = computed(() => isHC.value || isRWD.value)
// The hillclimb layer in the chain: the layer itself (HC view) or its source (RWD).
const hcLayer = computed(() =>
  isHC.value ? layer.value
    : isRWD.value ? store.layers.find((l) => l.id === layer.value?.sourceLayerId) ?? null
      : null)
const hcVariant = computed(() => (hcLayer.value?.variant === 'rot' ? 'rot' : 'orig'))
const hcD3Layer = computed(() =>
  hcLayer.value ? store.layers.find((l) => l.id === hcLayer.value.sourceLayerId) ?? null : null)

// Metro layers currently in the panel — the loadable sources.
const metroLayers = computed(() => store.layers.filter((l) => l.type === 'metro'))
// The metro layer this view draws — Info/Style/Object and the attribute table
// are bound to it, exactly like the MapLibre tab. Hill Climbing / RWD views
// resolve through their d3 layer to that view's metro source.
const sourceLayer = computed(() => {
  const srcId = needsHC.value ? hcD3Layer.value?.sourceLayerId : layer.value?.sourceLayerId
  return metroLayers.value.find((l) => l.id === srcId) ?? null
})
// A file-imported view owns its data (stored under its own id in layerData);
// panels and styling then bind to the d3 layer itself instead of a source layer.
const ownData = computed(() => !!layerData[layerId])
const panelLayer = computed(() => {
  if (ownData.value) return layer.value
  if (needsHC.value && hcD3Layer.value && layerData[hcD3Layer.value.id]) return hcD3Layer.value
  return sourceLayer.value
})

const host = ref(null)      // container div
const svgEl = ref(null)     // <svg>
const gEl = ref(null)       // zoomable <g>
const tipEl = ref(null)     // hover tooltip
const loading = ref(false)
const loadError = ref(null)

// Left view-list rail width — draggable via the divider (canvas re-renders on
// resize through the ResizeObserver on host).
const viewNavWidth = ref(132)
const navDragging = ref(false)
function startNavResize(e) {
  e.preventDefault()
  navDragging.value = true
  const startX = e.clientX
  const startW = viewNavWidth.value
  // 拖到極限：上限＝容器寬 − 留給畫布的一小條；下限縮到很小；不設固定 90/300。
  const host = e.currentTarget?.parentElement
  const move = (ev) => {
    const maxW = host ? Math.max(90, host.clientWidth - 80) : 600
    viewNavWidth.value = Math.min(maxW, Math.max(40, startW + (ev.clientX - startX)))
  }
  const up = () => {
    navDragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// Suggested rotation (Boeing-style dominant-axis tilt, from the Info rose).
// `rotated` re-projects the whole map with projection.angle(tilt) — measured:
// a positive d3 angle turns the map counter-clockwise, which is exactly what
// cancels a clockwise (positive) tilt. fitExtent then refits the rotated map.
const tilt = ref(0)
// 4 view modes as tabs; rotated / skeletonized are derived from the mode.
// (See skill route-skeleton-connect for the skeleton — keeps the geographic
// shape, only classifies nodes/edges; nothing is moved.)
// Map Adjust view modes (tabs). Grid modes ('grid-*') do the schematic gridding
// (⑨, see skill route-skeleton-grid); the rest are original/rotated/skeleton.
// A Hill Climbing view chains: the grid-post input, the optimized layout
// ('hc', ②, see skill route-hillclimb), the 端點拉直 ('hc-end', endpoint-only
// H/V pass — the hc 縮減網格 compacts ITS output), three H/V-maximising
// post-passes (直角爬山/軸對齊/整數規劃) and the 縮減網格s — rotation comes
// from its variant.
const mode = ref(isRWD.value ? 'rwd' : isHC.value ? 'hc' : 'original')
// Modes that need the hill-climbing result ('rwd' builds on its 縮減網格).
const hcMode = computed(() =>
  ['hc', 'hc-rect', 'hc-align', 'hc-ilp', 'hc-llm',
    'hc-end', 'hc-rect-end', 'hc-align-end', 'hc-ilp-end', 'hc-llm-end',
    'hc-compact', 'hc-rect-compact', 'hc-align-compact', 'hc-ilp-compact', 'hc-llm-compact',
    'rwd', 'rwd-llm'].includes(mode.value))
// 第四種後處理「LLM 對齊」不在瀏覽器計算：由 Claude Code 依 skill
// route-llm-align 預先跑好、存在 data/metro/llmviews/<city>.<variant>.json，
// 這裡只載入＋fingerprint 驗證。llmInfo 驅動按鈕上的「n輪 · 模型名」badge。
const llmMode = computed(() => isHC.value && mode.value.startsWith('hc-llm'))
// RWD 也能建立在「LLM 對齊縮減」之上（layer.compact === 'llm'）→ 同樣走載檔案路徑。
const useLlm = computed(() => llmMode.value || (isRWD.value && layer.value?.compact === 'llm'))
const llmInfo = ref(null)  // { rounds, model } once loaded
const llmStats = ref(null) // the whole llmview file (stats + prompt + transcript)
const llmMsg = ref(null)   // hint when the result is missing / stale
// 按鈕觸發：POST 給 dev server 的 /llm-align/run（vite plugin 起 headless
// Claude Code 跑 route-llm-align skill），輪詢 /llm-align/status，每輪 apply
// 寫檔後畫面就跟著更新，跑完載入最終結果。GH Pages 上沒有 dev server → 報錯。
const llmRun = ref(null)     // null | 'running' | 'error'
const llmRunTail = ref('')   // short error tail
const llmRunText = ref('')   // live streamed assistant transcript (LLM 回傳文字)
const llmLogEl = ref(null)   // overlay <pre>, auto-scrolled to the newest text
let llmPollTimer = null
const llmCityId = computed(() => sourceLayer.value?.id ?? null)
async function startLlmRun(userPrompt = '') {
  const cid = llmCityId.value
  if (!cid || llmRun.value === 'running') return
  llmRun.value = 'running'
  llmRunTail.value = ''
  llmRunText.value = ''
  // 清掉舊的 LLM 對齊「地圖」——執行中畫布留白、蓋上執行中 overlay，跑完再
  // 重新載入新結果（做好之後才再出現）。面板/按鈕的狀態保留（顯示執行中）。
  cachedLlm = null
  delete cachedEndp.llm // LLM 對齊端點拉直 跟著舊結果一起作廢
  if (llmMode.value) render()
  try {
    const res = await fetch('/llm-align/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        city: cid, variant: hcVariant.value,
        userPrompt: typeof userPrompt === 'string' ? userPrompt : '',
      }),
    })
    if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`)
    pollLlmRun()
  } catch {
    llmRun.value = 'error'
    llmRunTail.value = '無法觸發——需要本機 npm run dev（vite）＋已安裝 Claude Code CLI'
  }
}
function pollLlmRun() {
  clearTimeout(llmPollTimer)
  llmPollTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/llm-align/status?city=${llmCityId.value}&variant=${hcVariant.value}`)
      const s = await res.json()
      llmRunTail.value = s.tail ?? ''
      if (s.text != null) {
        llmRunText.value = s.text
        // stick to the bottom so the newest reply is always visible
        requestAnimationFrame(() => {
          if (llmLogEl.value) llmLogEl.value.scrollTop = llmLogEl.value.scrollHeight
        })
      }
      if (s.running) {
        // still running — keep the map blank + overlay up, just refresh the log
        pollLlmRun()
      } else if (s.exit === 0) {
        cachedLlm = null // reload the finished result
        delete cachedEndp.llm
        llmRun.value = null
        render()
      } else {
        cachedLlm = null
        delete cachedEndp.llm
        llmRun.value = 'error'
        if (llmMode.value) render() // fall to the 開始 LLM 對齊 retry state
      }
    } catch {
      llmRun.value = 'error'
      llmRunTail.value = '狀態輪詢失敗'
    }
  }, 2500)
}
// ---- LLM 調整（RWD Maps「AI 改網格長寬」，skill route-llm-grid）----
// 與 LLM 對齊同一套離線模式：使用者的一句話 POST 給 /llm-grid/run（vite plugin
// spawn headless Claude Code），模型推理每個 X 欄／Y 列區間的顯示權重、存到
// data/metro/llmgrids/<city>.<variant>.<compact>.json，這裡只載入＋fingerprint
// 驗證，axes 由 intervalAxes 正規化進固定外框。不改任何格座標拓撲。
const gridInfo = ref(null)     // { model } once loaded — 顯示在 tab 按鈕 badge
const gridStats = ref(null)    // the whole llmgrid file（右側 LLM調整 面板）
const gridMsg = ref(null)      // hint when the result is missing / stale
const gridRun = ref(null)      // null | 'running' | 'error'
const gridRunTail = ref('')
const gridRunText = ref('')
const gridLogEl = ref(null)
const gridOverlayPrompt = ref('') // canvas overlay 的一句話輸入框
let gridPollTimer = null
let cachedGrid = null          // fetched llmgrid: { colW, rowW, stats } or { miss }
let rwdGridSeq = 0             // 載入序號，併進 RWD 快取鍵
// 新結果到達時的動畫：從舊區間權重（無則均勻）內插格線位置到新權重。
let rwdAnimGridFrom = null, rwdAnimGridTo = null, pendingGridAnim = null
// RWD 圖層蓋在哪個縮減網格上（llmgrid 檔名的第三段）。
const rwdCompactKey = computed(() => (useLlm.value ? 'llm' : postKind.value ?? 'hc'))
async function startGridRun(userPrompt = '') {
  const cid = llmCityId.value
  if (!cid || gridRun.value === 'running') return
  gridRun.value = 'running'
  gridRunTail.value = ''
  gridRunText.value = ''
  // 動畫起點快照：跑完從目前版面過渡到新版面（沒有舊結果就從均勻網格）。
  pendingGridAnim = { from: cachedGrid?.colW ? { colW: cachedGrid.colW, rowW: cachedGrid.rowW } : null }
  cachedGrid = null
  if (isRWD.value) mode.value = 'rwd-llm' // 從面板觸發時自動切到 LLM調整 視圖
  if (rwdLlmMode.value) render()
  try {
    const res = await fetch('/llm-grid/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        city: cid, variant: hcVariant.value, compact: rwdCompactKey.value,
        userPrompt: typeof userPrompt === 'string' ? userPrompt : '',
      }),
    })
    if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`)
    pollGridRun()
  } catch {
    gridRun.value = 'error'
    gridRunTail.value = '無法觸發——需要本機 npm run dev（vite）＋已安裝 Claude Code CLI'
  }
}
function pollGridRun() {
  clearTimeout(gridPollTimer)
  gridPollTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/llm-grid/status?city=${llmCityId.value}&variant=${hcVariant.value}&compact=${rwdCompactKey.value}`)
      const s = await res.json()
      gridRunTail.value = s.tail ?? ''
      if (s.text != null) {
        gridRunText.value = s.text
        requestAnimationFrame(() => {
          if (gridLogEl.value) gridLogEl.value.scrollTop = gridLogEl.value.scrollHeight
        })
      }
      if (s.running) {
        pollGridRun()
      } else if (s.exit === 0) {
        cachedGrid = null // reload the finished result（render 內載檔並啟動動畫）
        gridRun.value = null
        render()
      } else {
        cachedGrid = null
        pendingGridAnim = null
        gridRun.value = 'error'
        if (rwdLlmMode.value) render()
      }
    } catch {
      gridRun.value = 'error'
      gridRunTail.value = '狀態輪詢失敗'
    }
  }, 2500)
}
// The three H/V-maximising post-passes (short-distance moves of coloured
// vertices AFTER the hill climbing — see skill route-hillclimb): 直角爬山
// re-climbs with |sin 2θ|, 軸對齊 merges near-axis chains on median
// coordinates, 整數規劃 solves per-axis offset programs exactly. Each is
// iterated to a FIXED POINT (fed its own output until nothing moves, cap
// POST_ITER_CAP) and each also has its own 縮減網格 tab (compactGrid over
// that pass's layout). postIters drives the 「n/20」 badge on the tab button.
const postIters = ref({}) // kind -> iterations used (set once computed)
const iterBadge = (kind) =>
  (postIters.value[kind] ? ` ${postIters.value[kind]}/${POST_ITER_CAP}` : '')
const POST_KIND = {
  'hc-rect': 'rect', 'hc-align': 'align', 'hc-ilp': 'ilp',
  'hc-rect-compact': 'rect', 'hc-align-compact': 'align', 'hc-ilp-compact': 'ilp',
  'hc-rect-end': 'rect', 'hc-align-end': 'align', 'hc-ilp-end': 'ilp',
}
const POST_BUILD = { rect: buildRectPolish, align: buildAxisAlign, ilp: buildAxisIlp }
// 端點拉直區塊（左選單第 4 部份）：每條鏈一個 tab——在該鏈的結果「之上」再做
// 端點拉直（原 tab 不變）。'hc' 的結果同時是 hc 縮減網格／RWD 底圖的輸入。
const END_KIND = {
  'hc-end': 'hc', 'hc-rect-end': 'rect', 'hc-align-end': 'align',
  'hc-ilp-end': 'ilp', 'hc-llm-end': 'llm',
}
// RWD 視圖建立在某個「縮減網格」之上：其 layer.compact（'hc'|'rect'|'align'|'ilp'）決定
// 要不要先套後處理再縮減（'hc'/未設＝基本縮減）。使 RWD 能選任一縮減網格變體。
const postKind = computed(() =>
  isHC.value ? POST_KIND[mode.value] ?? null
    : isRWD.value && ['rect', 'align', 'ilp'].includes(layer.value?.compact) ? layer.value.compact
      : null)
// 縮減網格 (4 tabs): drop empty (colour-free) grid rows/columns from the
// hill-climbing layout or from one of the three post-pass layouts — smaller
// grid, identical topology (rank order preserved by compactGrid).
// RWD views sit on the HC compact grid in BOTH of their tabs.
const hcCompact = computed(() => mode.value.endsWith('compact') || isRWD.value)
// RWD 路網: redraw the compact layout with strict H/V/45° legs (rwdMap.js).
// 「LLM調整」（rwd-llm）畫的是同一套 RWD 路網，只是欄寬列高由 LLM 推理的
// 區間權重決定（skill route-llm-grid，結果檔 data/metro/llmgrids/）。
const rwdMode = computed(() => mode.value === 'rwd' || mode.value === 'rwd-llm')
const rwdLlmMode = computed(() => mode.value === 'rwd-llm')
const rotated = computed(() =>
  needsHC.value ? hcVariant.value === 'rot' : /(^rotated|-rot-)/.test(mode.value))
const skeletonized = computed(() => mode.value.includes('skeleton') || mode.value.startsWith('grid-'))
const gridMode = computed(() => needsHC.value || mode.value.startsWith('grid-'))
const gridPost = computed(() => needsHC.value || mode.value.endsWith('post'))
const canRotate = computed(() => Math.abs(tilt.value) >= 0.5)

// Heavy bits precomputed ONCE per dataset so switching tabs is instant: the
// dominant-axis tilt, the connect skeleton (topology, rotation-independent) and
// the hill-climbing cells (rank-based → extent-independent, pixels re-derived).
let cacheData = null
let cachedSkeleton = null
let cachedHC = null
let cachedPost = {}    // rect / align / ilp post-pass results, keyed by kind
let cachedFp = null    // 本資料的內容指紋（localStorage 快取鍵用）

// ---- 跨 reload 持久快取（localStorage）----
// 最貴的計算是爬山（buildHillClimb）＋後處理（iteratePost）。它們的輸出是純資料
// （cellAfter = Map<id,[c,r]>、stats = 數字），與畫布大小無關（rank-based），且對
// 一份資料＋變體是確定的 → 存下來、關 tab 再開或重新整理都直接載回、不重跑。
// 失效靠「資料內容指紋」：站/線一變指紋就變 → 自動 cache miss 重算，永不載到舊的。
// LLM 對齊視圖只為了做指紋比對而跑爬山，載回快取後連它也免重算。
const HC_LS_KEY = 'd3tab-hc-cache-v1'
const HC_LS_MAX = 12 // 最多保留幾個 (資料,變體) 佈局；超過刪最久沒用的
function dataFingerprint(data) {
  let h = 5381
  const add = (s) => { for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0 }
  for (const f of data.features) {
    if (f.geometry?.type === 'Point') add(`${f.properties.station_id}@${f.geometry.coordinates.join(',')}`)
    else for (const r of f.properties?.routes ?? []) add(`${r.route_id ?? ''}#${(r.stations ?? []).map((s) => s.station_id).join('.')}`)
  }
  return (h >>> 0).toString(36)
}
function hcLsRead() { try { return JSON.parse(localStorage.getItem(HC_LS_KEY) || '{}') } catch { return {} } }
function hcLsWrite(o) { try { localStorage.setItem(HC_LS_KEY, JSON.stringify(o)) } catch { /* quota / private mode → 靜默跳過 */ } }
const deCells = (arr) => new Map(arr.map(([id, c, r]) => [id, [c, r]]))
const serCells = (m) => [...m.entries()].map(([id, [c, r]]) => [id, c, r])
function loadHcCache(key) {
  try {
    const e = hcLsRead()[key]; if (!e) return null
    const posts = {}
    for (const k of Object.keys(e.posts ?? {})) posts[k] = { cellAfter: deCells(e.posts[k].cellAfter), stats: e.posts[k].stats }
    return { hc: { cellAfter: deCells(e.hc.cellAfter), stats: e.hc.stats }, posts }
  } catch { return null }
}
function saveHcCache(key, hc, posts) {
  if (!key || !hc) return
  const o = hcLsRead()
  const pj = {}
  for (const k of Object.keys(posts ?? {})) if (posts[k]) pj[k] = { cellAfter: serCells(posts[k].cellAfter), stats: posts[k].stats }
  o[key] = { t: hcLruClock++, hc: { cellAfter: serCells(hc.cellAfter), stats: hc.stats }, posts: pj }
  const keys = Object.keys(o)
  if (keys.length > HC_LS_MAX) {
    keys.sort((a, b) => (o[a].t ?? 0) - (o[b].t ?? 0))
    for (const k of keys.slice(0, keys.length - HC_LS_MAX)) delete o[k]
  }
  hcLsWrite(o)
}
let hcLruClock = Date.now() // 單調遞增的 LRU 時戳（避免 Date.now 在同毫秒重複）
let cachedLlm = null   // fetched llmview: { cells, stats } or { miss: hint }
let cachedCompact = {} // compactGrid results, keyed by 'hc'/'rect'/'align'/'ilp'/'llm'
let cachedEndp = {}    // 端點拉直 (iteratePost over buildEndpointStraighten)，keyed by 鏈 'hc'/'rect'/'align'/'ilp'/'llm'
let cachedRWD = null // virtual-canvas routing — isotropic rescale on resize
const hcBusy = ref(false)
const busyText = ref('')
const hcStats = ref(null)
const postStats = ref(null)      // { hvBefore, hvAfter, segs, moved, ... }
const hcCompactStats = ref(null) // { fromCols, fromRows, cols, rows }
const endpStats = ref(null)      // 端點拉直: { hvBefore, hvAfter, segs, moved, endpoints, iters, ... }
const rwdStats = ref(null)       // { straight, single, double, fallback, segs }
// ---- 權重驅動版面簡化（RWD Maps 左側「權重」tab，論文 §九）----
// weight 掛在 cut-to-cut 段上；'weight' 模式時 weight → 非均勻欄寬列高 → 在新像素座標
// 重跑 buildRwdMap。'uniform' = 均勻網格（預設）。全部隨機每按一次整表重抽。
const rwdWeightMode = ref('uniform') // 'uniform' | 'weight'
const rwdShowWeights = ref(true)     // 是否顯示 weight 數字（開關）
const rwdWeights = ref(new Map())    // segKey -> 1..9
let rwdWeightSeq = 0                  // 重抽計數，併進 RWD 快取鍵
let cachedSegs = null                 // 本資料的 cut-to-cut segs（供權重面板重抽）
// 自動隱藏白點（直通站）：站距 < 門檻(pt)才刪，逐級升高 weight 差門檻直到站距達標。
const rwdHideStops = ref(false)
const rwdMinStopPx = ref(5)
const rwdStopStat = ref(null) // { high, wide, hidden, hiddenNames, hiddenMaxT }
// 動畫狀態：weight 改變時不瞬跳，而是內插欄／列格線位置、每幀在新像素空間重算
// H/V/45°（fast 模式，見 rwdMap.js opts.fast 與 skill §8.3）。最後一幀走完整品質。
let rwdAnimActive = false, rwdAnimFrom = null, rwdAnimTo = null, rwdAnimT = 0, rwdAnimRaf = 0
const RWD_ANIM_MS = 700
// 共同的 rAF 迴圈：t 從 0 走到 1、每幀 render（fast 重畫），最後一幀完整品質。
// weight 動畫與 LLM 調整的網格動畫都走這裡；內插的對象由 render 依模式選。
function runRwdAnim(onDone) {
  rwdAnimActive = true
  rwdAnimT = 0
  if (rwdAnimRaf) cancelAnimationFrame(rwdAnimRaf)
  let start = null
  const step = (ts) => {
    if (start == null) start = ts
    rwdAnimT = Math.min(1, (ts - start) / RWD_ANIM_MS)
    render()
    if (rwdAnimT < 1) { rwdAnimRaf = requestAnimationFrame(step) }
    else { rwdAnimActive = false; rwdAnimRaf = 0; rwdWeightSeq++; cachedRWD = null; onDone?.(); render() } // 收尾：完整品質
  }
  rwdAnimRaf = requestAnimationFrame(step)
}
function animateToWeights(newWeights) {
  if (!cachedSegs) return
  // 起點幾何：目前顯示的是 weight 版面就從現有 weights，否則從均勻網格。
  rwdAnimFrom = (rwdWeightMode.value === 'weight' && rwdWeights.value.size) ? rwdWeights.value : null
  rwdAnimTo = newWeights
  rwdWeights.value = newWeights   // 數字立刻顯示目標權重
  rwdWeightMode.value = 'weight'  // 點要變化 → 非均勻版面
  runRwdAnim()
}
function regenRwdWeights() {
  if (!cachedSegs) return
  animateToWeights(randomWeights(cachedSegs))
}
function setRwdWeightMode(m) {
  if (rwdWeightMode.value === m) return
  if (m === 'weight') {
    animateToWeights(rwdWeights.value.size ? rwdWeights.value : randomWeights(cachedSegs)) // 均勻→加權：動畫過去
    return
  }
  rwdWeightMode.value = m // 回均勻：瞬時
  cachedRWD = null
  render()
}
// 每 5 秒自動整表重抽 weight，network 點跟著版面變形（動畫過渡，見 animateToWeights）。
const rwdAutoShuffle = ref(false)
let rwdAutoTimer = null
function setRwdAutoShuffle(on) {
  rwdAutoShuffle.value = on
  if (rwdAutoTimer) { clearInterval(rwdAutoTimer); rwdAutoTimer = null }
  if (on) {
    regenRwdWeights()
    rwdAutoTimer = setInterval(() => { if (rwdAutoShuffle.value) regenRwdWeights() }, 5000)
  }
}
function toggleRwdAutoShuffle() { setRwdAutoShuffle(!rwdAutoShuffle.value) }
function setRwdShowWeights(on) { rwdShowWeights.value = on; render() }
function setRwdHideStops(on) { rwdHideStops.value = on; cachedRWD = null; render() }
function setRwdMinStopPx(px) {
  const v = Math.max(1, Math.round(+px || 5))
  if (v === rwdMinStopPx.value) return
  rwdMinStopPx.value = v
  cachedRWD = null
  render()
}
const rotLabel = computed(() => `旋轉 ${Math.abs(tilt.value).toFixed(0)}°`)
const VIEW_TABS = computed(() => {
  if (isRWD.value) {
    return [
      { id: 'hc-compact', label: 'Hill Climbing縮減網格' },
      { id: 'rwd', label: 'RWD 路網' },
      // LLM 調整（AI 改網格長寬）: the badge carries the model that produced it
      { id: 'rwd-llm', label: `LLM調整${gridInfo.value ? ` · ${gridInfo.value.model}` : ''}` },
    ]
  }
  if (isHC.value) {
    // 左選單分 5 個部份：原始／Hill Climbing／直線演算法／端點拉直／縮減網格
    // （header 項只是分組標題、不可點）。
    return [
      { header: '原始' },
      { id: 'grid-post', label: hcVariant.value === 'rot' ? `${rotLabel.value}格網化後` : '原始格網化後' },
      { header: 'Hill Climbing' },
      { id: 'hc', label: 'Hill Climbing' },
      // iterated-to-fixed-point passes: the button carries 「已迭代/上限」
      { header: '直線演算法' },
      { id: 'hc-rect', label: `直角爬山${iterBadge('rect')}` },
      { id: 'hc-align', label: `軸對齊${iterBadge('align')}` },
      { id: 'hc-ilp', label: `整數規劃${iterBadge('ilp')}` },
      // 第四種（LLM）: the badge carries the rounds AND the model that produced it
      { id: 'hc-llm', label: `LLM 對齊${llmInfo.value ? ` ${llmInfo.value.rounds}輪 · ${llmInfo.value.model}` : ''}` },
      // 端點拉直：每條鏈一個 tab（在該鏈結果之上做端點拉直，原 tab 不變）；
      // hc 鏈：Hill Climbing → 端點拉直 → 縮減網格（hc 縮減網格壓縮拉直後的結果）
      { header: '端點拉直' },
      { id: 'hc-end', label: 'Hill Climbing端點拉直' },
      { id: 'hc-rect-end', label: '直角爬山端點拉直' },
      { id: 'hc-align-end', label: '軸對齊端點拉直' },
      { id: 'hc-ilp-end', label: '整數規劃端點拉直' },
      { id: 'hc-llm-end', label: 'LLM 對齊端點拉直' },
      { header: '縮減網格' },
      { id: 'hc-compact', label: 'Hill Climbing縮減網格' },
      { id: 'hc-rect-compact', label: '直角爬山縮減網格' },
      { id: 'hc-align-compact', label: '軸對齊縮減網格' },
      { id: 'hc-ilp-compact', label: '整數規劃縮減網格' },
      { id: 'hc-llm-compact', label: 'LLM 對齊縮減網格' },
    ]
  }
  return [
    { id: 'original', label: '原始' },
    { id: 'rotated', label: rotLabel.value, rot: true },
    { id: 'skeleton', label: '原始骨架化' },
    { id: 'rotated-skeleton', label: `${rotLabel.value}骨架化`, rot: true },
    { id: 'grid-orig-pre', label: '原始格網化前' },
    { id: 'grid-orig-post', label: '原始格網化後' },
    { id: 'grid-rot-pre', label: `${rotLabel.value}格網化前`, rot: true },
    { id: 'grid-rot-post', label: `${rotLabel.value}格網化後`, rot: true },
  ]
})
const disposables = []
let zoomBehavior = null
let resizeObs = null
let zk = 1 // current zoom scale — mark sizes are divided by it so they stay constant

// Keep dot radius and label size constant on zoom (strokes use non-scaling-stroke
// via CSS; only geometric sizes need counter-scaling by the zoom factor k).
function applyZoomSizing(k) {
  zk = k
  const g = select(gEl.value)
  const r0 = panelLayer.value?.radius ?? 4
  g.selectAll('circle.station').attr('r', r0 / k)
  g.selectAll('circle.ref-foot').attr('r', 2 / k)
  g.selectAll('text.st-label')
    .style('font-size', `${9 / k}px`)
    .attr('y', (d) => d.y - (r0 + 3) / k)
}

// Same station-role colouring as the MapLibre tab's STATION_COLOR: interchange
// red, terminus blue, else white. 用 is_interchange（正式拓撲轉乘：degree>2 或 ≥2
// 線在此終止），不用 lines>1——後者把多線共軌的中途站（非轉乘）也誤判成紅（NYC 尤甚）。
function stationColor(p) {
  if (p.is_interchange) return '#e11d48'
  if (p.is_terminus) return '#2563eb'
  return '#ffffff'
}

async function sourceData() {
  // File-imported view: its own GeoJSON lives under this layer's id.
  if (layerData[layerId]) return layerData[layerId]
  if (needsHC.value) {
    // Hill Climbing / RWD → (HC layer →) Map Adjust layer → its data (own or metro).
    if (isRWD.value && !hcLayer.value) {
      if (layer.value?.sourceLayerId) loadError.value = '來源 Hill Climbing 圖層已被移除，請重新選擇'
      return null
    }
    const d3l = hcD3Layer.value
    if (!d3l) {
      if (hcLayer.value?.sourceLayerId) loadError.value = '來源 Map Adjust 圖層已被移除，請重新選擇'
      return null
    }
    if (layerData[d3l.id]) return layerData[d3l.id]
  }
  const src = sourceLayer.value
  if (!src) {
    // A dangling reference (source layer was removed) — say so instead of a blank canvas.
    if (layer.value?.sourceLayerId) loadError.value = '來源圖層已被移除，請重新選擇'
    return null
  }
  if (layerData[src.id]) return layerData[src.id]
  loading.value = true
  try {
    const res = await fetch(src.file)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = localizeStationNames(await res.json())
    layerData[src.id] = data
    return data
  } catch (err) {
    loadError.value = `無法載入 ${src.file}（${err.message}）`
    return null
  } finally {
    loading.value = false
  }
}

// (Re)draw the chosen metro layer with d3: mercator projection fit to the
// container, lines coloured per route, stations as role-coloured circles.
// render() is async (data fetch + HC busy-hint delay) and gets re-triggered
// while in flight (mount + ResizeObserver, mode switches) — without a guard
// both passes would append and everything is drawn twice. Each render takes a
// sequence number and bails after every await if a newer render has started.
let renderSeq = 0
async function render() {
  const svg = svgEl.value, g = gEl.value, el = host.value
  if (!svg || !g || !el) return
  const seq = ++renderSeq
  const sel = select(g)
  sel.selectAll('*').remove()
  loadError.value = null
  llmMsg.value = null
  gridMsg.value = null

  const data = await sourceData()
  if (seq !== renderSeq) return // superseded — the newer render draws
  if (!data) return

  const w = el.clientWidth || 600
  const h = el.clientHeight || 400
  const stations = data.features.filter((f) => f.geometry.type === 'Point')
  const lineFeats = data.features.filter((f) => f.geometry.type !== 'Point')

  // Precompute tilt + skeleton once per dataset (rotation-independent), so the
  // four view tabs only re-draw (fast) — never recompute — when switched.
  if (data !== cacheData) {
    cacheData = data
    tilt.value = computeOrientation(data).tilt
    cachedSkeleton = buildConnectSkeleton(data)
    cachedHC = null
    cachedPost = {}
    cachedLlm = null
    cachedGrid = null
    cachedCompact = {}
    cachedEndp = {}
    cachedRWD = null
    hcStats.value = null
    postStats.value = null
    postIters.value = {}
    llmInfo.value = null
    llmStats.value = null
    gridInfo.value = null
    gridStats.value = null
    hcCompactStats.value = null
    endpStats.value = null
    rwdStats.value = null
    // 跨 reload 快取：先算內容指紋，試著從 localStorage 載回本資料的 HC / 後處理 cells，
    // 命中就免跑爬山（資料變 → 指紋變 → 不命中 → 下面重算並覆寫）。
    cachedFp = dataFingerprint(data)
    const hit = loadHcCache(`${cachedFp}:${hcVariant.value}`)
    if (hit) { cachedHC = hit.hc; cachedPost = hit.posts }
  }

  const projection = geoMercator()
    .angle(rotated.value ? tilt.value : 0)
    .fitExtent(
      [[24, 24], [w - 24, h - 24]],
      { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : data.features },
    )
  const path = geoPath(projection)
  const P = (c) => projection(c)
  // coord → station id, so a line feature's vertices can be re-placed onto the
  // grid (格網化後 draws the SAME features as 格網化前, only snapped to cells).
  const coordKey = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`
  const coordId = new Map()
  for (const f of stations) coordId.set(coordKey(f.geometry.coordinates), f.properties.station_id)

  // Skeleton is the basis for both skeleton and grid views. Grid views override
  // each station's position: grid-pre = original projected, grid-post = snapped.
  const sk = (skeletonized.value || gridMode.value) ? cachedSkeleton : null
  const projById = new Map(stations.map((f) => [f.properties.station_id, P(f.geometry.coordinates)]))
  // Synthetic crossing (yellow) nodes are not real stations — feed their coords
  // to the grid + edge drawing so split edges and gridding resolve them.
  for (const c of sk?.crossings ?? []) projById.set(c.id, P(c.coord))
  const grid = gridMode.value ? buildSchematicGrid(cachedSkeleton, projById, [24, 24, w - 24, h - 24]) : null
  // Hill Climbing (②, see skill route-hillclimb): optimize the grid CELLS once
  // per dataset — cells are rank-based, so a resize only changes the pixel
  // mapping below, never the layout. Blacks are re-spread along the new runs.
  // 縮減網格 tab additionally drops colour-free rows/columns (compactGrid) —
  // fewer cells over the same extent, so everything spreads out.
  let hcPos = null, hcBlue = null, rwdLines = null, weighted = false
  if (grid && needsHC.value && hcMode.value) {
    if (!cachedHC) {
      hcBusy.value = true
      busyText.value = '爬山最佳化中…（多準則適應度 + 硬規則掃描）'
      await new Promise((r) => setTimeout(r, 30)) // let the busy hint paint first
      if (seq !== renderSeq) { hcBusy.value = false; return } // superseded
      cachedHC = buildHillClimb(cachedSkeleton, grid.cellOf, grid.cols, grid.rows)
      hcBusy.value = false
      saveHcCache(`${cachedFp}:${hcVariant.value}`, cachedHC, cachedPost) // 存下爬山結果，下次載檔免重算
    }
    hcStats.value = cachedHC.stats
    let cells = cachedHC.cellAfter, nC = grid.cols, nR = grid.rows
    // H/V-maximising post-pass tabs: same grid, short-distance vertex moves on
    // top of the hill-climbing result (each kind cached once per dataset).
    if (postKind.value) {
      const kind = postKind.value
      if (!cachedPost[kind]) {
        hcBusy.value = true
        busyText.value = { rect: '直角爬山中…（|sin 2θ| 短半徑再爬，迭代到不動）',
          align: '軸對齊中…（群組合併 + 中位數座標，迭代到不動）',
          ilp: '整數規劃中…（逐軸樹 DP 精確解，迭代到不動）' }[kind]
        await new Promise((r) => setTimeout(r, 30))
        if (seq !== renderSeq) { hcBusy.value = false; return } // superseded
        cachedPost[kind] = iteratePost(POST_BUILD[kind], cachedSkeleton, cachedHC.cellAfter, grid.cols, grid.rows)
        hcBusy.value = false
        saveHcCache(`${cachedFp}:${hcVariant.value}`, cachedHC, cachedPost) // 併入後處理結果一起存
      }
      postStats.value = cachedPost[kind].stats
      postIters.value = { ...postIters.value, [kind]: cachedPost[kind].stats.iters }
      cells = cachedPost[kind].cellAfter
    }
    // 第四種「LLM 對齊」: precomputed offline (skill route-llm-align) — fetch
    // the llmview for this city+variant and verify it matches THIS dataset's
    // HC result (fingerprint), otherwise explain how to (re)generate it.
    if (useLlm.value) {
      // 執行中：不畫任何佈局，canvas 留白給執行中 overlay 蓋上（已在 render
      // 開頭 remove 全部節點），跑完 poll 會清 cachedLlm 再 render 出新結果。
      if (llmRun.value === 'running') return
      if (!cachedLlm) {
        const cid = sourceLayer.value?.id
        cachedLlm = { miss: '匯入資料不支援 LLM 對齊（沒有城市 id 可對應結果檔）' }
        if (cid) {
          try {
            const res = await fetch(assetUrl(`data/metro/llmviews/${cid}.${hcVariant.value}.json`))
            const isJson = (res.headers.get('content-type') ?? '').includes('json')
            const j = res.ok && isJson ? await res.json() : null
            if (!j) {
              cachedLlm = { miss: `尚未產生 LLM 對齊——請在 Claude Code 對 ${cid}（${hcVariant.value}）跑 route-llm-align skill` }
            } else if (j.fingerprint?.verts !== cachedHC.stats.verts
              || j.fingerprint?.segs !== cachedHC.stats.segs
              || j.fingerprint?.cols !== grid.cols || j.fingerprint?.rows !== grid.rows
              || j.fingerprint?.hvStart !== cachedHC.stats.hvAfter) {
              cachedLlm = { miss: 'LLM 對齊結果與目前資料不符（資料已更新）——請重新產生' }
            } else {
              cachedLlm = { cells: new Map(j.cellAfter.map(([id, c, r]) => [id, [c, r]])), stats: j }
            }
          } catch { cachedLlm = { miss: '無法載入 LLM 對齊結果' } }
        }
        if (seq !== renderSeq) return // superseded during fetch
      }
      if (!cachedLlm.cells) {
        llmMsg.value = cachedLlm.miss
        return // nothing to draw — the hint overlay explains why
      }
      cells = cachedLlm.cells
      llmStats.value = cachedLlm.stats
      llmInfo.value = { rounds: cachedLlm.stats.rounds, model: cachedLlm.stats.model }
    }
    // 端點拉直區塊: endpoint straighten ON TOP of the current chain's result
    // (原 tab 不動)。每個非白點可把一個座標吸到某鄰居的欄/列，僅淨增 H/V 才動，
    // 走同一套硬規則、迭代到不動點。'hc' 的拉直結果同時餵 hc 縮減網格／RWD 底圖
    // （hc 鏈 = HC → 端點拉直 → 縮減網格）；rect/align/ilp/llm 的縮減網格仍壓縮
    // 各自的原結果。
    {
      const endKind = END_KIND[mode.value]
        ?? (hcCompact.value && rwdCompactKey.value === 'hc' ? 'hc' : null)
      if (endKind) {
        if (!cachedEndp[endKind]) cachedEndp[endKind] = iteratePost(buildEndpointStraighten, cachedSkeleton, cells, nC, nR)
        cells = cachedEndp[endKind].cellAfter
        endpStats.value = cachedEndp[endKind].stats
      }
    }
    if (hcCompact.value) {
      // compacts the CURRENT layout: the HC result, or the post-pass/LLM one
      // when this is one of the 縮減 tabs (cells already swapped above).
      const ckey = rwdCompactKey.value
      if (!cachedCompact[ckey]) cachedCompact[ckey] = compactGrid(cells, grid.cols, grid.rows)
      cells = cachedCompact[ckey].cellAfter
      nC = cachedCompact[ckey].cols
      nR = cachedCompact[ckey].rows
      hcCompactStats.value = { fromCols: grid.cols, fromRows: grid.rows, cols: nC, rows: nR }
    }
    const cw = (w - 48) / nC, ch = (h - 48) / nR
    const area = [24, 24, w - 24, h - 24]
    // 權重驅動版面：'weight' 模式時 weight → 非均勻欄寬列高（weightedAxes）；否則均勻。
    // 動畫中（rwdAnimActive）：內插「起點 axes → 目標 axes」的格線位置，每幀重算。
    // 動畫幀不重算 buildHcGraph（骨架／格不變）——省每幀成本，cachedSegs 沿用。
    // 平行邊（共用同兩端點的快車直達＋普通車 coline）收成一條交錯線，見 mergeParallelSegs。
    if (isRWD.value && !(rwdAnimActive && cachedSegs)) cachedSegs = mergeParallelSegs(buildHcGraph(cachedSkeleton, grid.cellOf).segs)
    // 「LLM調整」（rwd-llm）：欄寬列高不看流量 weight，改用 LLM 推理的區間權重
    // （llmgrids 結果檔）——先載入＋fingerprint 驗證，沒有結果就留白給 overlay。
    let gridAniming = false
    if (rwdLlmMode.value) {
      if (gridRun.value === 'running') return // 執行中：畫布留白、overlay 蓋上
      if (!cachedGrid) {
        const cid = sourceLayer.value?.id
        cachedGrid = { miss: '匯入資料不支援 LLM 調整（沒有城市 id 可對應結果檔）' }
        if (cid) {
          try {
            const res = await fetch(assetUrl(`data/metro/llmgrids/${cid}.${hcVariant.value}.${rwdCompactKey.value}.json`))
            const isJson = (res.headers.get('content-type') ?? '').includes('json')
            const j = res.ok && isJson ? await res.json() : null
            if (!j) {
              cachedGrid = { miss: '尚未產生 LLM 調整——輸入一句話（例：把市中心那幾欄拉開），讓模型推理每欄／列該佔多大' }
            } else if (j.fingerprint?.verts !== cachedHC.stats.verts
              || j.fingerprint?.segs !== cachedHC.stats.segs
              || j.fingerprint?.cols !== nC || j.fingerprint?.rows !== nR) {
              cachedGrid = { miss: 'LLM 調整結果與目前資料不符（資料已更新）——請重新產生' }
            } else {
              cachedGrid = { colW: j.colW, rowW: j.rowW, stats: j }
              rwdGridSeq++
            }
          } catch { cachedGrid = { miss: '無法載入 LLM 調整結果' } }
        }
        if (seq !== renderSeq) return // superseded during fetch
      }
      if (!cachedGrid.colW) {
        gridMsg.value = cachedGrid.miss
        pendingGridAnim = null
        return // nothing to draw — the hint overlay explains why
      }
      gridStats.value = cachedGrid.stats
      gridInfo.value = { model: cachedGrid.stats.model }
      // 剛跑完的新結果：從舊版面（無則均勻）動畫過渡到新區間權重。
      if (pendingGridAnim) {
        rwdAnimGridFrom = pendingGridAnim.from
        rwdAnimGridTo = { colW: cachedGrid.colW, rowW: cachedGrid.rowW }
        pendingGridAnim = null
        runRwdAnim(() => { rwdAnimGridFrom = null; rwdAnimGridTo = null })
      }
      gridAniming = rwdAnimActive && !!rwdAnimGridTo
    }
    // rwdAnimTo 必須存在（grid 動畫共用同一個 rAF 迴圈，途中切 tab 時這裡不能誤入）。
    const animing = !rwdLlmMode.value && rwdAnimActive && isRWD.value && !!cachedSegs && !!rwdAnimTo
    weighted = !rwdLlmMode.value
      && (animing || (isRWD.value && rwdWeightMode.value === 'weight' && rwdWeights.value.size > 0))
    let axes = null
    if (rwdLlmMode.value) {
      // 區間權重 → 格線位置（外框固定、minFrac 保底）；動畫中內插兩組格線。
      const toAx = intervalAxes(
        (gridAniming ? rwdAnimGridTo : cachedGrid).colW,
        (gridAniming ? rwdAnimGridTo : cachedGrid).rowW, area)
      if (gridAniming) {
        const fromAx = rwdAnimGridFrom
          ? intervalAxes(rwdAnimGridFrom.colW, rwdAnimGridFrom.rowW, area)
          : uniformAxes(nC, nR, area)
        axes = lerpAxes(fromAx, toAx, rwdAnimT)
      } else axes = toAx
    } else if (animing) {
      const toAx = weightedAxes(cells, cachedSegs, rwdAnimTo, nC, nR, area)
      const fromAx = rwdAnimFrom && rwdAnimFrom.size
        ? weightedAxes(cells, cachedSegs, rwdAnimFrom, nC, nR, area)
        : uniformAxes(nC, nR, area)
      axes = lerpAxes(fromAx, toAx, rwdAnimT)
    } else if (weighted) {
      axes = weightedAxes(cells, cachedSegs, rwdWeights.value, nC, nR, area)
    }
    const cellPx = axes ? axes.cellPx : ([c, r]) => [24 + (c + 0.5) * cw, 24 + (r + 0.5) * ch]
    if (rwdMode.value) {
      // RWD 路網: 八方向約束以「版面 pixel」為準 — the map follows the panel shape
      // (隨板面變形), so the polylines are rebuilt in the CURRENT canvas pixel
      // space whenever the size changes (with cw ≠ ch a cell-space 45° is not
      // 45° on screen). Same-size renders reuse the cached result. The interior
      // blacks already sit ON the polylines (no placeBlacks here).
      const sizeKey = `${w}x${h}|${gridAniming ? `ga${rwdAnimT.toFixed(3)}`
        : rwdLlmMode.value ? `g${rwdGridSeq}`
        : animing ? `a${rwdAnimT.toFixed(3)}` : weighted ? `w${rwdWeightSeq}` : 'u'}`
      if (!cachedRWD || cachedRWD.key !== sizeKey) {
        if (!animing && !gridAniming) {
          hcBusy.value = true
          busyText.value = 'RWD 路網畫線中…（H/V/45° 候選折線）'
          await new Promise((r) => setTimeout(r, 30))
          if (seq !== renderSeq) { hcBusy.value = false; return } // superseded
        }
        const pxPos = new Map()
        for (const [id, p] of cells) pxPos.set(id, cellPx(p))
        cachedRWD = {
          key: sizeKey,
          // 非均勻格的半格 A* lattice 尚未做（見 skill）——權重／動畫不傳 lattice，衝突走
          // 候選＋兜底；動畫幀再加 fast（略過多輪衝突消解，換每幀夠快）；均勻格照舊帶 lattice。
          ...buildRwdMap(cachedSegs, pxPos, {
            unit: Math.min(cw, ch),
            // 自動隱藏白點：站距 < 門檻才刪，逐級升高 weight 差門檻（見 rwdMap.js）。
            hideStops: rwdHideStops.value,
            minStopPx: rwdMinStopPx.value,
            linkWeight: (u, v) => linkWeight(rwdWeights.value, u, v),
            ...((animing || gridAniming) ? { fast: true }
              : (weighted || rwdLlmMode.value) ? {}
                : { lattice: { x0: 24, y0: 24, sx: cw / 2, sy: ch / 2, nx: nC * 2 + 1, ny: nR * 2 + 1 } }),
          }),
        }
        hcBusy.value = false
      }
      rwdStats.value = cachedRWD.stats
      hcPos = new Map(cachedRWD.posAfter)
      rwdLines = cachedRWD.lines.map((L) => ({ ...L, px: L.pts }))
      hcBlue = axes
        ? { xs: axes.colX, ys: axes.rowY }
        : {
          xs: Array.from({ length: nC + 1 }, (_, i) => 24 + i * cw),
          ys: Array.from({ length: nR + 1 }, (_, i) => 24 + i * ch),
        }
    } else {
      hcPos = new Map()
      for (const [id, p] of cells) hcPos.set(id, cellPx(p))
      placeBlacks(cachedSkeleton, hcPos, (id) => grid.posAfter.get(id) ?? null)
      hcBlue = {
        xs: Array.from({ length: nC + 1 }, (_, i) => 24 + i * cw),
        ys: Array.from({ length: nR + 1 }, (_, i) => 24 + i * ch),
      }
    }
  }
  const posOf = (id) =>
    (hcPos && hcPos.get(id)) || (grid && gridPost.value && grid.posAfter.get(id)) || projById.get(id)
  const MAX_OVERLAP = 6, DASH = 5 // overlap interleaved-dash pattern (screen px)
  // 'black' = untouched through station → keep the normal white fill; only the
  // specially-marked nodes get a colour. All keep the dark border (set below).
  const NODE_COLOR = { red: '#e11d48', blue: '#2563eb', black: '#ffffff', purple: '#a855f7', pink: '#ec4899', gray: '#9ca3af', yellow: '#eab308' }
  // Edge-class colours are drawn as a BOTTOM HIGHLIGHT (underlay) — NOT the line
  // colour. The line itself is always the original metro-map rendering.
  const EDGE_HL = { coline: '#e11d48', loop: '#16a34a', parallel: '#2563eb' }
  const EDGE_LABEL = { coline: '共線合併', loop: '環線', parallel: '頭尾共點', plain: '一般' }

  // Route details by id (from the source metro GeoJSON) so skeleton / grid / HC /
  // RWD edges can show the SAME route list as the Metro Maps (MapLibre) hover —
  // the view-specific edge info (class / bend count) is then appended below it.
  const routeById = new Map()
  for (const f of lineFeats) {
    for (const r of (f.properties.routes ?? [f.properties])) {
      if (r?.route_id && !routeById.has(r.route_id)) routeById.set(r.route_id, r)
    }
  }
  const routesHtml = (ids) => ids.map((id) => {
    const r = routeById.get(id)
    if (!r) return null
    const local = r.route_name_local && r.route_name_local !== r.route_name ? `（${r.route_name_local}）` : ''
    return `<span style="color:${r.route_color ?? '#e11d48'}">▬</span> `
      + `<strong>${r.route_ref ? `[${r.route_ref}] ` : ''}${r.route_name ?? '—'}</strong>${local}`
  }).filter(Boolean).join('<br/>')

  let lineData, stationData, highlightData = []
  if (sk) {
    const edgeD = (pathIds) => pathIds
      .map((id, i) => { const [x, y] = posOf(id); return `${i ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}` })
      .join(' ')
    // 線的顏色一律照原始 Metro Maps：單色 route → 實線原色；共線（≥2 相異色）→ 交錯
    // 彩色虛線（dasharray）。格網化後/HC/RWD 的線都經此，確保共線顯示與原始同樣的多色，
    // 不是併成單色（使用者要「色彩跟原來一樣」）。「共線變一條線」＝一條折線帶多色，
    // 不是變單色。
    const strokesOf = (e, d, html) => {
      const cols = (e.routeColors ?? []).slice(0, MAX_OVERLAP)
      if (new Set(cols).size >= 2) {
        const n = cols.length
        return cols.map((c, i) => ({ d, stroke: c, html, dash: `0 ${i * DASH} ${DASH} ${(n - 1 - i) * DASH}` }))
      }
      return [{ d, stroke: cols[0] ?? e.color ?? '#e11d48', html }]
    }
    if (rwdLines) {
      // RWD 路網: one polyline per cut-to-cut segment (H/V/45° legs), coloured
      // like its parent skeleton edge; the tooltip reports the bend count.
      const ptsD = (px) => px
        .map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`)
        .join(' ')
      lineData = rwdLines.flatMap((L) => {
        const e = L.seg.edge
        // Metro Maps route list first, then this view's routing detail below.
        const edgeInfo = `${EDGE_LABEL[e.cls]} · `
          + (L.fallback ? '兜底直線（非 H/V/45°）' : `轉折 ${L.bends}`)
          + (L.routed ? ' · A* 繞行（避開交叉）' : '')
          + (L.forced ? '<br/><span style="color:#f59e0b">殘留衝突：連 A* 繞行也找不到無交叉路徑</span>' : '')
        const routes = routesHtml([...e.routes])
        const html = (routes ? `${routes}<hr class="tip-sep"/>` : '') + edgeInfo
        return strokesOf(e, ptsD(L.px), html)
      })
      // Residual-conflict segments glow amber so leftover crossings explain
      // themselves; otherwise the usual edge-class underlay.
      highlightData = rwdLines
        .filter((L) => L.forced || EDGE_HL[L.seg.edge.cls])
        .map((L) => ({ d: ptsD(L.px), color: L.forced ? '#f59e0b' : EDGE_HL[L.seg.edge.cls] }))
    } else if (!hcPos && !(grid && gridPost.value)) {
      // 節點仍在**地理座標**（純骨架 `skeleton`，或**格網化前** `grid-*-pre`——後者只是
      // 疊上目標格線、節點還沒搬）→ 線一律照原始 feature 幾何 `path(f)` 畫，**與原始
      // 地圖一模一樣**（單線實色、共線＝交錯彩色虛線）。為何不用車站點的拓撲邊 edgeD：
      // 資料的線幾何含非車站折點（特快跳站段仍沿真實走廊彎，如 Sydney North Shore &
      // Western 快車段有 11 個折點），edgeD 只連相鄰「停靠站」會把跳站段拉成橫越空白的
      // 長直線。共線本來就是一筆 feature（route_count≥2）→ 一條線。hover 用 props（與
      // Metro Maps 相同）；節點分類色 + 邊分類襯底疊上。只有**格網化後/HC**（座標真的
      // 被搬到格子上）才改用 edgeD（見下方 else）。
      lineData = lineFeats.flatMap((f) => {
        const d = path(f)
        const cols = (f.properties.route_colors ?? []).slice(0, MAX_OVERLAP)
        if (new Set(cols).size >= 2) {
          const n = cols.length
          return cols.map((color, i) => ({
            d, stroke: color, props: f.properties,
            dash: `0 ${i * DASH} ${DASH} ${(n - 1 - i) * DASH}`,
          }))
        }
        return [{ d, stroke: cols[0] ?? '#e11d48', props: f.properties }]
      })
      // 邊分類襯底（線底下的 highlight）：沿骨架邊的**真實折線幾何 e.geom** 畫一條較寬
      // 半透明底色線（共線紅底 / 環線綠 / 頭尾共點藍），貼著線的彎曲、不會像用車站點
      // 那樣在跳站段戳出直線。plain 不畫襯底。
      const geomD = (geom) => geom
        .map((c, i) => { const [x, y] = P(c); return `${i ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}` })
        .join(' ')
      highlightData = sk.edges
        .filter((e) => EDGE_HL[e.cls] && e.geom?.length >= 2)
        .map((e) => ({ d: geomD(e.geom), color: EDGE_HL[e.cls] }))
    } else {
      // 格網化後 / HC / 縮減 ＝ **跟格網化前/原始畫的完全一樣**（同樣的 line feature、
      // 同樣單色實線／共線交錯彩色虛線），唯一差別是把每個 feature 頂點的**車站**改
      // 對應到它的格子座標（movedOf）。這樣「格網化後」就是「格網化前」的同一張圖、
      // 只是座標搬到格子上——顏色、共線交錯、哪些線併在一起，全部一致。（先前改用骨架
      // 拓撲邊 edgeD 畫，導致共線交錯樣式、合併方式跟格網化前不同，使用者回報「跟格網化
      // 前不一樣」。）非車站頂點（真實軌道折點）在格子上無對應 → 略過，格線間直連。
      const movedOf = (id) => (hcPos && hcPos.get(id)) || (grid && gridPost.value && grid.posAfter.get(id)) || null
      // A yellow crossing is a synthetic node sitting on a station→station segment
      // (not a feature vertex). At grid/HC positions the feature would skip its
      // cell → the yellow node floats off-line and the two routes stop meeting.
      // So on each station segment, splice in any crossing that lies on it (route
      // through its moved cell), keeping lines crossing exactly at the yellow node.
      const crossPts = sk.crossings ?? []
      const crossOnSeg = (A, B) => {
        if (!crossPts.length) return []
        const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy
        if (L2 < 1e-18) return []
        const out = []
        for (const c of crossPts) {
          const ex = c.coord[0] - A[0], ey = c.coord[1] - A[1]
          if (Math.abs(dx * ey - dy * ex) > 1e-8) continue // not collinear
          const t = (ex * dx + ey * dy) / L2
          if (t > 1e-3 && t < 1 - 1e-3) out.push({ t, id: c.id })
        }
        return out.sort((p, q) => p.t - q.t)
      }
      const featMovedD = (f) => {
        const segs = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]
        const parts = []
        for (const seg of segs) {
          let started = false, prevC = null
          for (const c of seg) {
            const id = coordId.get(coordKey(c))
            const p = id != null ? movedOf(id) : null
            if (!p) continue
            if (prevC) for (const x of crossOnSeg(prevC, c)) {
              const xp = movedOf(x.id)
              if (xp) parts.push(`L ${xp[0].toFixed(2)} ${xp[1].toFixed(2)}`)
            }
            parts.push(`${started ? 'L' : 'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`); started = true
            prevC = c
          }
        }
        return parts.join(' ')
      }
      lineData = lineFeats.flatMap((f) => {
        const d = featMovedD(f)
        if (!d) return []
        const cols = (f.properties.route_colors ?? []).slice(0, MAX_OVERLAP)
        if (new Set(cols).size >= 2) {
          const n = cols.length
          return cols.map((color, i) => ({
            d, stroke: color, props: f.properties,
            dash: `0 ${i * DASH} ${DASH} ${(n - 1 - i) * DASH}`,
          }))
        }
        return [{ d, stroke: cols[0] ?? '#e11d48', props: f.properties }]
      })
      highlightData = []
    }
    // RWD 路網：自動隱藏的白點（直通站）不畫（cachedRWD.hidden）。
    const hiddenWhite = (rwdLines && cachedRWD?.hidden) || null
    stationData = stations
      .filter((f) => !(hiddenWhite && hiddenWhite.has(f.properties.station_id)))
      .map((f) => {
        const [x, y] = posOf(f.properties.station_id)
        return { x, y, props: f.properties, fill: NODE_COLOR[sk.stationClass.get(f.properties.station_id)] ?? '#ffffff' }
      })
    // synthetic yellow crossing nodes (not real stations)
    for (const c of sk.crossings ?? []) {
      const p = posOf(c.id)
      if (p) stationData.push({ x: p[0], y: p[1], props: { station_id: c.id, station_name: '路線交叉點' }, fill: NODE_COLOR.yellow })
    }
  } else {
    // 原始 = EXACTLY the Metro Maps drawing: single route → solid colour, overlap
    // (≥2 distinct route colours) → interleaved coloured dashes (same as LayerTab).
    lineData = lineFeats.flatMap((f) => {
      const d = path(f)
      const cols = (f.properties.route_colors ?? []).slice(0, MAX_OVERLAP)
      if (new Set(cols).size >= 2) {
        const n = cols.length
        return cols.map((color, i) => ({
          d, stroke: color, props: f.properties,
          dash: `0 ${i * DASH} ${DASH} ${(n - 1 - i) * DASH}`,
        }))
      }
      return [{ d, stroke: cols[0] ?? '#e11d48', props: f.properties }]
    })
    stationData = stations.map((f) => {
      const [x, y] = P(f.geometry.coordinates)
      return { x, y, props: f.properties, fill: stationColor(f.properties) }
    })
  }

  // Bottom-to-top: the blue schematic grid at the very bottom, then edge-class
  // highlight underlay, lines, pink reference lines (hover), and stations on top.
  const gridG = sel.append('g').attr('class', 'grid-layer').style('pointer-events', 'none')
  const highlightG = sel.append('g').attr('class', 'hl-layer')
  const linesG = sel.append('g').attr('class', 'lines-layer')
  const refG = sel.append('g').attr('class', 'ref-layer').style('pointer-events', 'none')
  const stationsG = sel.append('g').attr('class', 'stations-layer')

  // Schematic gridding: blue lines run ON the ticks — i.e. THROUGH the cell
  // centres (cx/cy), which is where every network node sits (使用者規則：格線在
  // 刻度上、節點端點落在網格交叉線上，不是格子中間). The integer coordinate for
  // each column/row therefore sits right on its own grid line.
  if (grid) {
    const b = hcBlue ?? (gridPost.value ? grid.blueAfter : grid.blueBefore)
    const cx = [], cy = []
    for (let c = 0; c < b.xs.length - 1; c++) cx.push((b.xs[c] + b.xs[c + 1]) / 2)
    for (let r = 0; r < b.ys.length - 1; r++) cy.push((b.ys[r] + b.ys[r + 1]) / 2)
    for (const x of cx) {
      gridG.append('line').attr('x1', x).attr('y1', 24).attr('x2', x).attr('y2', h - 24)
        .attr('stroke', '#3b82f6').attr('stroke-width', 0.7).attr('stroke-opacity', 0.5)
    }
    for (const y of cy) {
      gridG.append('line').attr('x1', 24).attr('y1', y).attr('x2', w - 24).attr('y2', y)
        .attr('stroke', '#3b82f6').attr('stroke-width', 0.7).attr('stroke-opacity', 0.5)
    }
    for (let c = 0; c < cx.length; c++) {
      gridG.append('text').attr('class', 'grid-axis')
        .attr('x', cx[c]).attr('y', h - 10).attr('text-anchor', 'middle').text(c)
    }
    for (let r = 0; r < cy.length; r++) {
      gridG.append('text').attr('class', 'grid-axis')
        .attr('x', 12).attr('y', cy[r])
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'central').text(r)
    }
  }

  // 權重數字：只要有 weight 就一定顯示（不限 weight 模式）。粒度是「相鄰兩站」——
  // 每個 cut-to-cut 段展開成站鏈 [a, ...interior 白點, b]，鏈上每一對「可見」相鄰站各標
  // 一個 weight 在兩站連線中點（白色描邊底、讀得清楚）。白點位置：RWD 用 posAfter、縮減
  // 網格用 placeBlacks，posOf 都取得到。被隱藏的白點（cachedRWD.hidden）跨過去，合併後的
  // 可見路段標所跨原始 link 的**最大** weight。
  // 同時：量目前可見相鄰站的最小站距，分「高（垂直向）／寬（水平向）」——顯示在權重
  // tab「最小站距」下方，讓使用者看到隱藏後實際撐開到多少（45° link 兩向都計）。
  if (isRWD.value && cachedSegs) {
    const hiddenW = (rwdLines && cachedRWD?.hidden) || null
    const hasW = rwdShowWeights.value && rwdWeights.value.size > 0
    const wg = hasW ? sel.append('g').attr('class', 'weight-layer').style('pointer-events', 'none') : null
    let minHigh = Infinity, minWide = Infinity
    for (const s of cachedSegs) {
      const chain = [s.a, ...s.interior, s.b]
      let prev = chain[0], accMax = 0
      for (let i = 1; i < chain.length; i++) {
        accMax = Math.max(accMax, linkWeight(rwdWeights.value, chain[i - 1], chain[i]))
        const visible = i === chain.length - 1 || !(hiddenW && hiddenW.has(chain[i]))
        if (!visible) continue
        const a = posOf(prev), b = posOf(chain[i])
        if (a && b) {
          const dx = Math.abs(a[0] - b[0]), dy = Math.abs(a[1] - b[1]), d = Math.hypot(dx, dy)
          if (dx >= dy) minWide = Math.min(minWide, d)
          if (dy >= dx) minHigh = Math.min(minHigh, d)
          if (wg) wg.append('text').attr('class', 'weight-label')
            .attr('x', (a[0] + b[0]) / 2).attr('y', (a[1] + b[1]) / 2)
            .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
            .text(accMax)
        }
        prev = chain[i]; accMax = 0
      }
    }
    let hiddenNames = []
    if (hiddenW && hiddenW.size) {
      const nameById = new Map(stations.map((f) => [f.properties.station_id, f.properties.station_name]))
      hiddenNames = [...hiddenW].map((id) => nameById.get(id) || id).sort()
    }
    rwdStopStat.value = {
      high: isFinite(minHigh) ? minHigh : null,
      wide: isFinite(minWide) ? minWide : null,
      hidden: hiddenW ? hiddenW.size : 0,
      hiddenNames,
      hiddenMaxT: (rwdLines && cachedRWD?.hiddenMaxT != null) ? cachedRWD.hiddenMaxT : null,
      canvas: [Math.round(w), Math.round(h)], // 診斷：目前畫布像素尺寸
    }
  } else rwdStopStat.value = null

  // Pink reference lines: the whole-edge chord (sinuosity baseline), the DP
  // sub-segment baseline, and this point's perpendicular drop to it.
  function drawRef(info) {
    refG.selectAll('*').remove()
    const seg = (a, b, dash) => refG.append('line')
      .attr('x1', P(a)[0]).attr('y1', P(a)[1]).attr('x2', P(b)[0]).attr('y2', P(b)[1])
      .attr('stroke', '#ec4899').attr('stroke-width', 1.5)
      .attr('stroke-dasharray', dash || null)
    seg(info.chordA, info.chordB, '4 3') // edge chord (sinuosity)
    seg(info.baseA, info.baseB)          // DP baseline
    seg(info.pt, info.foot)              // perpendicular (垂距)
    refG.append('circle')
      .attr('class', 'ref-foot')
      .attr('cx', P(info.foot)[0]).attr('cy', P(info.foot)[1])
      .attr('r', 2 / zk).attr('fill', '#ec4899')
  }
  const clearRef = () => refG.selectAll('*').remove()

  highlightG.selectAll('path.hl')
    .data(highlightData)
    .join('path')
    .attr('class', 'hl')
    .attr('d', (d) => d.d)
    .attr('fill', 'none')
    .attr('stroke', (d) => d.color)
    .attr('stroke-opacity', 0.55)
    .attr('stroke-width', (panelLayer.value?.strokeWidth ?? 2.5) + 11)
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .style('pointer-events', 'none')

  linesG.selectAll('path.line')
    .data(lineData)
    .join('path')
    .attr('class', 'line')
    .attr('d', (d) => d.d)
    .attr('fill', 'none')
    .attr('stroke', (d) => d.stroke)
    .attr('stroke-dasharray', (d) => d.dash ?? null)
    .attr('stroke-linecap', (d) => (d.dash ? 'butt' : 'round'))
    .attr('stroke-linejoin', 'round')
    .style('cursor', 'pointer')
    .on('click', (e, d) => { e.stopPropagation(); if (d.props) store.setSelectedFeature(panelLayer.value?.id, d.props) })
    .on('mouseenter', function (e, d) {
      select(this).raise().attr('stroke-width', (panelLayer.value?.strokeWidth ?? 2.5) + 3)
      showTip(e, d.html ?? lineHtml(d.props))
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function () {
      select(this).attr('stroke-width', panelLayer.value?.strokeWidth ?? 2.5)
      hideTip()
    })

  stationsG.selectAll('circle.station')
    .data(stationData)
    .join('circle')
    .attr('class', 'station')
    .attr('cx', (d) => d.x)
    .attr('cy', (d) => d.y)
    .attr('fill', (d) => d.fill)
    .attr('stroke', '#3f3f46')
    .attr('stroke-width', 1)
    .style('cursor', 'pointer')
    .on('click', (e, d) => { e.stopPropagation(); store.setSelectedFeature(panelLayer.value?.id, d.props) })
    .on('mouseenter', function (e, d) {
      select(this).raise().attr('r', ((panelLayer.value?.radius ?? 4) + 3) / zk)
      // Same station hover as Metro Maps (name + local + lines); a pink bend
      // point appends its sinuosity detail below rather than replacing it.
      const info = sk?.pinkInfo?.get(d.props.station_id)
      if (info && !gridMode.value) drawRef(info)
      showTip(e, stationHtml(d.props) + (info ? pinkExtra(info) : ''))
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function () {
      select(this).attr('r', (panelLayer.value?.radius ?? 4) / zk)
      clearRef()
      hideTip()
    })

  // Station name labels above the dots (toggled by the Style tab).
  if (panelLayer.value?.showLabels) {
    const r = panelLayer.value?.radius ?? 4
    stationsG.selectAll('text.st-label')
      .data(stationData)
      .join('text')
      .attr('class', 'st-label')
      .attr('x', (d) => d.x)
      .attr('y', (d) => d.y - r - 3)
      .attr('text-anchor', 'middle')
      .style('pointer-events', 'none')
      .text((d) => d.props.station_name ?? '')
  }

  applyStyle()

  // reset zoom to identity on re-render
  if (zoomBehavior) select(svg).call(zoomBehavior.transform, zoomIdentity)
}

// Width / radius / opacity come from the SOURCE layer's style (the same values
// the Style tab edits for the MapLibre view) — applied without a re-render so
// slider drags stay smooth.
function applyStyle() {
  const src = panelLayer.value
  const sel = select(gEl.value)
  sel.selectAll('path.line')
    .attr('stroke-width', src?.strokeWidth ?? 2.5)
    .attr('stroke-opacity', src?.opacity ?? 1)
  sel.selectAll('path.hl')
    .attr('stroke-width', (src?.strokeWidth ?? 2.5) + 11)
  sel.selectAll('circle.station')
    .attr('r', (src?.radius ?? 4) / zk)
    .attr('opacity', src?.opacity ?? 1)
}

/* ---- hover popup (same content as the MapLibre tab) ---- */
function asArray(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.startsWith('[')) { try { return JSON.parse(v) } catch { /* */ } }
  return []
}
function stationHtml(p) {
  const local = p.station_name_local && p.station_name_local !== p.station_name
    ? `<br/>${p.station_name_local}` : ''
  const lines = asArray(p.lines)
  const linesHtml = lines.length ? `<br/>路線：${lines.join(', ')}` : ''
  // 共站（異名轉乘）：列出每個成員站名＋該名所屬路線
  const mn = asArray(p.merged_names)
  const merged = mn.length > 1
    ? '<br/>共站：' + mn.map((m) => `<br/>　${m.station_name}（${(m.lines || []).join(', ')}）`).join('')
    : ''
  return `<strong>${p.station_name ?? '—'}</strong>${local}${linesHtml}${merged}`
}
function lineHtml(p) {
  const routes = asArray(p.routes)
  const list = routes.length ? routes : [p]
  return list.map((r) => {
    const local = r.route_name_local && r.route_name_local !== r.route_name
      ? `（${r.route_name_local}）` : ''
    return `<span style="color:${r.route_color ?? '#e11d48'}">▬</span> `
      + `<strong>${r.route_ref ? `[${r.route_ref}] ` : ''}${r.route_name ?? '—'}</strong>${local}`
  }).join('<br/>')
}
// Pink (representative bend) hover: explain the two gates + this point's numbers.
// Pink (representative bend) EXTRA — appended below the shared station hover,
// not replacing it (the station name + lines come from stationHtml first).
function pinkExtra(info) {
  return '<hr class="tip-sep"/><span style="color:#ec4899">● 代表性轉折點（粉紅）</span>'
    + `<br/>邊曲折度 = 弧長÷弦長 = <b>${info.sinuosity.toFixed(2)}</b>（&gt;1.25 才挑）`
    + `<br/>此點 垂距÷弦長 = <b>${info.ratio.toFixed(2)}</b>（&gt;0.25 保留）`
    + '<br/><span style="color:#9ca3af;font-size:11px">曲折度：整條邊的弧長比兩端直線'
    + '（弦）長多少——越大越彎；虛線＝弦，實線＝DP 基線與垂距。</span>'
}
function showTip(e, html) {
  const el = tipEl.value
  if (!el) return
  el.innerHTML = html
  el.style.display = 'block'
  moveTip(e)
}
function moveTip(e) {
  const el = tipEl.value
  if (!el || el.style.display === 'none') return
  const [x, y] = pointer(e, host.value)
  el.style.left = `${x + 14}px`
  el.style.top = `${y + 14}px`
}
function hideTip() {
  if (tipEl.value) tipEl.value.style.display = 'none'
}

// Compact fitness numbers for the Hill Climbing stats readout.
const fmtFit = (x) => (x >= 10000 ? `${(x / 1000).toFixed(1)}k` : Math.round(x).toString())

watch(() => layer.value?.sourceLayerId, () => { cacheData = null; render() })
watch(mode, render)
// Live style sync from the bound layer (Style tab sliders).
watch(
  () => [panelLayer.value?.strokeWidth, panelLayer.value?.radius, panelLayer.value?.opacity],
  applyStyle,
)
// Toggling station labels needs a re-render (add/remove text nodes).
watch(() => panelLayer.value?.showLabels, render)

onMounted(() => {
  // d3-zoom drives the inner <g> transform (wheel zoom + drag pan).
  zoomBehavior = zoom()
    .scaleExtent([0.5, 20])
    .on('zoom', (e) => {
      select(gEl.value).attr('transform', e.transform)
      applyZoomSizing(e.transform.k)
    })
  select(svgEl.value).call(zoomBehavior)

  // Redraw when the panel is resized (dockview) or first laid out. Debounced:
  // during a continuous drag-resize the observer fires every frame, and the RWD
  // build's 30ms busy-delay + supersede check means each render bails before it
  // rebuilds — so nothing (incl. 白點隱藏 by pixel spacing) recomputes until the
  // drag stops. Wait for the size to settle, then run ONE full render.
  let resizeTimer = null
  resizeObs = new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => render(), 90)
  })
  resizeObs.observe(host.value)

  // Active tab keeps the layer-list highlight in sync (same per-panel event as
  // LayerTab — dockview 7's api-level active-panel event is unreliable).
  const setActive = (active) => { if (active) store.selectedLayerId = layerId }
  disposables.push(panelApi.onDidActiveChange(({ isActive }) => setActive(isActive)))
  setActive(panelApi.isActive)

  render()
})

onBeforeUnmount(() => {
  disposables.forEach((d) => d?.dispose?.())
  resizeObs?.disconnect()
  clearTimeout(llmPollTimer)
  clearTimeout(gridPollTimer)
  if (rwdAutoTimer) clearInterval(rwdAutoTimer)
  if (rwdAnimRaf) cancelAnimationFrame(rwdAnimRaf)
})
</script>

<template>
  <div class="ma-tab">
    <div class="tab-body">
      <div class="map-col">
        <div class="map-main">
          <div class="view-nav" :style="{ width: viewNavWidth + 'px' }" role="tablist">
            <template v-for="t in VIEW_TABS" :key="t.id ?? `h:${t.header}`">
              <div v-if="t.header" class="view-nav-group">{{ t.header }}</div>
              <button
                v-else
                class="view-nav-item"
                :class="{ active: mode === t.id }"
                role="tab"
                :aria-selected="mode === t.id"
                :disabled="!panelLayer || (t.rot && !canRotate)"
                :title="t.rot && !canRotate ? '網路已對齊正南北，無需旋轉' : ''"
                @click="mode = t.id"
              >{{ t.label }}</button>
            </template>
          </div>
          <div
            class="view-nav-resize"
            :class="{ dragging: navDragging }"
            role="separator"
            aria-orientation="vertical"
            @pointerdown="startNavResize"
          />

          <div ref="host" class="ma-canvas">
          <svg ref="svgEl" class="ma-svg" @click="panelLayer && store.setSelectedFeature(panelLayer.id, null)">
            <g ref="gEl" />
          </svg>
          <div ref="tipEl" class="ma-tip" />
          <div v-if="loading" class="ma-hint">載入中…</div>
          <div v-else-if="hcBusy" class="ma-hint">{{ busyText }}</div>
          <div v-else-if="loadError" class="ma-hint error">{{ loadError }}</div>
          <!-- 執行中 overlay：蓋住整個畫布，舊地圖已清空，跑完才出現新結果 -->
          <div v-else-if="llmMode && llmRun === 'running'" class="ma-hint llm-hint">
            <div class="llm-run-card">
              <div class="llm-spinner" />
              <div class="llm-run-title">LLM 對齊執行中…</div>
              <div class="llm-run-desc">headless Claude Code 依 route-llm-align skill 逐輪最佳化，完成後結果會自動出現</div>
              <div class="llm-run-label">LLM 回傳（即時串流）</div>
              <pre ref="llmLogEl" class="llm-run-log">{{ llmRunText || '等待模型回應…' }}</pre>
            </div>
          </div>
          <div v-else-if="llmMsg" class="ma-hint llm-hint">
            <div class="llm-box">
              <div>{{ llmMsg }}</div>
              <div v-if="llmRun === 'error'" class="llm-tail err">執行失敗：{{ llmRunTail }}</div>
              <button
                v-if="llmCityId"
                class="llm-btn"
                @click="startLlmRun"
              >開始 LLM 對齊</button>
            </div>
          </div>
          <!-- LLM 調整（AI 改網格長寬）執行中 overlay：畫布留白、跑完動畫過渡到新版面 -->
          <div v-else-if="rwdLlmMode && gridRun === 'running'" class="ma-hint llm-hint">
            <div class="llm-run-card">
              <div class="llm-spinner" />
              <div class="llm-run-title">LLM 調整執行中…</div>
              <div class="llm-run-desc">headless Claude Code 依 route-llm-grid skill 推理每個 X 欄／Y 列的顯示權重，完成後版面會動畫過渡</div>
              <div class="llm-run-label">LLM 回傳（即時串流）</div>
              <pre ref="gridLogEl" class="llm-run-log">{{ gridRunText || '等待模型回應…' }}</pre>
            </div>
          </div>
          <div v-else-if="gridMsg" class="ma-hint llm-hint">
            <div class="llm-box">
              <div>{{ gridMsg }}</div>
              <div v-if="gridRun === 'error'" class="llm-tail err">執行失敗：{{ gridRunTail }}</div>
              <template v-if="llmCityId">
                <textarea
                  v-model="gridOverlayPrompt"
                  class="grid-prompt-box"
                  rows="2"
                  placeholder="例：把市中心那幾欄拉開；中間幾列拉高；東側壓縮一點…"
                />
                <button class="llm-btn" @click="startGridRun(gridOverlayPrompt.trim())">開始 LLM 調整</button>
              </template>
            </div>
          </div>
          </div>
        </div>

        <AttributeTable
          v-if="store.ui.attributeTableOpen[layerId] && panelLayer"
          :layer="panelLayer"
          :owner-id="layerId"
        />
      </div>

      <StylePanel
      v-if="panelLayer"
      :layer="panelLayer"
      context="d3"
      :view-kind="isRWD ? 'rwd' : isHC ? 'hillclimb' : 'map-adjust'"
      :llm-record="isHC ? llmStats : null"
      :llm-running="llmRun === 'running'"
      :llm-can-run="!!llmCityId"
      :grid-record="isRWD ? gridStats : null"
      :grid-running="gridRun === 'running'"
      :grid-can-run="!!llmCityId"
      :weight-mode="rwdWeightMode"
      :weight-auto="rwdAutoShuffle"
      :show-weights="rwdShowWeights"
      :hide-stops="rwdHideStops"
      :min-stop-px="rwdMinStopPx"
      :stop-stat="rwdStopStat"
      @run-llm="startLlmRun"
      @run-grid="startGridRun"
      @weight-mode="setRwdWeightMode"
      @weight-random="regenRwdWeights"
      @weight-auto="toggleRwdAutoShuffle"
      @show-weights="setRwdShowWeights"
      @hide-stops="setRwdHideStops"
      @min-stop-px="setRwdMinStopPx"
    />
    </div>

    <!-- Footer status bar (mirrors the metro map tab's StatusBar): the toolbar's
         right-side readouts — per-mode stats + data source — live here now. -->
    <footer class="ma-statusbar">
      <!-- Hill Climbing: multicriteria fitness before → after (lower = better) -->
      <span v-if="isHC && (mode === 'hc' || mode === 'hc-compact') && hcStats" class="hc-stats">
        適應度 {{ fmtFit(hcStats.before) }} → {{ fmtFit(hcStats.after) }}
        · {{ hcStats.rounds }} 輪 · 移動 {{ hcStats.moved }} 站<template
          v-if="hcStats.clusterMoves"> · {{ hcStats.clusterMoves }} 群集</template><template
          v-if="hcCompact && hcCompactStats"> · 網格
          {{ hcCompactStats.fromCols }}×{{ hcCompactStats.fromRows }} →
          {{ hcCompactStats.cols }}×{{ hcCompactStats.rows }}</template>
      </span>

      <!-- 端點拉直: vertex-alignment H/V pass on top of each chain's result -->
      <span v-if="isHC && END_KIND[mode] && endpStats" class="hc-stats">
        端點拉直 移動 {{ endpStats.moved }}/{{ endpStats.endpoints }} 點
        · 水平垂直 {{ endpStats.hvBefore }} → {{ endpStats.hvAfter }}／{{ endpStats.segs }} 段
        · 迭代 {{ endpStats.iters }}/{{ endpStats.iterCap }}<template
          v-if="!endpStats.converged">（達上限未收斂）</template>
      </span>

      <!-- H/V-maximising post-passes: aligned-segment count before → after -->
      <span v-if="postKind && postStats" class="hc-stats">
        水平垂直 {{ postStats.hvBefore }} → {{ postStats.hvAfter }}／{{ postStats.segs }} 段
        · 迭代 {{ postStats.iters }}/{{ postStats.iterCap }}<template
          v-if="!postStats.converged">（達上限未收斂）</template>
        · 移動 {{ postStats.moved }} 站<template
          v-if="postStats.reverted">（淨值未改善，退回）</template><template
          v-if="postKind === 'rect'"> · 適應度 {{ fmtFit(postStats.before) }} →
          {{ fmtFit(postStats.after) }} · {{ postStats.rounds }} 輪</template><template
          v-else-if="postKind === 'align'"> · 橫群 {{ postStats.groupsH }}
          · 縱群 {{ postStats.groupsV }}</template><template
          v-else-if="postKind === 'ilp'"> · {{ postStats.comps }} 元件<template
            v-if="postStats.fallback">（{{ postStats.fallback }} 退回）</template></template><template
          v-if="hcCompact && hcCompactStats"> · 網格
          {{ hcCompactStats.fromCols }}×{{ hcCompactStats.fromRows }} →
          {{ hcCompactStats.cols }}×{{ hcCompactStats.rows }}</template>
      </span>

      <!-- LLM 對齊: button-triggered offline run — rounds + the model -->
      <span v-if="llmMode && llmStats" class="hc-stats">
        水平垂直 {{ llmStats.hvBefore }} → {{ llmStats.hvAfter }}／{{ llmStats.segs }} 段
        · 迭代 {{ llmStats.rounds }} 輪 · 移動 {{ llmStats.moved }} 站
        · 模型 {{ llmStats.model }}<template
          v-if="hcCompact && hcCompactStats"> · 網格
          {{ hcCompactStats.fromCols }}×{{ hcCompactStats.fromRows }} →
          {{ hcCompactStats.cols }}×{{ hcCompactStats.rows }}</template><template
          v-if="llmRun === 'running'"> · <b>執行中…</b></template>
        <button
          v-if="llmCityId && llmRun !== 'running'"
          class="llm-rerun"
          title="重新啟動 headless Claude Code 繼續改善"
          @click="startLlmRun"
        >重跑</button>
      </span>

      <!-- LLM 調整: interval-weight run — the model + how big the core got -->
      <span v-if="rwdLlmMode && gridStats" class="hc-stats">
        LLM 調整 · 模型 {{ gridStats.model }}
        · 最大倍率 {{ Math.max(...gridStats.colW, ...gridStats.rowW).toFixed(1) }}<template
          v-if="gridRun === 'running'"> · <b>執行中…</b></template>
      </span>

      <!-- RWD 路網: how each segment got routed (H/V/45° bend histogram) -->
      <span v-if="isRWD && rwdMode && rwdStats" class="hc-stats">
        {{ rwdStats.segs }} 段 · 直線 {{ rwdStats.straight }} · 單折 {{ rwdStats.single }}
        · 雙折 {{ rwdStats.double }}<template v-if="rwdStats.multi">
          · 多折 {{ rwdStats.multi }}</template><template v-if="rwdStats.rerouted">
          · 繞行 {{ rwdStats.rerouted }}</template><template v-if="rwdStats.swapped">
          · 順接調整 {{ rwdStats.swapped }}</template><template v-if="rwdStats.straightened">
          · 直線化 {{ rwdStats.straightened }}</template><template v-if="rwdStats.diag45">
          · 轉45 {{ rwdStats.diag45 }}</template><template v-if="rwdStats.squeezed">
          · 窄縫 {{ rwdStats.squeezed }}</template><template v-if="rwdStats.fallback">
          · 兜底 {{ rwdStats.fallback }}</template><template v-if="rwdStats.forced">
          · 殘留衝突 {{ rwdStats.forced }}</template><template v-if="hcCompactStats"> · 網格
          {{ hcCompactStats.cols }}×{{ hcCompactStats.rows }}</template>
      </span>

      <span class="ma-label">資料來源：</span>
      <span class="ma-source">
        {{ ownData ? `${layer?.name}（匯入 JSON）`
          : isRWD ? (hcLayer ? `${hcLayer.name}（Hill Climbing縮減網格）` : (layer?.sourceLayerId ?? '—'))
          : isHC ? (hcD3Layer ? `${hcD3Layer.name}（${hcVariant === 'rot' ? '旋轉' : '原始'}格網化後）` : (layer?.sourceLayerId ?? '—'))
          : (sourceLayer?.name ?? layer?.sourceLayerId ?? '—') }}
      </span>
    </footer>
  </div>
</template>

<style scoped>
.ma-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: hsl(var(--background));
}
.tab-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
/* Canvas + its attribute table stack vertically; StylePanel sits beside. */
.map-col {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
/* Map area: a left view-list rail + the canvas to its right. */
.map-main {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.view-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex-shrink: 0;
  padding: 6px;
  overflow-y: auto;
}
/* Section headers inside the view list（原始／Hill Climbing／直線演算法／…）。 */
.view-nav-group {
  padding: 8px 10px 2px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: hsl(var(--muted-foreground) / 0.75);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
}
.view-nav-group:not(:first-child) {
  margin-top: 4px;
  border-top: 1px solid hsl(var(--border) / 0.6);
}
/* Draggable divider between the view list and the canvas. */
.view-nav-resize {
  width: 5px;
  flex-shrink: 0;
  cursor: col-resize;
  border-left: 1px solid hsl(var(--border));
  background: transparent;
}
.view-nav-resize:hover, .view-nav-resize.dragging { background: hsl(var(--primary) / 0.3); }
.view-nav-item {
  text-align: left;
  padding: 6px 10px;
  font-size: 12.5px;
  border: none;
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.view-nav-item:hover:not(:disabled) { background: hsl(var(--accent)); color: hsl(var(--foreground)); }
.view-nav-item.active {
  background: hsl(var(--primary) / 0.12);
  color: hsl(var(--primary));
  font-weight: 600;
}
.view-nav-item:disabled { opacity: 0.4; cursor: default; }
/* Footer status bar — mirrors the metro map tab's StatusBar. Sits full-width
   below tab-body; holds the per-mode stats + data source moved off the toolbar. */
.ma-statusbar {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 28px;
  flex-shrink: 0;
  padding: 3px 12px;
  border-top: 1px solid hsl(var(--border));
  background: hsl(var(--muted) / 0.4);
  color: hsl(var(--muted-foreground));
  overflow: hidden;
}
/* long stats (esp. RWD histogram) truncate rather than shove the source off-screen */
.ma-statusbar .hc-stats { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ma-label { font-size: 12.5px; color: hsl(var(--muted-foreground)); white-space: nowrap; margin-left: auto; }
/* Hill Climbing fitness readout (before → after, 越低越好) */
.hc-stats {
  font-size: 11.5px;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ma-source { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.ma-svg { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; }
.ma-svg:active { cursor: grabbing; }
.ma-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: hsl(var(--muted-foreground));
  pointer-events: none;
}
.ma-hint.error { color: hsl(var(--destructive)); }
/* LLM 對齊: the hint hosts a real button (the default hint is click-through) */
.ma-hint.llm-hint { pointer-events: auto; }
/* 執行中 overlay: spinner card centred over a blanked canvas */
.llm-run-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 440px;
  padding: 24px 28px;
  text-align: center;
  background: hsl(var(--card) / 0.96);
  border: 1px solid hsl(var(--primary) / 0.4);
  border-radius: var(--radius);
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.28);
}
.llm-spinner {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid hsl(var(--primary) / 0.2);
  border-top-color: hsl(var(--primary));
  animation: llm-spin 0.8s linear infinite;
}
@keyframes llm-spin { to { transform: rotate(360deg); } }
.llm-run-title { font-size: 14px; font-weight: 700; color: hsl(var(--foreground)); }
.llm-run-desc { font-size: 11.5px; line-height: 1.6; color: hsl(var(--muted-foreground)); }
.llm-run-label {
  width: 100%;
  text-align: left;
  font-size: 10.5px;
  font-weight: 600;
  color: hsl(var(--primary));
}
.llm-run-log {
  width: 100%;
  min-width: 340px;
  height: 200px;
  overflow: auto;
  text-align: left;
  font-size: 10.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  padding: 8px 10px;
  background: hsl(var(--muted) / 0.5);
  border-radius: calc(var(--radius) - 2px);
}
.llm-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 420px;
  text-align: center;
}
.llm-tail { font-size: 11.5px; color: hsl(var(--muted-foreground)); }
.llm-tail pre {
  margin-top: 6px;
  max-height: 90px;
  overflow: auto;
  text-align: left;
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-all;
}
.llm-tail.err { color: hsl(var(--destructive)); }
/* LLM 調整 overlay 的一句話輸入框（畫布中央、開始鈕上方） */
.grid-prompt-box {
  width: 100%;
  min-width: 300px;
  resize: vertical;
  font-size: 12px;
  line-height: 1.5;
  padding: 6px 8px;
  color: hsl(var(--foreground));
  background: hsl(var(--muted) / 0.5);
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
}
.llm-btn {
  height: 28px;
  padding: 0 16px;
  font-size: 12.5px;
  font-weight: 600;
  border: 1px solid hsl(var(--primary) / 0.55);
  border-radius: calc(var(--radius) - 2px);
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.12);
}
.llm-btn:hover { background: hsl(var(--primary) / 0.22); }
.llm-rerun {
  margin-left: 6px;
  height: 18px;
  padding: 0 8px;
  font-size: 10.5px;
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 4px);
  color: hsl(var(--muted-foreground));
}
.llm-rerun:hover { background: hsl(var(--accent)); color: hsl(var(--foreground)); }
/* Strokes stay a constant screen width regardless of the zoom transform, so
   lines/borders/reference lines never thicken when zooming (dot radius & label
   size are counter-scaled in JS). */
.ma-svg :deep(g path),
.ma-svg :deep(g line),
.ma-svg :deep(g circle) { vector-effect: non-scaling-stroke; }
.ma-svg :deep(text.grid-axis) { fill: #3b82f6; font-size: 9px; font-weight: 600; }
.ma-svg :deep(text.weight-label) {
  fill: #b91c1c; font-size: 11px; font-weight: 700;
  paint-order: stroke; stroke: #fff; stroke-width: 3px; stroke-linejoin: round;
}
.ma-svg :deep(text.st-label) {
  font-size: 9px;
  fill: #e5e7eb;
  stroke: #111827;
  stroke-width: 2.4px;
  paint-order: stroke;
  stroke-linejoin: round;
}
.ma-tip {
  position: absolute;
  display: none;
  z-index: 10;
  pointer-events: none;
  max-width: 260px;
  background: hsl(var(--popover));
  color: hsl(var(--popover-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
  font-size: 12px;
  line-height: 1.5;
  padding: 8px 10px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.2);
}
/* Separator between the shared (Metro Maps) hover and this view's extra info. */
.ma-tip :deep(hr.tip-sep) {
  border: none;
  border-top: 1px solid hsl(var(--border));
  margin: 5px 0;
}
</style>
