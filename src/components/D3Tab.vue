<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { geoMercator, geoPath } from 'd3-geo'
import { select, pointer } from 'd3-selection'
import { zoom, zoomIdentity } from 'd3-zoom'
import { useMapStore } from '../stores/mapStore'
import { assetUrl } from '../lib/assetUrl'
// 爬山/後處理結果的 localStorage 持久快取（指紋失效＋LRU），見 hcCache.js 檔頭說明。
import { dataFingerprint, loadHcCache, saveHcCache } from '../lib/hcCache'
import { makeHeadlessRun } from '../lib/headlessRun'
import { resolveRwdFrame } from '../lib/rwdFrames'
import { layerData, layerExport, localizeStationNames } from '../stores/layerData'
import { computeOrientation } from '../stores/orientation'
import { buildConnectSkeleton, DEFAULT_RIVER_GRAY_SINUOSITY } from '../stores/skeleton'
import { buildSchematicGrid, placeBlacks } from '../stores/schematicGrid'
import {
  buildHillClimb, buildHcGraph, iteratePost, POST_ITER_CAP,
  straightenCompactLoop, movewiseStage,
  stepChainInit, stepChainNext, setSpanCap,
} from '../stores/hillClimb'
import { PAPER_KINDS, PAPER_BUILD, PAPER_ZH, buildShapeAlign } from '../stores/paperAlign'
import {
  LAYOUT_KINDS, PAPER_KIND_IDS, layoutKindOf, endKindOf, lineKindOf, gatherKindOf,
  loopKindOf, shapeKindOf, stepKindOf, postKindOf, needsHcLayout,
} from '../lib/hcMode'
import { LLM_MODEL_OPTIONS } from '../lib/llmModels'
import { llmApplyGet, llmApplySet } from '../lib/llmApplyPersist'
import {
  NODE_COLOR, EDGE_HL, EDGE_LABEL, dashStrokes, featStrokes, stationColor,
} from '../lib/metroDraw'
import { sceneToGeojson } from '../lib/sceneExport'
import { buildRwdMap, mergeParallelSegs, RWD_ROUTER_REV } from '../stores/rwdMap'
import { randomWeights, weightedAxes, intervalAxes, linkWeight, uniformAxes, lerpAxes } from '../stores/rwdWeight'
import { stationPopupHtml, linePopupHtml, buildPopupIndex, stationsAlongSeg } from '../stores/popupHtml'
import StylePanel from './StylePanel.vue'
import StyleBar from './StyleBar.vue'
import AttributeTable from './AttributeTable.vue'
import MIcon from './MIcon.vue'
import D3ViewNav from './d3/D3ViewNav.vue'
import D3StepPanel from './d3/D3StepPanel.vue'

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
// ('hc', ②, see skill route-hillclimb), the H/V-maximising post-passes
// (論文①〜⑧＋LLM 對齊), then per chain the 4-step tail 端點移動
// ('*-end') → 直線縮減 ('*-line') → 網格合併 ('*-gather') → 縮減網格
// ('*-compact') plus the '*-loop' cycle tabs — rotation comes from its variant.
const mode = ref(isRWD.value ? 'rwd' : isHC.value ? 'hc' : 'original')
// ---- HC mode 解析（lib/hcMode.js）----
// Modes that need the hill-climbing result ('rwd' builds on its 縮減網格).
// layout-* 也走 computeHcLayout（但只跑該演算法、不碰 HC／下游）。
const hcMode = computed(() => needsHcLayout(mode.value))
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
// 「指定對齊」（依使用者一句話）＝與「自動對齊」完全獨立的一組平行狀態：另存
// .prompt.json、自己的 run/串流/結果/toggle，互不影響。只在主視圖比較用、不餵下游。
const promptStats = ref(null) // the whole .prompt.json llmview file
const promptMsg = ref(null)   // hint when the result is missing / stale
const promptRun = ref(null)   // null | 'running' | 'error'
const promptRunTail = ref('')
const promptRunText = ref('')
const promptLogEl = ref(null)
const llmCityId = computed(() => sourceLayer.value?.id ?? null)
// 三個 LLM 功能（評價/對齊/調整）共用的模型選擇：面板下拉的短鍵，隨 /run 的
// body 送出，vite plugin 映射成 claude --model；'default' → 不帶旗標（沿用預設）。
const llmModel = ref('opus') // 預設 Opus 4.8（使用者：LLM 預設模型都改 Opus 4.8）
// run/poll 機構本體在 lib/headlessRun.js（三個 LLM 功能共用）——這裡把本元件的
// 城市 id、模型選擇與重畫函式注入進去（render 是 function declaration，取值安全）。
const makeRun = (cfg) => makeHeadlessRun({
  ...cfg,
  cityId: () => llmCityId.value,
  model: () => llmModel.value,
  render,
})
// 清掉 LLM 對齊的所有下游快取（端點移動／直線縮減／網格合併／循環／逐步）——
// 對齊佈局一變，這些以它為輸入的結果都作廢。run 前後與 toggle 時共用。
function invalidateLlmDownstream() {
  delete cachedEndp.llm
  delete cachedLine.llm
  delete cachedGather.llm
  delete cachedLoop.llm
  delete stepState.llm
  delete stepHistory.llm
}
// 「LLM 對齊主視圖目前顯示的佈局」——align 執行時當 seed 起點傳給後端（--base）。
function currentAlignBase() {
  if (promptApplied.value) return 'prompt'
  if (llmApplied.value) return 'auto'
  return 'hc'
}
const llmRunner = makeRun({
  base: '/llm-align',
  params: () => ({ variant: hcVariant.value, kind: 'auto', base: currentAlignBase(), span: appliedSpanCap.value ?? panelLayer.value?.spanCap ?? 3 }),
  run: llmRun, tail: llmRunTail, text: llmRunText, logEl: llmLogEl,
  shouldRender: () => false, // 唯讀：跑的時候畫布照畫（base HC/舊結果）、不留白，串流顯示在面板
  onStart: () => {
    // 清舊結果：面板的逐輪 transcript／provenance（llmStats）與提示一起清掉，
    // 跑完 render 再載入新結果（跟 eval/grid 的 onStart 一致）。
    cachedLlm = null; llmStats.value = null; llmMsg.value = null; llmInfo.value = null
    llmApplied.value = false; llmApplySet(llmApplyKeys.value.auto, false); invalidateLlmDownstream()
  },
  onDone: () => { cachedLlm = null; invalidateLlmDownstream() },
})
const startLlmRun = llmRunner.start
// 「指定對齊」的獨立 runner：kind:'prompt' → 後端寫 .prompt.json、job key 分開。
// 不動下游快取（指定對齊不餵下游，見 render）。清舊結果同 eval/grid。
const promptRunner = makeRun({
  base: '/llm-align',
  params: () => ({ variant: hcVariant.value, kind: 'prompt', base: currentAlignBase(), span: appliedSpanCap.value ?? panelLayer.value?.spanCap ?? 3 }),
  run: promptRun, tail: promptRunTail, text: promptRunText, logEl: promptLogEl,
  shouldRender: () => false,
  onStart: () => { cachedPrompt = null; promptStats.value = null; promptMsg.value = null; promptApplied.value = false; llmApplySet(llmApplyKeys.value.prompt, false) },
  onDone: () => { cachedPrompt = null },
})
const startPromptRun = promptRunner.start
// ---- 執行 LLM 對齊結果（不用 LLM）----
// 「執行調整」切換「LLM 對齊」主視圖（mode 'hc-llm'）顯示的佈局：base HC ⇄ 自動
// ⇄ 指定（自動與指定互斥）。**下游的鏈（hc-llm-*）跟著目前顯示的佈局走**——所以
// toggle 一變就作廢 'llm' 鏈快取、讓它們以新的顯示佈局重算（使用者裁決）。
// RWD 'llm' compact 是另一個 layer、沒有 toggle，維持用「自動對齊」當基準。
const llmApplied = ref(false)
const promptApplied = ref(false)
// 4 個 LLM 功能（自動對齊／指定對齊／LLM評價／LLM互動）的「執行調整」toggle 跨
// reload 記憶：只把布林旗標存進 localStorage（結果本身仍從結果檔重載），鍵到
// city+variant(+compact)。重整或切回本視圖時若有結果，就自動恢復上次「已套用」的
// 狀態，免得每次都要重按執行調整（使用者裁決 2026-07）。跑新結果時 onStart 會清掉
// 該鍵，維持「跑完不自動套用」。llmApplyGet/Set 見 lib/llmApplyPersist.js。
// 鍵隨目前 city/variant/compact 而變（rwdCompactKey 定義在後面、computed 惰性求值）。
const llmApplyKeys = computed(() => {
  const cid = sourceLayer.value?.id ?? '?'
  const v = hcVariant.value
  const c = rwdCompactKey.value
  return {
    auto: `auto|${cid}|${v}`,
    prompt: `prompt|${cid}|${v}`,
    eval: `eval|${cid}|${v}|${c}`,
    grid: `grid|${cid}|${v}|${c}`,
  }
})
function toggleLlmExec() {
  if (!cachedLlm?.cells) return
  llmApplied.value = !llmApplied.value
  if (llmApplied.value) promptApplied.value = false // 互斥
  llmApplySet(llmApplyKeys.value.auto, llmApplied.value)
  llmApplySet(llmApplyKeys.value.prompt, promptApplied.value)
  invalidateLlmDownstream() // 顯示佈局變了 → 鏈重算
  render()
}
function togglePromptExec() {
  if (!cachedPrompt?.cells) return
  promptApplied.value = !promptApplied.value
  if (promptApplied.value) llmApplied.value = false // 互斥
  llmApplySet(llmApplyKeys.value.prompt, promptApplied.value)
  llmApplySet(llmApplyKeys.value.auto, llmApplied.value)
  invalidateLlmDownstream() // 顯示佈局變了 → 鏈重算
  render()
}
// ---- LLM 互動（RWD Maps「AI 改網格長寬」，skill route-llm-grid）----
// 與 LLM 評價同一套離線模式：使用者的一句話 POST 給 /llm-grid/run（vite plugin
// spawn headless Claude Code），模型推理每個 X 欄／Y 列區間的顯示權重、存到
// data/metro/llmgrids/<city>.<variant>.<compact>.json，這裡只載入＋fingerprint
// 驗證。跟評價一樣**跑完不自動套用**：畫布照畫 RWD 路網、串流顯示在面板內，
// 使用者按「執行調整」才用 intervalAxes 正規化進固定外框重畫（見 gridApplied）。
const gridInfo = ref(null)     // { model } once loaded — 面板顯示
const gridStats = ref(null)    // the whole llmgrid file（右側 LLM互動 面板）
const gridMsg = ref(null)      // hint when the result is missing / stale
const gridRun = ref(null)      // null | 'running' | 'error'
const gridRunTail = ref('')
const gridRunText = ref('')
const gridLogEl = ref(null)
let cachedGrid = null          // fetched llmgrid: { colW, rowW, stats } or { miss }
let rwdGridSeq = 0             // 套用切換序號，併進 RWD 快取鍵
// RWD 圖層蓋在哪個縮減網格上（llmgrid 檔名的第三段）。
const rwdCompactKey = computed(() => (useLlm.value ? 'llm' : postKind.value ?? 'hc'))
const gridRunner = makeRun({
  base: '/llm-grid',
  params: () => ({ variant: hcVariant.value, compact: rwdCompactKey.value, span: appliedSpanCap.value ?? panelLayer.value?.spanCap ?? 3 }),
  run: gridRun, tail: gridRunTail, text: gridRunText, logEl: gridLogEl,
  shouldRender: () => false, // 唯讀：跑的時候畫布照畫 RWD、不留白（串流顯示在面板）
  onStart: () => { cachedGrid = null; gridStats.value = null; gridMsg.value = null; gridApplied.value = false; llmApplySet(llmApplyKeys.value.grid, false) },
  onDone: () => { cachedGrid = null }, // 清空 → render 內重新載入結果供面板顯示＋切換
})
const startGridRun = gridRunner.start
// ---- 執行 LLM 互動結果（不用 LLM）----
// 跟「執行 LLM 評價結果」同一套：跑完的區間權重（colW/rowW）存在結果檔，這顆
// 「執行調整」只切換顯示——套用＝用 intervalAxes 重畫 RWD 的欄寬列高，恢復＝切回
// 均勻/流量網格。可來回比較，不重跑任何 LLM。
const gridApplied = ref(false)
function toggleGridExec() {
  if (!cachedGrid?.colW) return
  gridApplied.value = !gridApplied.value
  llmApplySet(llmApplyKeys.value.grid, gridApplied.value)
  rwdGridSeq++
  cachedRWD = null // sizeKey 不含套用狀態——直接作廢重畫
  render()
}
// ---- LLM 評價（RWD Maps「AI 評路網佈局」，skill route-llm-eval）----
// 同一套離線模式，但**只評價、不修改**：按鈕 POST /llm-eval/run（vite plugin
// spawn headless Claude Code），模型讀縮減網格佈局的幾何（逐線段方向、彎折數）
// 寫評語存 data/metro/llmevals/<city>.<variant>.<compact>.json，這裡只載入＋
// fingerprint 驗證，顯示在右側「LLM評價」tab——畫布完全不受影響。
const evalStats = ref(null)   // the whole llmeval file（右側 LLM評價 面板）
const evalMsg = ref(null)     // hint when the result is missing / stale
const evalRun = ref(null)     // null | 'running' | 'error'
const evalRunTail = ref('')
const evalRunText = ref('')
const evalLogEl = ref(null)   // 評價不蓋畫布 overlay——串流顯示在面板內（StylePanel 自捲）
let cachedEval = null         // fetched llmeval: { stats } or { miss }
const evalRunner = makeRun({
  base: '/llm-eval',
  params: () => ({ variant: hcVariant.value, compact: rwdCompactKey.value, span: appliedSpanCap.value ?? panelLayer.value?.spanCap ?? 3 }),
  run: evalRun, tail: evalRunTail, text: evalRunText, logEl: evalLogEl,
  shouldRender: () => false, // 唯讀評價：畫布照畫、不留白、不蓋 overlay
  onStart: () => { cachedEval = null; evalStats.value = null; evalMsg.value = null; evalApplied.value = false; llmApplySet(llmApplyKeys.value.eval, false) },
  onDone: () => { cachedEval = null },
})
const startEvalRun = evalRunner.start
// ---- LLM 全部評價（原始＋旋轉最多 22 個 RWD 候選一次比較，含七條論文鏈）----
// 選出全體／原始／旋轉三個最佳；評審只選擇、說明，不套用或修改候選佈局。
const compareRecord = ref(null)
const compareMsg = ref(null)
const compareRun = ref(null)
const compareRunTail = ref('')
const compareRunText = ref('')
const compareLogEl = ref(null)
async function loadCompare() {
  const cid = sourceLayer.value?.id
  if (!cid) return
  try {
    const res = await fetch(assetUrl(`data/metro/llmcompares/${cid}.json`), { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    compareRecord.value = await res.json()
    compareMsg.value = null
  } catch {
    compareRecord.value = null
    compareMsg.value = '尚未產生全部評價——按上面的按鈕一次比較原始與旋轉共最多 22 個 RWD Maps 結果。'
  }
}
const compareRunner = makeRun({
  base: '/llm-compare',
  params: () => ({}),
  run: compareRun, tail: compareRunTail, text: compareRunText, logEl: compareLogEl,
  shouldRender: () => false,
  onStart: () => { compareRecord.value = null; compareMsg.value = null },
  onDone: async () => { await loadCompare() },
})
const startCompareRun = compareRunner.start
const compareRunning = computed(() => compareRun.value === 'running')
const compareError = computed(() => compareRun.value === 'error' ? compareRunTail.value : '')
// 目前 RWD 路網視圖對應的比較候選 id（variant.compact）→ 右上角徽章。
const compareViewTags = computed(() => {
  const r = compareRecord.value
  if (!isRWD.value || !rwdMode.value || !r) return []
  const id = `${hcVariant.value}.${rwdCompactKey.value}`
  const tags = []
  if (r.winner === id) tags.push({ kind: 'all', label: '全部最佳' })
  if (r.winnerOrig === id) tags.push({ kind: 'orig', label: '原始最佳' })
  if (r.winnerRot === id) tags.push({ kind: 'rot', label: '旋轉最佳' })
  return tags
})
// ---- 執行 LLM 評價結果（不用 LLM）----
// 評價時 llmEval.mjs apply 已把評價附帶的 moves 經 applyLlmTargets（與 LLM 對齊
// 完全相同的硬規則）套用、把調整後佈局存進結果檔的 exec.cells——這裡的「執行
// 調整」只是切換顯示：套用＝用 exec.cells 取代縮減網格佈局重畫，恢復＝切回原
// 佈局。可來回切換比較前後差別，不重跑任何 LLM。
const evalApplied = ref(false)
function toggleEvalExec() {
  if (!evalStats.value?.exec?.cells) return
  evalApplied.value = !evalApplied.value
  llmApplySet(llmApplyKeys.value.eval, evalApplied.value)
  cachedRWD = null // sizeKey 不含套用狀態——直接作廢重畫
  render()
}
// The H/V-maximising post-passes (short-distance moves of coloured vertices
// AFTER the hill climbing — see skill route-hillclimb): the eight paper chains
// ①〜⑧ from paperAlign.js (names map 1:1 to data/thesis papers). Each is
// iterated to a FIXED POINT (fed its own output until nothing moves, cap
// POST_ITER_CAP). postIters drives the 「n/20」 badge on the tab button.
const postIters = ref({}) // kind -> iterations used (set once computed)
const iterBadge = (kind) =>
  (postIters.value[kind] ? ` ${postIters.value[kind]}/${POST_ITER_CAP}` : '')
const POST_BUILD = { ...PAPER_BUILD }
// 各 step 區塊的語意（kind 查詢一律走上方的 endKindOf/lineKindOf/…）：
// - 端點移動（左選單第 4 部份，鏈的第 1 步）：在該鏈的結果之上做端點移動
//   （原 tab 不變）。各鏈的拉直結果同時是該鏈直線縮減／縮減網格／RWD 底圖的輸入。
// - 直線縮減（第 5 部份，鏈的第 2 步）：在該鏈「端點拉直後」的結果之上，把直線
//   （跨相交點串接的共線段鏈）整條垂直於線平移（水平線只能上下移、垂直線只能
//   左右移），讓「佔用的欄列」越少越好、network 結構不變、全網 H/V 段數不減
//   （movewise：每個移動後即壓縮）；網格合併 tab 接在它之後。
// - 網格合併（第 6 部份，鏈的第 3 步）：①有色點只要入射段 ≤2 且同軸（左右兩段
//   水平/上下兩段垂直；藍點單段必可）就沿線往中位點（黃色圓標位置）滑動；
//   ②串接直線整條垂直於線往中位點移。H/V 與網格尺寸都不變。
// - 循環（第 8 部份）：交替 端點移動→直線縮減→網格合併→縮減網格，跑到某輪
//   「沒有點可以動」為止（straightenCompactLoop）。
// - Shape-Guided（循環與逐步之間）：對①〜⑧各鏈的**循環結果**跑論文貼形
//   （buildShapeAlign；規定表城市才算，否則略過）。不進 PAPER_KINDS／畫廊 RWD compact。
// - 逐步驗證：同一條四步鏈，由使用者按「下一步」一步步執行：每步＝
//   目前階段的一個單掃描（或一次縮減網格），掃不動自動換下一階段，一輪全沒動靜
//   ＝完成（stepChainInit/stepChainNext）。也沒有 hc 鏈（使用者 2026-07 裁決）。
// RWD 視圖建立在某個「縮減網格」之上：其 layer.compact（'hc' 或 PAPER_KIND_IDS
// 之一）決定要不要先套後處理再縮減（'hc'/未設＝基本縮減）。使 RWD 能選任一縮減網格變體。
const postKind = computed(() =>
  isHC.value ? postKindOf(mode.value)
    : isRWD.value && PAPER_KIND_IDS.includes(layer.value?.compact) ? layer.value.compact
      : null)
// 縮減網格已非獨立步驟（每一個移動後由 movewiseStage 自動壓縮）；hcCompact
// 只剩 RWD 圖層在用（其「循環結果」輸入視圖 id 沿用 'hc-compact'）。
const hcCompact = computed(() => mode.value.endsWith('compact') || isRWD.value)
// RWD 路網: redraw the compact layout with strict H/V/45° legs (rwdMap.js).
// 「LLM互動」（skill route-llm-grid）不是獨立視圖，而是同一個 RWD 路網上的一個
// 切換：按「執行調整」才用 LLM 推理的區間權重（結果檔 data/metro/llmgrids/）重畫
// 欄寬列高、「恢復原佈局」切回——與「LLM評價」的執行調整 toggle 同一套 UX。
const rwdMode = computed(() => mode.value === 'rwd')
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
let cachedPost = {}    // 論文鏈後處理結果, keyed by kind (PAPER_KIND_IDS)
let cachedLayout = {}  // Hill Climbing 區「格網→論文鏈」比較結果, keyed by LAYOUT_KIND_IDS
let cachedFp = null    // 本資料的內容指紋（localStorage 快取鍵用）
// 河流分隔曲折度「已套用」值（Map Adjust 工具列輸入是草稿；按確定才寫這裡並重算骨架）
const appliedRiverGraySinuosity = ref(null)

let cachedLlm = null   // fetched llmview (自動對齊): { cells, stats } or { miss: hint }
let cachedPrompt = null // fetched .prompt.json (指定對齊): { cells, stats } or { miss }
let cachedEndp = {}    // 端點移動 (movewiseStage 'endp')，keyed by 鏈 kind（①〜⑧＋'llm'）
let cachedLine = {}    // 直線縮減 (movewiseStage 'line')，keyed by 鏈 kind（①〜⑧＋'llm'）
let cachedGather = {}  // 網格合併 (movewiseStage 'gather')，keyed by 鏈 kind（①〜⑧＋'llm'）
let cachedLoop = {}    // 端點移動+直線縮減+網格合併+縮減網格循環 (straightenCompactLoop)，keyed by 鏈
let cachedShape = {}   // Shape-Guided（對①〜⑧循環結果貼形），keyed by 論文鏈 kind
let stepState = {}     // 逐步驗證 進度 (stepChainInit/Next 的 state)，keyed by 鏈；按「下一步」推進
let stepHistory = {}   // 逐步驗證 復原堆疊，keyed by 鏈：[{ st, kind:'big'|'sub' }]（上一步/上一小步用）
let cachedRWD = null // virtual-canvas routing — isotropic rescale on resize
// llmview（LLM 對齊）與 llmgrid（LLM 調整）結果檔的共用載入器：fetch →
// content-type 檢查 → fingerprint 比對（verts/segs 共通＋fpOk 額外欄位）→
// 對應 miss 訊息；成功回 onOk(j)。呼叫端自己處理 renderSeq 過期。
async function fetchLlmResult(url, { missNone, missStale, missErr, fpOk, onOk, dims }) {
  try {
    const res = await fetch(assetUrl(url))
    const isJson = (res.headers.get('content-type') ?? '').includes('json')
    const j = res.ok && isJson ? await res.json() : null
    if (!j) return { miss: missNone }
    const fp = j.fingerprint ?? {}
    const vOk = fp.verts === cachedHC.stats.verts
    const sOk = fp.segs === cachedHC.stats.segs
    const extraOk = fpOk(fp)
    if (!vOk || !sOk || !extraOk) {
      // 診斷：印出「結果檔存的指紋 vs 網頁此刻實算」哪一欄對不上（stale 定位用）。
      const webCR = dims ? `${dims[0]}×${dims[1]}` : '?'
      const diag = `檔 v${fp.verts}/s${fp.segs}/${fp.cols}×${fp.rows}｜網頁 v${cachedHC.stats.verts}/s${cachedHC.stats.segs}/${webCR}｜不符：${[!vOk && 'verts', !sOk && 'segs', !extraOk && 'cols/rows'].filter(Boolean).join('、')}`
      console.warn('[llm-stale]', url, {
        fileFingerprint: fp,
        webVerts: cachedHC.stats.verts, webSegs: cachedHC.stats.segs, webDims: dims,
        vertsMatch: vOk, segsMatch: sOk, colsRowsMatch: extraOk,
      })
      return { miss: `${missStale}\n[診斷] ${diag}` }
    }
    return onOk(j)
  } catch { return { miss: missErr } }
}
const hcBusy = ref(false)
const busyText = ref('')
const hcStats = ref(null)
const layoutStats = ref(null)    // Hill Climbing 區 layout-* 比較視圖的 stats
// 各佈局實際算了多久（毫秒）——tab 名後面標注用。key：`hc`（②初步直線化本體）、
// `layout-<kind>`（初步直線化群組的 ①〜⑧ 比較）、`post-<kind>`（直線演算法鏈）。
// 值跟著快取走：算過就一直是那個數字，按「重新計算此城市全部圖層」清掉才重算。
const calcMs = ref({})
const calcNotes = ref({}) // 論文鏈等：時間後加註；Shape-Guided 略過／錯誤 → 不顯示 ms
const shapeRouteName = ref(null) // 規定路線名（例：山手線）；有算過才顯示
const shapeNoNeed = ref(false)   // 規定外／無法安全成方 → 整組不顯示計算時間
const shapeFailLabel = ref(null) // '不需計算' | null
function syncCalcMs() {
  const out = {}
  const notes = {}
  if (cachedHC?.stats?.ms != null) out.hc = cachedHC.stats.ms
  for (const k of Object.keys(cachedLayout)) {
    const st = cachedLayout[k]?.stats
    if (!st) continue
    if (k === 'shape' && (st.skipped || st.note === '不需計算')) {
      notes[`layout-${k}`] = '不需計算'
      continue
    }
    if (st.ms != null) out[`layout-${k}`] = st.ms
    // Shape-Guided 成功的 →方 不佔 badge（與①〜⑧比較列一致）
    if (st.note && k !== 'shape') notes[`layout-${k}`] = st.note
  }
  for (const k of Object.keys(cachedPost)) {
    if (cachedPost[k]?.stats?.ms != null) out[`post-${k}`] = cachedPost[k].stats.ms
    if (cachedPost[k]?.stats?.note) notes[`post-${k}`] = cachedPost[k].stats.note
  }
  let shapeRoute = null
  let anyShape = false
  let anyShapeOk = false
  for (const k of Object.keys(cachedShape)) {
    const st = cachedShape[k]?.stats
    if (!st) continue
    anyShape = true
    if (st.skipped) {
      // 規定外／格網無法安全成方：不顯示時間，寫「不需計算」
      notes[`shape-${k}`] = '不需計算'
      if (st.route) shapeRoute = st.route
    } else {
      anyShapeOk = true
      if (st.ms != null) out[`shape-${k}`] = st.ms
      if (st.route) shapeRoute = st.route
    }
  }
  calcMs.value = out
  calcNotes.value = notes
  shapeRouteName.value = shapeRoute
  // 有任一成功 → 標題寫路線；否則若已有結果且全略過 → 不需計算
  shapeNoNeed.value = anyShape && !anyShapeOk
  shapeFailLabel.value = anyShape && !anyShapeOk ? '不需計算' : null
}
// 「88ms」/「1.2s」；沒算過回空字串（tab 名就不帶標注）。
const msText = (ms) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)
const msBadge = (key) => {
  const n = calcNotes.value[key]
  if (n === '不需計算') return ' · 不需計算'
  const t = msText(calcMs.value[key])
  if (!t) return ''
  return n ? ` · ${t} · ${n}` : ` · ${t}`
}
const postStats = ref(null)      // { hvBefore, hvAfter, segs, moved, ... }
const hcCompactStats = ref(null) // { fromCols, fromRows, cols, rows }
const endpStats = ref(null)      // 端點移動: { hvBefore, hvAfter, segs, moved, endpoints, iters, ... }
const lineStats = ref(null)      // 直線縮減: { hvBefore, hvAfter, segs, moved, iters, fromCols, ..., converged }
const gatherStats = ref(null)    // 網格合併: { moved, segs, verts, iters, iterCap, converged }
const stepInfo = ref(null)       // 逐步驗證: { info, steps, round, done }（顯示在浮動面板）
const loopStats = ref(null)      // 循環: { hvBefore, hvAfter, segs, moved, lineMoved, rounds, fromCols, ..., converged }
const shapeStats = ref(null)     // Shape-Guided: { note, route, shapeZh, skipped, moved, ... }
const rwdStats = ref(null)       // { straight, single, double, fallback, segs }
// ---- 權重驅動版面簡化（RWD Maps 左側「權重」tab，論文 §九）----
// weight 掛在 cut-to-cut 段上；'weight' 模式時 weight → 非均勻欄寬列高 → 在新像素座標
// 重跑 buildRwdMap。'uniform' = 均勻網格（預設，欄寬列高隨板面拉伸填滿）。
// 'square' = 方形網格（格子強制正方，取 min(欄寬,列高) 為單位、置中 letterbox）。
// 'weight' = 權重網格。全部隨機每按一次整表重抽。
const rwdWeightMode = ref('uniform') // 'uniform' | 'square' | 'weight'
const rwdDirs = ref(8)               // RWD 允許的線方向數：4（只H/V）| 8（+45°，預設）| 16（+22.5°）
const rwdFrameId = ref('auto')       // 版面尺寸：目前面板／網頁／手機／IG（模擬 RWD）
const rwdFrameInfo = computed(() => resolveRwdFrame(rwdFrameId.value, 0, 0))
const rwdShowWeights = ref(true)     // 是否顯示 weight 數字（開關）
const rwdWeights = ref(new Map())    // segKey -> 1..9
let rwdWeightSeq = 0                  // 重抽計數，併進 RWD 快取鍵
let cachedSegs = null                 // 本資料的 cut-to-cut segs（供權重面板重抽）
// 自動隱藏白點（直通站）：站距 < 門檻(pt)才刪，逐級升高 weight 差門檻直到站距達標。
const rwdHideStops = ref(false)
const rwdMinStopPx = ref(5)
const rwdStopStat = ref(null) // { high, wide, hidden, hiddenNames, hiddenMaxT }
// 滑鼠放大鏡（魚眼變形，只 RWD）：開啟後游標所在細格為焦點，附近欄／列撐開、
// 遠處壓扁，外框固定（見 skill 「路網網格_2」）。footer 同時顯示游標座標。
const fisheyeOn = ref(false)
const fisheyeInfo = ref(null)  // footer 顯示：{ x, y, col, row }（游標所在像素＋粗格欄列）
let fisheyeAxes = null         // { xs, ys }：藍色示意網格的粗格邊界（footer 欄列＋外框範圍）
let fisheyeRaf = 0             // 緩動迴圈的 rAF handle
let feCur = null               // 目前（緩動中）焦點與強度：{ x, y, s∈[0,1] }
let feTarget = null            // 目標焦點：{ x, y, on }（on＝游標是否在有效框內）
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
  rwdWeightMode.value = m // 回均勻／方形網格：瞬時（無動畫）
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
// 允許的線方向數（4/8/16）：改了要作廢 RWD 快取重畫（候選集不同）。
function setRwdDirs(n) { rwdDirs.value = n; cachedRWD = null; render() }
function setRwdFrame(id) { rwdFrameId.value = id; cachedRWD = null; render() }
function setRwdHideStops(on) { rwdHideStops.value = on; cachedRWD = null; render() }
// 放大鏡開關：關掉時停緩動、清焦點與座標讀數，重畫回均勻（線在均勻格重繞）。
function setFisheye(on) {
  fisheyeOn.value = on
  if (!on) { stopFisheyeAnim(); feCur = null; feTarget = null; fisheyeInfo.value = null; render() }
}
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
      { header: '輸入', doc: 'movewise-loop' },
      { id: 'hc-compact', label: '循環結果' },
      { header: '結果', doc: 'rwd' },
      { id: 'rwd', label: 'RWD 路網' },
      // 「LLM互動」不再是獨立視圖——改成右側面板 tab ＋ RWD 路網上的「執行調整」
      // 切換（見 gridApplied），左邊列表不再列它。
    ]
  }
  if (isHC.value) {
    // 左選單分 8 個部份：原始／初步直線化／直線演算法／端點移動／直線縮減
    // ／網格合併／端點移動+直線縮減+網格合併循環／逐步驗證
    // （header 項是分組標題，可點開合——見下方 navSections；全部左側功能列
    // 共用同一套分組版面，Map Adjust／RWD 的清單也有 header）。
    return [
      { header: '原始', doc: 'grid' },
      { id: 'grid-post', label: hcVariant.value === 'rot' ? `${rotLabel.value}格網化後` : '原始格網化後' },
      // 8 個主佈局比較（格網化後為輸入；②＝爬山，其餘＝論文鏈直接餵格網）
      // ＋⑨ Shape-Guided。只供觀看，不進下游；下游仍只吃 `hc`——
      // 標籤特別註記「往後執行」／「僅比較」。
      { header: '初步直線化', doc: 'hillclimb' },
      { id: 'layout-stroke', label: `①筆畫法（僅比較）${msBadge('layout-stroke')}` },
      { id: 'hc', label: `②Hill Climbing（往後執行）${msBadge('hc')}` },
      ...LAYOUT_KINDS.filter((p) => p.kind !== 'stroke').map(({ kind, zh }) => ({
        id: `layout-${kind}`, label: `${zh}（僅比較）${msBadge(`layout-${kind}`)}`,
      })),
      { id: 'layout-shape', label: `⑨Shape-Guided（僅比較）${msBadge('layout-shape')}` },
      // iterated-to-fixed-point passes: the button carries 「已迭代/上限」
      { header: '直線演算法', doc: 'straighten' },
      // 論文①〜⑧的八條鏈（paperAlign.js PAPER_KINDS——名稱帶論文圈號，與
      // data/thesis/<n>_*_演算法說明.md 一一對應）＋ LLM 對齊，共 9 條。
      ...PAPER_KINDS.map(({ kind, zh }) => ({
        id: `hc-${kind}`, label: `${zh}${iterBadge(kind)}${msBadge(`post-${kind}`)}`,
      })),
      // 第九種（LLM）: the badge carries the rounds AND the model that produced it
      { id: 'hc-llm', label: `LLM 對齊${llmInfo.value ? ` ${llmInfo.value.rounds}輪 · ${llmInfo.value.model}` : ''}` },
      // 鏈的三步＋循環（每步一區、每條鏈一個 tab）：該鏈結果 → 端點移動 →
      // 直線縮減 → 網格合併 → 循環；再 Shape-Guided（只①〜⑧循環結果）→ 逐步驗證。
      ...[
        ['end', '端點移動', (zh) => `${zh}端點移動`, 'endpoint-move'],
        ['line', '直線縮減', (zh) => `${zh}直線縮減`, 'line-compact'],
        ['gather', '網格合併', (zh) => `${zh}網格合併`, 'grid-merge'],
        ['loop', '端點移動+直線縮減+網格合併循環', (zh) => `${zh}循環`, 'movewise-loop'],
      ].flatMap(([step, header, fmt, doc]) => [
        { header, doc },
        ...[...PAPER_KINDS.map(({ kind, zh }) => [kind, zh]), ['llm', 'LLM 對齊']]
          .map(([k, zh]) => ({ id: `hc-${k}-${step}`, label: fmt(zh) })),
      ]),
      // Shape-Guided：規定城市寫路線名；規定外 →「Shape-Guided 不需計算」
      {
        header: shapeRouteName.value
          ? `Shape-Guided ${shapeRouteName.value}`
          : shapeFailLabel.value
            ? `Shape-Guided ${shapeFailLabel.value}`
            : 'Shape-Guided',
        doc: 'shape-guided',
      },
      ...PAPER_KINDS.map(({ kind, zh }) => ({
        id: `hc-${kind}-shape`,
        label: `${zh}${msBadge(`shape-${kind}`)}`,
      })),
      { header: '逐步驗證', doc: 'step-verify' },
      ...[...PAPER_KINDS.map(({ kind, zh }) => [kind, zh]), ['llm', 'LLM 對齊']]
        .map(([k, zh]) => ({ id: `hc-${k}-step`, label: `${zh}逐步` })),
    ]
  }
  return [
    { header: '原始', doc: 'original' },
    { id: 'original', label: '原始' },
    { id: 'rotated', label: rotLabel.value, rot: true },
    { header: '骨架化', doc: 'skeleton' },
    { id: 'skeleton', label: '原始骨架化' },
    { id: 'rotated-skeleton', label: `${rotLabel.value}骨架化`, rot: true },
    { header: '格網化', doc: 'grid' },
    { id: 'grid-orig-pre', label: '原始格網化前' },
    { id: 'grid-orig-post', label: '原始格網化後' },
    { id: 'grid-rot-pre', label: `${rotLabel.value}格網化前`, rot: true },
    { id: 'grid-rot-post', label: `${rotLabel.value}格網化後`, rot: true },
  ]
})
const navSections = computed(() => {
  let cur = { header: null, items: [] }
  const secs = [cur]
  for (const t of VIEW_TABS.value) {
    if (t.header) { cur = { header: t.header, doc: t.doc, items: [] }; secs.push(cur) }
    else cur.items.push(t)
  }
  return secs.filter((s) => s.header || s.items.length)
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
// 逐步驗證：「下一步」執行整個 movewise 階段、「下一小步」只做一個點/線
// 的移動（limit=1），「上一步/上一小步」從復原堆疊回退，「重設」回到鏈的
// 起點。stepState/stepHistory 不是 reactive——推進後靠 render() 重畫、
// stepInfo ref 更新面板（含 hist 長度驅動按鈕 disabled）。
function stepNext(limit) {
  const kind = stepKindOf(mode.value)
  if (!kind || !stepState[kind] || !cachedSkeleton) return
  const prev = stepState[kind]
  const next = stepChainNext(cachedSkeleton, prev, limit ? { limit } : {})
  if (next === prev) return // 已完成——沒有新動作就不進堆疊
  ;(stepHistory[kind] ??= []).push({ st: prev, kind: limit === 1 ? 'sub' : 'big' })
  if (stepHistory[kind].length > 400) stepHistory[kind].shift()
  stepState[kind] = next
  render()
}
// 上一小步＝回退一個動作；上一步＝一路吞掉其後的小步、回退到上一個大步之前
// （堆疊裡沒有大步時退回起點）。
function stepPrev(sub) {
  const kind = stepKindOf(mode.value)
  const hist = stepHistory[kind]
  if (!kind || !hist?.length) return
  let entry = hist.pop()
  if (!sub) while (entry.kind === 'sub' && hist.length) entry = hist.pop()
  stepState[kind] = entry.st
  render()
}
function stepReset() {
  const kind = stepKindOf(mode.value)
  if (!kind) return
  delete stepState[kind]
  delete stepHistory[kind]
  render()
}

// 均勻藍色分隔網格（格線在刻度上、穿過格心）——HC/RWD 兩個分支共用。
function uniformBlue(nC, nR, cw, ch) {
  return {
    xs: Array.from({ length: nC + 1 }, (_, i) => 24 + i * cw),
    ys: Array.from({ length: nR + 1 }, (_, i) => 24 + i * ch),
  }
}

// 換了一份資料（載入新城市/匯入檔）：重算 tilt 與 connect 骨架、作廢所有衍生
// 快取與統計 ref、重建 hover 索引，並試著從 localStorage 載回這份資料的爬山結果。
function resetPerDataset(data) {
  cacheData = data
  tilt.value = computeOrientation(data).tilt
  // 已套用門檻存在共用 panelLayer.riverGraySinuosityApplied（按確定才寫）；草稿是
  // riverGraySinuosity。Straighten／RWD 與 Map Adjust 綁同一 panelLayer。
  const applied = panelLayer.value?.riverGraySinuosityApplied
    ?? panelLayer.value?.riverGraySinuosity
    ?? DEFAULT_RIVER_GRAY_SINUOSITY
  const th = Math.max(1.01, Math.round((+applied || DEFAULT_RIVER_GRAY_SINUOSITY) * 100) / 100)
  appliedRiverGraySinuosity.value = th
  if (panelLayer.value) {
    if (panelLayer.value.riverGraySinuosity == null) panelLayer.value.riverGraySinuosity = th
    if (panelLayer.value.riverGraySinuosityApplied == null) panelLayer.value.riverGraySinuosityApplied = th
  }
  cachedSkeleton = buildConnectSkeleton(data, { riverGraySinuosity: th })
  cachedHC = null
  cachedPost = {}
  cachedLayout = {}
  cachedLlm = null
  cachedPrompt = null
  cachedGrid = null
  cachedEval = null
  cachedEndp = {}
  cachedLine = {}
  cachedGather = {}
  cachedLoop = {}
  cachedShape = {}
  stepState = {}
  stepHistory = {}
  cachedRWD = null
  hcStats.value = null
  layoutStats.value = null
  postStats.value = null
  shapeStats.value = null
  shapeRouteName.value = null
  shapeNoNeed.value = false
  shapeFailLabel.value = null
  postIters.value = {}
  llmInfo.value = null
  llmStats.value = null
  gridInfo.value = null
  gridStats.value = null
  evalStats.value = null
  evalMsg.value = null
  hcCompactStats.value = null
  endpStats.value = null
  lineStats.value = null
  gatherStats.value = null
  stepInfo.value = null
  loopStats.value = null
  rwdStats.value = null
  // 跨 reload 快取：先算內容指紋，試著從 localStorage 載回本資料的 HC / 後處理 cells，
  // 命中就免跑爬山（資料變 → 指紋變 → 不命中 → 下面重算並覆寫）。
  tipIdx = buildPopupIndex(data) // hover 索引（refColor/segs/站點）——per dataset 一次
  cachedFp = `${dataFingerprint(data)}:rg${th}`
  const hit = loadHcCache(`${cachedFp}:${hcVariant.value}`)
  if (hit) { cachedHC = hit.hc; cachedPost = hit.posts; cachedLayout = hit.layouts ?? {} }
  syncCalcMs()
}

// 爬山鏈的佈局計算（render 的第 2 段）：在 grid 之上跑 Hill Climbing（含
// localStorage 快取與結構驗證）→ 後處理／LLM 對齊 → movewise 三步鏈／循環／
// 逐步驗證 → RWD 畫線，得到「這一幀要畫的座標」。回傳 { hcPos, hcBlue,
// rwdLines, stepMoves }；計算途中被更新的 render 蓋過（seq 過期）回傳 null。
async function computeHcLayout({ seq, w, h, grid }) {
  let hcPos = null, hcBlue = null, rwdLines = null, weighted = false, stepMoves = []
  // 跨距上限（預設 3）用「已套用」的值（appliedSpanCap）——滑桿改了但還沒按「重新
  // 計算」前，快取與新計算都維持舊上限，避免同畫面新舊混雜。
  if (appliedSpanCap.value == null) appliedSpanCap.value = panelLayer.value?.spanCap ?? 3
  setSpanCap(appliedSpanCap.value)

  // Hill Climbing 區的 layout-* 比較視圖：論文鏈直接餵格網化後，不跑爬山、不進下游。
  {
    const layoutKind = layoutKindOf(mode.value)
    if (layoutKind) {
      if (!cachedLayout[layoutKind]) {
        hcBusy.value = true
        busyText.value = {
          stroke: '①筆畫法中…（格網 → 筆畫串接，迭代到不動）',
          milp: '③MILP規劃中…（格網 → 方向指派，迭代到不動）',
          force: '④力導向中…（格網 → 磁力彈簧，迭代到不動）',
          lsq: '⑤最小平方中…（格網 → Gauss–Seidel，迭代到不動）',
          octi: '⑥八向格網中…（格網 → 逐邊定案，迭代到不動）',
          path: '⑦路徑簡化中…（格網 → C-directed 簡化，迭代到不動）',
          sat: '⑧SAT規劃中…（格網 → DPLL 指派，迭代到不動）',
          shape: '⑨Shape-Guided中…（格網 → 規定路段嵌形）',
        }[layoutKind]
        await new Promise((r) => setTimeout(r, 30))
        if (seq !== renderSeq) { hcBusy.value = false; return null }
        const t0 = performance.now()
        if (layoutKind === 'shape') {
          const cityId = sourceLayer.value?.id ?? null
          cachedLayout[layoutKind] = iteratePost(
            buildShapeAlign, cachedSkeleton, grid.cellOf, grid.cols, grid.rows, { cityId })
        } else {
          cachedLayout[layoutKind] = iteratePost(
            POST_BUILD[layoutKind], cachedSkeleton, grid.cellOf, grid.cols, grid.rows)
        }
        cachedLayout[layoutKind].stats.ms = Math.round(performance.now() - t0)
        hcBusy.value = false
        // 算過就存下來（同 ② 與後處理鏈）：關 tab／重新整理都直接載回，只有按
        // 「重新計算此城市全部圖層」才清掉重算。
        saveHcCache(`${cachedFp}:${hcVariant.value}`, cachedHC, cachedPost, cachedLayout)
        syncCalcMs()
      }
      layoutStats.value = cachedLayout[layoutKind].stats
      const cells = cachedLayout[layoutKind].cellAfter
      const nC = grid.cols, nR = grid.rows
      const cw = (w - 48) / nC, ch = (h - 48) / nR
      const cellPx = ([c, r]) => [24 + (c + 0.5) * cw, 24 + (r + 0.5) * ch]
      hcPos = new Map()
      for (const [id, p] of cells) hcPos.set(id, cellPx(p))
      placeBlacks(cachedSkeleton, hcPos, (id) => grid.posAfter.get(id) ?? null)
      hcBlue = uniformBlue(nC, nR, cw, ch)
      return { hcPos, hcBlue, rwdLines, stepMoves }
    }
  }
  layoutStats.value = null

  // 兜底結構驗證：快取的爬山結果必須（a）涵蓋目前格網的所有節點、且（b）每個格子都落在
  // 目前格網範圍 [0,cols)×[0,rows) 內。演算法/分類改版後，同一份資料的舊快取可能：節點集
  // 對不上（缺格子＝RWD/HC 線消失、站懸空），或座標空間變大（如河流分類改變使 cols/rows
  // 縮小，但舊快取的格子仍在較大空間 → 畫在新的較小格網上會**超出網格**）。任一不符即作廢重算。
  const cacheStale = cachedHC && (
    ![...grid.cellOf.keys()].every((id) => cachedHC.cellAfter.has(id))
    || [...cachedHC.cellAfter.values()].some(([c, r]) => c < 0 || r < 0 || c >= grid.cols || r >= grid.rows)
  )
  if (cacheStale) {
    cachedHC = null
    cachedPost = {}
  }
  if (!cachedHC) {
    hcBusy.value = true
    busyText.value = '爬山最佳化中…（多準則適應度 + 硬規則掃描）'
    await new Promise((r) => setTimeout(r, 30)) // let the busy hint paint first
    if (seq !== renderSeq) { hcBusy.value = false; return null } // superseded
    const t0 = performance.now()
    cachedHC = buildHillClimb(cachedSkeleton, grid.cellOf, grid.cols, grid.rows)
    cachedHC.stats.ms = Math.round(performance.now() - t0)
    hcBusy.value = false
    saveHcCache(`${cachedFp}:${hcVariant.value}`, cachedHC, cachedPost, cachedLayout) // 存下爬山結果，下次載檔免重算
    syncCalcMs()
  }
  hcStats.value = cachedHC.stats
  let cells = cachedHC.cellAfter, nC = grid.cols, nR = grid.rows
  // H/V-maximising post-pass tabs: same grid, short-distance vertex moves on
  // top of the hill-climbing result (each kind cached once per dataset).
  if (postKind.value) {
    const kind = postKind.value
    if (!cachedPost[kind]) {
      hcBusy.value = true
      busyText.value = { stroke: '①筆畫法中…（筆畫串接 + 4 主方向投影，迭代到不動）',
        rect: '②直角爬山中…（|sin 2θ| 短半徑再爬，迭代到不動）',
        milp: '③MILP規劃中…（3 候選方向精確指派 + 座標重建，迭代到不動）',
        force: '④力導向中…（磁力彈簧 40 輪 + 嚴格接受，迭代到不動）',
        lsq: '⑤最小平方中…（八方向化 Gauss–Seidel，迭代到不動）',
        octi: '⑥八向格網中…（ldeg 排序逐邊定案 + 嚴格接受，迭代到不動）',
        path: '⑦路徑簡化中…（C-directed 最少 link 刺穿，迭代到不動）',
        sat: '⑧SAT規劃中…（DPLL 分支定界方向指派，迭代到不動）' }[kind]
      await new Promise((r) => setTimeout(r, 30))
      if (seq !== renderSeq) { hcBusy.value = false; return null } // superseded
      const t0 = performance.now()
      cachedPost[kind] = iteratePost(POST_BUILD[kind], cachedSkeleton, cachedHC.cellAfter, grid.cols, grid.rows)
      cachedPost[kind].stats.ms = Math.round(performance.now() - t0)
      hcBusy.value = false
      saveHcCache(`${cachedFp}:${hcVariant.value}`, cachedHC, cachedPost, cachedLayout) // 併入後處理結果一起存
      syncCalcMs()
    }
    postStats.value = cachedPost[kind].stats
    postIters.value = { ...postIters.value, [kind]: cachedPost[kind].stats.iters }
    cells = cachedPost[kind].cellAfter
  }
  // 第四種「LLM 對齊」: precomputed offline (skill route-llm-align) — fetch
  // the llmview for this city+variant and verify it matches THIS dataset's
  // HC result (fingerprint), otherwise explain how to (re)generate it.
  if (useLlm.value) {
    // 唯讀載入對齊結果供面板顯示＋切換用（跟評價/互動一樣，跑的時候不阻擋畫圖：
    // 沒有結果或未套用時就照畫對齊前的 base 佈局，不留白）。
    let justLlm = false
    if (!cachedLlm && llmRun.value !== 'running') {
      const cid = sourceLayer.value?.id
      cachedLlm = !cid
        ? { miss: '匯入資料不支援 LLM 對齊（沒有城市 id 可對應結果檔）' }
        : await fetchLlmResult(`data/metro/llmviews/${cid}.${hcVariant.value}.json`, {
          missNone: `尚未產生 LLM 對齊——按「開始 LLM 對齊」讓模型移動座標`,
          missStale: 'LLM 對齊結果與目前資料不符（資料已更新）——請重新產生',
          missErr: '無法載入 LLM 對齊結果',
          fpOk: (fp) => fp.cols === grid.cols && fp.rows === grid.rows
            && fp.hvStart === cachedHC.stats.hvAfter,
          onOk: (j) => ({ cells: new Map(j.cellAfter.map(([id, c, r]) => [id, [c, r]])), stats: j }),
        })
      if (seq !== renderSeq) return null // superseded during fetch
      justLlm = true
    }
    if (cachedLlm?.cells) {
      llmStats.value = cachedLlm.stats
      llmInfo.value = { rounds: cachedLlm.stats.rounds, model: cachedLlm.stats.model }
      // 首次載到結果時，從 localStorage 恢復上次「已套用」狀態（見 llmApplyKeys）。
      if (justLlm) llmApplied.value = llmApplyGet(llmApplyKeys.value.auto)
    } else {
      llmStats.value = null
      llmMsg.value = cachedLlm?.miss ?? null
      llmApplied.value = false
    }
    // 「指定對齊」（.prompt.json）只在 LLM 對齊主視圖載入＋比較用，不餵下游。
    const onMainAlign = isHC.value && mode.value === 'hc-llm'
    let justPrompt = false
    if (onMainAlign && !cachedPrompt && promptRun.value !== 'running') {
      const cid = sourceLayer.value?.id
      cachedPrompt = !cid
        ? { miss: '匯入資料不支援 LLM 對齊（沒有城市 id 可對應結果檔）' }
        : await fetchLlmResult(`data/metro/llmviews/${cid}.${hcVariant.value}.prompt.json`, {
          missNone: '尚未產生指定對齊——在下面輸入一句話讓模型依指示對齊',
          missStale: '指定對齊結果與目前資料不符（資料已更新）——請重新產生',
          missErr: '無法載入指定對齊結果',
          fpOk: (fp) => fp.cols === grid.cols && fp.rows === grid.rows
            && fp.hvStart === cachedHC.stats.hvAfter,
          onOk: (j) => ({ cells: new Map(j.cellAfter.map(([id, c, r]) => [id, [c, r]])), stats: j }),
        })
      if (seq !== renderSeq) return null // superseded during fetch
      justPrompt = true
    }
    if (onMainAlign) {
      if (cachedPrompt?.cells) {
        promptStats.value = cachedPrompt.stats
        // 首次載到結果時恢復上次「已套用」狀態；與自動對齊互斥。
        if (justPrompt && llmApplyGet(llmApplyKeys.value.prompt)) { promptApplied.value = true; llmApplied.value = false }
      }
      else { promptStats.value = null; promptMsg.value = cachedPrompt?.miss ?? null; promptApplied.value = false }
    }
    // 套用規則：
    // - LLM 對齊主視圖（'hc-llm'）與其下游鏈（hc-llm-*）＝跟著「目前顯示的佈局」：
    //   指定 > 自動 > base HC（互斥 toggle）。鏈以此為輸入，toggle 變就重算（見
    //   toggleLlmExec/togglePromptExec 的 invalidateLlmDownstream）。
    // - RWD 'llm' compact（另一個 layer、沒有 toggle）＝以「自動對齊」為基準。
    if (isRWD.value) {
      if (cachedLlm?.cells) cells = cachedLlm.cells
    } else {
      if (promptApplied.value && cachedPrompt?.cells) cells = cachedPrompt.cells
      else if (llmApplied.value && cachedLlm?.cells) cells = cachedLlm.cells
      // 否則維持 base HC（cells 未動）
    }
  }
  // 鏈的後處理順序：端點移動 → 直線縮減 → 網格合併（循環 tab 另走
  // straightenCompactLoop）。三個階段都是 movewise（movewiseStage）——
  // 使用者規則：**取消獨立的縮減網格步驟，每一個小步驟（單一移動）完成後
  // 就做縮減網格**，所以每個 tab 的網格隨時緻密、尺寸逐階段縮小。
  // ① 端點移動: 每個非白點可把一個座標吸到某鄰居的欄/列，僅淨增 H/V 才動，
  // 走同一套硬規則。Applies to the -end tabs AND as step 1 under
  // 直線縮減/網格合併。
  // RWD 不走下面 ①〜③ 的單趟鏈——改建立在「循環」（straightenCompactLoop）
  // 的結果上（使用者 2026-07 裁決），見下方 loop 區塊的 isRWD fallback。
  {
    const endKind = endKindOf(mode.value) ?? lineKindOf(mode.value) ?? gatherKindOf(mode.value)
    if (endKind) {
      if (!cachedEndp[endKind]) cachedEndp[endKind] = movewiseStage('endp', cachedSkeleton, cells, nC, nR)
      cells = cachedEndp[endKind].cellAfter
      nC = cachedEndp[endKind].cols
      nR = cachedEndp[endKind].rows
      endpStats.value = cachedEndp[endKind].stats
    }
  }
  // ② 直線縮減: rigid PERPENDICULAR shifts of whole straight lines
  // (stitched across intersections; H lines move vertically, V lines
  // horizontally) on the straightened layout — the network structure and
  // the network-wide H/V count never degrade. Applies to the -line tabs
  // AND under 網格合併.
  {
    const lineKind = lineKindOf(mode.value) ?? gatherKindOf(mode.value)
    if (lineKind) {
      if (!cachedLine[lineKind]) cachedLine[lineKind] = movewiseStage('line', cachedSkeleton, cells, nC, nR)
      cells = cachedLine[lineKind].cellAfter
      nC = cachedLine[lineKind].cols
      nR = cachedLine[lineKind].rows
      lineStats.value = cachedLine[lineKind].stats
    }
  }
  // ③ 網格合併: 有色點（入射段 ≤2 且同軸；藍點必可）沿線滑動＋串接直線
  // 整條垂直平移，都往中位點。Applies to the -gather tabs.
  {
    const gatherKind = gatherKindOf(mode.value)
    if (gatherKind) {
      if (!cachedGather[gatherKind]) cachedGather[gatherKind] = movewiseStage('gather', cachedSkeleton, cells, nC, nR)
      cells = cachedGather[gatherKind].cellAfter
      nC = cachedGather[gatherKind].cols
      nR = cachedGather[gatherKind].rows
      gatherStats.value = cachedGather[gatherKind].stats
    }
  }
  // 循環 tabs: on the chain's result, rounds of the three movewise stages
  // until a round moves nothing (straightenCompactLoop).
  // Shape-Guided tabs 也先跑循環（輸入＝①〜⑧循環結果）。
  {
    // RWD（含其「縮減網格」輸入視圖）也走這裡：建立在該鏈的循環結果之上。
    const loopKind = loopKindOf(mode.value)
      ?? shapeKindOf(mode.value)
      ?? (isRWD.value ? rwdCompactKey.value : null)
    if (loopKind) {
      if (!cachedLoop[loopKind]) cachedLoop[loopKind] = straightenCompactLoop(cachedSkeleton, cells, nC, nR)
      cells = cachedLoop[loopKind].cellAfter
      nC = cachedLoop[loopKind].cols
      nR = cachedLoop[loopKind].rows
      loopStats.value = cachedLoop[loopKind].stats
      if (isRWD.value) hcCompactStats.value = { fromCols: grid.cols, fromRows: grid.rows, cols: nC, rows: nR }
    }
  }
  // Shape-Guided：在①〜⑧循環結果上貼形（各鏈獨立；規定表無此城才整組不需計算）
  {
    const sk = shapeKindOf(mode.value)
    if (sk) {
      if (!cachedShape[sk]) {
        // 僅「規定外／找不到規定路段」可共享；貼方失敗不可連坐其他鏈
        if (shapeNoNeed.value && shapeFailLabel.value === '不需計算') {
          const sample = Object.values(cachedShape).find(
            (v) => v?.stats?.skipped && v?.stats?.note === '不需計算' && !v?.stats?.routeSegment,
          )
          if (sample) cachedShape[sk] = sample
        }
        if (!cachedShape[sk]) {
          hcBusy.value = true
          busyText.value = `Shape-Guided中…（${PAPER_ZH[sk] ?? sk}循環）`
          await new Promise((r) => setTimeout(r, 30))
          if (seq !== renderSeq) { hcBusy.value = false; return null }
          const t0 = performance.now()
          const cityId = sourceLayer.value?.id ?? null
          cachedShape[sk] = iteratePost(buildShapeAlign, cachedSkeleton, cells, nC, nR, { cityId })
          cachedShape[sk].stats.ms = Math.round(performance.now() - t0)
          // 規定表無此城（沒有 routeSegment）→ ①〜⑧ 都不必再跑
          if (cachedShape[sk].stats.skipped && !cachedShape[sk].stats.routeSegment) {
            cachedShape[sk].stats.note = '不需計算'
            for (const { kind } of PAPER_KINDS) {
              if (!cachedShape[kind]) cachedShape[kind] = cachedShape[sk]
            }
          }
          hcBusy.value = false
          syncCalcMs()
        }
      }
      cells = cachedShape[sk].cellAfter
      shapeStats.value = cachedShape[sk].stats
    } else {
      shapeStats.value = null
    }
  }
  // 逐步驗證 tabs: 顯示逐步執行的當前佈局（按「下一步」由 stepNext
  // 推進 stepState 後重畫；見 stepKindOf）。
  {
    const stepKind = stepKindOf(mode.value)
    if (stepKind) {
      if (!stepState[stepKind]) stepState[stepKind] = stepChainInit(cachedSkeleton, cells, nC, nR)
      const st = stepState[stepKind]
      cells = st.cells
      nC = st.cols
      nR = st.rows
      stepInfo.value = {
        info: st.info, steps: st.steps, round: st.round, done: st.done,
        lastStage: st.lastStage, hist: stepHistory[stepKind]?.length ?? 0,
      }
      stepMoves = st.moves ?? []
    }
  }
  const cw = (w - 48) / nC, ch = (h - 48) / nR
  const area = [24, 24, w - 24, h - 24]
  // 權重驅動版面：'weight' 模式時 weight → 非均勻欄寬列高（weightedAxes）；否則均勻。
  // 動畫中（rwdAnimActive）：內插「起點 axes → 目標 axes」的格線位置，每幀重算。
  // 動畫幀不重算 buildHcGraph（骨架／格不變）——省每幀成本，cachedSegs 沿用。
  // 平行邊（共用同兩端點的快車直達＋普通車 coline）收成一條交錯線，見 mergeParallelSegs。
  if (isRWD.value && !(rwdAnimActive && cachedSegs)) cachedSegs = mergeParallelSegs(buildHcGraph(cachedSkeleton, grid.cellOf).segs)
  // 「比較」tab：一次載入城市的八候選評價結果。
  if (isRWD.value && !compareRecord.value && !compareMsg.value && compareRun.value !== 'running') {
    loadCompare()
  }
  // 「LLM評價」結果（llmevals，skill route-llm-eval）：唯讀評語——載入＋
  // fingerprint 驗證後只給右側面板顯示，不影響畫圖（沒有結果也照畫）。
  let justEval = false
  if (isRWD.value && !cachedEval && evalRun.value !== 'running') {
    const cid = sourceLayer.value?.id
    cachedEval = !cid
      ? { miss: '匯入資料不支援 LLM 評價（沒有城市 id 可對應結果檔）' }
      : await fetchLlmResult(`data/metro/llmevals/${cid}.${hcVariant.value}.${rwdCompactKey.value}.json`, {
        missNone: '尚未產生評價——按「開始 LLM 評價」讓模型評這個路網',
        missStale: 'LLM 評價與目前資料不符（資料已更新）——請重新產生',
        missErr: '無法載入 LLM 評價結果',
        fpOk: (fp) => fp.cols === nC && fp.rows === nR,
        dims: [nC, nR],
        onOk: (j) => ({ stats: j }),
      })
    if (seq !== renderSeq) return null // superseded during fetch
    evalStats.value = cachedEval.stats ?? null
    evalMsg.value = cachedEval.miss ?? null
    justEval = true
  }
  // 「執行調整」套用中：以評價存好的 exec.cells（apply 時已過硬規則）取代
  // 縮減網格佈局重畫；恢復＝這裡不取代。網格尺寸不變 → 前後可對齊比較。
  if (isRWD.value) {
    const evalExec = evalStats.value?.exec
    if (!evalExec?.cells) evalApplied.value = false
    else {
      // 首次載到結果時恢復上次「已套用」狀態（見 llmApplyKeys）。
      if (justEval) evalApplied.value = llmApplyGet(llmApplyKeys.value.eval)
      if (evalApplied.value) cells = new Map(evalExec.cells.map(([id, c, r]) => [id, [c, r]]))
    }
  }
  // 「LLM互動」（llmgrids 結果檔）：載入＋fingerprint 驗證，供面板顯示與「執行
  // 調整」切換——與評價一樣是唯讀載入、不影響畫圖（沒有結果也照畫 RWD）。
  let justGrid = false
  if (isRWD.value && !cachedGrid && gridRun.value !== 'running') {
    const cid = sourceLayer.value?.id
    cachedGrid = !cid
      ? { miss: '匯入資料不支援 LLM 互動（沒有城市 id 可對應結果檔）' }
      : await fetchLlmResult(`data/metro/llmgrids/${cid}.${hcVariant.value}.${rwdCompactKey.value}.json`, {
        missNone: '尚未產生 LLM 互動——輸入一句話（例：把市中心那幾欄拉開），讓模型推理每欄／列該佔多大',
        missStale: 'LLM 互動結果與目前資料不符（資料已更新）——請重新產生',
        missErr: '無法載入 LLM 互動結果',
        fpOk: (fp) => fp.cols === nC && fp.rows === nR,
        dims: [nC, nR],
        onOk: (j) => ({ colW: j.colW, rowW: j.rowW, stats: j }),
      })
    if (seq !== renderSeq) return null // superseded during fetch
    gridStats.value = cachedGrid.stats ?? null
    gridMsg.value = cachedGrid.miss ?? null
    gridInfo.value = cachedGrid.stats ? { model: cachedGrid.stats.model } : null
    justGrid = true
  }
  // 「執行調整」套用中：用 LLM 推理的區間權重（intervalAxes）決定欄寬列高重畫；
  // 沒有可套用的結果就強制恢復。網格拓撲不變、外框固定 → 前後可對齊比較。
  const gridExec = cachedGrid?.colW ? cachedGrid : null
  if (!gridExec) gridApplied.value = false
  // 首次載到結果時恢復上次「已套用」狀態（見 llmApplyKeys）。
  else if (justGrid) gridApplied.value = llmApplyGet(llmApplyKeys.value.grid)
  const gridOn = gridApplied.value && !!gridExec
  const animing = !gridOn && rwdAnimActive && isRWD.value && !!cachedSegs && !!rwdAnimTo
  weighted = !gridOn
    && (animing || (isRWD.value && rwdWeightMode.value === 'weight' && rwdWeights.value.size > 0))
  let axes = null
  if (gridOn) {
    // 區間權重 → 格線位置（外框固定、minFrac 保底）。
    axes = intervalAxes(gridExec.colW, gridExec.rowW, area)
  } else if (animing) {
    const toAx = weightedAxes(cells, cachedSegs, rwdAnimTo, nC, nR, area)
    const fromAx = rwdAnimFrom && rwdAnimFrom.size
      ? weightedAxes(cells, cachedSegs, rwdAnimFrom, nC, nR, area)
      : uniformAxes(nC, nR, area)
    axes = lerpAxes(fromAx, toAx, rwdAnimT)
  } else if (weighted) {
    axes = weightedAxes(cells, cachedSegs, rwdWeights.value, nC, nR, area)
  }
  // 方形網格（square）：格子強制正方——取 min(欄寬,列高) 當單位、整個網格置中
  // letterbox（不填滿板面）。均勻/權重/動畫/LLM 各模式都不是 square 時才走原本拉伸格。
  const squareMode = isRWD.value && !gridOn && !animing && !weighted && rwdWeightMode.value === 'square'
  const u = Math.min(cw, ch)
  const sqx0 = 24 + (w - 48 - nC * u) / 2, sqy0 = 24 + (h - 48 - nR * u) / 2
  const squareBlue = {
    xs: Array.from({ length: nC + 1 }, (_, i) => sqx0 + i * u),
    ys: Array.from({ length: nR + 1 }, (_, i) => sqy0 + i * u),
  }
  const cellPx = axes ? axes.cellPx
    : squareMode ? ([c, r]) => [sqx0 + (c + 0.5) * u, sqy0 + (r + 0.5) * u]
      : ([c, r]) => [24 + (c + 0.5) * cw, 24 + (r + 0.5) * ch]
  if (rwdMode.value) {
    // RWD 路網: 八方向約束以「版面 pixel」為準 — the map follows the panel shape
    // (隨板面變形), so the polylines are rebuilt in the CURRENT canvas pixel
    // space whenever the size changes (with cw ≠ ch a cell-space 45° is not
    // 45° on screen). Same-size renders reuse the cached result. The interior
    // blacks already sit ON the polylines (no placeBlacks here).
    // 未變形（base）藍格：既是 footer 欄／列查詢的座標系，也是滑鼠放大鏡的變形定義域。
    const baseBlue = axes ? { xs: axes.colX, ys: axes.rowY } : squareMode ? squareBlue : uniformBlue(nC, nR, cw, ch)
    fisheyeAxes = { xs: baseBlue.xs, ys: baseBlue.ys }
    // 放大鏡：把節點的 base 像素座標 (fx,fy) 搬到變形後位置，再交給 buildRwdMap 在該
    // 空間重繞線 → 線仍嚴格遵守 4/8/16 方向（不是把折點拉斜）。fast 幀＝放大鏡或權重動畫。
    const fWarp = fisheyeWarpFn()
    const fastFrame = animing || !!fWarp
    const sizeKey = `${RWD_ROUTER_REV}|${w}x${h}|d${rwdDirs.value}|${gridOn ? `g${rwdGridSeq}`
      : animing ? `a${rwdAnimT.toFixed(3)}` : weighted ? `w${rwdWeightSeq}` : squareMode ? 'sq' : 'u'}`
      + (fWarp ? `|f${Math.round(fWarp.x)}_${Math.round(fWarp.y)}_${fWarp.s.toFixed(2)}` : '')
    if (!cachedRWD || cachedRWD.key !== sizeKey) {
      if (!fastFrame) {
        hcBusy.value = true
        busyText.value = 'RWD 路網畫線中…（H/V/45° 候選折線）'
        await new Promise((r) => setTimeout(r, 30))
        if (seq !== renderSeq) { hcBusy.value = false; return null } // superseded
      }
      const pxPos = new Map()
      for (const [id, p] of cells) {
        const [px, py] = cellPx(p)
        pxPos.set(id, fWarp ? [fWarp.fx(px), fWarp.fy(py)] : [px, py])
      }
      cachedRWD = {
        key: sizeKey,
        // 非均勻格的半格 A* lattice 尚未做（見 skill）——權重／動畫／放大鏡不傳 lattice，衝突走
        // 候選＋兜底；fast 幀（動畫/放大鏡）再略過多輪衝突消解換每幀夠快；均勻格照舊帶 lattice。
        ...buildRwdMap(cachedSegs, pxPos, {
          unit: Math.min(cw, ch),
          dirs: rwdDirs.value, // 允許的線方向數 4/8/16
          // 自動隱藏白點：站距 < 門檻才刪，逐級升高 weight 差門檻（見 rwdMap.js）。
          hideStops: rwdHideStops.value,
          minStopPx: rwdMinStopPx.value,
          linkWeight: (u, v) => linkWeight(rwdWeights.value, u, v),
          ...(fastFrame ? { fast: true }
            : (weighted || gridOn) ? {}
              // 方形網格的 lattice 恰為正方（sx===sy）→ buildRwdMap 自動開 8 方向真 45° A*。
              : squareMode
                ? { lattice: { x0: sqx0, y0: sqy0, sx: u / 2, sy: u / 2, nx: nC * 2 + 1, ny: nR * 2 + 1 } }
                : { lattice: { x0: 24, y0: 24, sx: cw / 2, sy: ch / 2, nx: nC * 2 + 1, ny: nR * 2 + 1 } }),
        }),
      }
      hcBusy.value = false
    }
    rwdStats.value = cachedRWD.stats
    hcPos = new Map(cachedRWD.posAfter)
    rwdLines = cachedRWD.lines.map((L) => ({ ...L, px: L.pts }))
    if (import.meta.env.DEV) { // console 檢視 routing 旗標用（By：多分頁同開時依 key＋段數區分）
      window.__rwdDebug = cachedRWD
      ;(window.__rwdDebugBy ??= {})[`${cachedRWD.key}|s${cachedSegs.length}`] = cachedRWD
    }
    // 藍格跟著節點一起變形（畫面上格線與線／站對齊）；未開放大鏡則就是 base。
    hcBlue = fWarp ? { xs: baseBlue.xs.map(fWarp.fx), ys: baseBlue.ys.map(fWarp.fy) } : baseBlue
  } else {
    hcPos = new Map()
    for (const [id, p] of cells) hcPos.set(id, cellPx(p))
    placeBlacks(cachedSkeleton, hcPos, (id) => grid.posAfter.get(id) ?? null)
    hcBlue = squareMode ? squareBlue : uniformBlue(nC, nR, cw, ch)
  }
  return { hcPos, hcBlue, rwdLines, stepMoves }
}

// 色盤／共線虛線／地標色：lib/metroDraw.js（與 viewGeometry 同源）。

// 畫線資料組裝（render 的第 3 段）：把 RWD 折線／骨架拓撲邊／原始 feature 幾何
// 轉成 lineData（含 hover html）、stationData（節點分類色）與 highlightData
//（邊分類襯底）；posOf 是統一的座標查詢（HC 佈局 → 格網吸附 → 地理投影）。
function buildDrawData({ grid, sk, path, P, projById, stations, lineFeats, hcPos, rwdLines }) {
  const posOf = (id) =>
    (hcPos && hcPos.get(id)) || (grid && gridPost.value && grid.posAfter.get(id)) || projById.get(id)
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
      .map((id) => posOf(id)).filter(Boolean) // 缺座標的節點跳過，不讓整條線 render 拋錯/消失
      .map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`)
      .join(' ')
    // 線的顏色一律照原始 Metro Maps：單色 route → 實線原色；共線（≥2 相異色）→ 交錯
    // 彩色虛線（dasharray）。格網化後/HC/RWD 的線都經此，確保共線顯示與原始同樣的多色，
    // 不是併成單色（使用者要「色彩跟原來一樣」）。「共線變一條線」＝一條折線帶多色，
    // 不是變單色。
    const strokesOf = (e, d, html) => dashStrokes(d, e.renderColors ?? e.routeColors, e.color, { html })
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
      lineData = lineFeats.flatMap((f) =>
        featStrokes(f, path(f), { props: f.properties }))
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
      // 格網化後 / HC / 縮減：座標已搬到格子上 → 線改走 **skeleton 拓撲邊**（edgeD，
      // 連續停靠站直連，與 RWD 同源），不再逐頂點吸原始 feature 幾何。原因：feature
      // 幾何含該路線「只通過、不停靠」的 pass 站（如機場快綫實體軌道經 東涌／欣澳），
      // 這些站被吸到自己路線（東涌綫）的格子、遠離本線停靠鏈 → 逐頂點畫會把線拉去繞
      // 經它們，讓白色直通站（機場）落在折角（使用者回報的香港機場站轉折 bug）。
      // skeleton 邊的 path 已排除 pass 站、黃色交叉點是邊端點 → edgeD 自然穿過交叉、
      // 直通站沿邊內插保持共線、不繞行。共線多色交錯依 e.routeColors（strokesOf），與
      // RWD／原始一致（dasharray 逐邊重置相位，同 RWD 逐段畫法）。tooltip 用 html
      // （點路線列表＋邊分類），與 RWD 分支同型；不帶 props（骨架邊非單一 feature）。
      lineData = sk.edges.flatMap((e) => {
        const d = edgeD(e.path)
        if (!d) return []
        const routes = routesHtml([...e.routes])
        const html = (routes ? `${routes}<hr class="tip-sep"/>` : '') + EDGE_LABEL[e.cls]
        return strokesOf(e, d, html)
      })
      highlightData = [] // 移動後視圖不畫邊分類襯底（維持原本行為，共線僅靠交錯虛線表示）
    }
    // RWD 路網：自動隱藏的白點（直通站）不畫（cachedRWD.hidden）。
    const hiddenWhite = (rwdLines && cachedRWD?.hidden) || null
    // 河流站點（properties.river）＝一般網路節點，但**沒有白點**（使用者）：只在骨架分類為
    // 顯著點（紅匯流/藍端點/粉紅轉折/紫切點/黃/灰分隔）時才畫；黑的河流折點不畫。灰分隔點
    // （依曲折度遞迴細分放）要顯示、可 hover 畫參考線（見 grayInfo）。
    const riverShow = (p) => {
      const c = sk.stationClass.get(p.station_id)
      return c && c !== 'black'
    }
    stationData = stations
      .filter((f) => !(hiddenWhite && hiddenWhite.has(f.properties.station_id)))
      .filter((f) => !f.properties.river || riverShow(f.properties))
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
    lineData = lineFeats.flatMap((f) =>
      featStrokes(f, path(f), { props: f.properties }))
    stationData = stations
      .filter((f) => !f.properties.river) // 河流站點原始視圖不畫（河流沒有站圈，與地圖一致）
      .map((f) => {
        const [x, y] = P(f.geometry.coordinates)
        return { x, y, props: f.properties, fill: stationColor(f.properties) }
      })
  }

  return { posOf, lineData, stationData, highlightData }
}

// DOM 繪製（render 的第 4 段）：藍色示意網格 → 邊分類襯底 → 路線 → 逐步驗證
// 前後比對／權重數字（含最小站距統計）→ 站點（hover：粉紅參考線＋tooltip）。
function drawScene({ sel, w, h, grid, sk, P, hcBlue, rwdLines, stepMoves, stations, posOf, lineData, stationData, highlightData }) {
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
  // 顯示/隱藏網格（StyleBar 切換 layer.showGrid，預設顯示）——關掉時不畫藍色示意網格。
  if (grid && panelLayer.value?.showGrid !== false) {
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

  // 逐步驗證：這一步的前後比對——舊位置畫虛線空心圈、虛線連到新位置、
  // 新位置橘色實圈（線移動＝全部成員點都各畫一組）。畫在 ref 層、站點之下。
  // 每步後都會縮減網格 → moves 已是縮減後的 rank 空間；from 的欄/列若被
  // 清空會落在半格（x.5 / -0.5）→ 格心線性內插（頭尾外插）。
  if (stepMoves.length && grid) {
    const b2 = hcBlue ?? (gridPost.value ? grid.blueAfter : grid.blueBefore)
    const mids = (arr) => {
      const m = []
      for (let i = 0; i < arr.length - 1; i++) m.push((arr[i] + arr[i + 1]) / 2)
      return m
    }
    const midX = mids(b2.xs), midY = mids(b2.ys)
    const at = (m, v) => {
      if (!m.length) return NaN
      if (m.length === 1) return m[0]
      const lo = Math.max(0, Math.min(m.length - 2, Math.floor(v)))
      return m[lo] + (v - lo) * (m[lo + 1] - m[lo])
    }
    const px = (c) => at(midX, c)
    const py = (r) => at(midY, r)
    for (const m of stepMoves) {
      const x0p = px(m.from[0]), y0p = py(m.from[1])
      const x1p = px(m.to[0]), y1p = py(m.to[1])
      if ([x0p, y0p, x1p, y1p].some((v) => !Number.isFinite(v))) continue
      refG.append('line') // 移動軌跡
        .attr('x1', x0p).attr('y1', y0p).attr('x2', x1p).attr('y2', y1p)
        .attr('stroke', '#f97316').attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '4 3').attr('stroke-opacity', 0.8)
      refG.append('circle') // 舊位置（空心虛圈）
        .attr('cx', x0p).attr('cy', y0p).attr('r', 7)
        .attr('fill', 'none').attr('stroke', '#f97316')
        .attr('stroke-width', 1.5).attr('stroke-dasharray', '3 2').attr('stroke-opacity', 0.7)
      refG.append('circle') // 新位置（實線橘圈）
        .attr('cx', x1p).attr('cy', y1p).attr('r', 9)
        .attr('fill', 'none').attr('stroke', '#f97316')
        .attr('stroke-width', 2.5).attr('stroke-opacity', 0.9)
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

  // Reference lines for a bend/separator point: the chord (sinuosity baseline,
  // dashed), the DP sub-segment baseline (solid, pink only), and this point's
  // perpendicular drop to it. `color` = 粉紅 #ec4899 / 灰分隔 #9ca3af.
  // NOTE: `info.foot` from skeleton.js is the perpendicular foot in raw lng/lat
  // space, but the projection scales lng/lat differently (lng compressed by
  // cos(lat) + tilt), so drawing pt→foot with projected endpoints looks skewed.
  // Recompute the foot in PIXEL space here so the drop is visually perpendicular.
  function drawRef(info, color = '#ec4899') {
    refG.selectAll('*').remove()
    const segPx = (a, b, dash) => refG.append('line')
      .attr('x1', a[0]).attr('y1', a[1]).attr('x2', b[0]).attr('y2', b[1])
      .attr('stroke', color).attr('stroke-width', 1.5)
      .attr('stroke-dasharray', dash || null)
    if (info.chordA) segPx(P(info.chordA), P(info.chordB), '4 3') // chord (sinuosity)
    if (info.baseA) segPx(P(info.baseA), P(info.baseB))           // DP baseline (pink)
    // Baseline the perpendicular drops onto: DP sub-segment (pink) or sub-chord (gray).
    const bA = P(info.baseA ?? info.chordA), bB = P(info.baseB ?? info.chordB), Ppt = P(info.pt)
    const dx = bB[0] - bA[0], dy = bB[1] - bA[1], L2 = dx * dx + dy * dy || 1e-9
    const t = ((Ppt[0] - bA[0]) * dx + (Ppt[1] - bA[1]) * dy) / L2
    const foot = [bA[0] + t * dx, bA[1] + t * dy] // pixel-space perpendicular foot
    segPx(Ppt, foot) // perpendicular (垂距) — visually perpendicular on screen
    refG.append('circle')
      .attr('class', 'ref-foot')
      .attr('cx', foot[0]).attr('cy', foot[1])
      .attr('r', 2 / zk).attr('fill', color)
  }
  const clearRef = () => refG.selectAll('*').remove()

  // 隱藏 Highlight（StyleBar 切換 layer.showHighlight，預設顯示）——關掉時不畫邊分類
  // 襯底／RWD 殘留衝突光暈（Metro Maps 沒有此鈕，見 StyleBar）。
  highlightG.selectAll('path.hl')
    .data(panelLayer.value?.showHighlight === false ? [] : highlightData)
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
      showTip(e, d.html ?? linePopupHtml(d.props, tipSegStations(d.props?.seg_id))) // 共用 popupHtml（RWD 自帶 d.html 沿用）
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
      // Same station hover as Metro Maps (name + local + lines); a pink bend or
      // gray river separator appends its sinuosity detail below (not replacing).
      const pInfo = sk?.pinkInfo?.get(d.props.station_id)
      const gInfo = sk?.grayInfo?.get(d.props.station_id)
      const info = pInfo || gInfo
      if (info && !gridMode.value) drawRef(info, pInfo ? '#ec4899' : '#9ca3af')
      showTip(e, stationPopupHtml(d.props, tipIdx?.refColor)
        + (pInfo ? pinkExtra(pInfo) : gInfo ? grayExtra(gInfo) : '')) // 共用 popupHtml
    })
    .on('mousemove', moveTip)
    .on('mouseleave', function () {
      select(this).attr('r', (panelLayer.value?.radius ?? 4) / zk)
      clearRef()
      hideTip()
    })

  // Station name labels above the dots (toggled by the Style tab). 河流節點與合成的
  // 路線交叉點沒有真站名（使用者要求）——開站名時不標。
  if (panelLayer.value?.showLabels) {
    const r = panelLayer.value?.radius ?? 4
    const crossIds = new Set((sk?.crossings ?? []).map((c) => c.id))
    stationsG.selectAll('text.st-label')
      .data(stationData.filter((d) => !d.props.river && !crossIds.has(d.props.station_id)))
      .join('text')
      .attr('class', 'st-label')
      .attr('x', (d) => d.x)
      .attr('y', (d) => d.y - r - 3)
      .attr('text-anchor', 'middle')
      .style('pointer-events', 'none')
      .text((d) => d.props.station_name ?? '')
  }
}

let renderSeq = 0
// 目前畫面內容 → GeoJSON（圖層「匯出」）：lib/sceneExport.js。

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

  const hostW = el.clientWidth || 600
  const hostH = el.clientHeight || 400
  // 面板收合／拖曳動畫中會量到幾 px 的暫態尺寸——負的 cell 寬會讓 RWD 的
  // unit/minGap 變負、貼線防護整個失效（畫出互相重疊的線又不標衝突）。
  // 這種暫態不畫，等 ResizeObserver 量到真尺寸再 render。
  if (hostW < 80 || hostH < 80) return
  // RWD：可選固定版面（網頁／手機／IG）當畫線座標系，SVG letterbox 置中模擬 RWD。
  // 其他視圖仍跟面板一樣大。
  const frame = isRWD.value
    ? resolveRwdFrame(rwdFrameId.value, hostW, hostH)
    : { id: 'auto', w: hostW, h: hostH }
  const w = frame.w
  const h = frame.h
  const svgSel = select(svg)
  if (isRWD.value && frame.id !== 'auto') {
    svgSel.attr('viewBox', `0 0 ${w} ${h}`).attr('preserveAspectRatio', 'xMidYMid meet')
  } else {
    svgSel.attr('viewBox', null).attr('preserveAspectRatio', null)
  }
  const stations = data.features.filter((f) => f.geometry.type === 'Point')
  const lineFeats = data.features.filter((f) => f.geometry.type !== 'Point')

  // Precompute tilt + skeleton once per dataset (rotation-independent), so the
  // four view tabs only re-draw (fast) — never recompute — when switched.
  if (data !== cacheData) resetPerDataset(data)

  const projection = geoMercator()
    .angle(rotated.value ? tilt.value : 0)
    .fitExtent(
      [[24, 24], [w - 24, h - 24]],
      { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : data.features },
    )
  const path = geoPath(projection)
  const P = (c) => projection(c)

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
  // movewise 三階段會逐步縮小網格（每一個移動後就壓縮）——
  // fewer cells over the same extent, so everything spreads out.
  // 爬山鏈：計算這一幀的佈局座標（computeHcLayout，見上）；非 HC/RWD 視圖維持
  // null → 下面 posOf 落回格網/地理座標。
  let hcPos = null, hcBlue = null, rwdLines = null, stepMoves = []
  if (grid && needsHC.value && hcMode.value) {
    const layout = await computeHcLayout({ seq, w, h, grid })
    if (!layout) return // superseded mid-compute — the newer render draws
    ;({ hcPos, hcBlue, rwdLines, stepMoves } = layout)
  }
  const { posOf, lineData, stationData, highlightData } =
    buildDrawData({ grid, sk, path, P, projById, stations, lineFeats, hcPos, rwdLines })

  drawScene({ sel, w, h, grid, sk, P, hcBlue, rwdLines, stepMoves, stations, posOf, lineData, stationData, highlightData })

  // 匯出快照：把這一幀畫出的線與節點序列化成 GeoJSON，供「匯出」下載目前畫面內容。
  layerExport[layerId] = sceneToGeojson(lineData, stationData, w, h, layer.value?.type ?? 'd3')

  // 版面外框：選了固定版面（網頁／手機／IG…）時畫出該版面的邊界矩形，讓使用者看到
  // 模擬 RWD 的畫布範圍；「目前版面」（auto，跟著面板大小）不畫。畫在最上層、不吃事件。
  if (isRWD.value && frame.id !== 'auto') {
    sel.append('rect')
      .attr('class', 'frame-outline')
      .attr('x', 0.5).attr('y', 0.5).attr('width', w - 1).attr('height', h - 1)
      .attr('fill', 'none').attr('stroke', '#94a3b8').attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.85)
      .style('pointer-events', 'none')
  }

  applyStyle()

  // reset zoom to identity on re-render — 但放大鏡逐幀重畫時不重置（否則等於禁用縮放、
  // 且會與每幀的變形互踩）；放大鏡結束（淡出／關閉）的那次重畫才回正。
  if (zoomBehavior && !fisheyeActive()) select(svg).call(zoomBehavior.transform, zoomIdentity)
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
// hover HTML 與資料索引一律來自共用模組 popupHtml.js（與物件 tab、地圖 hover 同構）。
// 索引 per dataset 建一次（tipIdx），黃色交叉點 props 極簡也能渲染。
let tipIdx = null // buildPopupIndex 的結果
const tipSegStations = (segId) => stationsAlongSeg(tipIdx?.segs.get(segId), tipIdx?.stByCoord)
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
// Gray (river separator) EXTRA — the sub-segment (pink/yellow 邊界之間) it split.
function grayExtra(info) {
  const th = (cachedSkeleton?.riverGraySinuosity ?? appliedRiverGraySinuosity.value ?? DEFAULT_RIVER_GRAY_SINUOSITY).toFixed(2)
  return '<hr class="tip-sep"/><span style="color:#9ca3af">● 分隔點（灰）</span>'
    + `<br/>子段曲折度 = 弧長÷弦長 = <b>${info.sinuosity.toFixed(2)}</b>（&gt;${th} 要再分隔）`
    + '<br/><span style="color:#9ca3af;font-size:11px">粉紅／黃點等邊界之間仍太彎，'
    + '就在最中間的點放灰分隔並遞迴細分；虛線＝子段弦，實線＝垂距。</span>'
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
  const cvs = host.value
  if (!el || !cvs || el.style.display === 'none') return
  // Position relative to the canvas (host is the offset parent) so it tracks the
  // cursor exactly, then flip/clamp inside the visible canvas box so the tooltip
  // is never clipped by overflow:hidden and never spills outside the view.
  const pad = 6
  const [px, py] = pointer(e, cvs)
  const w = el.offsetWidth, h = el.offsetHeight
  const cw = cvs.clientWidth, ch = cvs.clientHeight
  let x = px + 14
  let y = py + 14
  if (x + w + pad > cw) x = px - w - 14              // flip to the left of cursor
  x = Math.max(pad, Math.min(x, cw - w - pad))
  if (y + h + pad > ch) y = py - h - 14              // flip above cursor
  y = Math.max(pad, Math.min(y, ch - h - pad))
  el.style.left = `${x}px`
  el.style.top = `${y}px`
}
function hideTip() {
  if (tipEl.value) tipEl.value.style.display = 'none'
}

// Compact fitness numbers for the Hill Climbing stats readout.
const fmtFit = (x) => (x >= 10000 ? `${(x / 1000).toFixed(1)}k` : Math.round(x).toString())

// 原 footer 左側運算狀態 → 右側「資訊」tab 底部；字串＋是否顯示 LLM 重跑鈕。
const layoutStatus = computed(() => {
  const m = mode.value
  if (isHC.value && m === 'hc' && hcStats.value) {
    const s = hcStats.value
    return {
      text: `適應度 ${fmtFit(s.before)} → ${fmtFit(s.after)} · ${s.rounds} 輪 · 移動 ${s.moved} 站`
        + (s.clusterMoves ? ` · ${s.clusterMoves} 群集` : '')
        + (s.hvBefore != null ? ` · 水平垂直 ${s.hvBefore} → ${s.hvAfter}／${s.segs} 段` : ''),
      llmRerun: false,
    }
  }
  {
    const lk = layoutKindOf(m)
    if (isHC.value && lk && layoutStats.value) {
      const s = layoutStats.value
      if (lk === 'shape') {
        if (s.skipped || s.note === '不需計算') {
          return { text: 'Shape-Guided 不需計算', llmRerun: false }
        }
        return {
          text: `Shape-Guided${s.route ? ` ${s.route}` : ''} · 移動 ${s.moved} 站`
            + (s.quality?.square ? ' · 已成方' : '')
            + (s.rulesOk === false ? ' · 規則未過' : '')
            + (s.crosses ? ` · 交叉 ${s.crosses}` : ''),
          llmRerun: false,
        }
      }
      let t = `水平垂直 ${s.hvBefore} → ${s.hvAfter}／${s.segs} 段 · 迭代 ${s.iters}/${s.iterCap}`
        + (s.converged ? '' : '（達上限未收斂）')
        + ` · 移動 ${s.moved} 站`
        + (s.reverted ? '（淨值未改善，退回）' : '')
      if (s.hvdBefore != null) t += ` · 含45° ${s.hvdBefore} → ${s.hvdAfter}`
      if (lk === 'stroke') t += ` · ${s.strokes} 筆畫／${s.substrokes} 子筆畫`
      else if (lk === 'milp' || lk === 'sat') t += ` · ${s.comps} 元件` + (s.fallback ? `（${s.fallback} 退回）` : '')
      else if (lk === 'octi') t += ` · 定案 ${s.settled} 點`
      else if (lk === 'path') t += ` · ${s.chains} 鏈／${s.links} link`
      return { text: t, llmRerun: false }
    }
  }
  if (isHC.value && lineKindOf(m) && lineStats.value) {
    const s = lineStats.value
    return {
      text: `直線縮減 移動 ${s.moved} 線 · 網格 ${s.fromCols}×${s.fromRows} → ${s.cols}×${s.rows}`
        + ` · 水平垂直 ${s.hvBefore} → ${s.hvAfter}／${s.segs} 段`
        + (s.converged ? '' : '（達上限未收斂）'),
      llmRerun: false,
    }
  }
  if (isHC.value && gatherKindOf(m) && gatherStats.value) {
    const s = gatherStats.value
    return {
      text: `網格合併 ${s.mergedRows} 列 · ${s.mergedCols} 欄 · 網格 ${s.fromCols}×${s.fromRows} → ${s.cols}×${s.rows}`
        + (s.converged ? '' : '（達上限未收斂）'),
      llmRerun: false,
    }
  }
  if (isHC.value && loopKindOf(m) && loopStats.value) {
    const s = loopStats.value
    return {
      text: `循環 ${s.rounds} 輪 · 端點移動 ${s.moved} 點 · 直線縮減 ${s.lineMoved} 線 · 網格合併 ${s.gatherMoved} 次`
        + ` · 水平垂直 ${s.hvBefore} → ${s.hvAfter}／${s.segs} 段`
        + ` · 網格 ${s.fromCols}×${s.fromRows} → ${s.cols}×${s.rows}`
        + (s.converged ? '' : '（達上限未收斂）'),
      llmRerun: false,
    }
  }
  if (isHC.value && shapeKindOf(m) && shapeStats.value) {
    const s = shapeStats.value
    if (s.skipped) {
      return { text: 'Shape-Guided 不需計算', llmRerun: false }
    }
    return {
      text: `Shape-Guided 移動 ${s.moved} 站`
        + ` · 水平垂直 ${s.hvBefore} → ${s.hvAfter}／${s.segs} 段`
        + (s.hvdBefore != null ? ` · 含45° ${s.hvdBefore} → ${s.hvdAfter}` : ''),
      llmRerun: false,
    }
  }
  if (isHC.value && endKindOf(m) && endpStats.value) {
    const s = endpStats.value
    return {
      text: `端點移動 移動 ${s.moved}/${s.verts} 點 · 水平垂直 ${s.hvBefore} → ${s.hvAfter}／${s.segs} 段`
        + ` · 網格 ${s.fromCols}×${s.fromRows} → ${s.cols}×${s.rows}`
        + (s.converged ? '' : '（達上限未收斂）'),
      llmRerun: false,
    }
  }
  if (postKind.value && postStats.value) {
    const s = postStats.value
    let t = `水平垂直 ${s.hvBefore} → ${s.hvAfter}／${s.segs} 段 · 迭代 ${s.iters}/${s.iterCap}`
      + (s.converged ? '' : '（達上限未收斂）')
      + ` · 移動 ${s.moved} 站`
      + (s.reverted ? '（淨值未改善，退回）' : '')
    if (postKind.value === 'rect') t += ` · 適應度 ${fmtFit(s.before)} → ${fmtFit(s.after)} · ${s.rounds} 輪`
    // 論文鏈（paperAlign.js）：八方向系——補「含 45° 對齊」讀數與各自的機構統計。
    else if (PAPER_ZH[postKind.value]) {
      if (s.hvdBefore != null) t += ` · 含45° ${s.hvdBefore} → ${s.hvdAfter}`
      if (postKind.value === 'stroke') t += ` · ${s.strokes} 筆畫／${s.substrokes} 子筆畫`
      else if (postKind.value === 'milp' || postKind.value === 'sat') t += ` · ${s.comps} 元件` + (s.fallback ? `（${s.fallback} 退回）` : '')
      else if (postKind.value === 'octi') t += ` · 定案 ${s.settled} 點`
      else if (postKind.value === 'path') t += ` · ${s.chains} 鏈／${s.links} link`
    }
    if (hcCompact.value && hcCompactStats.value) {
      const c = hcCompactStats.value
      t += ` · 網格 ${c.fromCols}×${c.fromRows} → ${c.cols}×${c.rows}`
    }
    return { text: t, llmRerun: false }
  }
  if (llmMode.value && llmStats.value && (m !== 'hc-llm' || llmApplied.value)) {
    const s = llmStats.value
    let t = `水平垂直 ${s.hvBefore} → ${s.hvAfter}／${s.segs} 段 · 迭代 ${s.rounds} 輪 · 移動 ${s.moved} 站 · 模型 ${s.model}`
    if (hcCompact.value && hcCompactStats.value) {
      const c = hcCompactStats.value
      t += ` · 網格 ${c.fromCols}×${c.fromRows} → ${c.cols}×${c.rows}`
    }
    if (llmRun.value === 'running') t += ' · 執行中…'
    return {
      text: t,
      llmRerun: !!llmCityId.value && llmRun.value !== 'running',
    }
  }
  if (isHC.value && m === 'hc-llm' && promptApplied.value && promptStats.value) {
    const s = promptStats.value
    return {
      text: `指定對齊 · 水平垂直 ${s.hvBefore} → ${s.hvAfter}／${s.segs} 段 · 迭代 ${s.rounds} 輪 · 移動 ${s.moved} 站 · 模型 ${s.model}`,
      llmRerun: false,
    }
  }
  if (gridApplied.value && gridStats.value) {
    const s = gridStats.value
    return {
      text: `LLM 互動（已套用）· 模型 ${s.model} · 最大倍率 ${Math.max(...s.colW, ...s.rowW).toFixed(1)}`,
      llmRerun: false,
    }
  }
  if (isRWD.value && rwdMode.value && rwdStats.value) {
    const s = rwdStats.value
    let t = (rwdFrameId.value !== 'auto' ? `版面 ${rwdFrameInfo.value.w}×${rwdFrameInfo.value.h} · ` : '')
      + `${s.segs} 段 · 直線 ${s.straight} · 單折 ${s.single} · 雙折 ${s.double}`
    if (s.multi) t += ` · 多折 ${s.multi}`
    if (s.rerouted) t += ` · 繞行 ${s.rerouted}`
    if (s.swapped) t += ` · 順接調整 ${s.swapped}`
    if (s.straightened) t += ` · 直線化 ${s.straightened}`
    if (s.diag45) t += ` · 轉45 ${s.diag45}`
    if (s.squeezed) t += ` · 窄縫 ${s.squeezed}`
    if (s.colinear) t += ` · 共線 ${s.colinear}`
    if (s.fallback) t += ` · 兜底 ${s.fallback}`
    if (s.forced) t += ` · 殘留衝突 ${s.forced}`
    if (hcCompactStats.value) t += ` · 網格 ${hcCompactStats.value.cols}×${hcCompactStats.value.rows}`
    return { text: t, llmRerun: false }
  }
  return null
})
const dataSourceText = computed(() => {
  if (ownData.value) return `${layer.value?.name}（匯入 JSON）`
  if (isRWD.value) {
    return hcLayer.value
      ? `${hcLayer.value.name}（端點移動+直線縮減+網格合併循環）`
      : (layer.value?.sourceLayerId ?? '—')
  }
  if (isHC.value) {
    return hcD3Layer.value
      ? `${hcD3Layer.value.name}（${hcVariant.value === 'rot' ? '旋轉' : '原始'}格網化後）`
      : (layer.value?.sourceLayerId ?? '—')
  }
  return sourceLayer.value?.name ?? layer.value?.sourceLayerId ?? '—'
})

watch(() => layer.value?.sourceLayerId, () => { cacheData = null; render() })
watch(mode, render)
// 樣式 tab 的「顏色點間最大跨距」：滑桿只改 layer.spanCap，不自動重算——
// 快取沿用 appliedSpanCap（上次套用的值），按「重新計算」才作廢重算。
const appliedSpanCap = ref(null)
watch(() => panelLayer.value?.id, () => {
  appliedSpanCap.value = panelLayer.value?.spanCap ?? 3
  const applied = panelLayer.value?.riverGraySinuosityApplied
    ?? panelLayer.value?.riverGraySinuosity
    ?? DEFAULT_RIVER_GRAY_SINUOSITY
  appliedRiverGraySinuosity.value = Math.max(1.01, Math.round((+applied || DEFAULT_RIVER_GRAY_SINUOSITY) * 100) / 100)
  if (panelLayer.value) {
    if (panelLayer.value.riverGraySinuosity == null) {
      panelLayer.value.riverGraySinuosity = appliedRiverGraySinuosity.value
    }
    if (panelLayer.value.riverGraySinuosityApplied == null) {
      panelLayer.value.riverGraySinuosityApplied = appliedRiverGraySinuosity.value
    }
  }
})
function recalcSpan() {
  appliedSpanCap.value = panelLayer.value?.spanCap ?? 3
  calcMs.value = {}
  // 跨距上限只約束爬山（setSpanCap → buildHillClimb），所以它與其後處理必須一併作廢，
  // 否則 render() 的 `if (!cachedHC)` 會沿用舊上限的佈局，下游重算也只是換湯不換藥。
  cachedHC = null
  cachedPost = {}
  cachedLayout = {}
  cachedEndp = {}
  cachedLine = {}
  cachedGather = {}
  cachedLoop = {}
  cachedShape = {}
  stepState = {}
  stepHistory = {}
  cachedRWD = null
  shapeRouteName.value = null
  shapeNoNeed.value = false
  shapeFailLabel.value = null
  render()
}

// Map Adjust 工具列「河流分隔曲折度」：
//   · riverGraySinuosity       ＝草稿（輸入框，改了不重算）
//   · riverGraySinuosityApplied ＝已套用（按確定才寫；Map Adjust／Straighten／RWD 共用
//     同一 panelLayer，watch 此欄讓已開啟的 Straighten／RWD 一併重算骨架＋佈局）
function applyRiverGrayAndInvalidate(v) {
  const th = Math.max(1.01, Math.round((+v || DEFAULT_RIVER_GRAY_SINUOSITY) * 100) / 100)
  if (appliedRiverGraySinuosity.value === th && cachedSkeleton?.riverGraySinuosity === th) return
  appliedRiverGraySinuosity.value = th
  if (!cacheData) { render(); return }
  cachedSkeleton = buildConnectSkeleton(cacheData, { riverGraySinuosity: th })
  calcMs.value = {}
  cachedHC = null
  cachedPost = {}
  cachedLayout = {}
  cachedLlm = null
  cachedPrompt = null
  cachedGrid = null
  cachedEval = null
  cachedEndp = {}
  cachedLine = {}
  cachedGather = {}
  cachedLoop = {}
  cachedShape = {}
  stepState = {}
  stepHistory = {}
  cachedRWD = null
  shapeRouteName.value = null
  shapeNoNeed.value = false
  shapeFailLabel.value = null
  cachedFp = `${dataFingerprint(cacheData)}:rg${th}`
  render()
}
function recalcRiverGray() {
  const raw = panelLayer.value?.riverGraySinuosity
  const v = Math.max(1.01, Math.round((+raw || DEFAULT_RIVER_GRAY_SINUOSITY) * 100) / 100)
  if (panelLayer.value) {
    panelLayer.value.riverGraySinuosity = v
    panelLayer.value.riverGraySinuosityApplied = v // 觸發其他已開 tab 的 watch
  }
  applyRiverGrayAndInvalidate(v)
  store.toast(`河流分隔曲折度 ${v}：骨架／Straighten／RWD Maps 已重算`)
}
// 其他分頁（或本分頁）改了共用的「已套用」門檻 → 跟著重算。
watch(() => panelLayer.value?.riverGraySinuosityApplied, (v) => {
  if (v == null) return
  applyRiverGrayAndInvalidate(v)
})
// Live style sync from the bound layer (Style tab sliders).
watch(
  () => [panelLayer.value?.strokeWidth, panelLayer.value?.radius, panelLayer.value?.opacity],
  applyStyle,
)
// Toggling station labels needs a re-render (add/remove text nodes).
watch(() => panelLayer.value?.showLabels, render)
// 顯示/隱藏網格：切換 showGrid → 重畫（藍色示意網格 add/remove）。
watch(() => panelLayer.value?.showGrid, render)
// 顯示/隱藏 Highlight：切換 showHighlight → 重畫（邊分類襯底／殘留衝突光暈 add/remove）。
watch(() => panelLayer.value?.showHighlight, render)

// 「顯示全部」（StyleBar）：把 d3-zoom 重置回 identity——render() 就是把投影 fit 到
// 容器後把 zoom 設為 identity，所以重置＝回到「全部可見」的初始 fit 狀態。
function fitView() {
  if (zoomBehavior && svgEl.value) {
    select(svgEl.value).call(zoomBehavior.transform, zoomIdentity)
  }
}

// ---- 滑鼠放大鏡（魚眼變形，skill 「路網網格_2」）----------------------------
// 分軸（X、Y 各自）的一維非均勻重映射：以游標座標為焦點，用一條「高斯隆起」的
// 放大密度 m(t)=1+amp·exp(−(t−focus)²/2σ²) 沿軸積分後正規化回同一外框 → 焦點附近
// 撐開、遠處壓扁而整體寬高不變。密度對「焦點位置」與「座標」都連續 → 游標一移動整條
// 映射平滑滑動、無跳格。**關鍵**：變形只作用在「節點的像素位置」上（fWarp 套在 pxPos），
// 之後由 buildRwdMap 在變形後空間重繞線 → 線仍嚴格遵守目前 4/8/16 方向（不是把折點
// 拉斜）。放大強度 s∈[0,1] 由 rAF 逐幀緩動、每幀 render 重繞 → 進出／移動都柔順。
const FISHEYE_AMP = 4          // 焦點峰值放大 = 1+amp（×5）
const FISHEYE_SIGMA_FRAC = 0.09 // 高斯半徑 = 外框長度 × 此比例（放大鏡影響範圍）
const FISHEYE_EASE = 0.22      // 每幀朝目標緩動的比例（越小越柔、越慢）
const FISHEYE_SAMPLES = 160    // 沿軸取樣段數（積分解析度，夠密就平滑）
// 造出「原座標 → 變形後座標」的平滑分段線性函式（外框 lo/hi 固定，區間外恆等）。
// 用均勻取樣 → 查表 O(1)。amp≤0 時退化為恆等（放大鏡淡出到無效果）。
function buildAxisWarp(lo, hi, focus, sigma, amp) {
  const span = hi - lo
  if (span <= 0 || amp <= 0 || sigma <= 0) return (v) => v
  const M = FISHEYE_SAMPLES, step = span / M
  const inv2s2 = 1 / (2 * sigma * sigma)
  const warped = new Float64Array(M + 1)
  const dens = new Float64Array(M)
  let sum = 0
  for (let i = 0; i < M; i++) {
    const dx = lo + (i + 0.5) * step - focus
    const d = 1 + amp * Math.exp(-dx * dx * inv2s2)
    dens[i] = d; sum += d
  }
  const scale = span / (sum * step) // 正規化：總長度回到 span，外框不動
  warped[0] = lo
  for (let i = 0; i < M; i++) warped[i + 1] = warped[i] + dens[i] * step * scale
  return (v) => {
    if (v <= lo || v >= hi) return v
    const t = (v - lo) / step
    const idx = Math.min(M - 1, t | 0)
    return warped[idx] + (t - idx) * (warped[idx + 1] - warped[idx])
  }
}
function coarseIndex(bounds, v) {
  for (let i = 0; i < bounds.length - 1; i++) if (v >= bounds[i] && v < bounds[i + 1]) return i
  return null
}
// 依目前（緩動中）焦點 feCur 造出這一幀的分軸魚眼函式 { fx, fy }，供 render 在建
// pxPos／藍格前套用 → 節點搬到變形後位置，再由 buildRwdMap 在該像素空間重繞線 →
// 線仍嚴格遵守目前的 4/8/16 方向（不是單純把折點拉斜）。強度 s≈0 或未啟用時回 null
// （等於不變形）。fisheyeAxes 的外框 [xs0,xsN]×[ys0,ysN] 就是放大鏡的有效範圍。
// 這一幀是否正在放大（開關開、焦點存在、強度可見）→ render 用它決定「fast 幀＋不重置縮放」。
const fisheyeActive = () => fisheyeOn.value && isRWD.value && !!feCur && feCur.s > 0.002 && !!fisheyeAxes
function fisheyeWarpFn() {
  if (!fisheyeActive()) return null
  const s = feCur.s
  const ax = fisheyeAxes
  const x0 = ax.xs[0], x1 = ax.xs[ax.xs.length - 1]
  const y0 = ax.ys[0], y1 = ax.ys[ax.ys.length - 1]
  const amp = FISHEYE_AMP * s
  return {
    s, x: feCur.x, y: feCur.y,
    fx: buildAxisWarp(x0, x1, feCur.x, (x1 - x0) * FISHEYE_SIGMA_FRAC, amp),
    fy: buildAxisWarp(y0, y1, feCur.y, (y1 - y0) * FISHEYE_SIGMA_FRAC, amp),
  }
}
// rAF 緩動迴圈：焦點 feCur.{x,y} 朝游標目標滑動、強度 feCur.s 淡入／淡出，每幀 render()
// ——render 讀 fisheyeWarpFn 在新像素空間**重繞線**（fast 模式，同權重動畫）。停穩或
// 完全淡出就停迴圈省 CPU；下次移動再喚醒。移動不瞬跳、進出柔順。
function stopFisheyeAnim() { if (fisheyeRaf) { cancelAnimationFrame(fisheyeRaf); fisheyeRaf = 0 } }
function fisheyeTick() {
  fisheyeRaf = 0
  if (!fisheyeAxes || !feCur || !feTarget) return
  const E = FISHEYE_EASE
  feCur.x += (feTarget.x - feCur.x) * E
  feCur.y += (feTarget.y - feCur.y) * E
  const targetS = feTarget.on ? 1 : 0
  feCur.s += (targetS - feCur.s) * E
  // 完全淡出 → 清掉焦點、重畫回均勻、結束迴圈（下次移動再重建 feCur）。
  if (targetS === 0 && feCur.s < 0.006) { feCur = null; render(); return }
  render() // 每幀在變形後像素空間重繞 H/V/45°（fisheyeWarpFn 由 render 讀取）
  const settled = Math.abs(feTarget.x - feCur.x) < 0.4 &&
    Math.abs(feTarget.y - feCur.y) < 0.4 && Math.abs(targetS - feCur.s) < 0.006
  if (!settled) fisheyeRaf = requestAnimationFrame(fisheyeTick)
}
function onFisheyeMove(e) {
  if (!fisheyeOn.value || !isRWD.value || !fisheyeAxes) return
  const [lx, ly] = pointer(e, gEl.value)
  const ax = fisheyeAxes
  const x0 = ax.xs[0], x1 = ax.xs[ax.xs.length - 1]
  const y0 = ax.ys[0], y1 = ax.ys[ax.ys.length - 1]
  const inside = lx >= x0 && lx <= x1 && ly >= y0 && ly <= y1
  fisheyeInfo.value = { x: Math.round(lx), y: Math.round(ly), col: coarseIndex(ax.xs, lx), row: coarseIndex(ax.ys, ly) }
  // 焦點鉗在框內（游標略出框時放大鏡停在最近邊緣、不亂飄）。
  feTarget = { x: Math.max(x0, Math.min(x1, lx)), y: Math.max(y0, Math.min(y1, ly)), on: inside }
  if (!feCur) feCur = { x: feTarget.x, y: feTarget.y, s: 0 } // 進場不瞬跳、由強度淡入
  if (!fisheyeRaf) fisheyeRaf = requestAnimationFrame(fisheyeTick)
}
function onFisheyeLeave() {
  if (feTarget) feTarget.on = false // 交給緩動迴圈淡出（不硬切）
  if (feCur && !fisheyeRaf) fisheyeRaf = requestAnimationFrame(fisheyeTick)
  fisheyeInfo.value = null
}

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
  llmRunner.stop()
  gridRunner.stop()
  evalRunner.stop()
  if (rwdAutoTimer) clearInterval(rwdAutoTimer)
  if (rwdAnimRaf) cancelAnimationFrame(rwdAnimRaf)
  if (fisheyeRaf) cancelAnimationFrame(fisheyeRaf)
})
</script>

<template>
  <div class="ma-tab">
    <div class="tab-body">
      <div class="map-col">
        <!-- 樣式工具列（地圖上方）：取代原右側面板的「樣式」tab -->
        <StyleBar
          v-if="panelLayer"
          :layer="panelLayer"
          :view-kind="isRWD ? 'rwd' : isHC ? 'hillclimb' : 'map-adjust'"
          :show-weights="rwdShowWeights"
          :weight-mode="rwdWeightMode"
          :dirs="rwdDirs"
          :frame="rwdFrameId"
          :weight-auto="rwdAutoShuffle"
          :hide-stops="rwdHideStops"
          :min-stop-px="rwdMinStopPx"
          :stop-stat="rwdStopStat"
          :span-applied="appliedSpanCap"
          :river-gray-applied="appliedRiverGraySinuosity"
          :fisheye="fisheyeOn"
          @fisheye="setFisheye"
          @show-weights="setRwdShowWeights"
          @weight-mode="setRwdWeightMode"
          @dir-count="setRwdDirs"
          @frame="setRwdFrame"
          @weight-random="regenRwdWeights"
          @weight-auto="toggleRwdAutoShuffle"
          @hide-stops="setRwdHideStops"
          @min-stop-px="setRwdMinStopPx"
          @recalc-span="recalcSpan"
          @recalc-river-gray="recalcRiverGray"
          @fit-view="fitView"
        />
        <div class="map-main">
          <D3ViewNav
            :sections="navSections"
            v-model:mode="mode"
            :panel-layer="panelLayer"
            :can-rotate="canRotate"
          />

          <!-- 地圖底色（樣式 tab 的 layer.d3Bg）——未設定時用主題預設背景 -->
          <div ref="host" class="ma-canvas" :style="panelLayer?.d3Bg ? { background: panelLayer.d3Bg } : null">
          <svg
            ref="svgEl"
            class="ma-svg"
            @click="panelLayer && store.setSelectedFeature(panelLayer.id, null)"
            @pointermove="fisheyeOn && onFisheyeMove($event)"
            @pointerleave="fisheyeOn && onFisheyeLeave()"
          >
            <g ref="gEl" />
          </svg>
          <div ref="tipEl" class="ma-tip" />
          <div v-if="loading" class="ma-hint">載入中…</div>
          <div v-else-if="hcBusy" class="ma-hint">{{ busyText }}</div>
          <div v-else-if="loadError" class="ma-hint error">{{ loadError }}</div>
          <!-- LLM 比較結果：本 RWD 視圖若是全部／原始／旋轉最佳，右上角標示 -->
          <div v-if="compareViewTags.length" class="ma-compare-badges">
            <span
              v-for="t in compareViewTags"
              :key="t.kind"
              class="ma-compare-badge"
              :class="'ma-compare-badge--' + t.kind"
            >{{ t.label }}</span>
          </div>
          <!-- LLM 對齊改成唯讀＋toggle（跟 LLM評價/互動一樣）：跑的時候不蓋畫布、
               不留白，串流與「執行調整/恢復原佈局」都在右側「LLM對齊」面板 tab。 -->
          <!-- 逐步驗證 控制面板：按「下一步」執行一個單掃描步驟，看四步鏈
               怎麼一步步收斂；「重設」回到該鏈的起點。 -->
          <D3StepPanel
            v-if="isHC && stepKindOf(mode)"
            :panel-layer="panelLayer"
            :step-info="stepInfo"
            @prev="stepPrev"
            @next="stepNext"
            @reset="stepReset"
          />
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
      :llm-view="isHC && mode === 'hc-llm'"
      :llm-text="llmRunText"
      :llm-msg="llmMsg"
      :llm-error="llmRun === 'error' ? llmRunTail : ''"
      :llm-applied="llmApplied"
      :prompt-record="isHC ? promptStats : null"
      :prompt-running="promptRun === 'running'"
      :prompt-text="promptRunText"
      :prompt-msg="promptMsg"
      :prompt-error="promptRun === 'error' ? promptRunTail : ''"
      :prompt-applied="promptApplied"
      :grid-record="isRWD ? gridStats : null"
      :grid-running="gridRun === 'running'"
      :grid-can-run="!!llmCityId"
      :grid-text="gridRunText"
      :grid-msg="gridMsg"
      :grid-error="gridRun === 'error' ? gridRunTail : ''"
      :grid-applied="gridApplied"
      :eval-record="isRWD ? evalStats : null"
      :eval-running="evalRun === 'running'"
      :eval-can-run="!!llmCityId"
      :eval-text="evalRunText"
      :eval-msg="evalMsg"
      :eval-error="evalRun === 'error' ? evalRunTail : ''"
      :eval-applied="evalApplied"
      :compare-record="isRWD ? compareRecord : null"
      :compare-running="compareRunning"
      :compare-can-run="!!llmCityId"
      :compare-text="compareRunText"
      :compare-msg="compareMsg"
      :compare-error="compareError"
      :llm-model="llmModel"
      @update:llm-model="llmModel = $event"
      :weight-mode="rwdWeightMode"
      :weight-auto="rwdAutoShuffle"
      :show-weights="rwdShowWeights"
      :hide-stops="rwdHideStops"
      :min-stop-px="rwdMinStopPx"
      :stop-stat="rwdStopStat"
      :span-applied="appliedSpanCap"
      :layout-status="layoutStatus"
      :data-source="dataSourceText"
      @recalc-span="recalcSpan"
      @run-llm="startLlmRun"
      @run-prompt="startPromptRun"
      @run-grid="startGridRun"
      @run-eval="startEvalRun"
      @run-compare="startCompareRun"
      @toggle-eval-exec="toggleEvalExec"
      @toggle-grid-exec="toggleGridExec"
      @toggle-llm-exec="toggleLlmExec"
      @toggle-prompt-exec="togglePromptExec"
      @weight-mode="setRwdWeightMode"
      @weight-random="regenRwdWeights"
      @weight-auto="toggleRwdAutoShuffle"
      @show-weights="setRwdShowWeights"
      @hide-stops="setRwdHideStops"
      @min-stop-px="setRwdMinStopPx"
      @llm-rerun="startLlmRun"
    />
    </div>

    <!-- Footer：永遠顯示（每個 tab 都有 footer，即使沒資訊）。RWD 診斷（最小站距／
         畫布／放大鏡座標）在有資料時顯示，否則顯示目前視圖名當中性佔位。運算狀態與
         資料來源在右側「資訊」tab。 -->
    <footer class="ma-statusbar">
      <div v-if="isRWD && rwdStopStat" class="ma-diag">
        <span>最小站距 高 <b>{{ rwdStopStat.high != null ? rwdStopStat.high.toFixed(1) : '—' }}</b>
          寬 <b>{{ rwdStopStat.wide != null ? rwdStopStat.wide.toFixed(1) : '—' }}</b> pt</span>
        <span v-if="rwdStopStat.canvas">畫布 <b>{{ rwdStopStat.canvas[0] }}</b> × <b>{{ rwdStopStat.canvas[1] }}</b> px</span>
        <span v-if="rwdHideStops">已隱藏 <b>{{ rwdStopStat.hidden }}</b> 站</span>
      </div>
      <span v-if="fisheyeOn" class="ma-coords">
        <MIcon name="my_location" :size="13" />
        <template v-if="fisheyeInfo">x={{ fisheyeInfo.x }}, y={{ fisheyeInfo.y }}<template
          v-if="fisheyeInfo.col != null && fisheyeInfo.row != null">（欄 {{ fisheyeInfo.col }}, 列 {{ fisheyeInfo.row }}）</template></template>
        <template v-else>移動滑鼠以放大網格</template>
      </span>
      <span v-if="!(isRWD && rwdStopStat) && !fisheyeOn" class="ma-empty">{{ panelLayer?.name ?? '—' }}</span>
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
/* Footer status bar — RWD 診斷靠左、資料來源靠右。 */
.ma-statusbar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 28px;
  flex-shrink: 0;
  padding: 3px 12px;
  border-top: 1px solid hsl(var(--border));
  background: hsl(var(--muted) / 0.4);
  color: hsl(var(--muted-foreground));
  overflow: hidden;
}
.ma-diag {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
  font-size: 11.5px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ma-diag b { color: hsl(var(--foreground)); font-weight: 600; }
/* 沒診斷資訊時的中性佔位（footer 仍在，維持每個 tab 都有 footer） */
.ma-empty { font-size: 11.5px; color: hsl(var(--muted-foreground) / 0.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 放大鏡座標：跟診斷同一側（左邊） */
.ma-coords {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  white-space: nowrap;
  color: hsl(var(--primary));
  font-variant-numeric: tabular-nums;
}
.ma-canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.ma-svg { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; }
.ma-svg:active { cursor: grabbing; }
/* LLM 比較：全部／原始／旋轉最佳徽章（RWD 路網畫布右上角） */
.ma-compare-badges {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  pointer-events: none;
}
.ma-compare-badge {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.25);
}
.ma-compare-badge--all { background: #f59e0b; }   /* 全部最佳：金 */
.ma-compare-badge--orig { background: #0d9488; }  /* 原始最佳：青绿 */
.ma-compare-badge--rot { background: #2563eb; }   /* 旋轉最佳：藍 */
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
.llm-model-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 8px 6px 0 0;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
}
.llm-model-pick select {
  height: 26px;
  padding: 0 6px;
  font-size: 12px;
  color: hsl(var(--foreground));
  background: hsl(var(--muted) / 0.5);
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px);
}
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
  z-index: 9999;
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
