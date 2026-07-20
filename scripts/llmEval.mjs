// LLM 評價（RWD Maps「AI 評路網佈局」）的 CLI — 由 Claude Code 依 skill
// route-llm-eval 驅動：export 印出縮減網格佈局的幾何脈絡（逐線的段方向統計、
// 彎折數、頂點鏈）給 LLM 讀、LLM 寫下對這個路網的評價（哪裡可以更直、更水平、
// 更方正、哪條線彎太多…），apply 驗證並存檔。**只評價、不修改**——不搬任何
// 座標，網頁端（StylePanel 的「LLM評價」tab）只載入 data/metro/llmevals/ 的結果。
//
//   node scripts/llmEval.mjs export <cityId> <orig|rot> [hc|rect|align|ilp|llm]
//   node scripts/llmEval.mjs apply  <cityId> <orig|rot> [compact] <eval.json>
//   node scripts/llmEval.mjs reset  <cityId> <orig|rot> [compact]
//
// eval.json: {
//   "model": "<模型名>",                        // 選填，預設 Opus 4.8；顯示在面板
//   "summary": "<總評（幾句話）>",              // 必填
//   "scores": [{ "aspect": "...", "score": 0-10, "comment": "..." }],
//   "lines": [{ "name": "<線名>", "comment": "<這條線的具體評價>" }],
//   "suggestions": ["<可以怎麼調整>", …],
//   "moves": { "<vertIndex>": [c, r], … },      // 建議對應的具體移動（export 的 verts[i].i）
//   "userPrompt": "<使用者的關注點（可空）>"
// }
// moves 由 apply 經 applyLlmTargets（與 LLM 對齊完全相同的硬規則）套用在縮減網格
// 佈局上，把結果（exec.cells＋前後 H/V＋被拒提案）一併存進結果檔——網頁的
// 「執行調整」按鈕只是載入 exec.cells 切換顯示，不再跑 LLM；原佈局隨時可恢復。

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import {
  buildHillClimb, buildHcGraph, iteratePost, applyLlmTargets,
  buildRectPolish, buildAxisAlign, buildAxisIlp, straightenCompactLoop, setSpanCap,
} from '../src/stores/hillClimb.js'
import { PAPER_KINDS, PAPER_BUILD } from '../src/stores/paperAlign.js'

// 跨距上限（SPAN_CAP）：與網頁一致——vite plugin 觸發的 headless run 經
// LLM_SPAN_CAP env 傳入網頁「已套用」的最大跨距；手動 CLI 跑（無 env）＝預設 3。
// 兩邊同值，縮減網格尺寸（fingerprint 的 cols/rows）才會一致。
setSpanCap(+(process.env.LLM_SPAN_CAP ?? 3) || 3)

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const OUT = join(DATA, 'llmevals')
const COMPACTS = ['hc', 'rect', 'align', 'ilp', 'llm', ...PAPER_KINDS.map((p) => p.kind)]
const POST_BUILD = { rect: buildRectPolish, align: buildAxisAlign, ilp: buildAxisIlp, ...PAPER_BUILD }

const argv = process.argv.slice(2)
const [cmd, cityId, variant = 'orig'] = argv
let compact = 'hc', evalPath = null
for (const a of argv.slice(3)) {
  if (COMPACTS.includes(a)) compact = a
  else evalPath = a
}
if (!cmd || !cityId || !['orig', 'rot'].includes(variant)) {
  console.error('usage: llmEval.mjs export|apply|reset <cityId> <orig|rot> [hc|rect|align|ilp|llm] [eval.json]')
  process.exit(1)
}
const outFile = join(OUT, `${cityId}.${variant}.${compact}.json`)

if (cmd === 'reset') {
  if (existsSync(outFile)) await rm(outFile)
  console.log('已刪除', outFile)
  process.exit(0)
}

