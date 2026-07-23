// scratch: 模擬 moves 後的 stats/acute（鏡像 scripts/llmEval.mjs 的管線）
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { geoMercator } from 'd3-geo'
import { computeOrientation } from '../src/stores/orientation.js'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { buildHcGraph, iteratePost, applyLlmTargets, straightenCompactLoop, setSpanCap } from '../src/stores/hillClimb.js'
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
const skeleton = buildConnectSkeleton(geojson)
const projection = geoMercator().angle(0).fitExtent([[24, 24], [1176, 776]], fitFC)
const projById = new Map()
for (const f of stations) { const p = projection(f.geometry.coordinates); if (p) projById.set(f.properties.station_id, p) }
for (const c of skeleton.crossings ?? []) { const p = projection(c.coord); if (p) projById.set(c.id, p) }
const grid = buildSchematicGrid(skeleton, projById, [24, 24, 1176, 776])
const baseCells = iteratePost(PAPER_BUILD[compact], skeleton, grid.cellOf, grid.cols, grid.rows).cellAfter
const comp = straightenCompactLoop(skeleton, baseCells, grid.cols, grid.rows)
const cells = comp.cellAfter
const nC = comp.cols, nR = comp.rows
const idsSorted = [...cells.keys()].sort()
const nameById = new Map(stations.map((f) => {
  const p = f.properties
  return [p.station_id, p.station_name_local || p.station_name || p.station_id]
}))
const routeMeta = new Map()
for (const f of lineFeats) for (const r of f.properties?.routes ?? []) {
  if (r.route_id && !routeMeta.has(r.route_id)) routeMeta.set(r.route_id, { name: r.route_name ?? String(r.route_id) })
}
const dirOf = (A, B) => {
  const dx = B[0] - A[0], dy = B[1] - A[1]
  if (dy === 0) return 'H'; if (dx === 0) return 'V'
  if (Math.abs(dx) === Math.abs(dy)) return 'D45'; return 'other'
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a)
function report(cl) {
  const { segs } = buildHcGraph(skeleton, cl)
  const g = { H: 0, V: 0, D45: 0, other: 0 }
  for (const s of segs) g[dirOf(cl.get(s.a), cl.get(s.b))]++
  const norm = (A, B) => { const dx = B[0] - A[0], dy = B[1] - A[1]; const q = gcd(Math.abs(dx), Math.abs(dy)) || 1; return `${dx / q},${dy / q}` }
  const label = (id) => { const [c, r] = cl.get(id); const n = nameById.get(id); return n ? `${n}(${c},${r})` : `×(${c},${r})` }
  const lines = []
  for (const [rid, m] of routeMeta) {
    const own = segs.filter((s) => s.routes?.has(rid))
    if (!own.length) continue
    const stat = { H: 0, V: 0, D45: 0, other: 0 }
    const adj = new Map()
    own.forEach((s, i) => {
      stat[dirOf(cl.get(s.a), cl.get(s.b))]++
      for (const v of [s.a, s.b]) { if (!adj.has(v)) adj.set(v, []); adj.get(v).push(i) }
    })
    const used = new Array(own.length).fill(false); const chains = []
    const walk = (start) => { const chain = [start]; let at = start; for (;;) { const ni = (adj.get(at) ?? []).find((i) => !used[i]); if (ni == null) break; used[ni] = true; at = own[ni].a === at ? own[ni].b : own[ni].a; chain.push(at) } return chain }
    for (const [v, list] of adj) if (list.length % 2 === 1 && list.some((i) => !used[i])) chains.push(walk(v))
    own.forEach((s, i) => { if (!used[i]) chains.push(walk(s.a)) })
    let bends = 0; const acuteAt = []
    for (const ch of chains) for (let i = 1; i + 1 < ch.length; i++) {
      const A = cl.get(ch[i - 1]), B = cl.get(ch[i]), C = cl.get(ch[i + 1])
      if (norm(A, B) !== norm(B, C)) bends++
      if ((A[0] - B[0]) * (C[0] - B[0]) + (A[1] - B[1]) * (C[1] - B[1]) > 0) acuteAt.push(label(ch[i]))
    }
    lines.push({ name: m.name, segs: own.length, ...stat, bends, acute: acuteAt.length, acuteAt, chains: chains.map((c) => c.map(label)) })
  }
  return { stats: { segs: segs.length, hv: g.H + g.V, h: g.H, v: g.V, d45: g.D45, other: g.other, acute: lines.reduce((s, l) => s + l.acute, 0) }, lines }
}
const before = report(cells)
const movesPath = process.argv[2]
if (!movesPath) { console.log(JSON.stringify(before, null, 1)); process.exit(0) }
const spec = JSON.parse(await readFile(movesPath, 'utf8'))
const targets = Object.entries(spec.moves).map(([i, t]) => [idsSorted[+i], t])
  .filter(([id, t]) => id && Array.isArray(t) && t[0] >= 0 && t[0] < nC && t[1] >= 0 && t[1] < nR)
const res = applyLlmTargets(skeleton, cells, nC, nR, targets)
const rejected = targets.filter(([id, t]) => { const p = res.cellAfter.get(id); return p && (p[0] !== t[0] || p[1] !== t[1]) })
  .map(([id, t]) => ({ i: idsSorted.indexOf(id), name: nameById.get(id) ?? '×', want: t, got: res.cellAfter.get(id) }))
const after = report(res.cellAfter)
console.log(JSON.stringify({
  before: before.stats, after: after.stats,
  hv: `${res.stats.hvBefore} -> ${res.stats.hvAfter}`, moved: res.stats.moved, proposed: targets.length, rejected,
  acuteLines: after.lines.filter((l) => l.acute).map((l) => ({ name: l.name, acuteAt: l.acuteAt })),
  linesAfter: process.argv[3] === 'full' ? after.lines : undefined,
}, null, 1))
