// Compare up to eight RWD-map candidates for one city (4 algorithms × orig/rot).
// Read-only judge: picks overall / orig / rot winners, never moves points.
//
// node scripts/llmCompare.mjs export <cityId>
// node scripts/llmCompare.mjs apply  <cityId> <result.json>
// node scripts/llmCompare.mjs reset  <cityId>
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
const VARIANT_ZH = { orig: '原始', rot: '旋轉' }
const [cmd, cityId, resultPath] = process.argv.slice(2)
if (!['export', 'apply', 'reset'].includes(cmd) || !cityId) {
  console.error('usage: llmCompare.mjs export|apply|reset <cityId> [result.json]')
  process.exit(1)
}
const outFile = join(OUT, `${cityId}.json`)
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

async function candidatesFor(variant) {
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

  async function one(compact) {
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
    const id = `${variant}.${compact}`
    return {
      id, variant, compact,
      label: `${VARIANT_ZH[variant]}·${NAMES[compact]}`,
      grid: { cols: loop.cols, rows: loop.rows },
      geometry: {
        segments: rwd.stats.segs, straight: rwd.stats.straight, singleBend: rwd.stats.single,
        doubleBend: rwd.stats.double, multiBend: rwd.stats.multi, bends,
        fallback: rwd.stats.fallback, forced: rwd.stats.forced, colinear: rwd.stats.colinear,
        straightness: +straightness.toFixed(4), balance: +balance.toFixed(4),
        boundingBox: [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)],
      },
    }
  }
  return (await Promise.all(['rect', 'align', 'ilp', 'llm'].map(one))).filter(Boolean)
}

const candidates = [...await candidatesFor('orig'), ...await candidatesFor('rot')]
const fingerprint = {
  city: cityId,
  candidates: candidates.map((c) => ({
    id: c.id, grid: c.grid, segments: c.geometry.segments, bends: c.geometry.bends,
  })),
}
if (cmd === 'export') {
  console.log(JSON.stringify({
    city: cityId, cityName: meta.city, candidates, fingerprint,
    instruction: '一次比較同一城市的原始＋旋轉共最多 8 個 RWD 路網（id＝variant.compact）。以方正、路線直、轉折少、畫面平衡為最高標準；forced/fallback 是嚴重缺點。必須逐一說明每個候選優缺點，並選出三個：winner（全體最佳）、winnerOrig（原始組最佳）、winnerRot（旋轉組最佳）；三者皆須是 candidates 的 id。',
  }))
  process.exit(0)
}
if (!resultPath) throw new Error('apply 需要 result.json')
const spec = JSON.parse(await readFile(resultPath, 'utf8'))
function asPoints(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return [v.trim()]
  return null
}
const allowed = new Set(candidates.map((c) => c.id))
const origIds = new Set(candidates.filter((c) => c.variant === 'orig').map((c) => c.id))
const rotIds = new Set(candidates.filter((c) => c.variant === 'rot').map((c) => c.id))
const analyses = (Array.isArray(spec.analyses) ? spec.analyses : [])
  .map((a) => {
    const id = a?.id ?? (a?.variant && a?.compact ? `${a.variant}.${a.compact}` : null)
    const strengths = asPoints(a?.strengths)
    const weaknesses = asPoints(a?.weaknesses)
    if (!allowed.has(id) || !strengths?.length || !weaknesses?.length) return null
    return { id, strengths, weaknesses }
  })
  .filter(Boolean)
const summary = asPoints(spec.summary)
const winnerReason = asPoints(spec.winnerReason) ?? []
const winnerOrigReason = asPoints(spec.winnerOrigReason) ?? []
const winnerRotReason = asPoints(spec.winnerRotReason) ?? []
const { winner, winnerOrig, winnerRot } = spec
if (!summary?.length
  || !allowed.has(winner)
  || !origIds.has(winnerOrig)
  || !rotIds.has(winnerRot)) {
  throw new Error('result.json 必須含 summary，且 winner／winnerOrig／winnerRot 分別為全體／原始／旋轉候選 id')
}
await mkdir(OUT, { recursive: true })
await writeFile(outFile, JSON.stringify({
  city: cityId, fingerprint, model: spec.model ?? 'Opus 4.8',
  candidates, analyses,
  winner, winnerOrig, winnerRot,
  winnerReason, winnerOrigReason, winnerRotReason,
  summary,
}))
console.log(JSON.stringify({
  saved: outFile, winner, winnerOrig, winnerRot,
  candidates: candidates.map((c) => c.id),
}))
