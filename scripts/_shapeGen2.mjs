// Adaptive Yamanote squaring generator (recomputes from CURRENT grid-post base).
// Ring -> 4 straight edges (same winding as current), green BR corner, per-row
// horizontal warp of the east half to verticalize the right arc onto c=82 while
// preserving inside/outside order. Hand nudges appended for top-band flippers.
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
const meta = JSON.parse(await readFile(join(DATA, 'views', `${cityId}.json`), 'utf8'))
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
const cols = grid.cols, rows = grid.rows
const ctx = shapeLlmContext(skeleton, grid.cellOf, cols, rows, cityId)
const ids = [...grid.cellOf.keys()].sort()
const idxOf = new Map(ids.map((id, i) => [id, i]))
const idOf = (i) => ids[i]
const outFile = join(DATA, 'llmshapes', `${cityId}.${variant}.json`)
let baseCells
if (existsSync(outFile)) { const s = JSON.parse(await readFile(outFile, 'utf8')); baseCells = new Map(s.cellAfter.map(([id, c, r]) => [id, [c, r]])) }
else baseCells = new Map([...grid.cellOf].map(([id, p]) => [id, [...p]]))
const pos = new Map([...baseCells].map(([id, p]) => [id, [p[0], p[1]]]))
const C = (i) => pos.get(idOf(i))[0]
const R = (i) => pos.get(idOf(i))[1]

const LEFT = 16, RIGHT = 82, TOP = 22, BOT = 88, PIVOT = 49
const moves = {}
// ---- ring edges (keep along-edge coord, snap perpendicular to the edge line) ----
// TOP r=22
moves[66] = [RIGHT, TOP]                 // TR corner
moves[35] = [LEFT, TOP]                  // TL corner
for (const i of [62, 30, 38, 8]) moves[i] = [C(i), TOP]
// LEFT c=16
moves[54] = [LEFT, BOT]                   // BL corner
for (const i of [91, 22, 39, 87]) moves[i] = [LEFT, R(i)]
// BOTTOM r=88
for (const i of [17, 19, 73, 11, 24]) moves[i] = [C(i), BOT]
// RIGHT c=82
for (const i of [96, 46, 47, 93, 85, 58, 56, 92]) moves[i] = [RIGHT, R(i)]
// green BR corner on ring seg i24-i96
const greens = [{ a: 24, b: 96, cell: [RIGHT, BOT] }]

// ---- per-row horizontal warp of the east half ----
// oldArc(r): current right ring-boundary col as a function of row.
const arc = [[16, 82], [23, 80], [33, 81], [38, 74], [50, 69], [53, 68], [61, 66], [65, 61], [69, 60], [84, 59], [88, 59]]
function oldArc(r) {
  if (r <= arc[0][0]) return arc[0][1]
  if (r >= arc[arc.length - 1][0]) return arc[arc.length - 1][1]
  for (let k = 0; k < arc.length - 1; k++) { const [r0, c0] = arc[k], [r1, c1] = arc[k + 1]; if (r >= r0 && r <= r1) return c0 + (c1 - c0) * (r - r0) / (r1 - r0) }
  return arc[arc.length - 1][1]
}
const ringI = new Set(ctx.cutIds.map((id) => idxOf.get(id)))
const taken = new Set(Object.keys(moves).map(Number))
let maxOut = 1
const band = []
for (const [id, p] of pos) {
  const i = idxOf.get(id)
  if (taken.has(i) || ringI.has(i)) continue
  const [c, r] = p
  if (r < TOP || r > BOT || c < PIVOT) continue
  const rc = oldArc(r)
  if (rc <= PIVOT + 1) continue
  band.push([i, c, r, rc])
  if (c > rc) maxOut = Math.max(maxOut, c - rc)
}
const OF = (cols - 1 - RIGHT) / maxOut
for (const [i, c, r, rc] of band) {
  let nc
  if (c <= rc) nc = Math.round(PIVOT + (c - PIVOT) * (RIGHT - PIVOT) / (rc - PIVOT))
  else nc = Math.round(RIGHT + (c - rc) * OF)
  nc = Math.max(0, Math.min(cols - 1, nc))
  if (nc !== c) moves[i] = [nc, r]
}
// ---- hand nudges (top-band interior flippers pushed below r=22) ----
const NUDGE = { 99: [30, 26], 37: [54, 27], 40: [84, 20] }
for (const [i, t] of Object.entries(NUDGE)) moves[+i] = t

const cand = { model: 'Opus 4.8', moves, greens }
await writeFile(join(__dirname, '_shapeCand.json'), JSON.stringify(cand, null, 1))
console.log('wrote', Object.keys(moves).length, 'moves,', greens.length, 'greens')
