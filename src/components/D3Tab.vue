<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { geoMercator, geoPath } from 'd3-geo'
import { select, pointer } from 'd3-selection'
import { zoom, zoomIdentity } from 'd3-zoom'
import { useMapStore } from '../stores/mapStore'
import { assetUrl } from '../lib/assetUrl'
import { dragResize } from '../lib/dragResize'
import { layerData, localizeStationNames } from '../stores/layerData'
import { computeOrientation } from '../stores/orientation'
import { buildConnectSkeleton } from '../stores/skeleton'
import { buildSchematicGrid, placeBlacks } from '../stores/schematicGrid'
import {
  buildHillClimb, buildHcGraph,
  buildRectPolish, buildAxisAlign, buildAxisIlp, iteratePost, POST_ITER_CAP,
  straightenCompactLoop, movewiseStage,
  stepChainInit, stepChainNext, setSpanCap,
} from '../stores/hillClimb'
import { buildRwdMap, mergeParallelSegs } from '../stores/rwdMap'
import { randomWeights, weightedAxes, intervalAxes, linkWeight, uniformAxes, lerpAxes } from '../stores/rwdWeight'
import { stationPopupHtml, linePopupHtml, buildPopupIndex, stationsAlongSeg } from '../stores/popupHtml'
import StylePanel from './StylePanel.vue'
import StyleBar from './StyleBar.vue'
import AttributeTable from './AttributeTable.vue'
import MIcon from './MIcon.vue'
import { openLayerDoc } from '../stores/layerDocHandle'

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
  const startW = viewNavWidth.value
  // 拖到極限：上限＝容器寬 − 留給畫布的一小條；下限縮到很小；不設固定 90/300。
  const host = e.currentTarget?.parentElement
  dragResize(e, {
    dragging: navDragging,
    onMove: (dx) => {
      const maxW = host ? Math.max(90, host.clientWidth - 80) : 600
      viewNavWidth.value = Math.min(maxW, Math.max(40, startW + dx))
    },
  })
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
// ('hc', ②, see skill route-hillclimb), three H/V-maximising post-passes
// (直角爬山/軸對齊/整數規劃), then per chain the 4-step tail 端點移動
// ('*-end') → 直線縮減 ('*-line') → 網格合併 ('*-gather') → 縮減網格
// ('*-compact') plus the '*-loop' cycle tabs — rotation comes from its variant.
const mode = ref(isRWD.value ? 'rwd' : isHC.value ? 'hc' : 'original')
// ---- HC mode 解析 ----
// HC 視圖 id 都是 `hc-<kind>[-<step>]`：kind ∈ rect|align|ilp|llm（四條鏈），
// step ∈ end|line|gather|loop|step（鏈的三步＋循環＋逐步驗證）。舊的六張
// kind 查表（POST/END/LINE/GATHER/LOOP/STEP_KIND）全部由這一條 regex 導出。
// hc 鏈不進四個後處理區（使用者 2026-07 裁決）——只有 rect/align/ilp/llm 四條鏈；
// RWD 底圖仍可用 hc 鏈的循環（loop 區塊的 isRWD fallback，key 'hc'）。
const HC_MODE_RE = /^hc-(rect|align|ilp|llm)(?:-(end|line|gather|loop|step))?$/
// 該 step 專屬的鏈 kind（step 不符 → null）——對應舊 END/LINE/GATHER/LOOP/STEP_KIND[mode]。
const kindAtStep = (m, step) => {
  const mm = HC_MODE_RE.exec(m)
  return mm && mm[2] === step ? mm[1] : null
}
const endKindOf = (m) => kindAtStep(m, 'end')       // 端點移動（鏈第 1 步）
const lineKindOf = (m) => kindAtStep(m, 'line')     // 直線縮減（鏈第 2 步）
const gatherKindOf = (m) => kindAtStep(m, 'gather') // 網格合併（鏈第 3 步）
const loopKindOf = (m) => kindAtStep(m, 'loop')     // 端點移動+直線縮減+網格合併+縮減網格循環
const stepKindOf = (m) => kindAtStep(m, 'step')     // 逐步驗證（同一條四步鏈、按「下一步」推進）
// 瀏覽器端後處理 kind（任何 step 都要先有該鏈的後處理結果）——llm 不在內
//（LLM 對齊在檔案端算好，這裡只載入）。對應舊 POST_KIND[mode]。
const postKindOf = (m) => {
  const mm = HC_MODE_RE.exec(m)
  return mm && mm[1] !== 'llm' ? mm[1] : null
}
// Modes that need the hill-climbing result ('rwd' builds on its 縮減網格).
const hcMode = computed(() =>
  mode.value === 'hc' || HC_MODE_RE.test(mode.value) ||
  mode.value === 'hc-compact' || // RWD 圖層的「循環結果」輸入視圖沿用這個 id（HC 圖層已無縮減網格 tabs）
  mode.value === 'rwd')
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
const llmModel = ref('fable') // 預設 Fable 5（使用者：LLM 預設模型都是 Fable 5）
// 畫布 overlay 備援按鈕的下拉選項（與 StylePanel 的 LLM_MODEL_OPTIONS 一致）。
const LLM_MODEL_OPTIONS = [
  { key: 'default', label: '沿用 CLI 預設' },
  { key: 'opus', label: 'Opus 4.8' },
  { key: 'fable', label: 'Fable 5' },
  { key: 'sonnet', label: 'Sonnet 5' },
  { key: 'haiku', label: 'Haiku 4.5' },
]
// LLM 對齊（/llm-align）與 LLM 調整（/llm-grid）共用的 run/poll 機構：POST 觸發
// vite plugin spawn 的 headless Claude Code、2.5s 輪詢 status、streamed transcript
// 自動捲到底、409（已在跑）視為接上。兩者的差異——endpoint、額外參數（grid 多帶
// compact）、啟動時的快取清理/動畫快照/自動切 tab、重畫守門（llmMode vs
// 評價/互動的唯讀）、完成後的快取清理——全部由 config 注入。
function makeHeadlessRun({ base, params, run, tail, text, logEl, shouldRender, onStart, onDone }) {
  let timer = null
  async function start(userPrompt = '') {
    const cid = llmCityId.value
    if (!cid || run.value === 'running') return
    // 先擷取 params（含 align 的 base＝目前顯示佈局）——必須在 onStart 清掉 toggle
    // 狀態「之前」算好，否則 base 會被 onStart 洗掉（re-run 自動對齊誤判成 hc）。
    const runParams = params()
    run.value = 'running'
    tail.value = ''
    text.value = ''
    // 清掉舊結果——執行中畫布留白、蓋上執行中 overlay，跑完再重新載入新結果
    // （做好之後才再出現）。面板/按鈕的狀態保留（顯示執行中）。
    onStart()
    if (shouldRender()) render()
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city: cid, ...runParams,
          userPrompt: typeof userPrompt === 'string' ? userPrompt : '',
          model: llmModel.value, // 面板下拉選的模型（'default' → 不帶 --model）
        }),
      })
      if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`)
      poll()
    } catch {
      run.value = 'error'
      tail.value = '無法觸發——需要本機 npm run dev（vite）＋已安裝 Claude Code CLI'
    }
  }
  function poll() {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ city: llmCityId.value, ...params() })
        const res = await fetch(`${base}/status?${qs}`)
        const s = await res.json()
        tail.value = s.tail ?? ''
        if (s.text != null) {
          text.value = s.text
          // stick to the bottom so the newest reply is always visible
          requestAnimationFrame(() => {
            if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
          })
        }
        if (s.running) {
          // still running — keep the map blank + overlay up, just refresh the log
          poll()
        } else if (s.exit === 0) {
          onDone(true) // reload the finished result
          run.value = null
          render()
        } else {
          onDone(false)
          run.value = 'error'
          if (shouldRender()) render() // fall to the 開始 retry state
        }
      } catch {
        run.value = 'error'
        tail.value = '狀態輪詢失敗'
      }
    }, 2500)
  }
  return { start, stop: () => clearTimeout(timer) }
}
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
const llmRunner = makeHeadlessRun({
  base: '/llm-align',
  params: () => ({ variant: hcVariant.value, kind: 'auto', base: currentAlignBase() }),
  run: llmRun, tail: llmRunTail, text: llmRunText, logEl: llmLogEl,
  shouldRender: () => false, // 唯讀：跑的時候畫布照畫（base HC/舊結果）、不留白，串流顯示在面板
  onStart: () => {
    // 清舊結果：面板的逐輪 transcript／provenance（llmStats）與提示一起清掉，
    // 跑完 render 再載入新結果（跟 eval/grid 的 onStart 一致）。
    cachedLlm = null; llmStats.value = null; llmMsg.value = null; llmInfo.value = null
    llmApplied.value = false; invalidateLlmDownstream()
  },
  onDone: () => { cachedLlm = null; invalidateLlmDownstream() },
})
const startLlmRun = llmRunner.start
// 「指定對齊」的獨立 runner：kind:'prompt' → 後端寫 .prompt.json、job key 分開。
// 不動下游快取（指定對齊不餵下游，見 render）。清舊結果同 eval/grid。
const promptRunner = makeHeadlessRun({
  base: '/llm-align',
  params: () => ({ variant: hcVariant.value, kind: 'prompt', base: currentAlignBase() }),
  run: promptRun, tail: promptRunTail, text: promptRunText, logEl: promptLogEl,
  shouldRender: () => false,
  onStart: () => { cachedPrompt = null; promptStats.value = null; promptMsg.value = null; promptApplied.value = false },
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
function toggleLlmExec() {
  if (!cachedLlm?.cells) return
  llmApplied.value = !llmApplied.value
  if (llmApplied.value) promptApplied.value = false // 互斥
  invalidateLlmDownstream() // 顯示佈局變了 → 鏈重算
  render()
}
function togglePromptExec() {
  if (!cachedPrompt?.cells) return
  promptApplied.value = !promptApplied.value
  if (promptApplied.value) llmApplied.value = false // 互斥
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
const gridRunner = makeHeadlessRun({
  base: '/llm-grid',
  params: () => ({ variant: hcVariant.value, compact: rwdCompactKey.value }),
  run: gridRun, tail: gridRunTail, text: gridRunText, logEl: gridLogEl,
  shouldRender: () => false, // 唯讀：跑的時候畫布照畫 RWD、不留白（串流顯示在面板）
  onStart: () => { cachedGrid = null; gridStats.value = null; gridMsg.value = null; gridApplied.value = false },
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
const evalRunner = makeHeadlessRun({
  base: '/llm-eval',
  params: () => ({ variant: hcVariant.value, compact: rwdCompactKey.value }),
  run: evalRun, tail: evalRunTail, text: evalRunText, logEl: evalLogEl,
  shouldRender: () => false, // 唯讀評價：畫布照畫、不留白、不蓋 overlay
  onStart: () => { cachedEval = null; evalStats.value = null; evalMsg.value = null },
  onDone: () => { cachedEval = null },
})
const startEvalRun = evalRunner.start
// ---- 執行 LLM 評價結果（不用 LLM）----
// 評價時 llmEval.mjs apply 已把評價附帶的 moves 經 applyLlmTargets（與 LLM 對齊
// 完全相同的硬規則）套用、把調整後佈局存進結果檔的 exec.cells——這裡的「執行
// 調整」只是切換顯示：套用＝用 exec.cells 取代縮減網格佈局重畫，恢復＝切回原
// 佈局。可來回切換比較前後差別，不重跑任何 LLM。
const evalApplied = ref(false)
function toggleEvalExec() {
  if (!evalStats.value?.exec?.cells) return
  evalApplied.value = !evalApplied.value
  cachedRWD = null // sizeKey 不含套用狀態——直接作廢重畫
  render()
}
// The three H/V-maximising post-passes (short-distance moves of coloured
// vertices AFTER the hill climbing — see skill route-hillclimb): 直角爬山
// re-climbs with |sin 2θ|, 軸對齊 merges near-axis chains on median
// coordinates, 整數規劃 solves per-axis offset programs exactly. Each is
// iterated to a FIXED POINT (fed its own output until nothing moves, cap
// POST_ITER_CAP). postIters drives the 「n/20」 badge on the tab button.
const postIters = ref({}) // kind -> iterations used (set once computed)
const iterBadge = (kind) =>
  (postIters.value[kind] ? ` ${postIters.value[kind]}/${POST_ITER_CAP}` : '')
const POST_BUILD = { rect: buildRectPolish, align: buildAxisAlign, ilp: buildAxisIlp }
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
// - 逐步驗證（第 9 部份）：同一條四步鏈，由使用者按「下一步」一步步執行：每步＝
//   目前階段的一個單掃描（或一次縮減網格），掃不動自動換下一階段，一輪全沒動靜
//   ＝完成（stepChainInit/stepChainNext）。也沒有 hc 鏈（使用者 2026-07 裁決）。
// 面板的階段 chips：這一步執行的工作（lastStage）會亮起。
// 縮減網格不是獨立階段——每一步完成後自動壓（訊息尾巴會標「縮減網格 a×b → c×d」）。
const STEP_STAGES = [
  { k: 'endp', label: '端點移動' }, { k: 'line', label: '直線縮減' },
  { k: 'gather', label: '網格合併' },
]
// RWD 視圖建立在某個「縮減網格」之上：其 layer.compact（'hc'|'rect'|'align'|'ilp'）決定
// 要不要先套後處理再縮減（'hc'/未設＝基本縮減）。使 RWD 能選任一縮減網格變體。
const postKind = computed(() =>
  isHC.value ? postKindOf(mode.value)
    : isRWD.value && ['rect', 'align', 'ilp'].includes(layer.value?.compact) ? layer.value.compact
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
let cachedPost = {}    // rect / align / ilp post-pass results, keyed by kind
let cachedFp = null    // 本資料的內容指紋（localStorage 快取鍵用）

// ---- 跨 reload 持久快取（localStorage）----
// 最貴的計算是爬山（buildHillClimb）＋後處理（iteratePost）。它們的輸出是純資料
// （cellAfter = Map<id,[c,r]>、stats = 數字），與畫布大小無關（rank-based），且對
// 一份資料＋變體是確定的 → 存下來、關 tab 再開或重新整理都直接載回、不重跑。
// 失效靠「資料內容指紋」：站/線一變指紋就變 → 自動 cache miss 重算，永不載到舊的。
// LLM 對齊視圖只為了做指紋比對而跑爬山，載回快取後連它也免重算。
// **快取鍵必須含演算法版本**：鍵的另一半是「資料指紋」（dataFingerprint 只看資料），
// 資料沒變但**演算法變了**（如骨架建圖改含 pass）時，舊快取的佈局與新骨架結構對不上——
// 節點缺格子 → RWD/HC 整段線消失、站點退回舊座標懸空（倫敦 Kilburn 案，2026-07-17）。
// 且 localStorage 不隨 dev server 重啟/硬重載清除，殘留跨天。**改了 skeleton/schematicGrid/
// hillClimb 的演算法就把版本 +1**；另有 use-time 結構驗證兜底（見 cachedHC 使用處）。
const HC_LS_KEY = 'd3tab-hc-cache-v7' // v7: 河流不放灰（座標空間縮小）＋快取加界內驗證，清掉 v6 gray-on 殘留避免超出網格；v6: 河流粉紅/灰與 metro 一致；v5: 河流全點保留＋絕對 km 粉紅（巴黎長弦案）；v4: validShift 變形段補洞（大邱案）；v3: 骨架建圖含 pass
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
let cachedLlm = null   // fetched llmview (自動對齊): { cells, stats } or { miss: hint }
let cachedPrompt = null // fetched .prompt.json (指定對齊): { cells, stats } or { miss }
let cachedEndp = {}    // 端點移動 (movewiseStage 'endp')，keyed by 鏈 'hc'/'rect'/'align'/'ilp'/'llm'
let cachedLine = {}    // 直線縮減 (movewiseStage 'line')，keyed by 鏈 'hc'/'rect'/'align'/'ilp'/'llm'
let cachedGather = {}  // 網格合併 (movewiseStage 'gather')，keyed by 鏈 'hc'/'rect'/'align'/'ilp'/'llm'
let cachedLoop = {}    // 端點移動+直線縮減+網格合併+縮減網格循環 (straightenCompactLoop)，keyed by 鏈
let stepState = {}     // 逐步驗證 進度 (stepChainInit/Next 的 state)，keyed by 鏈；按「下一步」推進
let stepHistory = {}   // 逐步驗證 復原堆疊，keyed by 鏈：[{ st, kind:'big'|'sub' }]（上一步/上一小步用）
let cachedRWD = null // virtual-canvas routing — isotropic rescale on resize
// llmview（LLM 對齊）與 llmgrid（LLM 調整）結果檔的共用載入器：fetch →
// content-type 檢查 → fingerprint 比對（verts/segs 共通＋fpOk 額外欄位）→
// 對應 miss 訊息；成功回 onOk(j)。呼叫端自己處理 renderSeq 過期。
async function fetchLlmResult(url, { missNone, missStale, missErr, fpOk, onOk }) {
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
      console.warn('[llm-stale]', url, {
        fileFingerprint: fp,
        webVerts: cachedHC.stats.verts, webSegs: cachedHC.stats.segs,
        vertsMatch: vOk, segsMatch: sOk, colsRowsMatch: extraOk,
      })
      return { miss: missStale }
    }
    return onOk(j)
  } catch { return { miss: missErr } }
}
const hcBusy = ref(false)
const busyText = ref('')
const hcStats = ref(null)
const postStats = ref(null)      // { hvBefore, hvAfter, segs, moved, ... }
const hcCompactStats = ref(null) // { fromCols, fromRows, cols, rows }
const endpStats = ref(null)      // 端點移動: { hvBefore, hvAfter, segs, moved, endpoints, iters, ... }
const lineStats = ref(null)      // 直線縮減: { hvBefore, hvAfter, segs, moved, iters, fromCols, ..., converged }
const gatherStats = ref(null)    // 網格合併: { moved, segs, verts, iters, iterCap, converged }
const stepInfo = ref(null)       // 逐步驗證: { info, steps, round, done }（顯示在浮動面板）
const loopStats = ref(null)      // 循環: { hvBefore, hvAfter, segs, moved, lineMoved, rounds, fromCols, ..., converged }
const rwdStats = ref(null)       // { straight, single, double, fallback, segs }
// ---- 權重驅動版面簡化（RWD Maps 左側「權重」tab，論文 §九）----
// weight 掛在 cut-to-cut 段上；'weight' 模式時 weight → 非均勻欄寬列高 → 在新像素座標
// 重跑 buildRwdMap。'uniform' = 均勻網格（預設）。全部隨機每按一次整表重抽。
const rwdWeightMode = ref('uniform') // 'uniform' | 'weight'
const rwdDirs = ref(8)               // RWD 允許的線方向數：4（只H/V）| 8（+45°，預設）| 16（+22.5°）
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
// 允許的線方向數（4/8/16）：改了要作廢 RWD 快取重畫（候選集不同）。
function setRwdDirs(n) { rwdDirs.value = n; cachedRWD = null; render() }
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
      { header: '輸入', doc: 'movewise-loop' },
      { id: 'hc-compact', label: '循環結果' },
      { header: '結果', doc: 'rwd' },
      { id: 'rwd', label: 'RWD 路網' },
      // 「LLM互動」不再是獨立視圖——改成右側面板 tab ＋ RWD 路網上的「執行調整」
      // 切換（見 gridApplied），左邊列表不再列它。
    ]
  }
  if (isHC.value) {
    // 左選單分 9 個部份：原始／Hill Climbing／直線演算法／端點移動／直線縮減
    // ／網格合併／縮減網格／端點移動+直線縮減+網格合併+縮減網格循環／逐步驗證
    // （header 項是分組標題，可點開合——見下方 navSections；全部左側功能列
    // 共用同一套分組版面，Map Adjust／RWD 的清單也有 header）。
    return [
      { header: '原始', doc: 'grid' },
      { id: 'grid-post', label: hcVariant.value === 'rot' ? `${rotLabel.value}格網化後` : '原始格網化後' },
      { header: 'Hill Climbing', doc: 'hillclimb' },
      { id: 'hc', label: 'Hill Climbing' },
      // iterated-to-fixed-point passes: the button carries 「已迭代/上限」
      { header: '直線演算法', doc: 'straighten' },
      { id: 'hc-rect', label: `直角爬山${iterBadge('rect')}` },
      { id: 'hc-align', label: `軸對齊${iterBadge('align')}` },
      { id: 'hc-ilp', label: `整數規劃${iterBadge('ilp')}` },
      // 第四種（LLM）: the badge carries the rounds AND the model that produced it
      { id: 'hc-llm', label: `LLM 對齊${llmInfo.value ? ` ${llmInfo.value.rounds}輪 · ${llmInfo.value.model}` : ''}` },
      // 鏈的三步＋循環＋逐步（每步一區、每條鏈一個 tab，前面的 tab 不受後面
      // 步驟影響）：該鏈結果 → 端點移動 → 直線縮減 → 網格合併；另有 循環
      //（交替四步直到沒有點可以動，見 loopKindOf）與 逐步驗證（按「下一步」
      // 推進，見 stepKindOf）。四條鏈 × 各區塊用迴圈生成。
      ...[
        ['end', '端點移動', (zh) => `${zh}端點移動`, 'endpoint-move'],
        ['line', '直線縮減', (zh) => `${zh}直線縮減`, 'line-compact'],
        ['gather', '網格合併', (zh) => `${zh}網格合併`, 'grid-merge'],
        ['loop', '端點移動+直線縮減+網格合併循環', (zh) => `${zh}循環`, 'movewise-loop'],
        ['step', '逐步驗證', (zh) => `${zh}逐步`, 'step-verify'],
      ].flatMap(([step, header, fmt, doc]) => [
        { header, doc },
        ...[['rect', '直角爬山'], ['align', '軸對齊'], ['ilp', '整數規劃'], ['llm', 'LLM 對齊']]
          .map(([k, zh]) => ({ id: `hc-${k}-${step}`, label: fmt(zh) })),
      ]),
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
// 左側功能列分組可開合（使用者規則：不用全部展開）。VIEW_TABS 依 header 收成
// sections；預設收合、只展開「含目前視圖」的那一組，點 header 切換。
// navOpen 只記使用者手動切換過的組（true/false），沒記錄的走預設。
const navSections = computed(() => {
  let cur = { header: null, items: [] }
  const secs = [cur]
  for (const t of VIEW_TABS.value) {
    if (t.header) { cur = { header: t.header, doc: t.doc, items: [] }; secs.push(cur) }
    else cur.items.push(t)
  }
  return secs.filter((s) => s.header || s.items.length)
})
const navOpen = ref({})
const navSectionOpen = (s) =>
  !s.header || (navOpen.value[s.header] ?? s.items.some((t) => t.id === mode.value))
function toggleNavSection(s) {
  if (s.header) navOpen.value[s.header] = !navSectionOpen(s)
}

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
    cachedPrompt = null
    cachedGrid = null
    cachedEval = null
    cachedEndp = {}
    cachedLine = {}
    cachedGather = {}
    cachedLoop = {}
    stepState = {}
    stepHistory = {}
    cachedRWD = null
    hcStats.value = null
    postStats.value = null
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
  let hcPos = null, hcBlue = null, rwdLines = null, weighted = false, stepMoves = []
  if (grid && needsHC.value && hcMode.value) {
    // 跨距上限（預設 3）用「已套用」的值（appliedSpanCap）——滑桿改了但還沒按「重新
    // 計算」前，快取與新計算都維持舊上限，避免同畫面新舊混雜。
    if (appliedSpanCap.value == null) appliedSpanCap.value = panelLayer.value?.spanCap ?? 3
    setSpanCap(appliedSpanCap.value)
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
      // 唯讀載入對齊結果供面板顯示＋切換用（跟評價/互動一樣，跑的時候不阻擋畫圖：
      // 沒有結果或未套用時就照畫對齊前的 base 佈局，不留白）。
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
        if (seq !== renderSeq) return // superseded during fetch
      }
      if (cachedLlm?.cells) {
        llmStats.value = cachedLlm.stats
        llmInfo.value = { rounds: cachedLlm.stats.rounds, model: cachedLlm.stats.model }
      } else {
        llmStats.value = null
        llmMsg.value = cachedLlm?.miss ?? null
        llmApplied.value = false
      }
      // 「指定對齊」（.prompt.json）只在 LLM 對齊主視圖載入＋比較用，不餵下游。
      const onMainAlign = isHC.value && mode.value === 'hc-llm'
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
        if (seq !== renderSeq) return // superseded during fetch
      }
      if (onMainAlign) {
        if (cachedPrompt?.cells) promptStats.value = cachedPrompt.stats
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
    {
      // RWD（含其「縮減網格」輸入視圖）也走這裡：建立在該鏈的循環結果之上。
      const loopKind = loopKindOf(mode.value) ?? (isRWD.value ? rwdCompactKey.value : null)
      if (loopKind) {
        if (!cachedLoop[loopKind]) cachedLoop[loopKind] = straightenCompactLoop(cachedSkeleton, cells, nC, nR)
        cells = cachedLoop[loopKind].cellAfter
        nC = cachedLoop[loopKind].cols
        nR = cachedLoop[loopKind].rows
        loopStats.value = cachedLoop[loopKind].stats
        if (isRWD.value) hcCompactStats.value = { fromCols: grid.cols, fromRows: grid.rows, cols: nC, rows: nR }
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
    // 「LLM評價」結果（llmevals，skill route-llm-eval）：唯讀評語——載入＋
    // fingerprint 驗證後只給右側面板顯示，不影響畫圖（沒有結果也照畫）。
    if (isRWD.value && !cachedEval && evalRun.value !== 'running') {
      const cid = sourceLayer.value?.id
      cachedEval = !cid
        ? { miss: '匯入資料不支援 LLM 評價（沒有城市 id 可對應結果檔）' }
        : await fetchLlmResult(`data/metro/llmevals/${cid}.${hcVariant.value}.${rwdCompactKey.value}.json`, {
          missNone: '尚未產生評價——按「開始 LLM 評價」讓模型評這個路網',
          missStale: 'LLM 評價與目前資料不符（資料已更新）——請重新產生',
          missErr: '無法載入 LLM 評價結果',
          fpOk: (fp) => fp.cols === nC && fp.rows === nR,
          onOk: (j) => ({ stats: j }),
        })
      if (seq !== renderSeq) return // superseded during fetch
      evalStats.value = cachedEval.stats ?? null
      evalMsg.value = cachedEval.miss ?? null
    }
    // 「執行調整」套用中：以評價存好的 exec.cells（apply 時已過硬規則）取代
    // 縮減網格佈局重畫；恢復＝這裡不取代。網格尺寸不變 → 前後可對齊比較。
    if (isRWD.value) {
      const evalExec = evalStats.value?.exec
      if (!evalExec?.cells) evalApplied.value = false
      else if (evalApplied.value) cells = new Map(evalExec.cells.map(([id, c, r]) => [id, [c, r]]))
    }
    // 「LLM互動」（llmgrids 結果檔）：載入＋fingerprint 驗證，供面板顯示與「執行
    // 調整」切換——與評價一樣是唯讀載入、不影響畫圖（沒有結果也照畫 RWD）。
    if (isRWD.value && !cachedGrid && gridRun.value !== 'running') {
      const cid = sourceLayer.value?.id
      cachedGrid = !cid
        ? { miss: '匯入資料不支援 LLM 互動（沒有城市 id 可對應結果檔）' }
        : await fetchLlmResult(`data/metro/llmgrids/${cid}.${hcVariant.value}.${rwdCompactKey.value}.json`, {
          missNone: '尚未產生 LLM 互動——輸入一句話（例：把市中心那幾欄拉開），讓模型推理每欄／列該佔多大',
          missStale: 'LLM 互動結果與目前資料不符（資料已更新）——請重新產生',
          missErr: '無法載入 LLM 互動結果',
          fpOk: (fp) => fp.cols === nC && fp.rows === nR,
          onOk: (j) => ({ colW: j.colW, rowW: j.rowW, stats: j }),
        })
      if (seq !== renderSeq) return // superseded during fetch
      gridStats.value = cachedGrid.stats ?? null
      gridMsg.value = cachedGrid.miss ?? null
      gridInfo.value = cachedGrid.stats ? { model: cachedGrid.stats.model } : null
    }
    // 「執行調整」套用中：用 LLM 推理的區間權重（intervalAxes）決定欄寬列高重畫；
    // 沒有可套用的結果就強制恢復。網格拓撲不變、外框固定 → 前後可對齊比較。
    const gridExec = cachedGrid?.colW ? cachedGrid : null
    if (!gridExec) gridApplied.value = false
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
    const cellPx = axes ? axes.cellPx : ([c, r]) => [24 + (c + 0.5) * cw, 24 + (r + 0.5) * ch]
    if (rwdMode.value) {
      // RWD 路網: 八方向約束以「版面 pixel」為準 — the map follows the panel shape
      // (隨板面變形), so the polylines are rebuilt in the CURRENT canvas pixel
      // space whenever the size changes (with cw ≠ ch a cell-space 45° is not
      // 45° on screen). Same-size renders reuse the cached result. The interior
      // blacks already sit ON the polylines (no placeBlacks here).
      const sizeKey = `${w}x${h}|d${rwdDirs.value}|${gridOn ? `g${rwdGridSeq}`
        : animing ? `a${rwdAnimT.toFixed(3)}` : weighted ? `w${rwdWeightSeq}` : 'u'}`
      if (!cachedRWD || cachedRWD.key !== sizeKey) {
        if (!animing) {
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
            dirs: rwdDirs.value, // 允許的線方向數 4/8/16
            // 自動隱藏白點：站距 < 門檻才刪，逐級升高 weight 差門檻（見 rwdMap.js）。
            hideStops: rwdHideStops.value,
            minStopPx: rwdMinStopPx.value,
            linkWeight: (u, v) => linkWeight(rwdWeights.value, u, v),
            ...(animing ? { fast: true }
              : (weighted || gridOn) ? {}
                : { lattice: { x0: 24, y0: 24, sx: cw / 2, sy: ch / 2, nx: nC * 2 + 1, ny: nR * 2 + 1 } }),
          }),
        }
        hcBusy.value = false
      }
      rwdStats.value = cachedRWD.stats
      hcPos = new Map(cachedRWD.posAfter)
      rwdLines = cachedRWD.lines.map((L) => ({ ...L, px: L.pts }))
      hcBlue = axes ? { xs: axes.colX, ys: axes.rowY } : uniformBlue(nC, nR, cw, ch)
    } else {
      hcPos = new Map()
      for (const [id, p] of cells) hcPos.set(id, cellPx(p))
      placeBlacks(cachedSkeleton, hcPos, (id) => grid.posAfter.get(id) ?? null)
      hcBlue = uniformBlue(nC, nR, cw, ch)
    }
  }
  const posOf = (id) =>
    (hcPos && hcPos.get(id)) || (grid && gridPost.value && grid.posAfter.get(id)) || projById.get(id)
  const MAX_OVERLAP = 6, DASH = 5 // overlap interleaved-dash pattern (screen px)
  // 均勻藍色分隔網格（格線在刻度上、穿過格心）——HC/RWD 兩個分支共用。
  function uniformBlue(nC, nR, cw, ch) {
    return {
      xs: Array.from({ length: nC + 1 }, (_, i) => 24 + i * cw),
      ys: Array.from({ length: nR + 1 }, (_, i) => 24 + i * ch),
    }
  }
  // 單色 route → 實線原色；共線（≥2 相異色）→ 交錯彩色虛線（dasharray 逐邊重
  // 置相位，同 RWD／原始逐段畫法）。extra 帶 props（原始 feature，hover 走
  // popupHtml）或 html（骨架邊/RWD 的現成 tooltip）。三個畫線分支共用。
  const dashStrokes = (d, colsIn, fallback, extra) => {
    const cols = (colsIn ?? []).slice(0, MAX_OVERLAP)
    if (new Set(cols).size >= 2) {
      const n = cols.length
      return cols.map((c, i) => ({ d, stroke: c, ...extra, dash: `0 ${i * DASH} ${DASH} ${(n - 1 - i) * DASH}` }))
    }
    return [{ d, stroke: cols[0] ?? fallback ?? '#e11d48', ...extra }]
  }
  // 地標 feature（河流骨架／皇居・公園）在 D3 視圖用地標色畫（與 LayerTab 一致）——
  // 河流骨架瑩光天藍 #00E5FF、面域綠 #58a866；否則會退回 route 預設色（玫瑰紅）＝使用者回報
  // 「地標顏色跟本來不一樣」。
  const isLandmark = (p) => p && p.landmark_id != null
  const landmarkStroke = (p) => (/river/.test(p.kind || '') ? '#00E5FF' : '#58a866') // 河流瑩光天藍
  const featStrokes = (f, d, extra) => isLandmark(f.properties)
    ? [{ d, stroke: landmarkStroke(f.properties), ...extra }]
    : dashStrokes(d, f.properties.route_colors, null, extra)
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
    // 顯著點（紅匯流/藍端點/粉紅轉折/紫切點/黃）時才畫；黑/灰的河流折點不畫。
    const riverShow = (p) => {
      const c = sk.stationClass.get(p.station_id)
      return c && c !== 'black' && c !== 'gray'
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
      // Same station hover as Metro Maps (name + local + lines); a pink bend
      // point appends its sinuosity detail below rather than replacing it.
      const info = sk?.pinkInfo?.get(d.props.station_id)
      if (info && !gridMode.value) drawRef(info)
      showTip(e, stationPopupHtml(d.props, tipIdx?.refColor) + (info ? pinkExtra(info) : '')) // 共用 popupHtml
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
// 樣式 tab 的「顏色點間最大跨距」：滑桿只改 layer.spanCap，不自動重算——
// 快取沿用 appliedSpanCap（上次套用的值），按「重新計算」才作廢重算。
const appliedSpanCap = ref(null)
watch(() => panelLayer.value?.id, () => { appliedSpanCap.value = panelLayer.value?.spanCap ?? 3 })
function recalcSpan() {
  appliedSpanCap.value = panelLayer.value?.spanCap ?? 3
  // 跨距上限只約束爬山（setSpanCap → buildHillClimb），所以它與其後處理必須一併作廢，
  // 否則 render() 的 `if (!cachedHC)` 會沿用舊上限的佈局，下游重算也只是換湯不換藥。
  cachedHC = null
  cachedPost = {}
  cachedEndp = {}
  cachedLine = {}
  cachedGather = {}
  cachedLoop = {}
  stepState = {}
  stepHistory = {}
  cachedRWD = null
  render()
}
// Live style sync from the bound layer (Style tab sliders).
watch(
  () => [panelLayer.value?.strokeWidth, panelLayer.value?.radius, panelLayer.value?.opacity],
  applyStyle,
)
// Toggling station labels needs a re-render (add/remove text nodes).
watch(() => panelLayer.value?.showLabels, render)
// 顯示/隱藏網格：切換 showGrid → 重畫（藍色示意網格 add/remove）。
watch(() => panelLayer.value?.showGrid, render)

// 「顯示全部」（StyleBar）：把 d3-zoom 重置回 identity——render() 就是把投影 fit 到
// 容器後把 zoom 設為 identity，所以重置＝回到「全部可見」的初始 fit 狀態。
function fitView() {
  if (zoomBehavior && svgEl.value) {
    select(svgEl.value).call(zoomBehavior.transform, zoomIdentity)
  }
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
          :weight-auto="rwdAutoShuffle"
          :hide-stops="rwdHideStops"
          :min-stop-px="rwdMinStopPx"
          :stop-stat="rwdStopStat"
          :span-applied="appliedSpanCap"
          @show-weights="setRwdShowWeights"
          @weight-mode="setRwdWeightMode"
          @dir-count="setRwdDirs"
          @weight-random="regenRwdWeights"
          @weight-auto="toggleRwdAutoShuffle"
          @hide-stops="setRwdHideStops"
          @min-stop-px="setRwdMinStopPx"
          @recalc-span="recalcSpan"
          @fit-view="fitView"
        />
        <div class="map-main">
          <div class="view-nav" :style="{ width: viewNavWidth + 'px' }" role="tablist">
            <div
              v-for="s in navSections"
              :key="s.header ?? 'flat'"
              class="view-nav-sec"
              :class="{ open: navSectionOpen(s), flat: !s.header }"
            >
              <button
                v-if="s.header"
                class="view-nav-group"
                :aria-expanded="navSectionOpen(s)"
                @click="toggleNavSection(s)"
              >
                <MIcon
                  :name="navSectionOpen(s) ? 'expand_more' : 'chevron_right'"
                  :size="14"
                  class="view-nav-caret"
                />
                <span class="view-nav-group-label">{{ s.header }}</span>
                <MIcon
                  v-if="s.doc"
                  name="help"
                  :size="14"
                  class="view-nav-help"
                  role="button"
                  title="這個圖層的做法／JSON 格式／顯示方式"
                  @click.stop="openLayerDoc(s.doc, s.header)"
                />
              </button>
              <div v-if="navSectionOpen(s)" class="view-nav-sec-items">
                <button
                  v-for="t in s.items"
                  :key="t.id"
                  class="view-nav-item"
                  :class="{ active: mode === t.id }"
                  role="tab"
                  :aria-selected="mode === t.id"
                  :disabled="!panelLayer || (t.rot && !canRotate)"
                  :title="t.rot && !canRotate ? '網路已對齊正南北，無需旋轉' : ''"
                  @click="mode = t.id"
                >{{ t.label }}</button>
              </div>
            </div>
          </div>
          <div
            class="view-nav-resize"
            :class="{ dragging: navDragging }"
            role="separator"
            aria-orientation="vertical"
            @pointerdown="startNavResize"
          />

          <!-- 地圖底色（樣式 tab 的 layer.d3Bg）——未設定時用主題預設背景 -->
          <div ref="host" class="ma-canvas" :style="panelLayer?.d3Bg ? { background: panelLayer.d3Bg } : null">
          <svg ref="svgEl" class="ma-svg" @click="panelLayer && store.setSelectedFeature(panelLayer.id, null)">
            <g ref="gEl" />
          </svg>
          <div ref="tipEl" class="ma-tip" />
          <div v-if="loading" class="ma-hint">載入中…</div>
          <div v-else-if="hcBusy" class="ma-hint">{{ busyText }}</div>
          <div v-else-if="loadError" class="ma-hint error">{{ loadError }}</div>
          <!-- LLM 對齊改成唯讀＋toggle（跟 LLM評價/互動一樣）：跑的時候不蓋畫布、
               不留白，串流與「執行調整/恢復原佈局」都在右側「LLM對齊」面板 tab。 -->
          <!-- 逐步驗證 控制面板：按「下一步」執行一個單掃描步驟，看四步鏈
               怎麼一步步收斂；「重設」回到該鏈的起點。 -->
          <div v-if="isHC && stepKindOf(mode)" class="step-panel">
            <button class="step-btn back" :disabled="!panelLayer || !stepInfo?.hist" @click="stepPrev(false)">◀ 上一步</button>
            <button class="step-btn" :disabled="!panelLayer || stepInfo?.done" @click="stepNext()">下一步 ▶</button>
            <button class="step-btn back sub" :disabled="!panelLayer || !stepInfo?.hist" @click="stepPrev(true)">‹ 上一小步</button>
            <button class="step-btn sub" :disabled="!panelLayer || stepInfo?.done" @click="stepNext(1)">下一小步 ›</button>
            <button class="step-btn ghost" :disabled="!panelLayer" @click="stepReset">重設</button>
            <span class="step-count" v-if="stepInfo">第 {{ stepInfo.steps }} 步</span>
            <!-- 這一步是哪一個工作：執行到的階段亮起 -->
            <span class="step-stages" v-if="stepInfo">
              <template v-for="(s, i) in STEP_STAGES" :key="s.k">
                <span v-if="i" class="step-arrow">→</span>
                <span class="step-chip" :class="{ active: stepInfo.lastStage === s.k }">{{ s.label }}</span>
              </template>
            </span>
            <span class="step-msg" v-if="stepInfo" :class="{ done: stepInfo.done }">{{ stepInfo.info }}</span>
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
      :llm-model="llmModel"
      @update:llm-model="llmModel = $event"
      :weight-mode="rwdWeightMode"
      :weight-auto="rwdAutoShuffle"
      :show-weights="rwdShowWeights"
      :hide-stops="rwdHideStops"
      :min-stop-px="rwdMinStopPx"
      :stop-stat="rwdStopStat"
      :span-applied="appliedSpanCap"
      @recalc-span="recalcSpan"
      @run-llm="startLlmRun"
      @run-prompt="startPromptRun"
      @run-grid="startGridRun"
      @run-eval="startEvalRun"
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
    />
    </div>

    <!-- Footer status bar (mirrors the metro map tab's StatusBar): the toolbar's
         right-side readouts — per-mode stats + data source — live here now. -->
    <footer class="ma-statusbar">
      <!-- Hill Climbing: multicriteria fitness before → after (lower = better) -->
      <span v-if="isHC && mode === 'hc' && hcStats" class="hc-stats">
        適應度 {{ fmtFit(hcStats.before) }} → {{ fmtFit(hcStats.after) }}
        · {{ hcStats.rounds }} 輪 · 移動 {{ hcStats.moved }} 站<template
          v-if="hcStats.clusterMoves"> · {{ hcStats.clusterMoves }} 群集</template>
      </span>

      <!-- 直線縮減: rigid perpendicular line shifts, grid compacted after every move -->
      <span v-if="isHC && lineKindOf(mode) && lineStats" class="hc-stats">
        直線縮減 移動 {{ lineStats.moved }} 線 · 網格
        {{ lineStats.fromCols }}×{{ lineStats.fromRows }} →
        {{ lineStats.cols }}×{{ lineStats.rows }}
        · 水平垂直 {{ lineStats.hvBefore }} → {{ lineStats.hvAfter }}／{{ lineStats.segs }} 段<template
          v-if="!lineStats.converged">（達上限未收斂）</template>
      </span>

      <!-- 網格合併: 相鄰 row/col 兩兩合併（validShift 判準、拓撲不變） -->
      <span v-if="isHC && gatherKindOf(mode) && gatherStats" class="hc-stats">
        網格合併 {{ gatherStats.mergedRows }} 列 · {{ gatherStats.mergedCols }} 欄
        · 網格 {{ gatherStats.fromCols }}×{{ gatherStats.fromRows }} →
        {{ gatherStats.cols }}×{{ gatherStats.rows }}<template
          v-if="!gatherStats.converged">（達上限未收斂）</template>
      </span>

      <!-- 循環: 端點移動 → 直線縮減 → 網格合併（每個移動後即壓縮）until nothing can move -->
      <span v-if="isHC && loopKindOf(mode) && loopStats" class="hc-stats">
        循環 {{ loopStats.rounds }} 輪 · 端點移動 {{ loopStats.moved }} 點
        · 直線縮減 {{ loopStats.lineMoved }} 線
        · 網格合併 {{ loopStats.gatherMoved }} 次
        · 水平垂直 {{ loopStats.hvBefore }} → {{ loopStats.hvAfter }}／{{ loopStats.segs }} 段
        · 網格 {{ loopStats.fromCols }}×{{ loopStats.fromRows }} →
        {{ loopStats.cols }}×{{ loopStats.rows }}<template
          v-if="!loopStats.converged">（達上限未收斂）</template>
      </span>

      <!-- 端點移動: vertex-alignment H/V pass on top of each chain's result -->
      <span v-if="isHC && endKindOf(mode) && endpStats" class="hc-stats">
        端點移動 移動 {{ endpStats.moved }}/{{ endpStats.verts }} 點
        · 水平垂直 {{ endpStats.hvBefore }} → {{ endpStats.hvAfter }}／{{ endpStats.segs }} 段
        · 網格 {{ endpStats.fromCols }}×{{ endpStats.fromRows }} →
        {{ endpStats.cols }}×{{ endpStats.rows }}<template
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

      <!-- LLM 對齊: button-triggered offline run — rounds + the model
           （對齊已套用到目前視圖時才顯示：主視圖看 toggle、各鏈一律套用）-->
      <span v-if="llmMode && llmStats && (mode !== 'hc-llm' || llmApplied)" class="hc-stats">
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

      <!-- LLM 指定對齊: 主視圖套用指定對齊時才顯示（與自動對齊互斥）-->
      <span v-if="isHC && mode === 'hc-llm' && promptApplied && promptStats" class="hc-stats">
        指定對齊 · 水平垂直 {{ promptStats.hvBefore }} → {{ promptStats.hvAfter }}／{{ promptStats.segs }} 段
        · 迭代 {{ promptStats.rounds }} 輪 · 移動 {{ promptStats.moved }} 站 · 模型 {{ promptStats.model }}
      </span>

      <!-- LLM 互動: interval-weight run — the model + how big the core got（套用中才顯示）-->
      <span v-if="gridApplied && gridStats" class="hc-stats">
        LLM 互動（已套用）· 模型 {{ gridStats.model }}
        · 最大倍率 {{ Math.max(...gridStats.colW, ...gridStats.rowW).toFixed(1) }}
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
          · 窄縫 {{ rwdStats.squeezed }}</template><template v-if="rwdStats.colinear">
          · 共線 {{ rwdStats.colinear }}</template><template v-if="rwdStats.fallback">
          · 兜底 {{ rwdStats.fallback }}</template><template v-if="rwdStats.forced">
          · 殘留衝突 {{ rwdStats.forced }}</template><template v-if="hcCompactStats"> · 網格
          {{ hcCompactStats.cols }}×{{ hcCompactStats.rows }}</template>
      </span>

      <span class="ma-label">資料來源：</span>
      <span class="ma-source">
        {{ ownData ? `${layer?.name}（匯入 JSON）`
          : isRWD ? (hcLayer ? `${hcLayer.name}（端點移動+直線縮減+網格合併循環）` : (layer?.sourceLayerId ?? '—'))
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
/* 分組（原始／Hill Climbing／直線演算法／…）——全部左側功能列共用同一套版面：
   header 一列（caret＋標題＋項目數 badge）可開合，展開的項目縮排並帶樹狀導引線。 */
.view-nav-sec {
  flex-shrink: 0; /* view 很多時不被壓扁——超出改由 .view-nav 的捲軸承接 */
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.view-nav-sec:not(:first-child):not(.flat) {
  margin-top: 3px;
  padding-top: 3px;
  border-top: 1px solid hsl(var(--border) / 0.5);
}
.view-nav-group {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 6px 8px;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: hsl(var(--muted-foreground));
  user-select: none;
  border: none;
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.view-nav-group:hover { background: hsl(var(--accent)); color: hsl(var(--foreground)); }
/* 同 Layers 面板的 group-chevron（MIcon chevron_right / expand_more, 14px）。 */
.view-nav-caret {
  flex-shrink: 0;
  color: hsl(var(--muted-foreground));
}
.view-nav-group-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 「?」說明 icon：平時淡、hover 才亮，點了開 LayerDocViewer（不影響展開） */
.view-nav-help {
  flex-shrink: 0;
  opacity: 0.45;
  color: hsl(var(--muted-foreground));
  cursor: help;
  border-radius: 50%;
}
.view-nav-help:hover { opacity: 1; color: hsl(var(--primary)); }
/* 展開的項目：縮排到 caret 之下、左側一條導引線。flat（無 header 的清單，
   理論上已不存在）不縮排。 */
.view-nav-sec-items {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-left: 14px;
  padding-left: 5px;
  border-left: 1px solid hsl(var(--border) / 0.7);
}
.view-nav-sec.flat .view-nav-sec-items {
  margin-left: 0;
  padding-left: 0;
  border-left: none;
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
  flex-shrink: 0; /* view 很多時不被壓扁——超出改由 .view-nav 的捲軸承接 */
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
/* 逐步驗證 浮動控制列（左上）：下一步／重設＋這一步做了什麼。 */
.step-panel {
  position: absolute;
  top: 10px;
  left: 10px;
  right: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  background: hsl(var(--card) / 0.92);
  backdrop-filter: blur(4px);
  font-size: 12px;
  z-index: 5;
  pointer-events: auto;
}
.step-btn {
  flex-shrink: 0;
  padding: 4px 12px;
  font-size: 12.5px;
  font-weight: 600;
  border: none;
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  cursor: pointer;
}
.step-btn:hover:not(:disabled) { opacity: 0.9; }
.step-btn:disabled { opacity: 0.4; cursor: default; }
.step-btn.sub {
  background: hsl(var(--primary) / 0.12);
  color: hsl(var(--primary));
}
.step-btn.back {
  background: transparent;
  border: 1px solid hsl(var(--primary) / 0.45);
  color: hsl(var(--primary));
  font-weight: 500;
}
.step-btn.back.sub { border-style: dashed; }
.step-btn.ghost {
  background: transparent;
  border: 1px solid hsl(var(--border));
  color: hsl(var(--muted-foreground));
  font-weight: 500;
}
.step-count {
  flex-shrink: 0;
  font-weight: 600;
  color: hsl(var(--primary));
}
.step-msg {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: hsl(var(--muted-foreground));
}
.step-msg.done { color: hsl(142 70% 40%); font-weight: 600; }
/* 階段 chips：這一步執行的工作亮起。 */
.step-stages {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.step-chip {
  padding: 2px 7px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid hsl(var(--border));
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
.step-chip.active {
  background: hsl(var(--primary));
  border-color: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  font-weight: 600;
}
.step-arrow { color: hsl(var(--muted-foreground) / 0.5); font-size: 10px; }
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
