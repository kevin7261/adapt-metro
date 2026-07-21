// ⑨ LLM 成方（route-llm-shape）的 CLI — 由 Claude Code 依 skill route-llm-shape
// 驅動，是 Shape-Guided（演算法本體 buildShapeAlign）的 LLM 版：不跑 §5 LS／§6
// Octi，而由 LLM 提出「移哪些點」，這裡把提案經與演算法本體完全相同的拓撲鐵律
// （topoSafeTowardTargets：每一步 makeMover.validMove ＝交叉不增／無撞格／環繞序
// 不變）落地，目標是把「規定路段 W」收成四邊直線正方（isFourLineSquare）。
// 網頁端（D3Tab 的「⑨LLM 成方」view）只載入 data/metro/llmshapes/ 的結果。
//
//   node scripts/llmShape.mjs export <cityId> <orig|rot>
//   node scripts/llmShape.mjs apply  <cityId> <orig|rot> <moves.json>
//   node scripts/llmShape.mjs reset  <cityId> <orig|rot>
//
// moves.json: {
//   "model": "<模型名>",                       // 選填，預設 Opus 4.8；顯示在網頁面板
//   "moves": { "<vertIndex>": [col, row], … }, // 可空（純記錄 note，不計輪）
//   "note": "<本輪思路，顯示在右側 LLM 成方 面板>",
//   "prompt": "<觸發這次執行的 skill/prompt，第一次提供時寫入>"
// }
// vertIndex 來自最近一次 export 的 verts[i].i（＝依 id 排序的索引，穩定）。
// 佈局＝排名制、與視窗無關 → node 端重建的鏈與 D3Tab 完全一致。
//
// 規定表（shapePresets.js）以外的城市＝不需計算，export 會回 null（前端 disable）。

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { buildHcGraph, setSpanCap } from '../src/stores/hillClimb.js'
import { shapeLlmContext, applyShapeLlmTargets } from '../src/stores/paper/shape.js'

// 跨距上限（SPAN_CAP）：與 LLM 對齊一致——vite plugin 觸發的 headless run 經
// LLM_SPAN_CAP env 傳入網頁「已套用」的最大跨距；手動 CLI 跑（無 env）＝預設 3。
setSpanCap(+(process.env.LLM_SPAN_CAP ?? 3) || 3)

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const OUT = join(DATA, 'llmshapes')

const [cmd, cityId, variant = 'orig', movesPath] = process.argv.slice(2)
if (!cmd || !cityId || !['orig', 'rot'].includes(variant)) {
  console.error('usage: llmShape.mjs export|apply|reset <cityId> <orig|rot> [moves.json]')
  process.exit(1)
}
const outFile = join(OUT, `${cityId}.${variant}.json`)

// ---- rebuild the deterministic chain (mirror of D3Tab / viewGeometry / llmAlign) ----
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
// ⑨ Shape-Guided（含 LLM 版）的輸入＝格網化後（grid.cellOf），與演算法本體
// buildShapeAlign 相同（不是 HC 結果——那是 LLM 對齊用的）。
const gridCells = grid.cellOf
const { pos: gp, segs: gseg } = buildHcGraph(skeleton, gridCells)
const fingerprint = {
  verts: gp.size, segs: gseg.length, cols: grid.cols, rows: grid.rows,
}

// Current working layout = saved LLM state (if it matches this dataset) or grid-post.
let saved = null
if (existsSync(outFile)) {
  saved = JSON.parse(await readFile(outFile, 'utf8'))
  if (JSON.stringify(saved.fingerprint) !== JSON.stringify(fingerprint)) {
    console.error('⚠ 既有 llmshape 與目前資料不符（fingerprint 變了）——視為不存在，apply 會重新開始')
    saved = null
  }
}
const baseCells = saved
  ? new Map(saved.cellAfter.map(([id, c, r]) => [id, [c, r]]))
  : new Map([...gridCells].map(([id, p]) => [id, [...p]]))

// Stable vertex indexing: sorted ids (same order every run).
const ids = [...baseCells.keys()].sort()
const idxOf = new Map(ids.map((id, i) => [id, i]))