// ---- rebuild the deterministic chain (mirror of D3Tab / llmGrid.mjs) ----
const meta = JSON.parse(await readFile(join(DATA, 'views', `${cityId}.json`), 'utf8'))
const geojson = JSON.parse(await readFile(join(DATA, meta.file), 'utf8'))
const stations = geojson.features.filter((f) => f.geometry?.type === 'Point')
const lineFeats = geojson.features.filter((f) => f.geometry && f.geometry.type !== 'Point')
const fitFC = { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : geojson.features }
const tilt = computeOrientation(geojson).tilt
const skeleton = buildConnectSkeleton(geojson)
const angle = variant === 'rot' && Math.abs(tilt) >= 0.5 ? tilt : 0
const projection = geoMercator().angle(angle).fitExtent([[24, 24], [1176, 776]], fitFC)
const projById = new Map()
for (const f of stations) {
  const p = projection(f.geometry.coordinates)
  if (p) projById.set(f.properties.station_id, p)
}
for (const c of skeleton.crossings ?? []) {
  const p = projection(c.coord)
  if (p) projById.set(c.id, p)
}
const grid = buildSchematicGrid(skeleton, projById, [24, 24, 1176, 776])
const hc = buildHillClimb(skeleton, grid.cellOf, grid.cols, grid.rows)

// Same base-layout selection as the RWD view (llmGrid.mjs): the layer's
// compact chain, then the 端點移動+直線縮減+網格合併 loop to its fixed point.
let baseCells
if (POST_BUILD[compact]) {
  baseCells = iteratePost(POST_BUILD[compact], skeleton, hc.cellAfter, grid.cols, grid.rows).cellAfter
} else if (compact === 'llm') {
  const f = join(DATA, 'llmviews', `${cityId}.${variant}.json`)
  if (!existsSync(f)) {
    console.error(`縮減來源是 LLM 對齊，但 ${f} 不存在——先跑 route-llm-align`)
    process.exit(1)
  }
  const j = JSON.parse(await readFile(f, 'utf8'))
  baseCells = new Map(j.cellAfter.map(([id, c, r]) => [id, [c, r]]))
} else {
  baseCells = hc.cellAfter
}
const comp = straightenCompactLoop(skeleton, baseCells, grid.cols, grid.rows)
const cells = comp.cellAfter
const nC = comp.cols, nR = comp.rows

const fingerprint = { verts: hc.stats.verts, segs: hc.stats.segs, cols: nC, rows: nR, compact }

let saved = null
if (existsSync(outFile)) {
  saved = JSON.parse(await readFile(outFile, 'utf8'))
  if (JSON.stringify(saved.fingerprint) !== JSON.stringify(fingerprint)) {
    console.error('⚠ 既有 llmeval 與目前資料不符（fingerprint 變了）——視為不存在')
    saved = null
  }
}

