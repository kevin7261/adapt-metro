// Targeted Yamanote squaring: move ONLY the 14 side-flippers + a few hub-order
// and on-edge-overlap fixes. i24 goes on the RIGHT edge; green BR between i11,i24.
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
const ids = [...grid.cellOf.keys()].sort()
const idxOf = new Map(ids.map((id, i) => [id, i]))
const idOf = (i) => ids[i]
const outFile = join(DATA, 'llmshapes', `${cityId}.${variant}.json`)
let baseCells
if (existsSync(outFile)) { const s = JSON.parse(await readFile(outFile, 'utf8')); baseCells = new Map(s.cellAfter.map(([id, c, r]) => [id, [c, r]])) }
else baseCells = new Map([...grid.cellOf].map(([id, p]) => [id, [...p]]))
const pos = new Map([...baseCells].map(([id, p]) => [id, [p[0], p[1]]]))
const C = (i) => pos.get(idOf(i))[0], R = (i) => pos.get(idOf(i))[1]

const LEFT = 16, RIGHT = 82, TOP = 22, BOT = 88
const moves = {}
// ---- ring ----
moves[66] = [RIGHT, TOP]; moves[35] = [LEFT, TOP]; moves[54] = [LEFT, BOT]
for (const i of [62, 30, 38, 8]) moves[i] = [C(i), TOP]
for (const i of [91, 22, 39, 87]) moves[i] = [LEFT, R(i)]
for (const i of [17, 19, 73, 11]) moves[i] = [C(i), BOT]
for (const i of [24, 96, 46, 47, 93, 85, 58, 56, 92]) moves[i] = [RIGHT, R(i)]
const greens = [{ a: 11, b: 24, cell: [RIGHT, BOT] }]
// ---- non-ring targeted fixes ----
Object.assign(moves, {
  // top band: push inside below r=22 / off the top edge line
  99: [30, 26], 37: [55, 27], 40: [78, 25],
  // SW bottom cluster: pull just inside the flat bottom edge
  68: [39, 85], 13: [42, 86], 60: [44, 85], 100: [47, 86], 36: [50, 85], 89: [53, 86],
  // east lune (were exterior at c<82): push east of the wall, order preserved
  57: [85, 72], 97: [89, 74], 5: [91, 76], 6: [93, 77], 10: [86, 49], 3: [87, 60],
  // Chuo hub: keep i2 right of its four ring spokes, i51 between i46/i47
  2: [74, 51], 51: [80, 58],
  // SE corner clearance: keep i9-i11 edge below the BR corner
  9: [87, 91],
})
const cand = { model: 'Opus 4.8', moves, greens }
await writeFile(join(__dirname, '_shapeCand.json'), JSON.stringify(cand, null, 1))
console.log('wrote', Object.keys(moves).length, 'moves,', greens.length, 'greens')
