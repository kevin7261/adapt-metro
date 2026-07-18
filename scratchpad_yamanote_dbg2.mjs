// 對單一移動列出對齊狀態改變的 segs
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from './src/stores/orientation.js'
import { buildConnectSkeleton } from './src/stores/skeleton.js'
import { buildSchematicGrid } from './src/stores/schematicGrid.js'
import { buildHillClimb, buildHcGraph, applyLlmTargets } from './src/stores/hillClimb.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, 'data', 'metro')
const cityId = 'as-jpn-tokyo-jr'
const outFile = join(DATA, 'llmviews', `${cityId}.rot.prompt.json`)

const meta = JSON.parse(await readFile(join(DATA, 'views', `${cityId}.json`), 'utf8'))
const geojson = JSON.parse(await readFile(join(DATA, meta.file), 'utf8'))
const stations = geojson.features.filter((f) => f.geometry?.type === 'Point')
const lineFeats = geojson.features.filter((f) => f.geometry && f.geometry.type !== 'Point')
const fitFC = { type: 'FeatureCollection', features: lineFeats.length ? lineFeats : geojson.features }
const tilt = computeOrientation(geojson).tilt
const skeleton = buildConnectSkeleton(geojson)
const projection = geoMercator().angle(Math.abs(tilt) >= 0.5 ? tilt : 0).fitExtent([[24, 24], [1176, 776]], fitFC)
const projById = new Map()
for (const f of stations) { const p = projection(f.geometry.coordinates); if (p) projById.set(f.properties.station_id, p) }
for (const c of skeleton.crossings ?? []) { const p = projection(c.coord); if (p) projById.set(c.id, p) }
const grid = buildSchematicGrid(skeleton, projById, [24, 24, 1176, 776])
const hc = buildHillClimb(skeleton, grid.cellOf, grid.cols, grid.rows)

let baseCells = hc.cellAfter
if (existsSync(outFile)) {
  const saved = JSON.parse(await readFile(outFile, 'utf8'))
  baseCells = new Map(saved.cellAfter.map(([id, c, r]) => [id, [c, r]]))
}
const ids = [...baseCells.keys()].sort()
const idxOf = new Map(ids.map((id, i) => [id, i]))
const nameOf = new Map(stations.map((f) => [f.properties.station_id, f.properties.station_name]))

const { segs } = buildHcGraph(skeleton, baseCells)
console.log('segs total:', segs.length)
const isHV = (cells, s) => {
  const A = cells.get(s.a), B = cells.get(s.b)
  return (A[0] === B[0]) !== (A[1] === B[1])
}
const clone = (m) => new Map([...m].map(([k, v]) => [k, [v[0], v[1]]]))

for (const [i, t] of [[9, [75, 88]], [91, [20, 36]], [24, [57, 92]], [73, [36, 100]]]) {
  const before = clone(baseCells)
  const res = applyLlmTargets(skeleton, clone(baseCells), grid.cols, grid.rows, [[ids[i], t]])
  // reverted 會還原 → 重跑一次拿未還原的中途狀態：改用 buildHcGraph + 手動重放不可行，
  // 所以直接看 res.stats；另外印出「若移動成功」的 seg 影響（用手動放置計算）。
  const manual = clone(baseCells)
  manual.set(ids[i], [t[0], t[1]])
  const changed = []
  for (const s of segs) {
    const b = isHV(before, s), a = isHV(manual, s)
    if (b !== a) changed.push(`${idxOf.get(s.a)}(${nameOf.get(s.a) ?? s.a})-${idxOf.get(s.b)}(${nameOf.get(s.b) ?? s.b}): ${b ? 'HV->off' : 'off->HV'}`)
  }
  console.log(`\ni=${i} ${nameOf.get(ids[i]) ?? ids[i]} -> ${JSON.stringify(t)}: stats=${JSON.stringify(res.stats)}`)
  console.log('  若直接放置的 seg 變化:', changed.length ? changed : '(無)')
  // 也列出這個點的所有邊
  const inc = segs.filter((s) => s.a === ids[i] || s.b === ids[i])
  console.log('  incident segs:', inc.map((s) => {
    const o = s.a === ids[i] ? s.b : s.a
    return `${idxOf.get(o)}(${nameOf.get(o) ?? o})${isHV(before, s) ? '[HV]' : ''}`
  }).join(', '))
}