// ---- 幾何評價脈絡：段方向分類 ＋ 逐線頂點鏈與彎折 ----
// 段方向以縮減網格的整數格座標算：H（Δr=0）／V（Δc=0）／D45（|Δc|=|Δr|）畫得出
// 嚴格 H/V/45° 直線；other 一定得折彎（RWD 畫線的單折/雙折候選）。
const dirOf = (A, B) => {
  const dx = B[0] - A[0], dy = B[1] - A[1]
  if (dy === 0) return 'H'
  if (dx === 0) return 'V'
  if (Math.abs(dx) === Math.abs(dy)) return 'D45'
  return 'other'
}
const { segs } = buildHcGraph(skeleton, cells)
const nameById = new Map(stations.map((f) => {
  const p = f.properties
  return [p.station_id, p.station_name_local || p.station_name || p.station_id]
}))
// route_id -> { name, color }（skeleton 不回傳 routes map，從 geojson 重建）
const routeMeta = new Map()
for (const f of lineFeats) {
  for (const r of f.properties?.routes ?? []) {
    if (r.route_id && !routeMeta.has(r.route_id)) {
      routeMeta.set(r.route_id, { name: r.route_name ?? String(r.route_id), color: r.route_color ?? null })
    }
  }
}
// 每條線：該線行經的段 → 依共用端點串成鏈（端點=奇數度；環線任取起點），
// 統計 H/V/D45/other 與彎折（相鄰兩段方向向量改變的內部頂點數）。
const globalStat = { H: 0, V: 0, D45: 0, other: 0 }
for (const s of segs) {
  globalStat[dirOf(cells.get(s.a), cells.get(s.b))]++
}
function lineReport(rid) {
  const own = segs.filter((s) => s.routes?.has(rid))
  if (!own.length) return null
  const stat = { H: 0, V: 0, D45: 0, other: 0 }
  const adj = new Map() // vert id -> [segIdx…]（該線內）
  own.forEach((s, i) => {
    stat[dirOf(cells.get(s.a), cells.get(s.b))]++
    for (const v of [s.a, s.b]) {
      if (!adj.has(v)) adj.set(v, [])
      adj.get(v).push(i)
    }
  })
  // walk chains: start at odd-degree verts, then leftover cycles
  const used = new Array(own.length).fill(false)
  const chains = []
  const walk = (start) => {
    const chain = [start]
    let at = start
    for (;;) {
      const nextI = (adj.get(at) ?? []).find((i) => !used[i])
      if (nextI == null) break
      used[nextI] = true
      at = own[nextI].a === at ? own[nextI].b : own[nextI].a
      chain.push(at)
    }
    return chain
  }
  for (const [v, list] of adj) {
    if (list.length % 2 === 1 && list.some((i) => !used[i])) chains.push(walk(v))
  }
  own.forEach((s, i) => { if (!used[i]) chains.push(walk(s.a)) }) // 環線/剩餘
  // 彎折：鏈上內部頂點，前後兩段的方向（gcd 正規化整數向量）不同就算一個彎
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  const norm = (A, B) => {
    const dx = B[0] - A[0], dy = B[1] - A[1]
    const g = gcd(Math.abs(dx), Math.abs(dy)) || 1
    return `${dx / g},${dy / g}`
  }
  const label = (id) => {
    const [c, r] = cells.get(id)
    const n = nameById.get(id)
    return n ? `${n}(${c},${r})` : `×(${c},${r})`
  }
  // bends＝相鄰兩段方向不同的內部頂點；acute＝其中「進出兩段夾角 < 90°」的尖角
  // （最該優先消除）。B 點的內角由 (A−B)·(C−B) 判：>0 → 銳角（含 45° 尖折與 180° 回折
  // hairpin）；=0 → 90° 直角（L 形，OK）；<0 → 鈍角（含 45° 過渡的 135° 與直通 180°，OK）。
  let bends = 0
  const acuteAt = []
  for (const chain of chains) {
    for (let i = 1; i + 1 < chain.length; i++) {
      const A = cells.get(chain[i - 1]), B = cells.get(chain[i]), C = cells.get(chain[i + 1])
      if (norm(A, B) !== norm(B, C)) bends++
      if ((A[0] - B[0]) * (C[0] - B[0]) + (A[1] - B[1]) * (C[1] - B[1]) > 0) acuteAt.push(label(chain[i]))
    }
  }
  return { segs: own.length, ...stat, bends, acute: acuteAt.length, acuteAt, chains: chains.map((ch) => ch.map(label)) }
}
const lines = [...routeMeta.entries()]
  .filter(([rid]) => !String(rid).startsWith('river:'))
  .map(([rid, m]) => ({ rid, name: m.name, color: m.color, ...lineReport(rid) }))
  .filter((l) => l.segs)
const stats = {
  cols: nC, rows: nR, segs: segs.length,
  hv: globalStat.H + globalStat.V, h: globalStat.H, v: globalStat.V,
  d45: globalStat.D45, other: globalStat.other,
  acute: lines.reduce((s, l) => s + (l.acute || 0), 0), // 全網銳角總數（最優先消除）
}

// 穩定頂點索引（同 llmAlign：依 id 排序、每次執行順序一致）——moves 用 i 指涉頂點。
const idsSorted = [...cells.keys()].sort()

