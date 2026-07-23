// 搜尋用模擬器：完全複用 llmEval.mjs 的佈局重建 + hillClimb 的 makeMover 硬規則。
import { readFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
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
const label = (id) => `${nameById.get(id) ?? '×'}[i${idx.get(id)}]`

// ---- 逐線鏈（複製 llmEval 的 walk），用來算 acute ----
const { segs: segsAll } = buildHcGraph(skeleton, cells)
function chainsOf(rid) {
  const own = segsAll.filter((s) => s.routes?.has(rid))
  if (!own.length) return []
  const adj = new Map()
  own.forEach((s, i) => { for (const v of [s.a, s.b]) { if (!adj.has(v)) adj.set(v, []); adj.get(v).push(i) } })
  const used = new Array(own.length).fill(false)
  const chains = []
  const walk = (start) => {
    const chain = [start]; let at = start
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
const triples = []
for (const [rid, m] of routeMeta) {
  if (String(rid).startsWith('river:')) continue
  for (const ch of chainsOf(rid)) for (let i = 1; i + 1 < ch.length; i++) triples.push([ch[i - 1], ch[i], ch[i + 1], m.name])
}

function metrics(pos) {
  let hv = 0, d45 = 0
  for (const s of segsAll) {
    const A = pos.get(s.a), B = pos.get(s.b)
    const dx = B[0] - A[0], dy = B[1] - A[1]
    if (dx === 0 || dy === 0) hv++
    else if (Math.abs(dx) === Math.abs(dy)) d45++
  }
  const ac = []
  for (const [a, b, c, ln] of triples) {
    const A = pos.get(a), B = pos.get(b), C = pos.get(c)
    if ((A[0] - B[0]) * (C[0] - B[0]) + (A[1] - B[1]) * (C[1] - B[1]) > 0) ac.push(`${ln}@${nameById.get(b) ?? '×'}(${B})`)
  }
  return { hv, d45, ac }
}

// ---- 搜尋：每一步用真正的 makeMover.validMove ----
const g = buildHcGraph(skeleton, cells)
let pos = g.pos
let M = makeMover(pos, g.segs, g.inc, nC, nR)
const start = new Map([...pos].map(([id, p]) => [id, [p[0], p[1]]]))
let cur = metrics(pos)
console.log('base HV', cur.hv, 'D45', cur.d45, 'acute', cur.ac.length, cur.ac)

const RADIUS = +(process.argv[2] ?? 3)
const PEN = +(process.argv[3] ?? 0.3)
const applied = []
const done = new Set()
for (let iter = 0; iter < 80; iter++) {
  let best = null
  for (const id of idsSorted) {
    if (!nameById.has(id)) continue // 不動交叉點 ×
    if (done.has(id)) continue // 每點只動一次（moves 是一次性目標）
    const [c0, r0] = pos.get(id)
    for (let dc = -RADIUS; dc <= RADIUS; dc++) for (let dr = -RADIUS; dr <= RADIUS; dr++) {
      if (!dc && !dr) continue
      const P = [c0 + dc, r0 + dr]
      if (P[0] < 0 || P[1] < 0 || P[0] >= nC || P[1] >= nR) continue
      if (!M.validMove(id, P)) continue
      pos.set(id, P)
      const s = metrics(pos)
      pos.set(id, [c0, r0])
      const dAc = cur.ac.length - s.ac.length
      const dHv = s.hv - cur.hv
      if (dAc < 0) continue
      const gain = dAc * 20 + dHv * 2 + (s.d45 - cur.d45) * 0.2 - PEN * Math.max(Math.abs(dc), Math.abs(dr))
      if (gain <= 0) continue
      if (!best || gain > best.gain) best = { id, P, s, gain, dAc, dHv }
    }
  }
  if (!best) break
  M.applyMove(best.id, best.P)
  cur = best.s
  done.add(best.id)
  applied.push([best.id, best.P])
  console.log(`move ${label(best.id)} ${start.get(best.id)} -> ${best.P} | HV ${cur.hv} D45 ${cur.d45} acute ${cur.ac.length}`)
}
console.log('FINAL HV', cur.hv, 'D45', cur.d45, 'acute', cur.ac.length, cur.ac)
const moves = {}
for (const [id, P] of applied) moves[idx.get(id)] = P
console.log(JSON.stringify(moves))
writeFileSync('.scratch/moves.json', JSON.stringify(moves, null, 1))
