// scratch: 在 base moves 之上貪婪搜尋單點移動（±R），目標 HV 最多、45 次之、銳角為 0
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { geoMercator } from 'd3-geo'
import { buildConnectSkeleton } from '../src/stores/skeleton.js'
import { buildSchematicGrid } from '../src/stores/schematicGrid.js'
import { buildHcGraph, iteratePost, applyLlmTargets, straightenCompactLoop, setSpanCap, makeMover } from '../src/stores/hillClimb.js'
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
const nameById = new Map(stations.map((f) => [f.properties.station_id, f.properties.station_name_local || f.properties.station_name || f.properties.station_id]))

const seed = JSON.parse(await readFile(join(__dirname, process.argv[2] ?? 'mv_base.json'), 'utf8'))
const seedTargets = Object.entries(seed.moves).map(([i, t]) => [idsSorted[+i], t])
const start = applyLlmTargets(skeleton, cells, nC, nR, seedTargets).cellAfter

// 從 start 開始貪婪
const pos = new Map([...start].map(([id, p]) => [id, [p[0], p[1]]]))
const { segs, inc } = buildHcGraph(skeleton, pos)
const M = makeMover(pos, segs, inc, nC, nR)
const dirOf = (A, B) => {
  const dx = B[0] - A[0], dy = B[1] - A[1]
  if (dy === 0) return 'H'; if (dx === 0) return 'V'
  if (Math.abs(dx) === Math.abs(dy)) return 'D45'; return 'other'
}
function acuteCount(p) {
  // 逐頂點：任兩條入射段夾角 <90 且該頂點在某路線鏈上連續 → 近似用「同 route 的兩段」
  let n = 0
  for (const [v, list] of inc) {
    const P = p.get(v)
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const s = segs[list[i]], t = segs[list[j]]
      const shared = [...(s.routes ?? [])].some((r) => (t.routes ?? new Set()).has(r))
      if (!shared) continue
      const A = p.get(s.a === v ? s.b : s.a), C = p.get(t.a === v ? t.b : t.a)
      if ((A[0] - P[0]) * (C[0] - P[0]) + (A[1] - P[1]) * (C[1] - P[1]) > 0) n++
    }
  }
  return n
}
function score(p) {
  let h = 0, v = 0, d = 0
  for (const s of segs) { const k = dirOf(p.get(s.a), p.get(s.b)); if (k === 'H') h++; else if (k === 'V') v++; else if (k === 'D45') d++ }
  return { hv: h + v, d45: d, acute: acuteCount(p) }
}
const key = (s) => -s.acute * 1e12 + s.hv * 1e6 + s.d45
let cur = score(pos)
console.error('start', JSON.stringify(cur))
const R = Number(process.argv[3] ?? 2)
const MAXDEV = Number(process.argv[4] ?? 4)
const origOf = new Map([...cells].map(([id, p]) => [id, p]))
for (let round = 0; round < 12; round++) {
  let best = null
  for (const v of [...pos.keys()]) {
    const [c0, r0] = pos.get(v)
    const [oc, orr] = origOf.get(v)
    for (let dc = -R; dc <= R; dc++) for (let dr = -R; dr <= R; dr++) {
      if (!dc && !dr) continue
      const P = [c0 + dc, r0 + dr]
      if (Math.max(Math.abs(P[0] - oc), Math.abs(P[1] - orr)) > MAXDEV) continue
      if (!M.validMove(v, P)) continue
      const save = pos.get(v)
      M.applyMove(v, P)
      const s = score(pos)
      if (key(s) > key(cur) && (!best || key(s) > key(best.s))) best = { v, P, s }
      M.applyMove(v, save)
    }
  }
  if (!best) break
  M.applyMove(best.v, best.P)
  cur = best.s
  console.error('round', round, nameById.get(best.v) ?? '×', best.P.join(','), JSON.stringify(cur))
}
const out = {}
for (const id of idsSorted) {
  const p = pos.get(id), o = origOf.get(id)
  if (p[0] !== o[0] || p[1] !== o[1]) out[String(idsSorted.indexOf(id))] = [p[0], p[1]]
}
console.log(JSON.stringify({ moves: out }))
