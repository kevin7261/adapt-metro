// For each non-ring vertex, report whether it is inside the OLD ring polygon vs
// inside the target SQUARE, so we only move the ones that flip side.
import { readFile } from 'node:fs/promises'
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

// ring in cut order
const ringIds = ctx.cutIds
const ringSet = new Set(ringIds)
const oldPoly = ringIds.map((id) => pos.get(id))
// target square positions for ring (same mapping as generator)
const LEFT = 16, RIGHT = 82, TOP = 22, BOT = 88
const C = (id) => pos.get(id)[0], Rr = (id) => pos.get(id)[1]
const tgt = new Map()
const set = (i, c, r) => tgt.set(idOf(i), [c, r])
set(66, RIGHT, TOP); set(35, LEFT, TOP); set(54, LEFT, BOT)
for (const i of [62, 30, 38, 8]) set(i, C(idOf(i)), TOP)
for (const i of [91, 22, 39, 87]) set(i, LEFT, Rr(idOf(i)))
for (const i of [17, 19, 73, 11]) set(i, C(idOf(i)), BOT)
for (const i of [24, 96, 46, 47, 93, 85, 58, 56, 92]) set(i, RIGHT, Rr(idOf(i)))
const newPoly = []
for (const id of ringIds) {
  newPoly.push(tgt.get(id))
  if (id === idOf(11)) newPoly.push([RIGHT, BOT]) // green BR corner after i11, before i24
}

function inPoly(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a[1] > pt[1]) !== (b[1] > pt[1])) {
      const x = a[0] + (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1])
      if (pt[0] < x) inside = !inside
    }
  }
  return inside
}
const flips = []
for (const [id, p] of pos) {
  const i = idxOf.get(id)
  if (ringSet.has(id)) continue
  const io = inPoly(p, oldPoly), inw = inPoly(p, newPoly)
  if (io !== inw) flips.push({ i, c: p[0], r: p[1], old: io ? 'IN' : 'out', neu: inw ? 'IN' : 'out' })
}
flips.sort((a, b) => a.c - b.c || a.r - b.r)
console.log('FLIPPERS (side changed):', flips.length)
for (const f of flips) console.log(`  i${f.i} (${f.c},${f.r})  ${f.old} -> ${f.neu}`)
