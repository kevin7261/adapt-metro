// Generate a candidate that verticalizes the RIGHT side of the Yamanote ring by a
// per-row horizontal warp on the right half (c>=PIVOT), mapping the right ring arc
// exactly onto c=RIGHT. Left half untouched (left edge already straight at c=16).
// Top/bottom/corner ring stations snapped to their edges; green BR corner inserted.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { existsSync } from 'node:fs'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { buildHcGraph, setSpanCap } from '../src/stores/hillClimb.js'
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
const cols = grid.cols, rows = grid.rows
const ctx = shapeLlmContext(skeleton, grid.cellOf, cols, rows, cityId)
const ids = [...grid.cellOf.keys()].sort()
const idxOf = new Map(ids.map((id, i) => [id, i]))
const idOf = (i) => ids[i]
const outFile = join(DATA, 'straighten-shape', `${cityId}.${variant}.json`)
let baseCells
if (existsSync(outFile)) { const s = JSON.parse(await readFile(outFile, 'utf8')); baseCells = new Map(s.cellAfter.map(([id, c, r]) => [id, [c, r]])) }
else baseCells = new Map([...grid.cellOf].map(([id, p]) => [id, [...p]]))
const pos = new Map([...baseCells].map(([id, p]) => [id, [p[0], p[1]]]))

const RIGHT = 82, LEFT = 16, TOP = 22, BOT = 88, PIVOT = 49
// right arc breakpoints (r asc) -> c, from current base ring positions
const ringR = [[26, 82], [31, 80], [39, 81], [42, 74], [51, 69], [54, 68], [60, 66], [63, 61], [66, 60], [77, 59], [82, 56]]
function ringRightC(r) {
  if (r <= ringR[0][0]) return ringR[0][1]
  if (r >= ringR[ringR.length - 1][0]) return ringR[ringR.length - 1][1]
  for (let i = 0; i < ringR.length - 1; i++) {
    const [r0, c0] = ringR[i], [r1, c1] = ringR[i + 1]
    if (r >= r0 && r <= r1) return c0 + (c1 - c0) * (r - r0) / (r1 - r0)
  }
  return ringR[ringR.length - 1][1]
}
const moves = {}
// explicit ring edge targets
const rightArc = [24, 96, 46, 47, 93, 85, 58, 56, 92]
const topArc = [62, 30, 38, 8]
const botArc = [17, 19, 73]
const keepRow = (i) => pos.get(idOf(i))[1]
const keepCol = (i) => pos.get(idOf(i))[0]
for (const i of rightArc) moves[i] = [RIGHT, keepRow(i)]
for (const i of topArc) moves[i] = [keepCol(i), TOP]
for (const i of botArc) moves[i] = [keepCol(i), BOT]
moves[66] = [RIGHT, TOP]; moves[35] = [LEFT, TOP]; moves[54] = [LEFT, BOT]
moves[11] = [RIGHT, BOT] // R11 is the BR corner itself (no green) so its east spoke i9 stops straddling
// warp every OTHER vertex in the right half (c>=PIVOT, r in [26,82]) horizontally.
// inside the diagonal (c<=rc): scale onto [PIVOT,82]. outside (c>rc): translate by
// the ring's rightward delta so the horizontal gap to the ring is preserved (keeps
// the external east cluster's internal order instead of clamp-piling at the wall).
const taken = new Set(Object.keys(moves).map(Number))
const warpable = []
let maxOut = 1
for (const [id, p] of pos) {
  const i = idxOf.get(id)
  if (taken.has(i)) continue
  if (ctx.cutIds.includes(id)) continue // ring handled or left/keep
  const [c, r] = p
  if (r < 26 || r > 82) continue
  if (c < PIVOT) continue
  const rc = ringRightC(r)
  if (rc <= PIVOT + 1) continue
  warpable.push([i, c, r, rc])
  if (c > rc) maxOut = Math.max(maxOut, c - rc)
}
const OF = (cols - 1 - RIGHT) / maxOut // compress the whole outside band into (RIGHT, cols-1]
for (const [i, c, r, rc] of warpable) {
  let nc
  if (c <= rc) nc = Math.round(PIVOT + (c - PIVOT) * (RIGHT - PIVOT) / (rc - PIVOT))
  else nc = Math.round(RIGHT + (c - rc) * OF) // outside: monotonic compress -> order preserved
  nc = Math.max(0, Math.min(cols - 1, nc))
  if (nc !== c) moves[i] = [nc, r]
}
// hand fixes
moves[37] = [54, 29]  // pull off top edge (was ptOverlap on Ri30-Ri62)
moves[2] = [74, 51]   // Chuo hub shifts right with its four ring spokes
moves[51] = [80, 58]  // keep i51 angularly between R47 and R46 as seen from i2
moves[13] = [38, 87]  // tuck i13 so the i13-i36 line clears i60(41,86) and R73<i13 order holds
const cand = { model: 'Opus 4.8', moves, greens: [] }
await writeFile(join(__dirname, '_shapeCand.json'), JSON.stringify(cand, null, 1))
console.log('wrote', Object.keys(moves).length, 'moves')
