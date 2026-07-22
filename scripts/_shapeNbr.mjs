import { readFile } from 'node:fs/promises'
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
const ringSet = new Set(ctx.cutIds)
const outFile = join(DATA, 'llmshapes', `${cityId}.${variant}.json`)
let baseCells
if (existsSync(outFile)) { const s = JSON.parse(await readFile(outFile, 'utf8')); baseCells = new Map(s.cellAfter.map(([id, c, r]) => [id, [c, r]])) }
else baseCells = new Map([...grid.cellOf].map(([id, p]) => [id, [...p]]))
const { pos, segs } = buildHcGraph(skeleton, baseCells)
const inc = new Map()
for (const s of segs) { if (!inc.has(s.a)) inc.set(s.a, []); if (!inc.has(s.b)) inc.set(s.b, []); inc.get(s.a).push(s); inc.get(s.b).push(s) }
const want = process.argv.slice(2).map(Number)
for (const wi of want) {
  const id = idOf(wi); if (!id) { console.log(wi, 'missing'); continue }
  const p = pos.get(id); const nbrs = (inc.get(id) || []).map((s) => (s.a === id ? s.b : s.a))
  const desc = nbrs.map((n) => { const q = pos.get(n); const i = idxOf.get(n); return (ringSet.has(n) ? 'R' : '.') + i + '(' + q[0] + ',' + q[1] + ')' })
  console.log((ringSet.has(id) ? 'R' : '.') + 'i' + wi + '(' + p[0] + ',' + p[1] + ') deg' + nbrs.length + ' -> ' + desc.join(' '))
}
