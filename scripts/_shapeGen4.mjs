import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { existsSync } from 'node:fs'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { setSpanCap } from '../src/stores/hillClimb.js'
import { shapeLlmContext } from '../src/stores/paper/shape.js'
setSpanCap(3)
const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const cityId = 'as-jpn-tokyo-jr', variant = 'orig'
const meta = JSON.parse(await readFile(join(DATA, 'map-adjust', `${cityId}.json`), 'utf8'))
const geojson = JSON.parse(await readFile(join(DATA, meta.file), 'utf8'))
const stations = geojson.features.filter((f) => f.geometry?.type === 'Point')
const lineFeats = geojson.features.filter((f) => f.geometry && f.geometry.type !== 'Point')
const fitFC = { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : geojson.features }
const skeleton = buildConnectSkeleton(geojson)
const projection = geoMercator().angle(0).fitExtent([[24, 24], [1176, 776]], fitFC)
const projById = new Map()
for (const f of stations) { const p = projection(f.geometry.coordinates); if (p) projById.set(f.properties.station_id, p) }
for (const c of skeleton.crossings ?? []) { const p = projection(c.coord); if (p) projById.set(c.id, p) }
const grid = buildSchematicGrid(skeleton, projById, [24, 24, 1176, 776])
const cols = grid.cols
const ctx = shapeLlmContext(skeleton, grid.cellOf, cols, grid.rows, cityId)
const ids = [...grid.cellOf.keys()].sort()
const idxOf = new Map(ids.map((id, i) => [id, i]))
const idOf = (i) => ids[i]
const outFile = join(DATA, 'straighten-shape', `${cityId}.${variant}.json`)
let baseCells
if (existsSync(outFile)) { const s = JSON.parse(await readFile(outFile, 'utf8')); baseCells = new Map(s.cellAfter.map(([id, c, r]) => [id, [c, r]])) }
else baseCells = new Map([...grid.cellOf].map(([id, p]) => [id, [...p]]))
const pos = new Map([...baseCells].map(([id, p]) => [id, [p[0], p[1]]]))
const C = (i) => pos.get(idOf(i))[0], R = (i) => pos.get(idOf(i))[1]

const LEFT = 16, RIGHT = 82, TOP = 22, BOT = 88
const moves = {}
moves[66] = [RIGHT, TOP]; moves[35] = [LEFT, TOP]; moves[54] = [LEFT, BOT]
for (const i of [62, 30, 38, 8]) moves[i] = [C(i), TOP]
for (const i of [91, 22, 39, 87]) moves[i] = [LEFT, R(i)]
for (const i of [17, 19, 73, 11]) moves[i] = [C(i), BOT]
for (const i of [24, 96, 46, 47, 93, 85, 58, 56, 92]) moves[i] = [RIGHT, R(i)]
const greens = [{ a: 11, b: 24, cell: [RIGHT, BOT] }]

// hand fixes
Object.assign(moves, {
  99: [30, 26], 37: [55, 27], 40: [78, 25],       // top band inside
  68: [39, 84], 100: [44, 84], 60: [41, 85], 89: [51, 85], 36: [49, 86], 13: [40, 87], // SW cluster keep-col vert squeeze
  51: [72, 57],                                    // between i47/i46 from i2, off the direct i2-i46 line
  9: [84, 92],                                     // SE tail attaches to i11 (bottom) -> r>88
})
// ---- east exterior monotonic warp into (RIGHT, 100] keeping row ----
const arc = [[16, 82], [23, 80], [33, 81], [38, 74], [50, 69], [53, 68], [61, 66], [65, 61], [69, 60], [84, 59], [88, 59]]
const oldArc = (r) => {
  if (r <= arc[0][0]) return arc[0][1]
  if (r >= arc[arc.length - 1][0]) return arc[arc.length - 1][1]
  for (let k = 0; k < arc.length - 1; k++) { const [r0, c0] = arc[k], [r1, c1] = arc[k + 1]; if (r >= r0 && r <= r1) return c0 + (c1 - c0) * (r - r0) / (r1 - r0) }
  return arc[arc.length - 1][1]
}
const ringI = new Set(ctx.cutIds.map((id) => idxOf.get(id)))
const taken = new Set(Object.keys(moves).map(Number))
const ext = []
let maxEx = 1
for (const [id, p] of pos) {
  const i = idxOf.get(id)
  if (ringI.has(i) || taken.has(i)) continue
  const [c, r] = p
  if (r > BOT) continue // include top-right exterior (r<22) so cross-boundary edges don't stretch
  const ex = c - oldArc(r)
  if (ex <= 0.5) continue
  ext.push([i, c, r, ex]); maxEx = Math.max(maxEx, ex)
}
const OF = (100 - RIGHT) / maxEx
for (const [i, , r, ex] of ext) {
  let nc = Math.round(RIGHT + ex * OF)
  nc = Math.max(RIGHT + 1, Math.min(cols - 1, nc))
  moves[i] = [nc, r]
}
const cand = { model: 'Opus 4.8', moves, greens }
await writeFile(join(__dirname, '_shapeCand.json'), JSON.stringify(cand, null, 1))
console.log('wrote', Object.keys(moves).length, 'moves,', greens.length, 'greens; east', ext.length, 'maxEx', maxEx.toFixed(1))
