import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { buildHcGraph, setSpanCap } from '../src/stores/hillClimb.js'
import { shapeLlmContext } from '../src/stores/paper/shape.js'
setSpanCap(3)
const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const cityId = process.argv[2] || 'as-jpn-tokyo-jr'
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
const { pos, segs } = buildHcGraph(skeleton, grid.cellOf)
const ctx = shapeLlmContext(skeleton, grid.cellOf, cols, rows, cityId)
const ids = [...grid.cellOf.keys()].sort()
const idxOf = new Map(ids.map((id, i) => [id, i]))
const ringSet = new Set(ctx.cutIds)
const inc = new Map()
for (const s of segs) { if (!inc.has(s.a)) inc.set(s.a, []); if (!inc.has(s.b)) inc.set(s.b, []); inc.get(s.a).push(s); inc.get(s.b).push(s) }
const ringOrder = ctx.cutIds.map((id) => idxOf.get(id))
console.log('cols', cols, 'rows', rows)
console.log('ring order (idx):', ringOrder.join(' '))
for (const id of ctx.cutIds) {
  const i = idxOf.get(id)
  const p = pos.get(id)
  const nbrs = (inc.get(id) || []).map((s) => (s.a === id ? s.b : s.a))
  const ringN = nbrs.filter((n) => ringSet.has(n)).map((n) => 'R' + idxOf.get(n))
  const spokeN = nbrs.filter((n) => !ringSet.has(n)).map((n) => { const q = pos.get(n); return '.' + idxOf.get(n) + '(' + q[0] + ',' + q[1] + ')' })
  console.log('Ri' + i + ' (' + p[0] + ',' + p[1] + ') deg=' + nbrs.length + ' ring[' + ringN.join(',') + '] spokes[' + spokeN.join(',') + ']')
}