if (cmd === 'export') {
  const ctx = shapeLlmContext(skeleton, baseCells, grid.cols, grid.rows, cityId)
  if (!ctx) {
    console.log(JSON.stringify({ city: cityId, variant, skipped: true, note: '此城非規定表——不需計算' }))
    process.exit(0)
  }
  const verts = ids.map((id, i) => {
    const [c, r] = baseCells.get(id)
    return { i, c, r }
  })
  // 環站（W）依站序；ring[k] 相鄰 ring[k+1]（末尾接回首站＝閉合環）。
  const ring = ctx.cutIds.map((id) => ({ i: idxOf.get(id), c: baseCells.get(id)[0], r: baseCells.get(id)[1] }))
  // 建議的正方目標格（把 W 均分到四邊，底→右→頂→左）——LLM 可照抄或自行微調。
  const suggest = {}
  if (ctx.targets) {
    for (const [id, t] of ctx.targets) {
      if (idxOf.has(id)) suggest[idxOf.get(id)] = t
    }
  }
  // 邊表（連通性，索引對）——讓 LLM 把整條線／整個分支當一組一起搬（整組移動）。
  const edges = ctx.edges
    .filter(([a, b]) => idxOf.has(a) && idxOf.has(b))
    .map(([a, b]) => [idxOf.get(a), idxOf.get(b)])
  console.log(JSON.stringify({
    city: cityId, variant, cols: grid.cols, rows: grid.rows,
    rounds: saved?.rounds ?? 0, model: saved?.model ?? null,
    route: ctx.routeName, cross0: ctx.cross0,
    square: ctx.square, quality: ctx.quality,
    box: ctx.box, segsTotal: fingerprint.segs,
    ring, suggest, edges, verts,
  }))
} else if (cmd === 'apply') {
  if (!movesPath) { console.error('apply 需要 moves.json 路徑'); process.exit(1) }
  const spec = JSON.parse(await readFile(movesPath, 'utf8'))
  spec.model ??= 'Opus 4.8'
  const noteOnly = !spec.moves || !Object.keys(spec.moves).length
  const targetEntries = Object.entries(spec.moves ?? {}).map(([i, t]) => [ids[+i], t])
  // 綠折點：moves.json 可含 greens: [{ a: <vertIdx>, b: <vertIdx>, cell: [c,r] }]
  // （a、b＝相鄰環站的穩定索引，綠點插在它們之間的段上、擺在方框角格）。≤4。
  const greenSpecs = (spec.greens ?? [])
    .filter((g) => g && ids[+g.a] && ids[+g.b] && Array.isArray(g.cell))
    .map((g) => ({ a: ids[+g.a], b: ids[+g.b], c: g.cell[0], r: g.cell[1] }))
  const res = applyShapeLlmTargets(skeleton, baseCells, grid.cols, grid.rows, targetEntries, cityId, greenSpecs)
  const rejected = res.stats.rejected.map((x) => ({ i: idxOf.get(x.id), want: x.want, got: x.got }))
  let movedVsBase = 0
  for (const [id, p] of res.cellAfter) {
    const q = gridCells.get(id)
    if (q && (q[0] !== p[0] || q[1] !== p[1])) movedVsBase++
  }
  const rounds = (saved?.rounds ?? 0) + (noteOnly ? 0 : 1)
  const transcript = saved?.transcript ?? []
  if (spec.note || !noteOnly) {
    transcript.push({
      round: noteOnly ? null : rounds,
      note: spec.note ?? null,
      proposed: targetEntries.length,
      square: res.stats.square,
      via: res.stats.via,
      greens: res.stats.greenCount,
      crosses: res.stats.crosses,
      rejected: rejected.length,
    })
  }
  await mkdir(OUT, { recursive: true })
  await writeFile(outFile, JSON.stringify({
    fingerprint, model: spec.model, rounds,
    prompt: saved?.prompt ?? spec.prompt ?? null,
    finalOutput: saved?.finalOutput,
    route: res.stats.route ?? saved?.route ?? null,
    transcript,
    square: res.stats.square, quality: res.stats.quality,
    via: res.stats.via, crosses: res.stats.crosses,
    greens: res.greens ?? [], greenCount: res.stats.greenCount,
    segs: res.stats.segs, moved: movedVsBase,
    cellAfter: [...res.cellAfter].map(([id, [c, r]]) => [id, c, r]),
  }))
  console.log(JSON.stringify({
    round: rounds,
    square: res.stats.square, via: res.stats.via, crosses: res.stats.crosses,
    greens: res.stats.greenCount, quality: res.stats.quality,
    reverted: res.stats.reverted, movedThisRound: res.stats.moved, movedVsBase,
    rejected,
  }, null, 1))
} else if (cmd === 'reset') {
  if (existsSync(outFile)) await rm(outFile)
  console.log('已刪除', outFile)
} else {
  console.error(`未知指令 ${cmd}`)
  process.exit(1)
}
