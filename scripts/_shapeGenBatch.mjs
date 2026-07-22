// Generate an affine-warp batch (applied to ALL vertices) to compress/align the
// whole map toward the target box while preserving orientation (topology-safe).
// Usage: node _shapeGenBatch.mjs <city> <variant> <outMovesJson> <spec-js>
// spec-js: a JS expression body mapping (c,r)->[c,r]; provided inline below by editing.
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { buildHcGraph, setSpanCap } from '../src/stores/hillClimb.js'
import { shapeLlmContext } from '../src/stores/paper/shape.js'

setSpanCap(+(process.env.LLM_SPAN_CAP ?? 3) || 3)
const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const cityId = process.argv[2]
const variant = process.argv[3]
const outMoves = process.argv[4]
const MODE = process.argv[5] || 'vcomp' // vcomp | shearR | ringedge
const FAC = +(process.argv[6] ?? 0.75)
const outFile = join(DATA, 'llmshapes', `${cityId}.${variant}.json`)

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
for (const f of stations) { const p = projection(f.geometry.coordinates); if (p) projById.set(f.properties.station_id, p) }
for (const c of skeleton.crossings ?? []) { const p = projection(c.coord); if (p) projById.set(c.id, p) }
const grid = buildSchematicGrid(skeleton, projById, [24, 24, 1176, 776])
const cols = grid.cols, rows = grid.rows
const { pos: gp, segs } = buildHcGraph(skeleton, grid.cellOf)
const fingerprint = { verts: gp.size, segs: segs.length, cols, rows }
let saved = null
if (existsSync(outFile)) { saved = JSON.parse(await readFile(outFile, 'utf8')); if (JSON.stringify(saved.fingerprint) !== JSON.stringify(fingerprint)) saved = null }
const baseCells = saved ? new Map(saved.cellAfter.map(([id, c, r]) => [id, [c, r]])) : new Map([...grid.cellOf].map(([id, p]) => [id, [...p]]))
const ids = [...baseCells.keys()].sort()
const idxOf = new Map(ids.map((id, i) => [id, i]))
const ctx = shapeLlmContext(skeleton, baseCells, cols, rows, cityId)
const ringSet = new Set(ctx.cutIds)

const CY = 55
const AA = +(process.argv[7] ?? 0.6)
function xform(c, r) {
  if (MODE === 'vcomp') return [c, Math.round(CY + (r - CY) * FAC)]
  if (MODE === 'hstretch') {
    // anchor at left edge x=16; horizontal scale grows with r (row) to straighten
    // the right side to vertical. Leave far-east exterior nodes (c>84) fixed;
    // cap stretched x at box right edge 82 so nothing overshoots into exterior.
    if (c > 84) return [c, r]
    const rr = Math.max(22, Math.min(88, r))
    const s = 1 + AA * (rr - 22) / 66
    return [Math.min(82, Math.round(16 + (c - 16) * s)), r]
  }
  return [c, r]
}
const clamp = (v, lim) => Math.max(0, Math.min(lim - 1, v))
const moves = {}
for (const id of ids) {
  const [c, r] = baseCells.get(id)
  const [nc, nr] = xform(c, r)
  const cc = clamp(nc, cols), rr = clamp(nr, rows)
  if (cc !== c || rr !== r) moves[idxOf.get(id)] = [cc, rr]
}
await writeFile(outMoves, JSON.stringify({ model: 'Opus 4.8', moves, greens: [], note: `warp ${MODE} fac=${FAC}` }, null, 0))
console.log('wrote', Object.keys(moves).length, 'moves to', outMoves)
