// 暫用探針（route-llm-eval）：列出所有讓 H/V 增加的單點移動候選。用完即刪。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import * as HC from '../src/stores/hillClimb.js'
import { PAPER_BUILD } from '../src/stores/paperAlign.js'

HC.setSpanCap(3)
const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const cityId = process.argv[2] || 'as-jpn-tokyo-jr'
const variant = process.argv[3] || 'orig'
const compact = process.argv[4] || 'rect'

const meta = JSON.parse(await readFile(join(DATA, 'map-adjust', `${cityId}.json`), 'utf8'))
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
const post = HC.iteratePost(PAPER_BUILD[compact], skeleton, grid.cellOf, grid.cols, grid.rows).cellAfter
const comp = HC.straightenCompactLoop(skeleton, post, grid.cols, grid.rows)
const nC = comp.cols, nR = comp.rows
const BASE = [...comp.cellAfter].map(([id, p]) => [id, [p[0], p[1]]])
const base = HC.buildHcGraph(skeleton, comp.cellAfter)
const ids = [...base.pos.keys()].sort()
const nameOf = new Map()
for (const f of stations) nameOf.set(f.properties.station_id, f.properties.name)

const run = (entries) =>
  HC.applyLlmTargets(skeleton, new Map(BASE.map(([id, p]) => [id, [p[0], p[1]]])), nC, nR, entries)

const SEEDS = [[49, [8, 11]], [25, [19, 2]], [19, [6, 17]], [27, [10, 6]], [56, [16, 6]], [65, [5, 11]]]
const seed = SEEDS // [[idx,[c,r]],…]
const seedEntries = seed.map(([i, t]) => [ids[i], t])
const r0 = run(seedEntries)
const hv0 = r0.stats.hvAfter, hvd0 = r0.stats.hvdAfter
console.log('seed hv', r0.stats.hvBefore, '->', hv0, 'hvd', r0.stats.hvdBefore, '->', hvd0, 'segs', r0.stats.segs)

const out = []
for (const [idx, id] of ids.entries()) {
  if (seed.some(([i]) => i === idx)) continue
  const [c0, r00] = base.pos.get(id)
  for (let dc = -3; dc <= 3; dc++) for (let dr = -3; dr <= 3; dr++) {
    if (!dc && !dr) continue
    if (Math.abs(dc) + Math.abs(dr) > 4) continue
    const c = c0 + dc, r = r00 + dr
    if (c < 0 || r < 0 || c >= nC || r >= nR) continue
    const res = run([...seedEntries, [id, [c, r]]])
    if (!res.stats.moved) continue
    const d = res.stats.hvAfter - hv0
    if (d > 0) out.push([d, res.stats.hvdAfter - hvd0, idx, nameOf.get(id) || '×', `${c0},${r00}`, `${c},${r}`])
  }
}
out.sort((a, b) => b[0] - a[0] || b[1] - a[1])
for (const o of out) console.log(o.join('  '))
console.log('candidates', out.length)
