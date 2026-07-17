// LLM 對齊 (第四種 H/V 後處理) 的 CLI — 由 Claude Code 依 skill
// route-llm-align 驅動：export 印出目前佈局給 LLM 讀、LLM 提出 moves、
// apply 把提案經與其他三種完全相同的硬規則 (applyLlmTargets) 套用並存檔，
// 網頁端 (D3Tab 的「LLM 對齊」tab) 只載入 data/metro/llmviews/ 的結果。
//
//   node scripts/llmAlign.mjs export <cityId> <orig|rot>
//   node scripts/llmAlign.mjs apply  <cityId> <orig|rot> <moves.json>
//   node scripts/llmAlign.mjs reset  <cityId> <orig|rot>
//
// moves.json: {
//   "model": "<模型名>",                        // 選填，預設 Fable 5；顯示在網頁按鈕與面板
//   "moves": { "<vertIndex>": [col, row], … },  // 可空（純記錄 note，不計輪）
//   "note": "<本輪思路，顯示在右側 LLM對齊 面板>",
//   "prompt": "<觸發這次執行的 skill/prompt，第一次提供時寫入>"
// }
// vertIndex 來自最近一次 export 的 verts[i].i（= 依 id 排序的索引，穩定）。
// 佈局的格子是排名制、與視窗無關 → node 端重建的鏈與 D3Tab 完全一致。

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { buildHillClimb, buildHcGraph, applyLlmTargets } from '../src/stores/hillClimb.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const OUT = join(DATA, 'llmviews')

const [cmd, cityId, variant = 'orig', movesPath] = process.argv.slice(2)
if (!cmd || !cityId || !['orig', 'rot'].includes(variant)) {
  console.error('usage: llmAlign.mjs export|apply|reset <cityId> <orig|rot> [moves.json]')
  process.exit(1)
}
const outFile = join(OUT, `${cityId}.${variant}.json`)

// ---- rebuild the deterministic chain (mirror of D3Tab / viewGeometry) ----
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
const fingerprint = {
  verts: hc.stats.verts, segs: hc.stats.segs,
  cols: grid.cols, rows: grid.rows, hvStart: hc.stats.hvAfter,
}

// Current working layout = saved LLM state (if it matches this dataset) or HC.
let saved = null
if (existsSync(outFile)) {
  saved = JSON.parse(await readFile(outFile, 'utf8'))
  if (JSON.stringify(saved.fingerprint) !== JSON.stringify(fingerprint)) {
    console.error('⚠ 既有 llmview 與目前資料不符（fingerprint 變了）——視為不存在，apply 會重新開始')
    saved = null
  }
}
const baseCells = saved
  ? new Map(saved.cellAfter.map(([id, c, r]) => [id, [c, r]]))
  : hc.cellAfter

// Stable vertex indexing: sorted ids (same order every run).
const ids = [...baseCells.keys()].sort()
const idxOf = new Map(ids.map((id, i) => [id, i]))
const { segs } = buildHcGraph(skeleton, baseCells)
const hvOf = (cells) => {
  let n = 0
  for (const s of segs) {
    const A = cells.get(s.a), B = cells.get(s.b)
    if ((A[0] === B[0]) !== (A[1] === B[1])) n++
  }
  return n
}

if (cmd === 'export') {
  const verts = ids.map((id, i) => {
    const [c, r] = baseCells.get(id)
    return { i, c, r }
  })
  // offSegs = what to fix; hvSegs = what NOT to break (a move that unaligns
  // one of these costs exactly what a new alignment gains).
  const offSegs = []
  const hvSegs = []
  for (const s of segs) {
    const A = baseCells.get(s.a), B = baseCells.get(s.b)
    const dx = B[0] - A[0], dy = B[1] - A[1]
    if ((A[0] === B[0]) !== (A[1] === B[1])) {
      hvSegs.push({ a: idxOf.get(s.a), b: idxOf.get(s.b), dir: dx === 0 ? 'V' : 'H' })
    } else {
      offSegs.push({ a: idxOf.get(s.a), b: idxOf.get(s.b), dx, dy })
    }
  }
  console.log(JSON.stringify({
    city: cityId, variant, cols: grid.cols, rows: grid.rows,
    rounds: saved?.rounds ?? 0, model: saved?.model ?? null,
    hv: hvOf(baseCells), segsTotal: segs.length,
    verts, offSegs, hvSegs,
  }))
} else if (cmd === 'apply') {
  if (!movesPath) { console.error('apply 需要 moves.json 路徑'); process.exit(1) }
  const spec = JSON.parse(await readFile(movesPath, 'utf8'))
  spec.model ??= 'Fable 5' // 預設模型 Fable 5（Claude Code 執行時的模型）；moves.json 可覆寫
  const noteOnly = !spec.moves || !Object.keys(spec.moves).length
  const targetEntries = Object.entries(spec.moves ?? {}).map(([i, t]) => [ids[+i], t])
  const res = applyLlmTargets(skeleton, baseCells, grid.cols, grid.rows, targetEntries)
  const rejected = targetEntries
    .filter(([id, t]) => id && (res.cellAfter.get(id)[0] !== t[0] || res.cellAfter.get(id)[1] !== t[1]))
    .map(([id, t]) => ({ i: idxOf.get(id), want: t, got: res.cellAfter.get(id) }))
  let movedVsHC = 0
  for (const [id, p] of res.cellAfter) {
    const q = hc.cellAfter.get(id)
    if (q && (q[0] !== p[0] || q[1] !== p[1])) movedVsHC++
  }
  // A note-only apply (no moves) documents the session without counting a round.
  const rounds = (saved?.rounds ?? 0) + (noteOnly ? 0 : 1)
  const transcript = saved?.transcript ?? []
  if (spec.note || !noteOnly) {
    transcript.push({
      round: noteOnly ? null : rounds,
      note: spec.note ?? null,
      proposed: targetEntries.length,
      hv: `${res.stats.hvBefore} → ${res.stats.hvAfter}`,
      rejected: rejected.length,
    })
  }
  await mkdir(OUT, { recursive: true })
  await writeFile(outFile, JSON.stringify({
    fingerprint, model: spec.model, rounds,
    prompt: saved?.prompt ?? spec.prompt ?? null,
    finalOutput: saved?.finalOutput, // trigger plugin's merge survives re-applies
    transcript,
    hvBefore: fingerprint.hvStart, hvAfter: res.stats.hvAfter,
    segs: segs.length, moved: movedVsHC,
    cellAfter: [...res.cellAfter].map(([id, [c, r]]) => [id, c, r]),
  }))
  console.log(JSON.stringify({
    round: rounds,
    hv: `${res.stats.hvBefore} -> ${res.stats.hvAfter} / ${segs.length}`,
    hvFromHC: fingerprint.hvStart,
    reverted: res.stats.reverted, movedThisRound: res.stats.moved, movedVsHC,
    rejected,
  }, null, 1))
} else if (cmd === 'reset') {
  if (existsSync(outFile)) await rm(outFile)
  console.log('已刪除', outFile)
} else {
  console.error(`未知指令 ${cmd}`)
  process.exit(1)
}
