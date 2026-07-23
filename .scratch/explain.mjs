// 逐 move 說明：套用前後每條受影響段的方向變化 + 全網 HV/D45/acute。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { buildHcGraph, iteratePost, makeMover, straightenCompactLoop, setSpanCap } from '../src/stores/hillClimb.js'
import { PAPER_BUILD } from '../src/stores/paperAlign.js'

setSpanCap(3)
const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'data', 'metro')
const cityId = 'as-jpn-tokyo-jr', variant = 'orig', compact = 'stroke'
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
const baseCells = iteratePost(PAPER_BUILD[compact], skeleton, grid.cellOf, grid.cols, grid.rows).cellAfter
const comp = straightenCompactLoop(skeleton, baseCells, grid.cols, grid.rows)
const cells = comp.cellAfter
const nC = comp.cols, nR = comp.rows
const nameById = new Map(stations.map((f) => {
  const p = f.properties
  return [p.station_id, p.station_name_local || p.station_name || p.station_id]
}))
const routeMeta = new Map()
for (const f of lineFeats) for (const r of f.properties?.routes ?? []) {
  if (r.route_id && !routeMeta.has(r.route_id)) routeMeta.set(r.route_id, { name: r.route_name ?? String(r.route_id) })
}
const idsSorted = [...cells.keys()].sort()
const idx = new Map(idsSorted.map((id, i) => [id, i]))
const { segs: segsAll } = buildHcGraph(skeleton, cells)
function chainsOf(rid) {
  const own = segsAll.filter((s) => s.routes?.has(rid))
  if (!own.length) return []
  const adj = new Map()
  own.forEach((s, i) => { for (const v of [s.a, s.b]) { if (!adj.has(v)) adj.set(v, []); adj.get(v).push(i) } })
  const used = new Array(own.length).fill(false)
  const chains = []
  const walk = (st) => {
    const chain = [st]; let at = st
    for (;;) {
      const nextI = (adj.get(at) ?? []).find((i) => !used[i])
      if (nextI == null) break
      used[nextI] = true
      at = own[nextI].a === at ? own[nextI].b : own[nextI].a
      chain.push(at)
    }
    return chain
  }
  for (const [v, list] of adj) if (list.length % 2 === 1 && list.some((i) => !used[i])) chains.push(walk(v))
  own.forEach((s, i) => { if (!used[i]) chains.push(walk(s.a)) })
  return chains
}
const routeChains = []
for (const [rid, m] of routeMeta) {
  if (String(rid).startsWith('river:')) continue
  for (const ch of chainsOf(rid)) routeChains.push([m.name, ch])
}
const dirOf = (A, B) => {
  const dx = B[0] - A[0], dy = B[1] - A[1]
  if (dy === 0) return 'H'
  if (dx === 0) return 'V'
  if (Math.abs(dx) === Math.abs(dy)) return 'D45'
  return 'other'
}
function report(pos, tag) {
  const st = { H: 0, V: 0, D45: 0, other: 0 }
  for (const s of segsAll) st[dirOf(pos.get(s.a), pos.get(s.b))]++
  const ac = []
  for (const [ln, ch] of routeChains) for (let i = 1; i + 1 < ch.length; i++) {
    const A = pos.get(ch[i - 1]), B = pos.get(ch[i]), C = pos.get(ch[i + 1])
    if ((A[0] - B[0]) * (C[0] - B[0]) + (A[1] - B[1]) * (C[1] - B[1]) > 0) ac.push(`${ln}@${nameById.get(ch[i]) ?? '×'}(${B})`)
  }
  console.log(tag, JSON.stringify(st), 'HV', st.H + st.V, 'acute', ac.length, ac)
  // per line
  const per = new Map()
  for (const [ln, ch] of routeChains) {
    if (!per.has(ln)) per.set(ln, { H: 0, V: 0, D45: 0, other: 0 })
    for (let i = 0; i + 1 < ch.length; i++) per.get(ln)[dirOf(pos.get(ch[i]), pos.get(ch[i + 1]))]++
  }
  return { st, ac, per }
}
const moves = JSON.parse(await readFile('.scratch/moves.json', 'utf8'))
const g = buildHcGraph(skeleton, cells)
const pos = g.pos
const before = report(pos, 'BEFORE')
const M = makeMover(pos, g.segs, g.inc, nC, nR)
const nbr = new Map()
for (const s of g.segs) {
  if (!nbr.has(s.a)) nbr.set(s.a, []); nbr.get(s.a).push(s.b)
  if (!nbr.has(s.b)) nbr.set(s.b, []); nbr.get(s.b).push(s.a)
}
const order = Object.keys(moves).map(Number)
for (const i of order) {
  const id = idsSorted[i]
  const from = pos.get(id).slice()
  const P = moves[i]
  const lines0 = (nbr.get(id) ?? []).map((u) => `${nameById.get(u) ?? '×'}(${pos.get(u)}) ${dirOf(from, pos.get(u))}`)
  const ok = M.validMove(id, P)
  if (ok) M.applyMove(id, P)
  const lines1 = (nbr.get(id) ?? []).map((u) => `${dirOf(pos.get(id), pos.get(u))}`)
  console.log(`\ni${i} ${nameById.get(id)} (${from}) -> (${P}) valid=${ok}`)
  lines0.forEach((l, k) => console.log('   ', l, '=>', lines1[k]))
}
const after = report(pos, '\nAFTER')
console.log('\n--- per line H/V/D45/other ---')
for (const [ln, b] of before.per) {
  const a = after.per.get(ln)
  console.log(ln.padEnd(18), `${b.H}/${b.V}/${b.D45}/${b.other}`, '->', `${a.H}/${a.V}/${a.D45}/${a.other}`)
}
