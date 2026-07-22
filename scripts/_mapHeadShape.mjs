import { readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { geoMercator } from 'd3-geo'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'

const city = process.argv[2]
const geoPath = process.argv[3]
const outMoves = process.argv[4]
const raw = JSON.parse(readFileSync(geoPath, 'utf8'))
const stations = raw.features.filter(f => f.geometry?.type === 'Point')
const lineFeats = raw.features.filter(f => f.geometry && f.geometry.type !== 'Point')
const fitFC = { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : raw.features }
const projection = geoMercator().fitExtent([[24, 24], [1176, 776]], fitFC)
const sk = buildConnectSkeleton(raw)
const projById = new Map(stations.map(f => [f.properties.station_id, projection(f.geometry.coordinates)]))
for (const c of sk.crossings ?? []) projById.set(c.id, projection(c.coord))
const grid = buildSchematicGrid(sk, projById, [24, 24, 1176, 776])
const ids = [...grid.cellOf.keys()].sort()
const idxOf = new Map(ids.map((id, i) => [id, i]))
const head = JSON.parse(execSync(`git show HEAD:data/metro/straighten-shape/${city}.orig.json`, { encoding: 'utf8' }))
const moves = {}
for (const [id, c, r] of head.cellAfter) {
  if (String(id).startsWith('shape-g')) continue
  if (!idxOf.has(id)) continue
  const [c0, r0] = grid.cellOf.get(id)
  if (c0 !== c || r0 !== r) moves[idxOf.get(id)] = [c, r]
}
const greens = (head.greens || []).map(g => ({
  a: idxOf.get(g.a), b: idxOf.get(g.b), cell: [g.c, g.r],
})).filter(g => g.a != null && g.b != null)
writeFileSync(outMoves, JSON.stringify({
  model: 'Composer', prompt: `全球一次跑完——${city} orig`, note: 'HEAD cellAfter 映射', moves, greens,
}, null, 2))
console.log(city, 'moves', Object.keys(moves).length, 'greens', greens.length, 'verts', ids.length, 'headCells', head.cellAfter.length)
