// Compare the four RWD-map candidates for one city/variant.  This is a
// read-only judge: the LLM selects and explains a winner, never moves points.
//
// node scripts/llmCompare.mjs export <cityId> <orig|rot>
// node scripts/llmCompare.mjs apply  <cityId> <orig|rot> <result.json>
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import {
  buildHillClimb, buildHcGraph, iteratePost, buildRectPolish, buildAxisAlign,
  buildAxisIlp, straightenCompactLoop,
} from '../src/stores/hillClimb.js'
import { buildRwdMap, mergeParallelSegs } from '../src/stores/rwdMap.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const OUT = join(DATA, 'llmcompares')
const POST = { rect: buildRectPolish, align: buildAxisAlign, ilp: buildAxisIlp }
const NAMES = { rect: '直角爬山', align: '軸對齊', ilp: '整數規劃', llm: 'LLM對齊' }
const [cmd, cityId, variant = 'orig', resultPath] = process.argv.slice(2)
if (!['export', 'apply', 'reset'].includes(cmd) || !cityId || !['orig', 'rot'].includes(variant)) {
  console.error('usage: llmCompare.mjs export|apply|reset <cityId> <orig|rot> [result.json]')
  process.exit(1)
}
const outFile = join(OUT, `${cityId}.${variant}.json`)
if (cmd === 'reset') {
  await rm(outFile, { force: true })
  console.log('已刪除', outFile)
  process.exit(0)
}

const meta = JSON.parse(await readFile(join(DATA, 'views', `${cityId}.json`), 'utf8'))
const geojson = JSON.parse(await readFile(join(DATA, meta.file), 'utf8'))
const lines = geojson.features.filter((f) => f.geometry?.type !== 'Point')
const stations = geojson.features.filter((f) => f.geometry?.type === 'Point')
const fitFC = { type: 'FeatureCollection', features: lines.length ? lines : geojson.features }
const skeleton = buildConnectSkeleton(geojson)
const tilt = computeOrientation(geojson).tilt
const angle = variant === 'rot' && Math.abs(tilt) >= 0.5 ? tilt : 0
const projection = geoMercator().angle(angle).fitExtent([[24, 24], [1176, 776]], fitFC)
const projected = new Map()
for (const f of stations) {
  const p = projection(f.geometry.coordinates)
  if (p) projected.set(f.properties.station_id, p)
}
for (const c of skeleton.crossings ?? []) {
  const p = projection(c.coord)
  if (p) projected.set(c.id, p)
}
const grid = buildSchematicGrid(skeleton, projected, [24, 24, 1176, 776])
const hc = buildHillClimb(skeleton, grid.cellOf, grid.cols, grid.rows)

async function candidate(compact) {
  let base
  if (POST[compact]) base = iteratePost(POST[compact], skeleton, hc.cellAfter, grid.cols, grid.rows).cellAfter
  else {
    const f = join(DATA, 'llmviews', `${cityId}.${variant}.json`)
    if (!existsSync(f)) return null
    const j = JSON.parse(await readFile(f, 'utf8'))
    base = new Map(j.cellAfter.map(([id, c, r]) => [id, [c, r]]))
  }
  const loop = straightenCompactLoop(skeleton, base, grid.cols, grid.rows)
  const cells = loop.cellAfter
  const cw = 1152 / loop.cols, ch = 752 / loop.rows
  const pos = new Map([...cells].map(([id, [c, r]]) => [id, [24 + (c + 0.5) * cw, 24 + (r + 0.5) * ch]]))
  const segs = mergeParallelSegs(buildHcGraph(skeleton, cells).segs)
  const rwd = buildRwdMap(segs, pos, {
    unit: Math.min(cw, ch), dirs: 8,
    lattice: { x0: 24, y0: 24, sx: cw / 2, sy: ch / 2, nx: loop.cols * 2 + 1, ny: loop.rows * 2 + 1 },
  })
  const pts = rwd.lines.flatMap((l) => l.pts)
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const balance = Math.max(0, 1 - ((Math.abs(cx - 600) / 576) + (Math.abs(cy - 400) / 376)) / 2)
  const bends = rwd.lines.reduce((n, l) => n + l.bends, 0)
  const straightness = rwd.stats.segs ? rwd.stats.straight / rwd.stats.segs : 0
  return {
    compact, label: NAMES[compact], grid: { cols: loop.cols, rows: loop.rows },
    geometry: {
      segments: rwd.stats.segs, straight: rwd.stats.straight, singleBend: rwd.stats.single,
      doubleBend: rwd.stats.double, multiBend: rwd.stats.multi, bends,
      fallback: rwd.stats.fallback, forced: rwd.stats.forced, colinear: rwd.stats.colinear,
      straightness: +straightness.toFixed(4), balance: +balance.toFixed(4),
      boundingBox: [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)],
    },
  }
}

const candidates = (await Promise.all(['rect', 'align', 'ilp', 'llm'].map(candidate))).filter(Boolean)
const fingerprint = {
  city: cityId, variant, candidates: candidates.map((c) => ({
    compact: c.compact, grid: c.grid, segments: c.geometry.segments, bends: c.geometry.bends,
  })),
}
if (cmd === 'export') {
  console.log(JSON.stringify({
    city: cityId, cityName: meta.city, variant, candidates, fingerprint,
    instruction: '比較的是同一城市同一變體的 RWD 路網。以方正、路線直、轉折少、畫面平衡為最高標準；forced/fallback 是嚴重缺點。必須逐一說明每個候選優缺點，從候選 compact 中選一個 winner。',
  }))
  process.exit(0)
}
if (!resultPath) throw new Error('apply 需要 result.json')
const spec = JSON.parse(await readFile(resultPath, 'utf8'))
const allowed = new Set(candidates.map((c) => c.compact))
if (!allowed.has(spec.winner) || typeof spec.summary !== 'string' || !spec.summary.trim()) {
  throw new Error('result.json 必須含 summary，winner 必須是目前候選之一')
}
const analyses = (Array.isArray(spec.analyses) ? spec.analyses : [])
  .filter((a) => allowed.has(a.compact) && typeof a.strengths === 'string' && typeof a.weaknesses === 'string')
  .map((a) => ({ compact: a.compact, strengths: a.strengths, weaknesses: a.weaknesses }))
await mkdir(OUT, { recursive: true })
await writeFile(outFile, JSON.stringify({
  city: cityId, variant, fingerprint, model: spec.model ?? 'Opus 4.8',
  candidates, analyses, winner: spec.winner, winnerReason: String(spec.winnerReason ?? '').trim(),
  summary: spec.summary.trim(),
}))
console.log(JSON.stringify({ saved: outFile, winner: spec.winner, candidates: candidates.map((c) => c.compact) }))
