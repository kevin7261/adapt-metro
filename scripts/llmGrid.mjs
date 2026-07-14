// LLM 調整（RWD Maps「AI 改網格長寬」）的 CLI — 由 Claude Code 依 skill
// route-llm-grid 驅動：export 印出縮減網格的 X 欄／Y 列區間（含各欄列的站名
// 脈絡）給 LLM 讀、LLM 依使用者的一句話推理每個區間的顯示權重、apply 驗證
// （全區間、正數、外框由前端正規化）並存檔，網頁端（D3Tab 的「LLM調整」tab）
// 只載入 data/metro/llmgrids/ 的結果。
//
//   node scripts/llmGrid.mjs export <cityId> <orig|rot> [hc|rect|align|ilp|llm]
//   node scripts/llmGrid.mjs apply  <cityId> <orig|rot> [compact] <weights.json>
//   node scripts/llmGrid.mjs reset  <cityId> <orig|rot> [compact]
//
// weights.json: {
//   "model": "<模型名>",                 // 必填，顯示在網頁 tab 與面板
//   "colW": [w0, w1, …],                 // 全部 X 欄區間的顯示權重（正數）
//   "rowW": [w0, w1, …],                 // 全部 Y 列區間的顯示權重（正數）
//   "note": "<本次思路，顯示在右側 LLM調整 面板>",
//   "userPrompt": "<使用者的一句話>"
// }
// weight=1 維持原尺寸、>1 放大、0<w<1 壓縮；前端把全部權重正規化進固定外框
// （intervalAxes，含 minFrac 保底），所以只有「相對比例」有意義。

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import {
  buildHillClimb, compactGrid, iteratePost,
  buildRectPolish, buildAxisAlign, buildAxisIlp,
} from '../src/stores/hillClimb.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const OUT = join(DATA, 'llmgrids')
const COMPACTS = ['hc', 'rect', 'align', 'ilp', 'llm']
const POST_BUILD = { rect: buildRectPolish, align: buildAxisAlign, ilp: buildAxisIlp }

// compact 參數可省略（預設 'hc'）——apply 的最後一個參數永遠是 weights.json。
const argv = process.argv.slice(2)
const [cmd, cityId, variant = 'orig'] = argv
let compact = 'hc', weightsPath = null
for (const a of argv.slice(3)) {
  if (COMPACTS.includes(a)) compact = a
  else weightsPath = a
}
if (!cmd || !cityId || !['orig', 'rot'].includes(variant)) {
  console.error('usage: llmGrid.mjs export|apply|reset <cityId> <orig|rot> [hc|rect|align|ilp|llm] [weights.json]')
  process.exit(1)
}
const outFile = join(OUT, `${cityId}.${variant}.${compact}.json`)

if (cmd === 'reset') {
  if (existsSync(outFile)) await rm(outFile)
  console.log('已刪除', outFile)
  process.exit(0)
}

// ---- rebuild the deterministic chain (mirror of D3Tab / llmAlign.mjs) ----
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

// The RWD view compacts the layout its layer.compact picks: the HC result, a
// post-pass ('rect'/'align'/'ilp'), or the offline LLM 對齊 (llmviews file).
let baseCells = hc.cellAfter
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
}
const comp = compactGrid(baseCells, grid.cols, grid.rows)
const cells = comp.cellAfter
const nC = comp.cols, nR = comp.rows

// D3Tab loads the result only when it matches the SAME dataset + layout dims.
const fingerprint = { verts: hc.stats.verts, segs: hc.stats.segs, cols: nC, rows: nR, compact }

let saved = null
if (existsSync(outFile)) {
  saved = JSON.parse(await readFile(outFile, 'utf8'))
  if (JSON.stringify(saved.fingerprint) !== JSON.stringify(fingerprint)) {
    console.error('⚠ 既有 llmgrid 與目前資料不符（fingerprint 變了）——視為不存在')
    saved = null
  }
}

if (cmd === 'export') {
  // Per-interval context so the model can ground「市中心」「東側」「紅線那帶」:
  // the stations sitting in each column / row (local name; ＊ = 轉乘站).
  const nameById = new Map(stations.map((f) => {
    const p = f.properties
    const name = p.station_name_local || p.station_name || p.station_id
    const transfer = (Array.isArray(p.lines) && p.lines.length > 1) || p.is_interchange
    return [p.station_id, transfer ? `＊${name}` : name]
  }))
  const colStations = Array.from({ length: nC }, () => [])
  const rowStations = Array.from({ length: nR }, () => [])
  for (const [id, [c, r]] of cells) {
    const n = nameById.get(id)
    if (!n) continue // synthetic crossings carry no name
    if (c >= 0 && c < nC) colStations[c].push(n)
    if (r >= 0 && r < nR) rowStations[r].push(n)
  }
  console.log(JSON.stringify({
    city: cityId, cityName: meta.city, variant, compact,
    cols: nC, rows: nR,
    axes: '欄 0 在最左（西）、欄 cols-1 在最右（東）；列 0 在最上（北）、列 rows-1 在最下（南）',
    columns: colStations.map((s, i) => ({ i, stations: s })),
    rowsInfo: rowStations.map((s, i) => ({ i, stations: s })),
    current: saved ? { colW: saved.colW, rowW: saved.rowW, userPrompt: saved.userPrompt ?? null } : null,
  }))
} else if (cmd === 'apply') {
  if (!weightsPath) { console.error('apply 需要 weights.json 路徑'); process.exit(1) }
  const spec = JSON.parse(await readFile(weightsPath, 'utf8'))
  if (!spec.model) { console.error('weights.json 必須含 "model"（顯示在網頁 tab 上）'); process.exit(1) }
  const check = (arr, n, what) => {
    if (!Array.isArray(arr) || arr.length !== n) {
      console.error(`${what} 必須是長度 ${n} 的陣列（全部區間都要給），拿到 ${arr?.length ?? typeof arr}`)
      process.exit(1)
    }
    // 權重只有相對比例有意義；夾在 [0.05, 8] 防止單格吃掉整個外框或塌成零寬。
    return arr.map((w) => {
      if (!Number.isFinite(w) || w <= 0) { console.error(`${what} 含非正數 ${w}`); process.exit(1) }
      return Math.min(8, Math.max(0.05, w))
    })
  }
  const colW = check(spec.colW, nC, 'colW')
  const rowW = check(spec.rowW, nR, 'rowW')
  const maxW = Math.max(...colW, ...rowW)
  if (maxW < 3) {
    console.error(`⚠ 最大權重 ${maxW} < 3 —— 放大類意圖通常代表沒做完（核心應 3–5 倍），請確認是否要加大再 apply 一次`)
  }
  await mkdir(OUT, { recursive: true })
  await writeFile(outFile, JSON.stringify({
    fingerprint, city: cityId, variant, compact, cols: nC, rows: nR,
    model: spec.model,
    colW, rowW,
    note: spec.note ?? null,
    userPrompt: spec.userPrompt ?? saved?.userPrompt ?? null,
    prompt: saved?.prompt ?? spec.prompt ?? null,
    finalOutput: saved?.finalOutput, // trigger plugin's merge survives re-applies
  }))
  console.log(JSON.stringify({
    saved: outFile, cols: nC, rows: nR,
    colW, rowW, maxW,
  }, null, 1))
} else {
  console.error(`未知指令 ${cmd}`)
  process.exit(1)
}