if (cmd === 'export') {
  const verts = idsSorted.map((id, i) => {
    const [c, r] = cells.get(id)
    return { i, name: nameById.get(id) ?? '×', c, r }
  })
  console.log(JSON.stringify({
    city: cityId, cityName: meta.city, variant, compact,
    axes: '格座標 (c,r)：c 向東遞增、r 向南遞增；H=水平段、V=垂直段、D45=45°段、other=畫出來一定有折彎的段；'
      + 'acute=進出兩段夾角<90°的銳角尖折（最優先消除，改成 90° L 形直角或 180° 直通；acuteAt=在哪些站）',
    stats,
    lines: lines.map(({ rid, ...l }) => l),
    verts, // moves 的索引來源：moves["i"] = [c, r]
    current: saved ? { summary: saved.summary, userPrompt: saved.userPrompt ?? null } : null,
  }))
} else if (cmd === 'apply') {
  if (!evalPath) { console.error('apply 需要 eval.json 路徑'); process.exit(1) }
  const spec = JSON.parse(await readFile(evalPath, 'utf8'))
  spec.model ??= 'Opus 4.8' // 預設模型 Opus 4.8（Claude Code 執行時的模型）；eval.json 可覆寫
  if (typeof spec.summary !== 'string' || !spec.summary.trim()) {
    console.error('eval.json 必須含非空的 "summary"（總評）'); process.exit(1)
  }
  const scores = (Array.isArray(spec.scores) ? spec.scores : [])
    .filter((s) => s && typeof s.aspect === 'string' && Number.isFinite(+s.score))
    .map((s) => ({ aspect: s.aspect, score: Math.min(10, Math.max(0, +s.score)), comment: s.comment ?? '' }))
  const lineComments = (Array.isArray(spec.lines) ? spec.lines : [])
    .filter((l) => l && typeof l.name === 'string' && typeof l.comment === 'string')
    .map((l) => ({ name: l.name, comment: l.comment }))
  const suggestions = (Array.isArray(spec.suggestions) ? spec.suggestions : [])
    .filter((s) => typeof s === 'string' && s.trim())
  // moves（建議對應的具體移動）：這裡就經 applyLlmTargets（與 LLM 對齊完全相同的
  // 硬規則）套用在縮減網格佈局上，把結果存進 exec——網頁「執行調整」只載入
  // exec.cells 切換顯示，不再跑 LLM；被硬規則拒絕的提案記在 exec.rejected。
  let exec = null
  if (spec.moves && typeof spec.moves === 'object' && Object.keys(spec.moves).length) {
    const targetEntries = Object.entries(spec.moves)
      .map(([i, t]) => [idsSorted[+i], t])
      .filter(([id, t]) => id && Array.isArray(t)
        && Number.isInteger(t[0]) && Number.isInteger(t[1])
        && t[0] >= 0 && t[0] < nC && t[1] >= 0 && t[1] < nR)
    if (targetEntries.length) {
      const res = applyLlmTargets(skeleton, cells, nC, nR, targetEntries)
      const rejected = targetEntries
        .filter(([id, t]) => {
          const p = res.cellAfter.get(id)
          return p && (p[0] !== t[0] || p[1] !== t[1])
        })
        .map(([id, t]) => ({ name: nameById.get(id) ?? '×', want: t, got: res.cellAfter.get(id) }))
      exec = {
        cells: [...res.cellAfter].map(([id, [c, r]]) => [id, c, r]),
        hvBefore: res.stats.hvBefore, hvAfter: res.stats.hvAfter,
        proposed: targetEntries.length, moved: res.stats.moved, rejected,
      }
    }
  }
  await mkdir(OUT, { recursive: true })
  await writeFile(outFile, JSON.stringify({
    fingerprint, city: cityId, variant, compact,
    model: spec.model,
    stats, // 客觀數字（本 script 算的），評語（模型寫的）在下面
    summary: spec.summary.trim(),
    scores, lines: lineComments, suggestions,
    moves: spec.moves ?? null,
    exec,
    userPrompt: spec.userPrompt ?? saved?.userPrompt ?? null,
    prompt: saved?.prompt ?? spec.prompt ?? null,
    finalOutput: saved?.finalOutput, // trigger plugin's merge survives re-applies
  }))
  console.log(JSON.stringify({
    saved: outFile,
    stats, scores: scores.length, lines: lineComments.length, suggestions: suggestions.length,
    exec: exec ? {
      hv: `${exec.hvBefore} -> ${exec.hvAfter} / ${stats.segs}`,
      proposed: exec.proposed, moved: exec.moved, rejected: exec.rejected,
    } : '（無 moves——評價建議未附具體移動，網頁將沒有「執行調整」可按）',
  }, null, 1))
} else {
  console.error(`未知指令 ${cmd}`)
  process.exit(1)
}
